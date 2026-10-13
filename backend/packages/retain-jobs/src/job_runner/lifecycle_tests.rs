use super::*;
use crate::models::request::CreateJobInput;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::sync::Notify;

struct Fixture {
    deps: ProcessRuntimeDeps,
    root: std::path::PathBuf,
}
impl Fixture {
    fn new(slots: usize) -> Self {
        let deps = super::super::process_runner::tests::test_runtime_deps(slots);
        let root = deps.config.project_root.clone();
        Self { deps, root }
    }
    fn job(&self, id: &str, status: JobStatusKind) -> JobSnapshot {
        let mut job = JobSnapshot::new(
            id.into(),
            CreateJobInput::default(),
            vec!["fake-worker".into()],
        );
        job.status = status;
        self.deps.db.save_job(&job).unwrap();
        job
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

async fn succeeded(_: ProcessRuntimeDeps, mut job: JobRuntimeState) -> Result<JobRuntimeState> {
    job.status = JobStatusKind::Succeeded;
    Ok(job)
}

#[test]
fn workflow_dispatch_does_not_embed_large_pipeline_futures() {
    fn future_size<F, Fut>(_: F) -> usize
    where
        F: FnOnce(ProcessRuntimeDeps, JobRuntimeState) -> Fut,
        Fut: std::future::Future<Output = Result<JobRuntimeState>>,
    {
        std::mem::size_of::<Fut>()
    }
    let size = future_size(dispatch_workflow);
    assert!(
        size <= 64 * 1024,
        "workflow dispatcher retains {size} bytes; pipeline branches must be heap-pinned"
    );
}

#[tokio::test]
async fn repeated_launch_has_one_driver_even_while_queued() {
    let fixture = Fixture::new(1);
    fixture.job("same", JobStatusKind::Queued);
    let permit = fixture
        .deps
        .job_slots
        .clone()
        .acquire_owned()
        .await
        .unwrap();
    let count = Arc::new(AtomicUsize::new(0));
    let worker_count = count.clone();
    let handle = spawn_job_with_workflow(
        fixture.deps.clone(),
        "same".into(),
        move |deps, job| async move {
            worker_count.fetch_add(1, Ordering::SeqCst);
            succeeded(deps, job).await
        },
    )
    .unwrap();
    for _ in 0..100 {
        assert!(spawn_job_with_workflow(fixture.deps.clone(), "same".into(), succeeded).is_none());
    }
    assert_eq!(count.load(Ordering::SeqCst), 0);
    drop(permit);
    handle.await.unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 1);
    assert!(fixture.deps.job_drivers.claim("same").is_some());
}

#[tokio::test]
async fn terminal_launch_never_dispatches_or_changes_snapshot() {
    let fixture = Fixture::new(1);
    for (id, status) in [
        ("done", JobStatusKind::Succeeded),
        ("failed", JobStatusKind::Failed),
        ("cancel", JobStatusKind::Canceled),
    ] {
        fixture.job(id, status);
        let before = serde_json::to_value(fixture.deps.db.get_job(id).unwrap()).unwrap();
        spawn_job_with_workflow(fixture.deps.clone(), id.into(), |_, _| async {
            panic!("terminal job dispatched");
            #[allow(unreachable_code)]
            Ok(unreachable!())
        })
        .unwrap()
        .await
        .unwrap();
        assert_eq!(
            serde_json::to_value(fixture.deps.db.get_job(id).unwrap()).unwrap(),
            before
        );
    }
}

#[tokio::test]
async fn canceled_stale_snapshot_rejects_queue_cas_and_dispatch() {
    let fixture = Fixture::new(1);
    let mut stale = fixture.job("race", JobStatusKind::Queued);
    fixture.job("race", JobStatusKind::Canceled);
    assert!(!persist_queued_job(&fixture.deps, &mut stale).unwrap());
    assert_eq!(
        fixture.deps.db.get_job("race").unwrap().status,
        JobStatusKind::Canceled
    );
    run_job(fixture.deps.clone(), "race".into(), |_, _| async {
        panic!("canceled job dispatched");
        #[allow(unreachable_code)]
        Ok(unreachable!())
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn two_jobs_share_slot_limit_and_waiting_cancel_never_dispatches() {
    let fixture = Fixture::new(1);
    fixture.job("first", JobStatusKind::Queued);
    fixture.job("second", JobStatusKind::Queued);
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let (worker_entered, worker_release) = (entered.clone(), release.clone());
    let first = spawn_job_with_workflow(
        fixture.deps.clone(),
        "first".into(),
        move |deps, job| async move {
            worker_entered.notify_one();
            worker_release.notified().await;
            succeeded(deps, job).await
        },
    )
    .unwrap();
    entered.notified().await;
    let second = spawn_job_with_workflow(fixture.deps.clone(), "second".into(), |_, _| async {
        panic!("waiting canceled job dispatched");
        #[allow(unreachable_code)]
        Ok(unreachable!())
    })
    .unwrap();
    tokio::task::yield_now().await;
    assert_eq!(fixture.deps.job_slots.available_permits(), 0);
    fixture.job("second", JobStatusKind::Canceled);
    second.await.unwrap();
    release.notify_one();
    first.await.unwrap();
    assert_eq!(fixture.deps.job_slots.available_permits(), 1);
}

#[tokio::test]
async fn failure_and_abort_release_driver_ownership() {
    let fixture = Fixture::new(1);
    fixture.job("error", JobStatusKind::Queued);
    spawn_job_with_workflow(fixture.deps.clone(), "error".into(), |_, _| async {
        anyhow::bail!("synthetic failure")
    })
    .unwrap()
    .await
    .unwrap();
    assert_eq!(
        fixture.deps.db.get_job("error").unwrap().status,
        JobStatusKind::Failed
    );
    assert!(fixture.deps.job_drivers.claim("error").is_some());
    fixture.job("abort", JobStatusKind::Queued);
    let handle = spawn_job_with_workflow(fixture.deps.clone(), "abort".into(), |_, _| async {
        std::future::pending().await
    })
    .unwrap();
    handle.abort();
    assert!(handle.await.unwrap_err().is_cancelled());
    assert!(fixture.deps.job_drivers.claim("abort").is_some());
}

#[tokio::test]
async fn repeated_launch_starts_only_one_real_local_worker() {
    let fixture = Fixture::new(1);
    let marker = fixture.root.join("worker-starts.txt");
    let mut job = fixture.job("real-worker", JobStatusKind::Queued);
    job.command = vec![
        "python3".into(),
        "-c".into(),
        "import pathlib,sys; p=pathlib.Path(sys.argv[1]); p.open('a').write('started\\n')".into(),
        marker.to_string_lossy().into_owned(),
    ];
    fixture.deps.db.save_job(&job).unwrap();
    let handle = spawn_job_with_workflow(
        fixture.deps.clone(),
        job.job_id.clone(),
        |deps, job| async move {
            super::super::process_runner::execute_process_job(deps, job, &[]).await
        },
    )
    .unwrap();
    for _ in 0..100 {
        assert!(
            spawn_job_with_workflow(fixture.deps.clone(), job.job_id.clone(), succeeded).is_none()
        );
    }
    handle.await.unwrap();
    assert_eq!(std::fs::read_to_string(marker).unwrap(), "started\n");
    assert_eq!(
        fixture.deps.db.get_job(&job.job_id).unwrap().status,
        JobStatusKind::Succeeded
    );
}

/// 取消标记在队列门被消费掉之后，任务必须落终态，不能挂着。
///
/// `wait_for_execution_slot` 命中标记会清掉它并返回 None，driver 随即退出。
/// 正常取消路径靠 `cancel_job` 紧接着的 CAS 写兜底，但 `cancel_job(ocr_only=true)`
/// 在 `stage != "queued"` 时一个字都不写 DB——于是没人收尾，任务永久卡在
/// queued/running 且再无 driver 驱动，用户看到永久转圈、连重跑都点不了。
///
/// 反证方式：把 `run_job` 里 `None => { persist_canceled_job(..)?; .. }` 退回
/// `None => return Ok(())`，这个测试必须变红——行会停在 Queued。
#[tokio::test]
async fn consumed_cancel_flag_still_lands_a_terminal_state() {
    let fx = Fixture::new(1);
    let job = fx.job("job-consumed-flag", JobStatusKind::Queued);

    // 模拟 cancel_job(ocr_only=true) + stage != "queued"：只塞注册表，不写 DB。
    super::super::cancel_registry::request_cancel_with_registry(
        fx.deps.canceled_jobs.as_ref(),
        &job.job_id,
    )
    .await;

    let handle = spawn_job_with_workflow(fx.deps.clone(), job.job_id.clone(), succeeded);
    if let Some(h) = handle {
        let _ = h.await;
    }

    let after = fx.deps.db.get_job(&job.job_id).unwrap();
    assert_eq!(
        after.status,
        JobStatusKind::Canceled,
        "取消标记被队列门消费掉之后，必须有人落终态；停在 {:?} 就是永久挂起",
        after.status
    );
    assert!(
        !super::super::cancel_registry::is_cancel_requested_with_registry(
            fx.deps.canceled_jobs.as_ref(),
            &job.job_id,
        )
        .await,
        "标记应当已被清除"
    );
}

/// 取消在「等待执行槽位」期间到达时，同样必须落终态。
///
/// 这条走的是 `wait_for_execution_slot` 里的取消分支，和上面那个测试不是同一处出口：
/// `should_skip_job_execution` 在 job 启动的一瞬间只查一次，之后 job 可能在队列里
/// 等很久，取消完全可能落在这段窗口里。队列门命中标记后同样会**清掉标记并返回
/// None**，若无人收尾，任务就永久挂着。
///
/// 做法：先把唯一的槽位占掉，让 job 卡在轮询循环里，再塞取消标记。
///
/// 反证方式：把 `run_job` 里 `None => { persist_canceled_job(..)?; .. }` 退回
/// `None => return Ok(())`，这个测试必须变红。
#[tokio::test]
async fn cancel_while_waiting_for_a_slot_still_lands_a_terminal_state() {
    let fx = Fixture::new(1);
    let job = fx.job("job-canceled-in-queue", JobStatusKind::Queued);

    // 占住唯一的槽位，逼 job 停在 wait_for_execution_slot 的轮询里。
    let hold = fx.deps.job_slots.clone().acquire_owned().await.unwrap();

    let handle = spawn_job_with_workflow(fx.deps.clone(), job.job_id.clone(), succeeded);

    // 让它先跑过 should_skip_job_execution，确保确实是在队列门里等。
    tokio::time::sleep(std::time::Duration::from_millis(60)).await;
    assert_eq!(
        fx.deps.db.get_job(&job.job_id).unwrap().status,
        JobStatusKind::Queued,
        "此刻应当已经进入排队状态"
    );

    super::super::cancel_registry::request_cancel_with_registry(
        fx.deps.canceled_jobs.as_ref(),
        &job.job_id,
    )
    .await;

    if let Some(h) = handle {
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), h).await;
    }
    drop(hold);

    let after = fx.deps.db.get_job(&job.job_id).unwrap();
    assert_eq!(
        after.status,
        JobStatusKind::Canceled,
        "队列门消费掉标记之后必须落终态；停在 {:?} 就是永久挂起",
        after.status
    );
}

// ── 任务成功后 active_job_id 换不换 ────────────────────────────────────────

fn seed_document(fx: &Fixture) -> String {
    let upload = crate::models::domain::UploadRecord {
        upload_id: "up-1".into(),
        filename: "book.pdf".into(),
        stored_path: "uploads/up-1/book.pdf".into(),
        bytes: 1,
        page_count: 10,
        uploaded_at: crate::models::domain::now_iso(),
        developer_mode: false,
        content_hash: "d".repeat(64),
    };
    fx.deps.db.save_upload(&upload).unwrap();
    fx.deps.db.upsert_document_from_upload(&upload).unwrap();
    "d".repeat(64)
}

fn document_job(fx: &Fixture, id: &str, created_at: &str, workflow: WorkflowKind, status: JobStatusKind) -> JobSnapshot {
    let mut job = JobSnapshot::new(id.into(), CreateJobInput::default(), vec!["fake-worker".into()]);
    job.status = status;
    job.workflow = workflow;
    job.created_at = created_at.into();
    job.upload_id = Some("up-1".into());
    fx.deps.db.save_job(&job).unwrap();
    fx.deps.db.link_job_to_document(id, "up-1").unwrap();
    job
}

fn active(fx: &Fixture, document_id: &str) -> Option<String> {
    fx.deps.db.get_document(document_id).unwrap().active_job_id
}

#[test]
fn an_older_job_finishing_while_a_newer_one_runs_keeps_the_newer_on_the_card() {
    // 先提交 1-5 页（old），再提交 6-10 页（new）。new 提交时指针给了它；old 先完成。
    let fx = Fixture::new(1);
    let document_id = seed_document(&fx);
    let old = document_job(&fx, "old", "2026-10-01T00:00:00", WorkflowKind::Book, JobStatusKind::Succeeded);
    document_job(&fx, "new", "2026-10-02T00:00:00", WorkflowKind::Book, JobStatusKind::Running);
    fx.deps.db.set_document_active_job(&document_id, "new", None).unwrap();

    update_document_after_job(&fx.deps, &old.into_runtime());

    assert_eq!(active(&fx, &document_id).as_deref(), Some("new"), "旧任务后完成，把正在跑的新任务顶掉了");
}

#[test]
fn an_ocr_job_finishing_does_not_hide_the_translation_from_the_card() {
    let fx = Fixture::new(1);
    let document_id = seed_document(&fx);
    document_job(&fx, "translation", "2026-10-01T00:00:00", WorkflowKind::Book, JobStatusKind::Succeeded);
    let ocr = document_job(&fx, "ocr", "2026-10-02T00:00:00", WorkflowKind::Ocr, JobStatusKind::Succeeded);
    fx.deps.db.set_document_active_job(&document_id, "ocr", None).unwrap();

    update_document_after_job(&fx.deps, &ocr.into_runtime());

    assert_eq!(active(&fx, &document_id).as_deref(), Some("translation"));
}

#[test]
fn a_newer_job_finishing_takes_the_card_as_before() {
    let fx = Fixture::new(1);
    let document_id = seed_document(&fx);
    document_job(&fx, "old", "2026-10-01T00:00:00", WorkflowKind::Book, JobStatusKind::Succeeded);
    let new = document_job(&fx, "new", "2026-10-02T00:00:00", WorkflowKind::Book, JobStatusKind::Succeeded);
    fx.deps.db.set_document_active_job(&document_id, "old", None).unwrap();

    update_document_after_job(&fx.deps, &new.into_runtime());

    assert_eq!(active(&fx, &document_id).as_deref(), Some("new"));
}

// ── 没有 upload_id 的派生任务（重新渲染 / 重试 / 继续）结束后的维护 ──────────────

/// 派生任务只带 artifact_job_id；提交时已经继承了 jobs.document_id（job_launcher）。
fn derived_job(fx: &Fixture, document_id: &str, id: &str, created_at: &str, status: JobStatusKind) -> JobSnapshot {
    let mut job = JobSnapshot::new(id.into(), CreateJobInput::default(), vec!["fake-worker".into()]);
    job.status = status;
    job.workflow = WorkflowKind::Render;
    job.created_at = created_at.into();
    job.upload_id = None;
    job.request_payload.source.artifact_job_id = "old".into();
    fx.deps.db.save_job(&job).unwrap();
    fx.deps.db.set_job_document_id(id, document_id).unwrap();
    job
}

#[test]
fn a_derived_job_without_upload_id_still_takes_the_card_and_rebuilds_the_index() {
    let fx = Fixture::new(1);
    let document_id = seed_document(&fx);
    document_job(&fx, "old", "2026-10-01T00:00:00", WorkflowKind::Book, JobStatusKind::Succeeded);
    fx.deps.db.set_document_active_job(&document_id, "old", None).unwrap();
    // 旧任务留下的索引行：派生任务成功后必须按整本书重建（这里没有产物文件，重建后为空）。
    fx.deps
        .db
        .replace_document_fts(
            &document_id,
            "old",
            &[crate::models::api::FtsBlockRow {
                page_idx: 0,
                block_id: "p001-b0000".into(),
                source_text: "stale source".into(),
                translated_text: "过期的旧索引".into(),
            }],
        )
        .unwrap();
    let render = derived_job(&fx, &document_id, "render", "2026-10-02T00:00:00", JobStatusKind::Succeeded);

    update_document_after_job(&fx.deps, &render.into_runtime());

    assert_eq!(active(&fx, &document_id).as_deref(), Some("render"), "没有 upload_id 的任务成功后没纠正书卡");
    assert!(
        fx.deps.db.search_blocks("过期的旧索引", 10, None).unwrap().is_empty(),
        "没有 upload_id 的任务成功后没重建全文索引"
    );
}

#[tokio::test]
async fn a_failed_derived_job_hands_the_card_back_to_the_last_success() {
    let fx = Fixture::new(1);
    let document_id = seed_document(&fx);
    let mut old = document_job(&fx, "old", "2026-10-01T00:00:00", WorkflowKind::Book, JobStatusKind::Succeeded);
    old.finished_at = Some("2026-10-01T01:00:00".into());
    fx.deps.db.save_job(&old).unwrap();

    // 1) workflow 正常返回 Failed（run_job 的出口）。
    let failed = derived_job(&fx, &document_id, "retry-a", "2026-10-02T00:00:00", JobStatusKind::Failed);
    fx.deps.db.set_document_active_job(&document_id, "retry-a", None).unwrap();
    update_document_after_job(&fx.deps, &failed.into_runtime());
    assert_eq!(active(&fx, &document_id).as_deref(), Some("old"), "失败的重试把书卡留在了失败任务上");

    // 2) workflow 报错（spawn_job_with_workflow → persist_failed_job 的出口）。
    derived_job(&fx, &document_id, "retry-b", "2026-10-03T00:00:00", JobStatusKind::Queued);
    fx.deps.db.set_document_active_job(&document_id, "retry-b", None).unwrap();
    spawn_job_with_workflow(fx.deps.clone(), "retry-b".into(), |_, _| async {
        anyhow::bail!("synthetic failure")
    })
    .unwrap()
    .await
    .unwrap();
    assert_eq!(fx.deps.db.get_job("retry-b").unwrap().status, JobStatusKind::Failed);
    assert_eq!(active(&fx, &document_id).as_deref(), Some("old"), "报错退出的重试把书卡留在了失败任务上");

    // 3) 指针已被别的任务接走时不动。
    derived_job(&fx, &document_id, "retry-c", "2026-10-04T00:00:00", JobStatusKind::Failed);
    derived_job(&fx, &document_id, "newer", "2026-10-05T00:00:00", JobStatusKind::Running);
    fx.deps.db.set_document_active_job(&document_id, "newer", None).unwrap();
    update_document_after_job(&fx.deps, &fx.deps.db.get_job("retry-c").unwrap().into_runtime());
    assert_eq!(active(&fx, &document_id).as_deref(), Some("newer"));
}

/// 经 API 取消已过排队阶段的 OCR 任务时 API 不写 DB,由 runner 的取消检查点自己落 Canceled;
/// driver 最后的 CAS 没更新就退出 —— 以前这里不碰书卡,书卡停在被取消的任务上。
#[tokio::test]
async fn a_job_canceled_by_its_own_runner_checkpoint_hands_the_card_back() {
    let fx = Fixture::new(1);
    let document_id = seed_document(&fx);
    let mut old = document_job(&fx, "old", "2026-10-01T00:00:00", WorkflowKind::Book, JobStatusKind::Succeeded);
    old.finished_at = Some("2026-10-01T01:00:00".into());
    fx.deps.db.save_job(&old).unwrap();
    derived_job(&fx, &document_id, "ocr-redo", "2026-10-02T00:00:00", JobStatusKind::Queued);
    fx.deps.db.set_document_active_job(&document_id, "ocr-redo", None).unwrap();

    spawn_job_with_workflow(fx.deps.clone(), "ocr-redo".into(), |deps, mut job| async move {
        // runner 的取消检查点:自己 CAS 落 Canceled,再把同样的终态返回给 driver。
        job.status = JobStatusKind::Canceled;
        job.stage = Some("canceled".into());
        assert!(cas_persist_job_with_resources(
            deps.db.as_ref(),
            &deps.persist.data_root,
            &deps.persist.output_root,
            &job.snapshot(),
            &["queued", "running"],
        )?);
        Ok(job)
    })
    .unwrap()
    .await
    .unwrap();

    assert_eq!(fx.deps.db.get_job("ocr-redo").unwrap().status, JobStatusKind::Canceled);
    assert_eq!(
        active(&fx, &document_id).as_deref(),
        Some("old"),
        "runner 自己落定的取消没有把书卡退回上一个成功任务"
    );
}
