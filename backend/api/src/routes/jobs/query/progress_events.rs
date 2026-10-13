//! 进度事件 SSE:把任务事件流以服务端推送的方式发给浏览器/插件。
//!
//! 与 `/live-events`(译文段落提交流,为边翻边看预览设计)不同,这里推的是
//! 事件总览的增量(stage_detail 人话、progress.percent)。
//!
//! 结构:每个任务至多一个后台读取器,多个订阅者经 broadcast 共享同一份读取
//! 结果——同一任务 N 个客户端订阅时数据库查询不随 N 增长;最后一个订阅者
//! 离开后读取器自动退出。读取本身经 `run_job_query` 的受限阻塞通道执行,
//! 不占用异步运行线程。翻页复用事件 feed 的 cursor/epoch 机制:突发超过
//! 单页窗口的事件按 `has_more` 连页追平,不会被 100 条窗口截断;feed 重建
//! (epoch 过期)时重开尾窗继续推流。
//!
//! 终态行为:增量推完后发命名事件 `end` 并关流。客户端收到 `end` 必须主动
//! close();否则 EventSource 的自动重连会拿到一条立即结束的新流,形成重连风暴。

use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::{Arc, LazyLock, Mutex, Weak};
use std::time::Duration;

use axum::extract::State;
use axum::http::{header, HeaderValue};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::IntoResponse;
use futures_util::stream::{self};
use tokio::sync::broadcast;

use crate::app::AppState;
use crate::error::AppError;
use crate::models::api::{JobEventListView, ListJobEventsQuery};
use crate::models::domain::JobStatusKind;
use crate::routes::common::{build_jobs_query_route_deps, run_job_query, ApiPath, ApiQuery};

/// 每页读取的窗口大小。事件是阶段级粒度,单页 100 条;页与页之间按
/// cursor 续读,总量不受这个窗口截断。
const PAGE_LIMIT: u32 = 100;
/// 无新事件时的轮询间隔:与前端详情页此前 1s 轮询的节奏对齐。
const POLL_INTERVAL: Duration = Duration::from_secs(1);
/// 连续读取失败的预算:瞬时 DB 忙不拆全体订阅者的流,连续失败才放弃。
const READ_ERROR_BUDGET: u32 = 3;
/// broadcast 缓冲深度。慢订阅者落后超过这个数会被断流,由客户端自动
/// 重连 + seq 去重兜底,不能让慢订阅者阻塞其他订阅者。
const TAIL_CAPACITY: usize = 256;

/// 读取器与订阅者之间的帧。刻意用可 Clone 的裸数据而不是 axum::Event
/// (broadcast 要求 T: Clone),订阅侧再渲染成 SSE 事件。
#[derive(Clone)]
struct TailFrame {
    id: String,
    name: &'static str,
    payload: serde_json::Value,
}

