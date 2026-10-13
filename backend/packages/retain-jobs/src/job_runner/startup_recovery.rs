use anyhow::Result;
use std::path::Path;
use tracing::warn;

use crate::config::AppConfig;
use crate::db::Db;
use crate::job_events::persist_job_with_resources;
use crate::models::domain::{now_iso, JobFailureInfo, JobStatusKind};

use super::worker_process::{terminate_job_process_tree_blocking, worker_process_exists};

/// Why a `Running`-status job found when its owning runtime starts is being reconciled.
enum StaleReason {
    /// No pid was ever recorded for this job.
    NoPid,
    /// The recorded pid is no longer alive.
    Dead(u32),
    /// The recorded pid is still alive, but the owning runtime restarted and
    /// can no longer consume its stdout or mark it finished.
    Orphaned(u32),
}

/// Reconcile workers only when the process that owns the runtime starts.
///
/// InProcess mode calls this from the HTTP shell. Remote mode calls it from
/// retain-jobsd. The shell must never call it for jobsd-owned workers.
pub fn reconcile_stale_running_jobs(config: &AppConfig, db: &Db) -> Result<usize> {
    let running_jobs = db.list_job_process_records_with_status(&JobStatusKind::Running)?;
    let mut reconciled = 0usize;
    for job_record in running_jobs {
        let reason = match job_record.pid {
            Some(pid) if worker_process_exists(pid) => StaleReason::Orphaned(pid),
            Some(pid) => StaleReason::Dead(pid),
            None => StaleReason::NoPid,
        };

        if let StaleReason::Orphaned(pid) = reason {
            warn!(
                "runtime startup found live orphaned worker process pid={pid} for job {} still running; terminating its process tree before recovering job state",
                job_record.job_id
            );
            if let Err(error) = terminate_job_process_tree_blocking(
                pid,
                config.job_runner.worker_terminate_grace_secs,
                config.job_runner.worker_terminate_poll_ms,
            ) {
                warn!(
                    "failed to terminate orphaned worker process pid={pid} for job {}: {error:#}",
                    job_record.job_id
                );
            }
        }

        let (detail, failure_category, failure_code) = match reason {
            StaleReason::Orphaned(pid) => (
                format!(
                    "任务运行时启动时发现遗留 running 任务，worker 进程 {pid} 仍在运行（孤儿进程），已终止该进程"
                ),
                "worker_orphaned_after_restart",
                "worker_orphaned_after_restart",
            ),
            StaleReason::Dead(pid) => (
                format!("任务运行时启动时发现遗留 running 任务，但 worker 进程 {pid} 已不存在"),
                "worker_process_missing",
                "worker_process_missing",
            ),
            StaleReason::NoPid => (
                "任务运行时启动时发现遗留 running 任务，但未记录 worker pid".to_string(),
                "worker_process_missing",
                "worker_process_missing",
            ),
        };
        let timestamp = now_iso();
        let resumable = db.has_running_pipeline_attempt(&job_record.job_id)?;
        match db.get_job(&job_record.job_id) {
            Ok(mut job) => {
                job.updated_at = timestamp.clone();
                job.pid = None;
                let committed_render_output = restore_committed_render_output(
                    &mut job,
                    committed_render_output_path(db, &job_record.job_id)?,
                );
                if committed_render_output {
                    job.append_log(&format!("WARN: {detail}"));
                    job.append_log(
                        "INFO: committed render output recovered; task completed without rerender",
                    );
                    job.status = JobStatusKind::Succeeded;
                    job.stage = Some("finished".to_string());
                    job.stage_detail =
                        Some("runtime restart recovered committed render output".to_string());
                    job.error = None;
                    job.finished_at = Some(timestamp.clone());
                    job.replace_failure_info(None);
                } else if resumable {
                    job.append_log(&format!("WARN: {detail}"));
                    job.append_log(
                        "INFO: durable pipeline checkpoint found; job requeued for automatic resume",
                    );
                    job.status = JobStatusKind::Queued;
                    job.stage_detail = Some(
                        "runtime restart recovered durable checkpoint; waiting to resume"
                            .to_string(),
                    );
                    job.error = None;
                    job.finished_at = None;
                    job.replace_failure_info(None);
                } else {
                    job.append_log(&format!("ERROR: {detail}"));
                    job.status = JobStatusKind::Failed;
                    job.stage = Some("failed".to_string());
                    job.stage_detail =
                        Some("runtime startup stale running job recovered".to_string());
                    job.error = Some(detail.clone());
                    job.finished_at = Some(timestamp.clone());
                    // 查目录而不是写死:新增失败类型只该改 job_failure_catalogue 一处。
                    let recovery =
                        retain_core::job_failure_catalogue::recovery_for(failure_category);
                    job.replace_failure_info(Some(JobFailureInfo {
                        stage: "startup_recovery".to_string(),
                        category: failure_category.to_string(),
                        code: None,
                        failed_stage: Some("startup_recovery".to_string()),
                        failure_code: Some(failure_code.to_string()),
                        failure_category: Some("internal".to_string()),
                        provider_stage: None,
                        provider_code: None,
                        summary: "任务运行时启动时回收了遗留 running 任务".to_string(),
                        root_cause: Some(detail.clone()),
                        retryable: true,
                        upstream_host: None,
                        provider: None,
                        suggestion: Some(
                            "该任务对应的 worker 已不在运行；请重新提交或手动重试".to_string(),
                        ),
                        last_log_line: Some(detail.clone()),
                        raw_excerpt: Some(detail.clone()),
                        raw_error_excerpt: Some(detail.clone()),
                        raw_diagnostic: None,
                        ai_diagnostic: None,
                        resume_from: recovery.resume_from.map(|s| s.as_str().to_string()),
                        recovery_hint: Some(recovery.hint.to_string()),
                    }));
                }
                job.sync_runtime_state();
                persist_job_with_resources(db, &config.data_root, &config.output_root, &job)?;
                if committed_render_output {
                    db.finish_latest_pipeline_attempt(&job_record.job_id, "succeeded")?;
                }
            }
            Err(error) => {
                warn!(
                    "runtime startup reconciliation fell back to raw DB recovery for {}: {}",
                    job_record.job_id, error
                );
                db.recover_stale_running_job(&job_record.job_id, &detail, &timestamp)?;
            }
        }
        reconciled += 1;
        warn!(
            "recovered stale running job during runtime startup: {} resumable={resumable}",
            job_record.job_id
        );
    }
    if reconciled > 0 {
        warn!("runtime startup reconciliation recovered {reconciled} stale running job(s)");
    }
    // 放在上面的循环之后：那一轮会把当时在跑的父任务判成 queued（随后恢复）或 failed，
    // 判完再看哪些子任务的父任务已经终态。
    settle_orphaned_ocr_children(config, db)?;
    Ok(reconciled)
}

