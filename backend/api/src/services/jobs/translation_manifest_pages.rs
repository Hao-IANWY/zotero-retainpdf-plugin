//! 翻译清单（translation-manifest.json）的分页读取，只留一份实现。
//!
//! 阅读区块（reader_regions）和译文列表、单条译文（debug）都读它。以前两边各有一份，
//! 报错说法和返回形状已经走样；清单里的路径以前也放行绝对路径和跳出目录的写法——Python
//! 写清单只写相对路径、读的时候拒绝跳出去的（`translate/core/payload/manifest.py`），这边
//! 现在同样拒绝（回移自上游 refactor/manifest-page-loader）。

use std::path::{Component, Path, PathBuf};

use serde_json::Value;

use crate::error::AppError;

fn read_json_value(path: &Path) -> Result<Value, AppError> {
    let text = std::fs::read_to_string(path)?;
    serde_json::from_str(&text)
        .map_err(|err| AppError::internal(format!("parse json {}: {err}", path.display())))
}

fn value_string(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).unwrap_or("").to_string()
}

/// 翻译清单里的每一页：(页号, 清单里写的相对路径, 这一页的条目)。
///
/// 清单里的路径必须在清单所在的目录里面。
pub(super) fn load_manifest_pages(
    manifest_path: &Path,
) -> Result<Vec<(i64, String, Vec<Value>)>, AppError> {
    let manifest = read_json_value(manifest_path)?;
    let pages = manifest
        .get("pages")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            AppError::internal(format!(
                "invalid translation manifest: {}",
                manifest_path.display()
            ))
        })?;
    let base_dir = manifest_path.parent().unwrap_or(manifest_path);
    let mut result = Vec::new();
    for page in pages {
        let page_idx = page
            .get("page_index")
            .and_then(Value::as_i64)
            .unwrap_or_default();
        let rel_path = value_string(page.get("path"));
        if rel_path.is_empty() {
            continue;
        }
        let relative = Path::new(&rel_path);
        if relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
        {
            return Err(AppError::internal(format!(
                "translation manifest page {page_idx} points outside the translation directory: {rel_path}"
            )));
        }
        let payload_path: PathBuf = base_dir.join(relative);
        let page_payload = read_json_value(&payload_path)?;
        let items = page_payload.as_array().cloned().unwrap_or_default();
        result.push((page_idx, rel_path, items));
    }
    Ok(result)
}

#[cfg(test)]
mod manifest_path_tests {
    use super::load_manifest_pages;

    fn manifest_with(dir: &std::path::Path, path: &str) -> std::path::PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("page-001.json"), r#"[{"item_id": "p001-b000"}]"#).unwrap();
        let manifest = dir.join("translation-manifest.json");
        std::fs::write(
            &manifest,
            format!(r#"{{"pages": [{{"page_index": 0, "path": "{path}"}}]}}"#),
        )
        .unwrap();
        manifest
    }

    #[test]
    fn pages_are_read_relative_to_the_manifest() {
        let dir = std::env::temp_dir().join(format!("retain-manifest-ok-{}", fastrand::u64(..)));
        let pages = load_manifest_pages(&manifest_with(&dir, "./page-001.json")).unwrap();
        assert_eq!(pages.len(), 1);
        assert_eq!(pages[0].0, 0);
        assert_eq!(pages[0].2.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_page_path_outside_the_translation_directory_is_refused() {
        // Python 写清单只写相对路径、读的时候拒绝跳出去的，这边以前照读。
        let dir =
            std::env::temp_dir().join(format!("retain-manifest-escape-{}", fastrand::u64(..)));
        let error = load_manifest_pages(&manifest_with(&dir, "../page-001.json")).unwrap_err();
        assert!(error.to_string().contains("points outside the translation directory"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_absolute_page_path_is_refused_too() {
        let dir = std::env::temp_dir().join(format!("retain-manifest-abs-{}", fastrand::u64(..)));
        let absolute = std::fs::canonicalize(std::env::temp_dir()).unwrap();
        let error = load_manifest_pages(&manifest_with(
            &dir,
            &absolute.join("page-001.json").display().to_string(),
        ))
        .unwrap_err();
        assert!(error.to_string().contains("points outside the translation directory"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
