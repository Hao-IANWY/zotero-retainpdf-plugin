use std::path::Path;

use crate::db::Db;
use crate::error::AppError;
use crate::job_events::persist_job_with_resources;
use crate::models::domain::JobSnapshot;

use super::runtime_gateway::JobRuntimeLauncher;

#[derive(Clone)]
pub struct JobLaunchDeps<'a> {
    pub db: &'a Db,
    pub data_root: &'a Path,
    pub output_root: &'a Path,
    pub runtime: JobRuntimeLauncher,
}

impl<'a> JobLaunchDeps<'a> {
    pub fn new(
        db: &'a Db,
        data_root: &'a Path,
        output_root: &'a Path,
        runtime: JobRuntimeLauncher,
    ) -> Self {
        Self {
            db,
            data_root,
            output_root,
            runtime,
        }
    }
}

pub fn start_job_execution(
    deps: &JobLaunchDeps<'_>,
    job: JobSnapshot,
) -> Result<JobSnapshot, AppError> {
    // The new contract must never silently use the legacy Python transport.
    // Worker rollout is a separate, explicit gate while migration is in flight.
    if job
        .request_payload
        .translation
        .execution_connection
        .is_some()
        && (std::env::var("RETAIN_MODEL_EXECUTOR_ENABLED").as_deref() != Ok("1")
            || std::env::var("RETAIN_MODEL_WORKER_ENABLED").as_deref() != Ok("1"))
    {
        return Err(AppError::ServiceUnavailable("Rust model worker rollout is not enabled; execution_connection will not fall back to Python transport".into()));
    }
    persist_job_with_resources(deps.db, deps.data_root, deps.output_root, &job)?;
    link_new_job_to_document(deps.db, &job, None);
    deps.runtime.launch(job.job_id.clone());
    Ok(job)
}

/// 新任务归到哪本书：写 `jobs.document_id`，并把书卡（`documents.active_job_id`）指向它。
///
/// 所有「建任务即开跑」的入口都要经过这里 —— 主页卡片靠 active_job_id 找运行中任务，
/// 「这本书的任务」（list_jobs_for_document / 阅读页的打开计划 / 全文索引 / 删书级联）
/// 靠 jobs.document_id。以前只有带 upload_id 的任务在这里关联；重新渲染、重试、继续/重跑
/// 这些从已有任务派生出来的任务只带 `source.artifact_job_id`，各入口各补一半（有的只改
/// 书卡、没写归属），没补到的要等重启回填才出现在这本书下。
///
/// 规则：先按 upload_id（经 uploads.content_hash）关联；查不到再沿 artifact_job_id 继承源任务的
/// 归属（源任务的 jobs.document_id，退回它 upload 的 content_hash）；还查不到、而调用方知道它是
/// 从哪个任务派生的（`derived_from`：OCR 重试只带 upload_id / source_url、不带 artifact_job_id），
/// 再按那个任务继承。
///
/// 尽力而为：失败只记日志，绝不影响提交；终态 lifecycle 还会再对账一次。
pub(crate) fn link_new_job_to_document(db: &Db, job: &JobSnapshot, derived_from: Option<&str>) {
    let Some(document_id) = resolve_new_job_document(db, job, derived_from) else {
        return;
    };
    if let Err(error) = db.set_document_active_job(&document_id, &job.job_id, None) {
        tracing::warn!("library: set active job for {document_id} at submit failed: {error}");
    }
}

fn resolve_new_job_document(
    db: &Db,
    job: &JobSnapshot,
    derived_from: Option<&str>,
) -> Option<String> {
    if let Some(upload_id) = job.upload_id.as_deref().filter(|id| !id.is_empty()) {
        match db.link_job_to_document(&job.job_id, upload_id) {
            Ok(Some(document_id)) => return Some(document_id),
            Ok(None) => {}
            Err(error) => tracing::warn!(
                "library: link job {} to document at submit failed: {error}",
                job.job_id
            ),
        }
    }
    let document_id = [Some(job.request_payload.source.artifact_job_id.as_str()), derived_from]
        .into_iter()
        .flatten()
        .map(str::trim)
        .filter(|source| !source.is_empty())
        .find_map(|source| document_of_job(db, source))?;
    if let Err(error) = db.set_job_document_id(&job.job_id, &document_id) {
        tracing::warn!(
            "library: link job {} to {document_id} at submit failed: {error}",
            job.job_id
        );
        return None;
    }
    Some(document_id)
}

/// 源任务归属的书：jobs.document_id，退回它 upload 的 content_hash。
fn document_of_job(db: &Db, job_id: &str) -> Option<String> {
    match db.document_id_for_job(job_id) {
        Ok(Some(document_id)) => Some(document_id),
        Ok(None) | Err(_) => match db.get_document_by_job_id(job_id) {
            Ok(document) => document.map(|document| document.document_id),
            Err(error) => {
                tracing::warn!("library: resolve document for source job {job_id} failed: {error}");
                None
            }
        },
    }
}
