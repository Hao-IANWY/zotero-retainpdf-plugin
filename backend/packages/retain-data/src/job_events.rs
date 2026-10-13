use std::path::Path;

use anyhow::Result;
use serde_json::Value;
use tracing::warn;

use crate::db::Db;
use crate::models::api::JobEventRecord;
use crate::models::domain::{JobRuntimeState, JobSnapshot};
mod derivation;
mod jsonl;

use derivation::{
    custom_event, derive_events, normalize_user_stage, progress_unit_for_event,
    user_stage_for_event, PendingJobEvent,
};
use jsonl::append_event_jsonl;

pub fn persist_job_with_resources(
    db: &Db,
    data_root: &Path,
    output_root: &Path,
    job: &JobSnapshot,
) -> Result<()> {
    let previous = db.get_job(&job.job_id).ok();
    let mut current = job.clone();
    current.sync_runtime_state();
    db.save_job(&current)?;
    emit_job_events_best_effort(db, data_root, output_root, previous.as_ref(), &current);
    Ok(())
}

pub fn cas_persist_job_with_resources(
    db: &Db,
    data_root: &Path,
    output_root: &Path,
    job: &JobSnapshot,
    expected_statuses: &[&str],
) -> Result<bool> {
    let previous = db.get_job(&job.job_id).ok();
    let mut current = job.clone();
    current.sync_runtime_state();
    let updated = db.cas_save_job(&current, expected_statuses)?;
    if updated {
        emit_job_events_best_effort(db, data_root, output_root, previous.as_ref(), &current);
    }
    Ok(updated)
}

/// 同 [`cas_persist_job_with_resources`] 的 CAS 写，但**不派生事件**。
///
/// 只给「顺带同步一下别的任务的行」这种镜像写用：那份进度已经由真正的来源
/// 自己发过事件了，再从这一行的 diff 派生一套，读者就会看到同一条消息两遍。
/// 典型例子是 OCR 子任务往父任务镜像阶段——子任务的事件本来就会被导入父任务
/// 的事件流。
///
/// 后续正常写入仍用 `previous`（即这里落下的行）做 diff，所以跳过的只是这一次
/// 镜像本身产生的变化，不会让下一次写多派生或少派生。
pub fn cas_persist_job_row_without_events(
    db: &Db,
    job: &JobSnapshot,
    expected_statuses: &[&str],
) -> Result<bool> {
    let mut current = job.clone();
    current.sync_runtime_state();
    db.cas_save_job(&current, expected_statuses)
}

pub fn persist_runtime_job_with_resources(
    db: &Db,
    data_root: &Path,
    output_root: &Path,
    job: &JobRuntimeState,
) -> Result<()> {
    let snapshot = job.snapshot();
    persist_job_with_resources(db, data_root, output_root, &snapshot)
}

pub fn record_custom_job_event_with_resources(
    db: &Db,
    data_root: &Path,
    output_root: &Path,
    job: &JobSnapshot,
    level: &str,
    event: &str,
    message: impl Into<String>,
    payload: Option<Value>,
) {
    let pending = custom_event(job, level, event, message, payload);
    if let Err(err) = append_pending_event(db, data_root, output_root, job, pending) {
        warn!("failed to append job event for {}: {}", job.job_id, err);
    }
}

pub fn record_custom_runtime_event_with_resources(
    db: &Db,
    data_root: &Path,
    output_root: &Path,
    job: &JobSnapshot,
    level: &str,
    event: &str,
    message: impl Into<String>,
    payload: Option<Value>,
) {
    record_custom_job_event_with_resources(
        db,
        data_root,
        output_root,
        job,
        level,
        event,
        message,
        payload,
    );
}

fn emit_job_events_best_effort(
    db: &Db,
    data_root: &Path,
    output_root: &Path,
    previous: Option<&JobSnapshot>,
    current: &JobSnapshot,
) {
    for pending in derive_events(previous, current) {
        if let Err(err) = append_pending_event(db, data_root, output_root, current, pending) {
            warn!("failed to append job event for {}: {}", current.job_id, err);
        }
    }
}

fn append_pending_event(
    db: &Db,
    data_root: &Path,
    output_root: &Path,
    job: &JobSnapshot,
    pending: PendingJobEvent,
) -> Result<JobEventRecord> {
    let event = db.append_event(
        &job.job_id,
        &pending.level,
        pending.stage.clone(),
        pending.stage_detail.clone(),
        pending.provider.clone(),
        pending.provider_stage.clone(),
        &pending.event,
        Some(pending.event.clone()),
        &pending.message,
        pending.progress_current,
        pending.progress_total,
        pending.payload.clone(),
        pending.retry_count,
        pending.elapsed_ms,
    )?;
    let event = JobEventRecord {
        user_stage: pending
            .user_stage
            .clone()
            .map(normalize_user_stage)
            .or_else(|| user_stage_for_event(event.stage.as_deref())),
        substage: pending
            .substage
            .clone()
            .or_else(|| event.provider_stage.clone()),
        progress_unit: pending
            .progress_unit
            .clone()
            .or_else(|| progress_unit_for_event(event.stage.as_deref(), &event.event)),
        ..event
    };
    append_event_jsonl(data_root, output_root, job, &event)?;
    Ok(event)
}
