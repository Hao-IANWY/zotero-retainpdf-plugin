//! 合并译文：同一本书的多个范围任务合成一个整本长度、「长得和普通任务一样」的目录。
//!
//! 计划由 `merge::plan::merge_plan` 算，各任务的产物路径由 `merge::sources` 读出。产物分两半，各交给一个 Python 子命令：
//!
//! - `merge-translated-artifacts`：译文 JSON + manifest、OCR 规范化文档、图片，页号改写成
//!   文档页号。阅读器选区、Word 导出、AI 问答、全文搜索读的是这些。
//! - `merge-translated-pdf`：以源 PDF 为底本「移植」译文页。看 PDF 的出口读这个。
//!
//! 这里只管缓存键、调子进程、原子发布。
//!
//! # 缓存：按内容指纹命名的不可变目录
//!
//! 产物是 `data/documents/<doc>/merged/<指纹前 16 位>/`，**目录存在即完整且新鲜**：先在
//! 同级的临时目录里生成，两半都成功后才整体 rename 过去。
//!
//! 不能沿用 `cached_output_is_fresh` 的 mtime 比较：删掉一个较新的任务后，剩下所有输入
//! 都比产物旧，它会继续返回包含已删任务的旧合并结果；改了拼接代码也不会失效。指纹里
//! 放的是「这次合并由什么决定」—— 合并器版本、源 PDF、每页取自哪个任务的哪一页、每个
//! 被引用任务的输出 PDF / 译文 manifest / OCR 文档的大小和修改时间、OCR 页号表。任何一项
//! 变了就是一个新目录。
//!
//! 目录名不可变还有一个好处：用户正在下载旧的合并结果时，新的合并不会把它从脚下替换掉
//! （断点续传不会拼出半新半旧的 PDF）。旧目录在新目录发布后按年龄清理（`prune_stale`）。

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use sha2::{Digest, Sha256};

use crate::error::AppError;
use crate::services::merge::plan::PageSource;
use crate::services::merge::sources::BuildInputs;

use super::{document_artifacts_dir, DerivedArtifactDeps};

/// 拼接器的行为一变就加一。它进了指纹，旧缓存自动作废 —— Word 导出就吃过「改了代码、
/// 缓存不认」的亏（`word.rs` 的 `RENDERER_VERSION`）。
const MERGE_VERSION: u32 = 3;

/// 50 页 4 个来源交错实测 0.5 秒；留足余量给大书和慢盘。
const BUILD_TIMEOUT: Duration = Duration::from_secs(120);

fn file_stamp(path: &Path) -> Result<String, AppError> {
    let meta = std::fs::metadata(path)?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    Ok(format!("{}|{}|{}", path.display(), meta.len(), modified))
}

/// 每个任务去哪读产物，按 job_id 索引。
pub(crate) type JobInputs = BTreeMap<String, BuildInputs>;

/// 计划里引用到的任务 → 它的产物路径。计划引用了不存在的任务就是调用方的 bug。
fn referenced_jobs<'a>(
    plan: &[PageSource],
    jobs: &'a JobInputs,
) -> Result<BTreeMap<&'a str, &'a BuildInputs>, AppError> {
    let mut referenced = BTreeMap::new();
    for source in plan {
        if let PageSource::Job { job_id, .. } = source {
            let (id, inputs) = jobs.get_key_value(job_id).ok_or_else(|| {
                AppError::internal(format!("merge plan references unknown job {job_id}"))
            })?;
            referenced.insert(id.as_str(), inputs);
        }
    }
    Ok(referenced)
}

