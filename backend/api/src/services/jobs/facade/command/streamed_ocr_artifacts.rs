//! 边识别边翻译（OCR 和翻译并行）的书，翻译失败时补回 OCR 子任务的产物。
//!
//! 2026-11-03 以前 runner 在翻译失败那条路上直接返回，没把 OCR 子任务（`{父任务}-ocr`）的产物（原文 PDF、规范化
//! 文档……）并回父任务，父任务的记录里就没有这些路径：「重试翻译」判成缺文件、灰着，新任务也找不到可复用的 OCR
//! 结果（任务 20261103044311-4bdc13，6574 页，翻完 6.86 万条后失败）。runner 已经改了（translation_flow 的失败
//! 路径补调 sync_parent_with_ocr_child）；以前留下的这些任务，在看「能做哪些操作」和提交重试时从 OCR 子任务补
//! 回来。只补成功的子任务，父任务已经有规范化文档时不动。

use crate::db::Db;
use crate::error::AppError;
use crate::models::domain::{JobArtifacts, JobSnapshot, JobStatusKind, WorkflowKind};

/// 父任务缺 OCR 产物、OCR 子任务成功了时，子任务的编号和产物。
fn missing_child_ocr_artifacts(db: &Db, job: &JobSnapshot) -> Option<(String, JobArtifacts)> {
    if !matches!(job.workflow, WorkflowKind::Book | WorkflowKind::Translate) {
        return None;
    }
    let artifacts = job.artifacts.as_ref();
    let has_document = artifacts
        .and_then(|item| item.normalized_document_json.as_deref())
        .is_some_and(|value| !value.trim().is_empty());
    if has_document {
        return None;
    }
    let child_id = artifacts
        .and_then(|item| item.ocr_job_id.clone())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("{}-ocr", job.job_id));
    let child = db.get_job(&child_id).ok()?;
    if !matches!(child.status, JobStatusKind::Succeeded) {
        return None;
    }
    let child_artifacts = child.artifacts?;
    child_artifacts
        .normalized_document_json
        .as_deref()
        .filter(|value| !value.trim().is_empty())?;
    Some((child_id, child_artifacts))
}

/// 只在内存里补（看「能做哪些操作」用，不写库）。
pub(crate) fn with_streamed_ocr_artifacts(db: &Db, mut job: JobSnapshot) -> JobSnapshot {
    if let Some((child_id, child_artifacts)) = missing_child_ocr_artifacts(db, &job) {
        job.artifacts
            .get_or_insert_with(JobArtifacts::default)
            .copy_ocr_checkpoint_from(&child_id, &child_artifacts);
    }
    job
}

/// 补好并写回父任务（提交重试前用：新任务运行时按 artifact_job_id 回库里读源任务）。只写已经结束的任务。
pub(crate) fn adopt_streamed_ocr_artifacts(db: &Db, job: JobSnapshot) -> Result<JobSnapshot, AppError> {
    if !matches!(job.status, JobStatusKind::Failed | JobStatusKind::Canceled) {
        return Ok(job);
    }
    let Some((child_id, child_artifacts)) = missing_child_ocr_artifacts(db, &job) else {
        return Ok(job);
    };
    let mut job = job;
    job.artifacts
        .get_or_insert_with(JobArtifacts::default)
        .copy_ocr_checkpoint_from(&child_id, &child_artifacts);
    if !db.cas_save_job(&job, &["failed", "canceled"])? {
        return Err(AppError::conflict(format!(
            "job {} changed while its OCR artifacts were being restored; retry again",
            job.job_id
        )));
    }
    Ok(job)
}
