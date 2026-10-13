use axum::extract::State;
use axum::Json;

use crate::error::AppError;
use crate::models::api::ApiResponse;
use crate::models::domain::UploadRecord;
use crate::routes::common::{
    build_upload_route_deps, ok_json, read_multipart_text_limited, safe_multipart_error,
    ApiMultipart, UploadRouteDeps,
};
use crate::services::uploads::api::{
    admit_upload, commit_upload_view, stage_upload_field, store_upload as store_upload_service,
    StagedUpload,
};
use crate::AppState;

/// 上传入口。接入许可在读取任何文件字节之前取得并贯穿全程:读取阶段
/// 分块落盘受控暂存,解析阶段沿用解析/修复并发与内存预算。
pub async fn upload_pdf(
    State(state): State<AppState>,
    ApiMultipart(mut multipart): ApiMultipart,
) -> Result<Json<ApiResponse<crate::models::UploadView>>, AppError> {
    const TEXT_FIELD_MAX_BYTES: std::num::NonZeroU64 =
        std::num::NonZeroU64::new(1024 * 1024).expect("multipart text limit is non-zero");

    let deps = build_upload_route_deps(&state);
    let admission = admit_upload(&deps.uploads)?;
    let mut staged: Option<StagedUpload> = None;
    let mut developer_mode = false;

    while let Some(field) = multipart.next_field().await.map_err(safe_multipart_error)? {
        let name = field.name().unwrap_or_default().to_string();
        if name == "file" {
            // 第二个 file 字段在读取其内容之前就拒绝
            if staged.is_some() {
                return Err(AppError::bad_request("duplicate multipart field: file"));
            }
            staged = Some(stage_upload_field(&deps.uploads, field, deps.upload_max_bytes).await?);
        } else if name == "developer_mode" {
            let value = read_multipart_text_limited(field, TEXT_FIELD_MAX_BYTES).await?;
            developer_mode = matches!(value.trim(), "1" | "true" | "True" | "TRUE");
        }
    }

    let staged = staged.ok_or_else(|| AppError::bad_request("missing multipart field: file"))?;
    Ok(ok_json(
        commit_upload_view(&deps.uploads, admission, staged, developer_mode).await?,
    ))
}

pub async fn store_upload(
    deps: &UploadRouteDeps<'_>,
    filename: String,
    bytes: Vec<u8>,
    developer_mode: bool,
) -> Result<UploadRecord, AppError> {
    store_upload_service(&deps.uploads, filename, bytes, developer_mode).await
}