pub(crate) fn merge_fingerprint(
    source_pdf: &Path,
    plan: &[PageSource],
    jobs: &JobInputs,
) -> Result<String, AppError> {
    let mut hasher = Sha256::new();
    hasher.update(format!("v{MERGE_VERSION}\n"));
    hasher.update(format!("source {}\n", file_stamp(source_pdf)?));
    for source in plan {
        match source {
            PageSource::Original => hasher.update("page original\n"),
            PageSource::Job { job_id, local_index } => {
                hasher.update(format!("page {job_id}#{local_index}\n"))
            }
        }
    }
    for (job_id, inputs) in referenced_jobs(plan, jobs)? {
        hasher.update(format!("job {job_id} {}\n", file_stamp(&inputs.output_pdf)?));
        hasher.update(format!("  ocr {:?}\n", inputs.ocr_page_numbers));
        let manifest = inputs
            .translations_dir
            .as_ref()
            .map(|dir| dir.join("translation-manifest.json"));
        for (label, path) in [
            ("manifest", manifest.as_deref()),
            ("document", inputs.normalized_document.as_deref()),
        ] {
            match path.filter(|path| path.is_file()) {
                Some(path) => hasher.update(format!("  {label} {}\n", file_stamp(path)?)),
                None => hasher.update(format!("  {label} none\n")),
            }
        }
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

/// 交给 Python 的计划：`{"pages": [null | {"pdf": 绝对路径, "index": n}, …]}`。
fn plan_json(plan: &[PageSource], jobs: &JobInputs) -> Result<String, AppError> {
    let referenced = referenced_jobs(plan, jobs)?;
    let pages: Vec<serde_json::Value> = plan
        .iter()
        .map(|source| match source {
            PageSource::Original => serde_json::Value::Null,
            PageSource::Job { job_id, local_index } => serde_json::json!({
                "pdf": referenced[job_id.as_str()].output_pdf,
                "index": local_index,
            }),
        })
        .collect();
    Ok(serde_json::json!({ "pages": pages }).to_string())
}

/// 交给 `merge-translated-artifacts` 的计划。
fn artifacts_plan_json(
    source_pdf: &Path,
    plan: &[PageSource],
    jobs: &JobInputs,
) -> Result<String, AppError> {
    let referenced = referenced_jobs(plan, jobs)?;
    let mut job_specs = serde_json::Map::new();
    for (job_id, inputs) in &referenced {
        let translations_dir = inputs.translations_dir.as_ref().ok_or_else(|| {
            AppError::internal(format!("job {job_id} has no translations dir to merge"))
        })?;
        job_specs.insert(
            job_id.to_string(),
            serde_json::json!({
                "translations_dir": translations_dir,
                "normalized_document": inputs.normalized_document,
                "markdown_images_dir": inputs.markdown_images_dir,
                "ocr_page_numbers": inputs.ocr_page_numbers,
            }),
        );
    }
    let pages: Vec<serde_json::Value> = plan
        .iter()
        .map(|source| match source {
            PageSource::Original => serde_json::Value::Null,
            PageSource::Job { job_id, .. } => serde_json::json!({ "job": job_id }),
        })
        .collect();
    Ok(serde_json::json!({
        "document_page_count": plan.len(),
        "source_pdf": source_pdf,
        "jobs": job_specs,
        "pages": pages,
    })
    .to_string())
}

/// 合并目录。布局与普通任务目录一致，下游按读普通任务的方式读。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MergedTranslation {
    pub root: PathBuf,
}

impl MergedTranslation {
    pub fn output_pdf(&self) -> PathBuf {
        self.root.join("rendered").join("merged.pdf")
    }

    pub fn translations_dir(&self) -> PathBuf {
        self.root.join("translated")
    }

    pub fn normalized_document(&self) -> PathBuf {
        self.root.join("ocr").join("normalized").join("document.v1.json")
    }
}

pub(crate) fn merged_root(
    data_root: &Path,
    document_id: &str,
    fingerprint: &str,
) -> Result<PathBuf, AppError> {
    let dir = document_artifacts_dir(data_root, document_id)?.join("merged");
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(&fingerprint[..16]))
}

/// 生成失败时整个临时目录一起删掉。
struct BuildingDir(PathBuf);

impl Drop for BuildingDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn run_step(
    anchor: &Path,
    label: &str,
    deps: DerivedArtifactDeps<'_>,
    subcommand: &str,
    args: &[&std::ffi::OsStr],
) -> Result<(), AppError> {
    let mut command = std::process::Command::new(deps.pipeline_command);
    command.arg(subcommand).args(args);
    let (status, diagnostics) =
        super::side_by_side::run_supervised(anchor, label, BUILD_TIMEOUT, command)?;
    if !status.success() {
        return Err(diagnostics.error(format!("failed to build {label}")));
    }
    Ok(())
}

