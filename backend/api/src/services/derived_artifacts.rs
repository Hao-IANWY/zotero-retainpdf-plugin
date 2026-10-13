use std::path::{Path, PathBuf};

use crate::error::AppError;
use crate::models::domain::JobSnapshot;

pub(crate) mod merged;
pub(crate) mod pdf;
pub(crate) mod preview;
pub(crate) mod side_by_side;
pub(crate) mod word;

#[derive(Clone, Copy)]
pub(crate) struct DerivedArtifactDeps<'a> {
    pub(crate) python_bin: &'a str,
    pub(crate) pipeline_command: &'a str,
}

impl<'a> DerivedArtifactDeps<'a> {
    pub(crate) fn new(python_bin: &'a str) -> Self {
        Self {
            python_bin,
            pipeline_command: "retainpdf-pipeline",
        }
    }

    pub(crate) fn with_pipeline_command(python_bin: &'a str, pipeline_command: &'a str) -> Self {
        Self {
            python_bin,
            pipeline_command,
        }
    }
}

pub(crate) fn job_artifacts_dir(data_root: &Path, job: &JobSnapshot) -> Result<PathBuf, AppError> {
    let output_dir = job_artifacts_dir_path(data_root, job)?;
    std::fs::create_dir_all(&output_dir)?;
    Ok(output_dir)
}

/// 任务派生产物（Word、双栏 PDF、缩略图…）的缓存目录。
///
/// 普通任务是 `data/jobs/<job_id>/artifacts`。合并结果的虚拟 id 不能这么拼 —— 会在
/// `jobs/` 下凭空多出一个假任务目录 —— 它的缓存放进合并目录自己的 `artifacts/`：合并目录
/// 按内容指纹命名、不可变，缓存天然跟着内容走。
pub(crate) fn job_artifacts_dir_path(data_root: &Path, job: &JobSnapshot) -> Result<PathBuf, AppError> {
    if crate::services::merge::reading::is_virtual_job_id(&job.job_id) {
        let root = crate::storage_paths::resolve_job_root(job, data_root)
            .ok_or_else(|| AppError::internal(format!("merged job has no root: {}", job.job_id)))?;
        return Ok(root.join("artifacts"));
    }
    Ok(data_root.join("jobs").join(&job.job_id).join("artifacts"))
}

/// 文档级缓存目录（无 job 时封面/缩略图仍可落盘）。
pub(crate) fn document_artifacts_dir(
    data_root: &Path,
    document_id: &str,
) -> Result<PathBuf, AppError> {
    let output_dir = data_root.join("documents").join(document_id);
    std::fs::create_dir_all(&output_dir)?;
    Ok(output_dir)
}

pub(crate) fn cached_output_is_fresh(
    output_path: &Path,
    inputs: &[&Path],
) -> Result<bool, AppError> {
    if !output_path.exists() || !output_path.is_file() {
        return Ok(false);
    }
    let output_modified = std::fs::metadata(output_path)?.modified().ok();
    Ok(inputs.iter().all(|input| {
        let input_modified = std::fs::metadata(input)
            .and_then(|meta| meta.modified())
            .ok();
        output_modified >= input_modified
    }))
}
