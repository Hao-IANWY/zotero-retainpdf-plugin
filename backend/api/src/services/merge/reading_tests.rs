use super::*;
use crate::models::request::CreateJobInput;

fn job_page(id: &str, local: usize) -> PageSource {
    PageSource::Job { job_id: id.to_string(), local_index: local }
}

#[test]
fn a_single_job_covering_the_whole_document_in_order_is_opened_directly() {
    let plan = [job_page("a", 0), job_page("a", 1), job_page("a", 2)];
    assert_eq!(single_whole_document_job(&plan), Some("a"));
}

#[test]
fn anything_short_of_one_whole_document_job_needs_a_merge() {
    // 单个任务只覆盖一部分：它的 PDF 只有那几页，对照模式会错页 —— 也要合并。
    assert_eq!(single_whole_document_job(&[job_page("a", 0), PageSource::Original]), None);
    assert_eq!(single_whole_document_job(&[PageSource::Original, job_page("a", 0)]), None);
    // 两个任务。
    assert_eq!(single_whole_document_job(&[job_page("a", 0), job_page("b", 0)]), None);
    // 一个任务但顺序不对（不会真的发生，但不能当成整本直接打开）。
    assert_eq!(single_whole_document_job(&[job_page("a", 1), job_page("a", 0)]), None);
    assert_eq!(single_whole_document_job(&[]), None);
}

fn snapshot(job_id: &str, created_at: &str, job_root: &str, translations_dir: &str) -> JobSnapshot {
    let mut job = JobSnapshot::new(job_id.to_string(), CreateJobInput::default(), vec![]);
    job.created_at = created_at.to_string();
    job.artifacts = Some(JobArtifacts {
        job_root: Some(job_root.to_string()),
        translations_dir: Some(translations_dir.to_string()),
        ..JobArtifacts::default()
    });
    job
}

#[test]
fn a_render_job_ranks_by_the_job_that_produced_its_translation() {
    let data_root = Path::new("/data");
    let producer = snapshot("p", "2026-10-01T00:00:00", "jobs/p", "jobs/p/translated");
    let relayout = snapshot("r", "2026-10-05T00:00:00", "jobs/r", "jobs/p/translated");
    let jobs = [producer.clone(), relayout.clone()];
    assert_eq!(producer_created_at(&relayout, &jobs, data_root), "2026-10-01T00:00:00");
    assert_eq!(producer_created_at(&producer, &jobs, data_root), "2026-10-01T00:00:00");
}

#[test]
fn a_render_job_whose_producer_is_gone_falls_back_to_its_own_time() {
    let relayout = snapshot("r", "2026-10-05T00:00:00", "jobs/r", "jobs/deleted/translated");
    assert_eq!(producer_created_at(&relayout, &[relayout.clone()], Path::new("/data")), "2026-10-05T00:00:00");
}

#[test]
fn a_job_root_that_merely_shares_a_prefix_is_not_the_producer() {
    // jobs/p 不是 jobs/p2/translated 的产出者 —— 按路径组件比，不按字符串前缀比。
    let data_root = Path::new("/data");
    let lookalike = snapshot("p", "2026-09-01T00:00:00", "jobs/p", "jobs/p/translated");
    let job = snapshot("p2", "2026-10-05T00:00:00", "jobs/p2", "jobs/p2/translated");
    assert_eq!(producer_created_at(&job, &[lookalike, job.clone()], data_root), "2026-10-05T00:00:00");
}
