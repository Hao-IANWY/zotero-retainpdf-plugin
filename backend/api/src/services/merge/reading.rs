//! 「这本书该打开哪个任务」——阅读器和下载的入口。
//!
//! 阅读器、下载、预览全是按任务读的（`/jobs/:id/...`），而且几乎都经过同一个加载函数
//! `jobs::query::load_supported_job`。所以合并结果不另开一套接口，而是给它一个**虚拟任务
//! id**：`merged-<文档 id>-<指纹前 16 位>`。读接口认出它，拼一个产物指向合并目录的任务
//! 快照；写接口（重试、取消、删除）走的是 `load_job_or_404`，查不到它，自然拒绝。
//!
//! # 生成和读取分开
//!
//! - **生成**在 `resolve_reading_target`：要调 Python 子命令，需要流水线命令的配置，只有
//!   专门的入口接口拿得到。
//! - **读取**在 `load_virtual_job`：虚拟 id 带着指纹，直接对应一个不可变目录，只读目录里的
//!   `reading.json`，不重算计划、不生成。阅读器打开期间有新任务完成也不会把正在看的这份
//!   换掉；重新打开才会拿到新的。


use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::db::Db;
use crate::error::AppError;
use crate::models::domain::{JobArtifacts, JobSnapshot, JobStatusKind};
use crate::services::derived_artifacts::merged::{
    ensure_merged_translation, JobInputs, MergedTranslation,
};
use crate::services::derived_artifacts::DerivedArtifactDeps;
use crate::storage_paths::{is_merged_job_id, resolve_data_path, to_relative_data_path, MergedJobId};

use super::plan::{merge_plan, PageSource};
use super::sources::{job_merge_source, MergeSource};

const SIDECAR: &str = "reading.json";

/// 虚拟任务 id 的格式定义在 `storage_paths::MergedJobId`：Python 的 AI 服务也要认它。
pub(crate) type VirtualJobId = MergedJobId;

pub(crate) fn is_virtual_job_id(job_id: &str) -> bool {
    is_merged_job_id(job_id)
}

/// 合并目录里的说明文件：拼任务快照要的、目录本身看不出来的东西。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct ReadingSidecar {
    document_id: String,
    /// 最新的参与任务。快照的请求参数、标题这些展示信息取自它。
    base_job_id: String,
    contributing_job_ids: Vec<String>,
    page_count: u32,
    source_pdf: String,
}

// ── 每个任务的排序和产物 ────────────────────────────────────────────────────

/// 产出这份译文的那个任务的提交时间。
///
/// 单独建的 render 任务（换字体重新排版）没有产出新译文，它的 `translations_dir` 指向
/// 产出者的 `translated/`。按产出者排，「重新排版不算重新翻译」。产出者找不到（被删了）
/// 就退回自己的提交时间。
fn producer_created_at(job: &JobSnapshot, jobs: &[JobSnapshot], data_root: &Path) -> String {
    let resolve = |raw: Option<&String>| raw.and_then(|raw| resolve_data_path(data_root, raw).ok());
    let Some(translations) = resolve(job.artifacts.as_ref().and_then(|a| a.translations_dir.as_ref()))
    else {
        return job.created_at.clone();
    };
    jobs.iter()
        .find(|candidate| {
            resolve(candidate.artifacts.as_ref().and_then(|a| a.job_root.as_ref()))
                .is_some_and(|root| translations.starts_with(&root))
        })
        .map(|producer| producer.created_at.clone())
        .unwrap_or_else(|| job.created_at.clone())
}

pub(crate) fn document_merge_sources(jobs: &[JobSnapshot], data_root: &Path) -> Vec<MergeSource> {
    jobs.iter()
        .filter_map(|job| job_merge_source(job, data_root, &producer_created_at(job, jobs, data_root)))
        .collect()
}