/// 父任务已终态的 OCR 子任务一次性落终态，并收尾悬空的 pipeline attempt。
///
/// 历史上子任务的 attempt 从没人收尾（只有顶层 driver 收尾自己的），于是子任务行可能
/// 已经 succeeded/failed 而 attempt 还 running；子任务跑着时重启，又会被上面的循环改回
/// queued、被恢复查询排除，永远卡住；父任务在建子任务的窗口被取消，子任务行留在 queued。
/// 父任务都结束了，不会再有人推进这些子任务：
/// - 行还在 queued/running：父任务取消 → canceled，其余 → failed；
/// - 然后按行的终态收尾 attempt（已经终态的行只收尾 attempt，状态不动）。
fn settle_orphaned_ocr_children(config: &AppConfig, db: &Db) -> Result<usize> {
    let children = db.list_unsettled_ocr_children()?;
    for (child_id, parent_status) in &children {
        let mut child = match db.get_job(child_id) {
            Ok(child) => child,
            Err(error) => {
                warn!("runtime startup failed to load orphaned ocr child {child_id}: {error:#}");
                continue;
            }
        };
        if matches!(child.status, JobStatusKind::Queued | JobStatusKind::Running) {
            let timestamp = now_iso();
            let canceled = *parent_status == JobStatusKind::Canceled;
            let detail = if canceled {
                "父任务已取消，OCR 子任务随之取消（启动时收尾）"
            } else {
                "父任务已结束而 OCR 子任务未收尾（启动时收尾）"
            };
            child.status = if canceled {
                JobStatusKind::Canceled
            } else {
                JobStatusKind::Failed
            };
            child.stage = Some(if canceled { "canceled" } else { "failed" }.to_string());
            child.stage_detail = Some(detail.to_string());
            child.error = (!canceled).then(|| detail.to_string());
            child.pid = None;
            child.updated_at = timestamp.clone();
            child.finished_at = Some(timestamp);
            child.append_log(&format!("WARN: {detail}"));
            child.sync_runtime_state();
            persist_job_with_resources(db, &config.data_root, &config.output_root, &child)?;
        }
        let status = match child.status {
            JobStatusKind::Succeeded => "succeeded",
            JobStatusKind::Canceled => "canceled",
            _ => "failed",
        };
        db.finish_latest_pipeline_attempt(child_id, status)?;
    }
    if !children.is_empty() {
        warn!(
            "runtime startup settled {} orphaned OCR child job(s) whose parent already finished",
            children.len()
        );
    }
    Ok(children.len())
}