/// 拿到（必要时生成）这本书当前的合并译文目录。
pub(crate) fn ensure_merged_translation(
    deps: DerivedArtifactDeps<'_>,
    data_root: &Path,
    document_id: &str,
    source_pdf: &Path,
    plan: &[PageSource],
    jobs: &JobInputs,
) -> Result<MergedTranslation, AppError> {
    let fingerprint = merge_fingerprint(source_pdf, plan, jobs)?;
    let root = merged_root(data_root, document_id, &fingerprint)?;
    if root.is_dir() {
        return Ok(MergedTranslation { root });
    }
    let parent = root.parent().expect("merged root has a parent");
    let building = BuildingDir(parent.join(format!(
        ".building-{}-{:016x}",
        &fingerprint[..16],
        fastrand::u64(..)
    )));
    std::fs::create_dir(&building.0)?;
    let staged = MergedTranslation { root: building.0.clone() };
    let pdf_plan = building.0.with_extension("pdf-plan.json");
    let artifacts_plan = building.0.with_extension("artifacts-plan.json");
    let result = (|| {
        std::fs::File::create(&artifacts_plan)?
            .write_all(artifacts_plan_json(source_pdf, plan, jobs)?.as_bytes())?;
        run_step(
            &building.0,
            "merged-artifacts",
            deps,
            "merge-translated-artifacts",
            &[
                "--plan".as_ref(),
                artifacts_plan.as_os_str(),
                "--output-dir".as_ref(),
                building.0.as_os_str(),
            ],
        )?;
        std::fs::File::create(&pdf_plan)?.write_all(plan_json(plan, jobs)?.as_bytes())?;
        std::fs::create_dir_all(staged.output_pdf().parent().expect("rendered dir"))?;
        run_step(
            &building.0,
            "merged-pdf",
            deps,
            "merge-translated-pdf",
            &[
                "--source-pdf".as_ref(),
                source_pdf.as_os_str(),
                "--plan".as_ref(),
                pdf_plan.as_os_str(),
                "--output-pdf".as_ref(),
                staged.output_pdf().as_os_str(),
            ],
        )?;
        if !staged.output_pdf().is_file() || !staged.translations_dir().is_dir() {
            return Err(AppError::internal("merged translation is incomplete"));
        }
        Ok::<(), AppError>(())
    })();
    let _ = std::fs::remove_file(&pdf_plan);
    let _ = std::fs::remove_file(&artifacts_plan);
    result?;
    match std::fs::rename(&building.0, &root) {
        Ok(()) => {}
        // 并发的另一次请求先发布了同一个指纹：内容相同，用它的，丢掉自己的。
        Err(_) if root.is_dir() => {}
        Err(error) => return Err(error.into()),
    }
    prune_stale(parent, &root, std::time::SystemTime::now());
    Ok(MergedTranslation { root })
}

/// 旧的合并目录保留多久。不在新目录一发布就删：可能有人正拿着旧的虚拟 id 开着阅读器、
/// 或者正在下载旧的合并 PDF（虚拟 id 带指纹，读的就是那个目录）。
const STALE_MERGED_AFTER: Duration = Duration::from_secs(24 * 60 * 60);
/// `.building-*` 是生成中的临时目录；进程崩溃会把它留下。生成最多跑两步子进程，各自
/// 有 `BUILD_TIMEOUT`，一小时还在的一定是残骸。
const STALE_BUILDING_AFTER: Duration = Duration::from_secs(60 * 60);

/// 删掉 `merged/` 下除 `keep` 之外、足够旧的合并目录和残留的临时目录。尽力而为：清理失败
/// 不影响这次合并。
fn prune_stale(merged_dir: &Path, keep: &Path, now: std::time::SystemTime) {
    let Ok(entries) = std::fs::read_dir(merged_dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path == keep || !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let max_age = if name.starts_with(".building-") {
            STALE_BUILDING_AFTER
        } else if name.len() == 16 && name.bytes().all(|b| b.is_ascii_hexdigit()) {
            STALE_MERGED_AFTER
        } else {
            // 不认识的东西不碰。
            continue;
        };
        let age = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok());
        if age.is_some_and(|age| age > max_age) {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
}

#[cfg(test)]
#[path = "merged_tests.rs"]
mod tests;
