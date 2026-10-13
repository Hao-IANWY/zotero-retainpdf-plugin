//! Bounded, in-flight-only generation of expensive download artifacts.
//! Request cancellation never cancels an admitted blocking writer.
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use tokio::sync::{watch, Semaphore};

use super::jobs::FileDownload;
use crate::error::AppError;

type Outcome = Result<FileDownload, AppError>;
type Completion = watch::Sender<Option<Outcome>>;

pub struct DownloadGeneration {
    slots: Arc<Semaphore>,
    in_flight: Mutex<HashMap<String, Completion>>,
    max_keys: usize,
}

impl Default for DownloadGeneration {
    fn default() -> Self {
        Self::with_limits(2, 128)
    }
}

impl DownloadGeneration {
    fn with_limits(slots: usize, max_keys: usize) -> Self {
        Self {
            slots: Arc::new(Semaphore::new(slots.max(1))),
            in_flight: Mutex::new(HashMap::new()),
            max_keys: max_keys.max(1),
        }
    }

    pub async fn run(
        self: &Arc<Self>,
        key: String,
        work: impl FnOnce() -> Outcome + Send + 'static,
    ) -> Outcome {
        // No await between admission and spawning the independent supervisor:
        // dropping the requesting future cannot leave an ownerless map entry.
        let mut completion = {
            let mut in_flight = self.in_flight.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(existing) = in_flight.get(&key) {
                existing.subscribe()
            } else {
                // Includes running work. Existing keys can always join even
                // when distinct-key admission is at capacity.
                if in_flight.len() >= self.max_keys {
                    return Err(AppError::too_many_requests(
                        "download generation queue is full",
                    ));
                }
                let (sender, receiver) = watch::channel(None);
                in_flight.insert(key.clone(), sender.clone());
                let owner = Arc::clone(self);
                tokio::spawn(async move {
                    let outcome = match owner.slots.clone().acquire_owned().await {
                        Ok(permit) => {
                            match tokio::task::spawn_blocking(move || {
                                // The blocking writer, not a cancellable HTTP
                                // future, owns its capacity until it finishes.
                                let _permit = permit;
                                work()
                            })
                            .await
                            {
                                Ok(result) => result,
                                Err(_) => {
                                    Err(AppError::internal("download generation task failed"))
                                }
                            }
                        }
                        Err(_) => Err(AppError::service_unavailable(
                            "download generation unavailable",
                        )),
                    };
                    let mut in_flight = owner.in_flight.lock().unwrap_or_else(|e| e.into_inner());
                    // Publish even if every original caller disconnected. The
                    // channel can publish without receivers; no result is
                    // retained as a historical artifact cache.
                    sender.send_replace(Some(outcome));
                    in_flight.remove(&key);
                });
                receiver
            }
        };
        loop {
            if let Some(result) = completion.borrow_and_update().clone() {
                return result;
            }
            if completion.changed().await.is_err() {
                return Err(AppError::internal("download generation task unavailable"));
            }
        }
    }
}

#[cfg(test)]
mod tests;