/// Re-drive queued jobs that never started a durable attempt.
///
/// Startup-only contract (see `Db::list_stuck_queued_job_ids`): right after
/// a runtime (re)start no driver task owns any queued job, so re-driving is
/// safe. Jobs with a running attempt are excluded here; they resume through
/// `list_resumable_pipeline_job_ids` instead, so the two paths never
/// double-drive the same job.
pub fn requeue_stuck_queued_jobs(config: &AppConfig, db: &Db) -> Result<Vec<String>> {
    let stuck = db.list_stuck_queued_job_ids()?;
    let timestamp = now_iso();
    for job_id in &stuck {
        match db.get_job(job_id) {
            Ok(mut job) => {
                job.updated_at = timestamp.clone();
                job.stage_detail = Some(
                    "runtime startup requeued stuck queued job for automatic resume".to_string(),
                );
                job.append_log(
                    "WARN: runtime startup found queued job with no driver; requeued for automatic resume",
                );
                job.sync_runtime_state();
                if let Err(error) =
                    persist_job_with_resources(db, &config.data_root, &config.output_root, &job)
                {
                    warn!("runtime startup failed to mark requeued job {job_id}: {error:#}");
                }
            }
            Err(error) => {
                warn!("runtime startup found stuck queued job {job_id} but failed to load it: {error:#}");
            }
        }
        warn!("runtime startup requeued stuck queued job {job_id}");
    }
    if !stuck.is_empty() {
        warn!(
            "runtime startup reconciliation requeued {} stuck queued job(s)",
            stuck.len()
        );
    }
    Ok(stuck)
}

fn committed_render_output_path(db: &Db, job_id: &str) -> Result<Option<String>> {
    let Some(stage) = db.running_pipeline_stage_state(job_id)? else {
        return Ok(None);
    };
    if stage.stage_key != "render" || stage.status != "completed" {
        return Ok(None);
    }
    let units = db.list_pipeline_units(job_id, stage.attempt, "render")?;
    Ok(units.into_iter().rev().find_map(|unit| {
        (unit.unit_key == "output-pdf"
            && unit
                .payload
                .get("unit_kind")
                .and_then(serde_json::Value::as_str)
                == Some("render_output"))
        .then(|| {
            unit.payload
                .get("path")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        })
        .flatten()
    }))
}

fn restore_committed_render_output(
    job: &mut crate::models::domain::JobSnapshot,
    committed_output_path: Option<String>,
) -> bool {
    let Some(output_path) = committed_output_path else {
        return false;
    };
    job.artifacts
        .get_or_insert_with(Default::default)
        .output_pdf = Some(output_path);
    render_artifacts_are_ready(job)
}

