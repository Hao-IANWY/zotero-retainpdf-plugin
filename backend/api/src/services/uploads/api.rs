use std::num::NonZeroU64;

use axum::extract::multipart::Field;

use super::{Admission, UploadService, UploadedPdfInput};
use crate::error::{safe_multipart_error, AppError};
use crate::models::api::{upload_to_response, UploadView};
use crate::models::domain::UploadRecord;

// 路由只经 `uploads::api::` 门面取类型,架构检查按此前缀放行;
// staging 等内部模块名不得出现在路由导入里。
pub(crate) use super::StagedUpload;

pub(crate) struct UploadApiDeps<'a> {
    uploads: &'a UploadService,
}

impl<'a> UploadApiDeps<'a> {
    pub(crate) fn new(uploads: &'a UploadService) -> Self {
        Self { uploads }
    }
}

pub(crate) async fn store_upload(
    deps: &UploadApiDeps<'_>,
    filename: String,
    bytes: Vec<u8>,
    developer_mode: bool,
) -> Result<UploadRecord, AppError> {
    deps.uploads
        .store(UploadedPdfInput {
            filename,
            bytes,
            developer_mode,
        })
        .await
        .map_err(AppError::from)
}

/// 在读取任何文件字节之前取得上传接入许可(读取/暂存/排队/解析全程持有)。
pub(crate) fn admit_upload(deps: &UploadApiDeps<'_>) -> Result<Admission, AppError> {
    deps.uploads.admit().map_err(AppError::from)
}

/// 把一个 multipart 文件字段分块写入受控暂存目录。字节按实际收到量
/// 累计检查上限;超限/断开由暂存守卫随 drop 清理,内存不攒整份文件。
pub(crate) async fn stage_upload_field(
    deps: &UploadApiDeps<'_>,
    mut field: Field<'_>,
    max_bytes: NonZeroU64,
) -> Result<StagedUpload, AppError> {
    let filename = field
        .file_name()
        .map(str::to_string)
        .unwrap_or_else(|| "upload.pdf".to_string());
    let mut writer = deps
        .uploads
        .begin_stage(&filename)
        .await
        .map_err(AppError::from)?;
    while let Some(chunk) = field.chunk().await.map_err(safe_multipart_error)? {
        writer
            .write_chunk(&chunk, max_bytes.get())
            .await
            .map_err(AppError::from)?;
    }
    writer.finish().await.map_err(AppError::from)
}

/// 流式上传的发布:接管接入许可与暂存文件,完成解析→修复→入库。
pub(crate) async fn commit_upload(
    deps: &UploadApiDeps<'_>,
    admission: Admission,
    staged: StagedUpload,
    developer_mode: bool,
) -> Result<UploadRecord, AppError> {
    deps.uploads
        .commit(admission, staged, developer_mode)
        .await
        .map_err(AppError::from)
}

pub(crate) async fn commit_upload_view(
    deps: &UploadApiDeps<'_>,
    admission: Admission,
    staged: StagedUpload,
    developer_mode: bool,
) -> Result<UploadView, AppError> {
    let upload = commit_upload(deps, admission, staged, developer_mode).await?;
    Ok(upload_to_response(&upload))
}