/// 计划里只有一个任务、而且它按顺序覆盖了整本：直接打开它，不用合并。
///
/// 只覆盖一部分的单个任务**也要合并**：它的输出 PDF 只有那几页，阅读器对照、双栏对照
/// 都按页序号配对，从中间开始的范围今天就是错页的。合并出来的整本长度 PDF 正好修好它。
pub(crate) fn single_whole_document_job(plan: &[PageSource]) -> Option<&str> {
    let first = match plan.first()? {
        PageSource::Job { job_id, .. } => job_id.as_str(),
        PageSource::Original => return None,
    };
    plan.iter()
        .enumerate()
        .all(|(index, source)| {
            matches!(source, PageSource::Job { job_id, local_index }
                if job_id == first && *local_index == index)
        })
        .then_some(first)
}

// ── 生成 ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ReadingTarget {
    /// 没有任何可读的译文任务。
    None,
    /// 一个任务就覆盖了整本：打开它本身。
    Job(String),
    /// 打开合并结果。
    Merged { job_id: String, merged: MergedTranslation },
}

pub(crate) fn resolve_reading_target(
    db: &Db,
    data_root: &Path,
    deps: DerivedArtifactDeps<'_>,
    document_id: &str,
    source_pdf: &Path,
) -> Result<ReadingTarget, AppError> {
    let jobs = db.list_jobs_for_document(document_id, 500, 0)?;
    let sources = document_merge_sources(&jobs, data_root);
    if sources.is_empty() {
        return Ok(ReadingTarget::None);
    }
    let page_count = lopdf::Document::load(source_pdf)
        .map_err(|error| AppError::internal(format!("read source pdf {}: {error}", source_pdf.display())))?
        .get_pages()
        .len() as u32;
    let ranked: Vec<_> = sources.iter().map(|source| source.ranked.clone()).collect();
    let plan = merge_plan(page_count, &ranked);
    if let Some(job_id) = single_whole_document_job(&plan) {
        return Ok(ReadingTarget::Job(job_id.to_string()));
    }
    let inputs: JobInputs = sources
        .iter()
        .map(|source| (source.ranked.rank.job_id.clone(), source.inputs.clone()))
        .collect();
    let merged = ensure_merged_translation(deps, data_root, document_id, source_pdf, &plan, &inputs)?;
    write_sidecar_once(&merged, data_root, document_id, &sources, &plan, page_count, source_pdf)?;
    let fingerprint = merged
        .root
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| AppError::internal("merged root has no name"))?
        .to_string();
    let job_id = VirtualJobId { document_id: document_id.to_string(), fingerprint }.format();
    Ok(ReadingTarget::Merged { job_id, merged })
}

fn write_sidecar_once(
    merged: &MergedTranslation,
    data_root: &Path,
    document_id: &str,
    sources: &[MergeSource],
    plan: &[PageSource],
    page_count: u32,
    source_pdf: &Path,
) -> Result<(), AppError> {
    let path = merged.root.join(SIDECAR);
    if path.is_file() {
        return Ok(());
    }
    let mut contributing: Vec<&MergeSource> = Vec::new();
    for source in plan {
        if let PageSource::Job { job_id, .. } = source {
            if !contributing.iter().any(|s| &s.ranked.rank.job_id == job_id) {
                let found = sources.iter().find(|s| &s.ranked.rank.job_id == job_id);
                contributing.extend(found);
            }
        }
    }
    let base = contributing
        .iter()
        .max_by(|a, b| a.ranked.rank.cmp(&b.ranked.rank))
        .ok_or_else(|| AppError::internal("merged translation has no contributing job"))?;
    let sidecar = ReadingSidecar {
        document_id: document_id.to_string(),
        base_job_id: base.ranked.rank.job_id.clone(),
        contributing_job_ids: contributing.iter().map(|s| s.ranked.rank.job_id.clone()).collect(),
        page_count,
        source_pdf: to_relative_data_path(data_root, source_pdf)
            .unwrap_or_else(|_| source_pdf.to_string_lossy().into_owned()),
    };
    // 同一个指纹的并发请求可能同时写：先写临时文件再 rename，内容一样，谁赢都对。
    let temporary = merged.root.join(format!(".{SIDECAR}.{:016x}", fastrand::u64(..)));
    std::fs::write(&temporary, serde_json::to_vec_pretty(&sidecar).map_err(|e| AppError::internal(e.to_string()))?)?;
    std::fs::rename(&temporary, &path)?;
    Ok(())
}

