use crate::db::PipelineDispatchRecord;
use crate::error::AppError;
use crate::models::domain::JobSnapshot;
use crate::models::request::CreateJobInput;
use crate::services::job_launcher::{link_new_job_to_document, start_job_execution};
use serde_json::Value;

use super::job_builders::{build_ocr_job_snapshot, build_translation_job_snapshot};
use super::ocr_credentials::{acquire_job_credential_usage_lock, secure_job_credentials};
use crate::services::jobs::deps::JobSubmitDeps;
use crate::services::uploads::UploadedPdfInput;

pub(crate) fn create_translation_job(
    deps: &JobSubmitDeps<'_>,
    input: &CreateJobInput,
) -> Result<JobSnapshot, AppError> {
    let input = &super::dev_defaults::with_dev_translation_defaults(input);
    let job = build_translation_job_snapshot(&deps.snapshot, input)?;
    let job = secure_job_credentials(deps, job)?;
    let _credential_guard = acquire_job_credential_usage_lock(deps, &job)?;
    start_job_execution(&deps.launcher, job)
}

pub(crate) fn create_ocr_ambiguity_recovery_job(
    deps: &JobSubmitDeps<'_>,
    input: &CreateJobInput,
    source_dispatch: &PipelineDispatchRecord,
    resolution: &str,
    receipt: Option<&Value>,
) -> Result<JobSnapshot, AppError> {
    let job = build_translation_job_snapshot(&deps.snapshot, input)?;
    let job = secure_job_credentials(deps, job)?;
    let _credential_guard = acquire_job_credential_usage_lock(deps, &job)?;
    if !deps.launcher.db.create_ocr_recovery_job_state(
        source_dispatch,
        &job,
        resolution,
        receipt,
    )? {
        return Err(AppError::conflict(
            "OCR ambiguity was already resolved by another request",
        ));
    }
    // 不经 start_job_execution（行由 create_ocr_recovery_job_state 原子建），归属在这里补；
    // 它只带 upload_id，upload 没有 content_hash 时按发生歧义的源任务继承。
    link_new_job_to_document(deps.launcher.db, &job, Some(&source_dispatch.job_id));
    deps.launcher.runtime.launch(job.job_id.clone());
    Ok(job)
}

pub(crate) async fn create_ocr_job_from_upload(
    deps: &JobSubmitDeps<'_>,
    input: &CreateJobInput,
    upload: Option<UploadedPdfInput>,
) -> Result<JobSnapshot, AppError> {
    let stored = match upload {
        Some(upload) => Some(deps.uploads.store(upload).await?),
        None => None,
    };
    let job = build_ocr_job_snapshot(&deps.snapshot, input, stored.as_ref())?;
    let job = secure_job_credentials(deps, job)?;
    let _credential_guard = acquire_job_credential_usage_lock(deps, &job)?;
    start_job_execution(&deps.launcher, job)
}
