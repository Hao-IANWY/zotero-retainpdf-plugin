use crate::error::AppError;
use crate::models::domain::{JobSnapshot, JobStatusKind};
use crate::services::artifacts::{
    artifact_is_direct_downloadable, build_bundle_for_job, build_markdown_bundle_for_job,
    resolve_registry_artifact,
};
use crate::storage_paths::{
    ARTIFACT_KEY_MARKDOWN_BUNDLE_ZIP, ARTIFACT_KEY_SOURCE_PDF, ARTIFACT_KEY_TRANSLATED_PDF,
};

use super::super::query::load_supported_job;
use crate::services::download_names::{job_download_file_name, DownloadKind};
use crate::storage_paths::ARTIFACT_KEY_MARKDOWN_RAW;
use super::pdf::linearized_pdf_or_original;
use super::{DownloadJobsDeps, FileDownload};

pub(super) fn bundle_download(
    deps: &DownloadJobsDeps<'_>,
    job_id: &str,
) -> Result<FileDownload, AppError> {
    let job = load_supported_job(deps.db, deps.data_root, job_id)?;
    if !matches!(job.status, JobStatusKind::Succeeded) {
        return Err(AppError::conflict("job is not finished successfully"));
    }
    let zip_path = build_bundle_for_job(deps.db, deps.data_root, deps.downloads_dir, &job)?;
    Ok(
        FileDownload::new(
            zip_path,
            "application/zip",
            Some(job_download_file_name(deps.db, &job, DownloadKind::Bundle)),
        )
            .with_job_id_header(job_id),
    )
}

pub(super) fn registered_artifact_download(
    deps: &DownloadJobsDeps<'_>,
    job: &JobSnapshot,
    artifact_key: &str,
    include_job_dir: bool,
) -> Result<FileDownload, AppError> {
    if artifact_key == ARTIFACT_KEY_MARKDOWN_BUNDLE_ZIP {
        let (item, path) =
            build_markdown_bundle_for_job(deps.db, deps.data_root, job, include_job_dir)?;
        let name = job_download_file_name(deps.db, job, DownloadKind::MarkdownBundle);
        return Ok(FileDownload::new(path, item.content_type, item.file_name.map(|_| name)));
    }
    let Some((item, path)) = resolve_registry_artifact(deps.db, deps.data_root, job, artifact_key)?
    else {
        return Err(AppError::not_found(format!(
            "artifact not found: {}/{artifact_key}",
            job.job_id
        )));
    };
    if !artifact_is_direct_downloadable(&item) {
        return Err(AppError::conflict(format!(
            "artifact is a directory and cannot be streamed directly: {artifact_key}"
        )));
    }
    if !item.ready || !path.exists() || !path.is_file() {
        return Err(AppError::not_found(format!(
            "artifact not ready: {}/{artifact_key}",
            job.job_id
        )));
    }
    let path = if item.content_type == "application/pdf"
        && matches!(
            artifact_key,
            ARTIFACT_KEY_SOURCE_PDF | ARTIFACT_KEY_TRANSLATED_PDF
        ) {
        linearized_pdf_or_original(deps, job, &path, artifact_key)?
    } else {
        path
    };
    // 给用户的几类文件统一命名（services::download_names）；原来是附件的还是附件、
    // 原来 inline 的还是 inline，只换名字。排查用的文件保持原名。
    let kind = match artifact_key {
        ARTIFACT_KEY_SOURCE_PDF => Some(DownloadKind::Source),
        ARTIFACT_KEY_TRANSLATED_PDF => Some(DownloadKind::Translated),
        ARTIFACT_KEY_MARKDOWN_RAW => Some(DownloadKind::OcrMarkdown),
        _ => None,
    };
    let Some(kind) = kind else {
        return Ok(FileDownload::new(path, item.content_type, item.file_name));
    };
    let name = job_download_file_name(deps.db, job, kind);
    Ok(match item.file_name {
        Some(_) => FileDownload::new(path, item.content_type, Some(name)),
        None => FileDownload::new(path, item.content_type, None).with_inline_name(name),
    })
}