// ── 读取 ────────────────────────────────────────────────────────────────────

/// 把虚拟 id 解析成一个任务快照：请求参数、标题取自最新的参与任务，产物全部指向合并目录。
///
/// 产物从 `JobArtifacts::default()` 起步，只填合并目录里真有的东西。不沿用参与任务的
/// 产物字段：那些路径（诊断、日志、OCR 原始包…）属于某一个任务，挂在合并结果上会让
/// 下游读到只覆盖一部分页的数据。
pub(crate) fn load_virtual_job(db: &Db, data_root: &Path, job_id: &str) -> Result<JobSnapshot, AppError> {
    let not_found = || AppError::not_found(format!("job not found: {job_id}"));
    let id = VirtualJobId::parse(job_id).ok_or_else(not_found)?;
    let merged = MergedTranslation { root: id.root(data_root) };
    let sidecar: ReadingSidecar = std::fs::read(merged.root.join(SIDECAR))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .ok_or_else(not_found)?;
    if sidecar.document_id != id.document_id {
        return Err(not_found());
    }
    let base = db.get_job(&sidecar.base_job_id).map_err(|_| not_found())?;
    let relative = |path: &Path| {
        to_relative_data_path(data_root, path).unwrap_or_else(|_| path.to_string_lossy().into_owned())
    };
    let mut job = base;
    job.job_id = job_id.to_string();
    job.status = JobStatusKind::Succeeded;
    job.request_payload.translation.start_page = 0;
    job.request_payload.translation.end_page = -1;
    job.request_payload.translation.page_ranges = Default::default();
    job.artifacts = Some(JobArtifacts {
        job_root: Some(relative(&merged.root)),
        source_pdf: Some(sidecar.source_pdf.clone()),
        output_pdf: Some(relative(&merged.output_pdf())),
        translations_dir: Some(relative(&merged.translations_dir())),
        normalized_document_json: Some(relative(&merged.normalized_document()))
            .filter(|_| merged.normalized_document().is_file()),
        ocr_page_numbers: (1..=sidecar.page_count).collect(),
        ..JobArtifacts::default()
    });
    Ok(job)
}

/// 参与这份合并的任务 id，按页序首次出现的顺序。给界面说「这本书由哪几次翻译拼成」。
pub(crate) fn contributing_jobs(data_root: &Path, job_id: &str) -> Option<Vec<String>> {
    let id = VirtualJobId::parse(job_id)?;
    let bytes = std::fs::read(id.root(data_root).join(SIDECAR)).ok()?;
    let sidecar: ReadingSidecar = serde_json::from_slice(&bytes).ok()?;
    Some(sidecar.contributing_job_ids)
}


/// `GET /api/v1/documents/:id/reading` 的回包。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DocumentReadingView {
    /// 阅读器该打开的任务 id；`None` 表示这本书还没有可读的译文。
    pub job_id: Option<String>,
    /// 是不是多次翻译拼成的。
    pub merged: bool,
    /// 拼成这份译文的任务，按页序首次出现的顺序；不是合并时就是那一个任务。
    pub contributing_job_ids: Vec<String>,
}

impl ReadingTarget {
    pub(crate) fn view(&self, data_root: &Path) -> DocumentReadingView {
        match self {
            Self::None => DocumentReadingView { job_id: None, merged: false, contributing_job_ids: vec![] },
            Self::Job(job_id) => DocumentReadingView {
                job_id: Some(job_id.clone()),
                merged: false,
                contributing_job_ids: vec![job_id.clone()],
            },
            Self::Merged { job_id, .. } => DocumentReadingView {
                job_id: Some(job_id.clone()),
                merged: true,
                contributing_job_ids: contributing_jobs(data_root, job_id).unwrap_or_default(),
            },
        }
    }
}

#[cfg(test)]
#[path = "reading_tests.rs"]
mod tests;
