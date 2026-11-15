use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::error::AppError;
use crate::models::api::TranslationDebugIndexView;
use crate::models::domain::JobSnapshot;
use crate::storage_paths::{resolve_translation_debug_index, resolve_translation_manifest};

pub(super) fn read_translation_debug_index_file(
    data_root: &Path,
    job: &JobSnapshot,
) -> Result<Option<TranslationDebugIndexView>, AppError> {
    let Some(path) = resolve_translation_debug_index(job, data_root) else {
        return Ok(None);
    };
    let text = std::fs::read_to_string(&path)?;
    let payload: TranslationDebugIndexView = serde_json::from_str(&text).map_err(|err| {
        AppError::internal(format!("parse debug index {}: {err}", path.display()))
    })?;
    Ok(Some(payload))
}

pub(super) fn translation_manifest_path(
    data_root: &Path,
    job: &JobSnapshot,
) -> Result<PathBuf, AppError> {
    resolve_translation_manifest(job, data_root).ok_or_else(|| {
        AppError::not_found(format!("translation manifest not found: {}", job.job_id))
    })
}

pub(super) fn load_manifest_pages(
    manifest_path: &Path,
) -> Result<Vec<(i64, String, Vec<Value>)>, AppError> {
    // 清单分页只留一份实现（reader_regions、debug 共用；路径越界一起拒）。
    crate::services::jobs::translation_manifest_pages::load_manifest_pages(manifest_path)
}