/// 每个任务的共享读取器。Arc 由后台任务持有,注册表只存 Weak:读取器
/// 退出(终态/全部订阅者离开/连续失败)后 Arc 释放,Weak 失效,下一个
/// 订阅者自然起新的读取器。
static TAILS: LazyLock<Mutex<HashMap<String, Weak<broadcast::Sender<TailFrame>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub async fn get_progress_events(
    State(state): State<AppState>,
    ApiPath(job_id): ApiPath<String>,
    ApiQuery(_query): ApiQuery<ListJobEventsQuery>,
) -> Result<axum::response::Response, AppError> {
    // 打开流之前先校验任务存在:404/409 在握手期返回,而不是流里静默关闭
    build_jobs_query_route_deps(&state)
        .jobs
        .job_events_view(&job_id, &page_query(None), false)?;

    let sender = join_tail(state, job_id.clone());
    let rx = sender.subscribe();
    let stream = stream::unfold(rx, |mut rx| async move {
        loop {
            match rx.recv().await {
                Ok(frame) => {
                    let event = Event::default()
                        .id(frame.id)
                        .event(frame.name)
                        .json_data(frame.payload)
                        .expect("tail frame is serializable");
                    return Some((Ok::<_, Infallible>(event), rx));
                }
                // Lagged=订阅者跟不上,Closed=读取器退出:都结束本流。断流后
                // 客户端自动重连,尾窗帧带 seq id,重连不会造成状态回退。
                Err(broadcast::error::RecvError::Lagged(_)) => return None,
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    });
    let mut response = Sse::new(stream)
        .keep_alive(
            KeepAlive::new()
                .interval(Duration::from_secs(15))
                .text("keep-alive"),
        )
        .into_response();
    // 显式声明禁止代理缓冲:反向代理(nginx)按上游头逐响应生效,
    // 不依赖部署侧给每条 SSE location 单独配 proxy_buffering。
    let response_headers = response.headers_mut();
    response_headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response_headers.insert(
        header::HeaderName::from_static("x-accel-buffering"),
        HeaderValue::from_static("no"),
    );
    Ok(response)
}

fn page_query(cursor: Option<String>) -> ListJobEventsQuery {
    ListJobEventsQuery {
        limit: PAGE_LIMIT,
        start: None,
        cursor,
    }
}

/// 加入(或创建)该任务的共享读取器,返回可用的事件广播。
fn join_tail(state: AppState, job_id: String) -> Arc<broadcast::Sender<TailFrame>> {
    let mut tails = TAILS.lock().expect("progress tail registry");
    tails.retain(|_, weak| weak.upgrade().is_some());
    if let Some(sender) = tails.get(&job_id).and_then(Weak::upgrade) {
        return sender;
    }
    let sender = Arc::new(broadcast::channel(TAIL_CAPACITY).0);
    tails.insert(job_id.clone(), Arc::downgrade(&sender));
    drop(tails);
    tokio::spawn(run_tail(state, job_id, sender.clone()));
    sender
}

/// 一拍读取结果:事件页 + 终态探测用的最小任务状态。
#[derive(Clone)]
struct TailPage {
    view: JobEventListView,
    status: Option<JobStatusKind>,
}

async fn run_tail(state: AppState, job_id: String, sender: Arc<broadcast::Sender<TailFrame>>) {
    let mut cursor: Option<String> = None;
    let mut read_errors: u32 = 0;
    loop {
        match read_tail_page(&state, &job_id, &cursor).await {
            Ok(page) => {
                read_errors = 0;
                cursor = Some(page.view.next_cursor);
                for item in &page.view.items {
                    let frame = TailFrame {
                        id: item.event.seq.to_string(),
                        name: "progress",
                        payload: serde_json::to_value(&item.event).unwrap_or_default(),
                    };
                    if sender.send(frame).is_err() {
                        return; // 最后一个订阅者已离开
                    }
                }
                if let Some(status) = page.status {
                    if matches!(
                        status,
                        JobStatusKind::Succeeded | JobStatusKind::Failed | JobStatusKind::Canceled
                    ) {
                        let _ = sender.send(TailFrame {
                            id: String::new(),
                            name: "end",
                            payload: serde_json::json!({
                                "status": format!("{status:?}").to_ascii_lowercase(),
                                "job_id": job_id,
                            }),
                        });
                        return;
                    }
                }
                if page.view.has_more {
                    // 突发事件按页追平,不等下一拍
                    continue;
                }
            }
            Err(error) if is_cursor_expired(&error) => {
                // feed 被重建(epoch 过期):重开尾窗。计入失败预算,
                // 防止异常环境下热循环重开。
                read_errors += 1;
                cursor = None;
                if read_errors >= READ_ERROR_BUDGET {
                    return;
                }
            }
            Err(_) => {
                // DB 忙/任务被清:给瞬时错误几次机会,连续失败才关流
                read_errors += 1;
                if read_errors >= READ_ERROR_BUDGET {
                    return;
                }
            }
        }
        // 等待下一拍,同时监听订阅者全部离开:断开后及时退出后台读取
        tokio::select! {
            _ = sender.closed() => return,
            _ = tokio::time::sleep(POLL_INTERVAL) => {}
        }
    }
}

async fn read_tail_page(
    state: &AppState,
    job_id: &str,
    cursor: &Option<String>,
) -> Result<TailPage, AppError> {
    let query = page_query(cursor.clone());
    let job_id = job_id.to_string();
    // 同一任务同一游标的并发读取在受限阻塞通道内合并执行
    let key = format!(
        "progress-events:{job_id}:{}",
        cursor.as_deref().unwrap_or("tail")
    );
    run_job_query(state, key, move |jobs| {
        let view = jobs.job_events_view(&job_id, &query, false)?;
        Ok(TailPage {
            status: jobs.job_status_kind(&job_id),
            view,
        })
    })
    .await
}

fn is_cursor_expired(error: &AppError) -> bool {
    matches!(error, AppError::EventCursorExpired(_))
}
