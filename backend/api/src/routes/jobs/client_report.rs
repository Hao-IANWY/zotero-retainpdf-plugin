//! 客户端结果上报:Zotero 插件把下载/挂回等客户端环节的结果写回事件流,
//! 让网页端详情页能看到「服务端成功但客户端挂回失败」这类断链。
//!
//! 设计:接受任意 stage/level/message,写成一条 `client_report` 事件。
//! 服务端不校验 stage 白名单——客户端环境差异大,宽松入口比枚举清单可维护。

use axum::extract::State;
use axum::Json;

use crate::app::AppState;
use crate::error::AppError;
use crate::models::api::ApiResponse;
use crate::routes::common::{build_jobs_client_report_deps, ApiPath, ApiQuery};

#[derive(Debug, serde::Deserialize)]
pub struct ClientReportInput {
    /// 环节:upload / create / download-mono / attach-mono / ... 客户端自定
    pub stage: String,
    /// info | error
    pub level: String,
    pub message: String,
}

#[derive(Debug, Default, serde::Deserialize)]
pub struct ClientReportQuery {
    #[serde(default)]
    pub ocr_only: bool,
}

pub async fn post_client_report(
    State(state): State<AppState>,
    ApiPath(job_id): ApiPath<String>,
    ApiQuery(_query): ApiQuery<ClientReportQuery>,
    Json(input): Json<ClientReportInput>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    let stage = input.stage.trim().chars().take(64).collect::<String>();
    let level = match input.level.trim().to_ascii_lowercase().as_str() {
        "error" => "error",
        _ => "info",
    };
    let message: String = input.message.trim().chars().take(2000).collect();
    if stage.is_empty() || message.is_empty() {
        return Err(AppError::bad_request("stage and message are required"));
    }

    let deps = build_jobs_client_report_deps(&state);
    let job = deps
        .db
        .get_job(&job_id)
        .map_err(|_| AppError::not_found(format!("job not found: {job_id}")))?;

    retain_data::job_events::record_custom_runtime_event_with_resources(
        deps.db,
        deps.data_root,
        deps.output_root,
        &job,
        level,
        "client_report",
        format!("[{stage}] {message}"),
        Some(serde_json::json!({
            "client_stage": stage,
            "client_level": level,
        })),
    );

    Ok(Json(ApiResponse::ok(serde_json::json!({ "recorded": true }))))
}
