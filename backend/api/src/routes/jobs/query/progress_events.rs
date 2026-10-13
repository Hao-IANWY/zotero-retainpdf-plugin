//! 进度事件 SSE:把任务事件流以服务端推送的方式发给浏览器/插件。
//!
//! 与 `/live-events`(译文段落提交流,为边翻边看预览设计)不同,这里推的是
//! 事件总览的增量(stage_detail 人话、progress.percent)。实现上刻意复用
//! `JobQueries::job_events_view`:每拍都经它读(synchronize/redact/epoch 语义
//! 全部继承),本文件只负责「tail 最新窗口 + seq 去重 + SSE 化 + 终态收尾」。
//!
//! 终态行为:增量推完后发命名事件 `end` 并关流。客户端收到 `end` 必须主动
//! close();否则 EventSource 的自动重连会拿到一条立即结束的新流,形成重连风暴。

use std::time::Duration;

use axum::extract::State;
use axum::response::sse::{Event, KeepAlive, Sse};
use futures_util::stream::{Stream, poll_fn};
use tokio::sync::mpsc;

use crate::app::AppState;
use crate::error::AppError;
use crate::models::api::ListJobEventsQuery;
use crate::models::domain::JobStatusKind;
use crate::routes::common::{build_jobs_query_route_deps, ApiPath, ApiQuery};

/// 每拍读取的窗口大小。事件是阶段级粒度,100 条足够覆盖任何单拍增量;
/// 客户端按 seq 去重,窗口外的旧事件不会重复推送。
const TAIL_LIMIT: u32 = 100;
/// 无新事件时的轮询间隔:与前端详情页此前 1s 轮询的节奏对齐。
const POLL_INTERVAL: Duration = Duration::from_secs(1);

pub async fn get_progress_events(
    State(state): State<AppState>,
    ApiPath(job_id): ApiPath<String>,
    ApiQuery(_query): ApiQuery<ListJobEventsQuery>,
) -> Result<Sse<impl Stream<Item = Result<Event, axum::Error>>>, AppError> {
    // 打开流之前先校验任务存在:404 在握手期返回,而不是流里静默关闭
    build_jobs_query_route_deps(&state)
        .jobs
        .job_events_view(&job_id, &tail_query(1), false)?;

    let (tx, mut rx) = mpsc::channel::<Result<Event, axum::Error>>(64);
    let app = state.clone();
    tokio::spawn(async move {
        let mut cursor: i64 = 0;
        loop {
            let jobs = build_jobs_query_route_deps(&app).jobs;
            let view = match jobs.job_events_view(&job_id, &tail_query(TAIL_LIMIT), false) {
                Ok(view) => view,
                Err(_) => return, // DB 忙/任务被清:关流,客户端自行重连或放弃
            };
            let fresh: Vec<_> = view
                .items
                .iter()
                .filter(|item| item.event.seq > cursor)
                .collect();
            if let Some(last) = fresh.last() {
                cursor = cursor.max(last.event.seq);
            }
            for item in fresh {
                let payload = serde_json::to_value(&item.event).unwrap_or_default();
                let event = Event::default()
                    .id(item.event.seq.to_string())
                    .event("progress")
                    .json_data(payload);
                if tx.send(event).await.is_err() {
                    return; // 客户端断开
                }
            }
            if let Some(terminal) = terminal_payload(&app, &job_id) {
                let _ = tx
                    .send(Event::default().event("end").json_data(terminal))
                    .await;
                return;
            }
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    });

    Ok(Sse::new(poll_fn(move |cx| rx.poll_recv(cx))).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keep-alive"),
    ))
}

fn tail_query(limit: u32) -> ListJobEventsQuery {
    ListJobEventsQuery {
        limit,
        start: None,
        cursor: None,
    }
}

/// 终态探测:succeeded/failed/canceled → Some(status payload)。
/// 只取 status,不构造完整详情(base_url 留空,视图链接不可用但不消费)。
fn terminal_payload(state: &AppState, job_id: &str) -> Option<serde_json::Value> {
    let view = build_jobs_query_route_deps(state)
        .jobs
        .job_detail_view("", job_id, false)
        .ok()?;
    if !matches!(
        view.status,
        JobStatusKind::Succeeded | JobStatusKind::Failed | JobStatusKind::Canceled
    ) {
        return None;
    }
    Some(serde_json::json!({
        "status": format!("{:?}", view.status).to_ascii_lowercase(),
        "job_id": view.job_id,
    }))
}