fn render_artifacts_are_ready(job: &crate::models::domain::JobSnapshot) -> bool {
    let Some(artifacts) = job.artifacts.as_ref() else {
        return false;
    };
    let outputs = artifacts.render_outputs();
    outputs
        .output_pdf
        .as_deref()
        .map(Path::new)
        .is_some_and(Path::is_file)
        && outputs
            .summary
            .as_deref()
            .map(Path::new)
            .is_some_and(Path::is_file)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::{render_artifacts_are_ready, restore_committed_render_output};
    use crate::models::domain::JobSnapshot;
    use crate::models::request::CreateJobInput;

    #[test]
    fn committed_render_recovery_requires_output_and_summary_files() {
        let root = std::env::temp_dir().join(format!(
            "retain-render-recovery-{}-{}",
            std::process::id(),
            fastrand::u64(..)
        ));
        fs::create_dir_all(&root).expect("fixture root");
        let output = root.join("output.pdf");
        let summary = root.join("pipeline_summary.json");
        let mut job = JobSnapshot::new(
            "job-1".to_string(),
            CreateJobInput::default(),
            vec!["python".to_string()],
        );
        let artifacts = job.artifacts.get_or_insert_with(Default::default);
        artifacts.output_pdf = Some(output.to_string_lossy().into_owned());
        artifacts.summary = Some(summary.to_string_lossy().into_owned());

        fs::write(&output, b"pdf").expect("output");
        assert!(!render_artifacts_are_ready(&job));
        fs::write(&summary, b"{}").expect("summary");
        assert!(render_artifacts_are_ready(&job));

        job.artifacts.as_mut().expect("artifacts").output_pdf = None;
        assert!(restore_committed_render_output(
            &mut job,
            Some(output.to_string_lossy().into_owned())
        ));
        assert_eq!(
            job.artifacts
                .as_ref()
                .and_then(|artifacts| artifacts.output_pdf.as_deref()),
            Some(output.to_string_lossy().as_ref())
        );

        let _ = fs::remove_dir_all(root);
    }

    fn save(db: &crate::db::Db, id: &str, status: crate::models::domain::JobStatusKind) {
        let mut job = JobSnapshot::new(id.to_string(), CreateJobInput::default(), vec![]);
        job.status = status;
        db.save_job(&job).expect("save job");
    }

    /// 父任务已终态的 OCR 子任务，启动时必须落终态、收尾悬空 attempt。
    ///
    /// 数据库拷贝上的现状：pipeline_attempts 里 31 条 running 全是 `-ocr` 子任务（25 个行已
    /// succeeded、6 个 failed），父任务全部终态 —— 子任务的 attempt 从没人收尾。
    #[test]
    fn startup_settles_ocr_children_whose_parent_already_finished() {
        use crate::models::domain::JobStatusKind::*;
        let deps = crate::job_runner::process_runner::tests::test_runtime_deps(1);
        let db = deps.db.as_ref();
        let running_attempt = |id: &str| db.has_running_pipeline_attempt(id).unwrap();

        // 行已 succeeded、attempt 还 running（历史残留的主体）。
        save(db, "p-done", Succeeded);
        save(db, "p-done-ocr", Succeeded);
        db.acquire_pipeline_attempt("p-done-ocr", "native-ocr:1:p-done-ocr", "ocr", 0).unwrap();
        // 父任务失败，子任务跑到一半（重启前）：行 running、attempt running。
        save(db, "p-failed", Failed);
        save(db, "p-failed-ocr", Running);
        db.acquire_pipeline_attempt("p-failed-ocr", "native-ocr:1:p-failed-ocr", "ocr", 0).unwrap();
        // 父任务在建子任务的窗口里被取消：子任务行留在 queued、没有 attempt。
        save(db, "p-canceled", Canceled);
        save(db, "p-canceled-ocr", Queued);
        // 父任务还会恢复：子任务不碰。
        save(db, "p-queued", Queued);
        save(db, "p-queued-ocr", Queued);
        db.acquire_pipeline_attempt("p-queued-ocr", "native-ocr:1:p-queued-ocr", "ocr", 0).unwrap();
        // 名字碰巧以 -ocr 结尾的独立任务：没有父任务，不碰。
        save(db, "solo-ocr", Queued);

        super::reconcile_stale_running_jobs(&deps.config, db).expect("startup recovery");

        assert!(!running_attempt("p-done-ocr"), "已成功的子任务 attempt 仍是 running");
        assert_eq!(db.get_job("p-done-ocr").unwrap().status, Succeeded, "已终态的子任务状态不该变");
        assert_eq!(db.get_job("p-failed-ocr").unwrap().status, Failed);
        assert!(!running_attempt("p-failed-ocr"));
        assert_eq!(db.get_job("p-canceled-ocr").unwrap().status, Canceled);
        assert!(running_attempt("p-queued-ocr"), "父任务还会恢复，子任务 attempt 不能动");
        assert_eq!(db.get_job("p-queued-ocr").unwrap().status, Queued);
        assert_eq!(db.get_job("solo-ocr").unwrap().status, Queued);

        // 幂等：再启动一次什么都不剩。
        assert!(db.list_unsettled_ocr_children().unwrap().is_empty());
    }
}
