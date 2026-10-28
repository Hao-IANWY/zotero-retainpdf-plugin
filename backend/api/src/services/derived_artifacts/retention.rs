//! 派生缓存的定期回收：Word、对照 PDF、线性化 PDF、页预览这些下载时按需生成、删了下次请求会重新生成的文件。
//!
//! 只认得出名字的才删。任务的 `artifacts/` 里还有管线自己写的东西（`summary.json`、调试诊断、渲染中间文件……），
//! 删了就重建不回来，所以不能整个目录清。名字都从 `derived_artifacts.rs` 的那几个函数来，生成那边改了名字，
//! 这里的测试会红。
//!
//! 封面、缩略图不删：每张不大，书库列表一打开就要几十张，删了是成批重渲染。
//! 按文件自己的修改时间算：生成以后超过保留天数就删，哪怕这期间一直有人下载。删不掉的（被占用）
//! 记进 `failed`，下一轮再试。

use std::path::Path;
use std::time::SystemTime;

use crate::db::Db;
use crate::models::domain::JobStatusKind;

use super::side_by_side_file_name;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct DerivedCachePruned {
    pub files: usize,
    pub bytes: u64,
    /// 到期了但删不掉的文件数（权限、被占用）。
    pub failed: usize,
}

impl DerivedCachePruned {
    fn add(&mut self, other: Self) {
        self.files += other.files;
        self.bytes += other.bytes;
        self.failed += other.failed;
    }
}

/// 任务 `artifacts/` 里的派生缓存是不是这个名字（产物本身）。
fn is_job_derived_cache(job_id: &str, name: &str) -> bool {
    if name == side_by_side_file_name(job_id) {
        return true;
    }
    if name.starts_with(&format!("{job_id}-layout-")) && name.ends_with(".docx") {
        return true;
    }
    if name.ends_with(".linearized.pdf") {
        return true;
    }
    (name.starts_with("preview-source-p") || name.starts_with("preview-translated-p"))
        && name.ends_with(".jpg")
}

/// 删掉一个终态任务 `jobs/<任务>/artifacts/` 里修改时间早于 `older_than` 的派生缓存。
/// 只看这一层，不进子目录。调用方负责只给终态任务（排队、在跑的任务可能正要读它们）。
fn prune_job_derived_cache(
    data_root: &Path,
    job_id: &str,
    older_than: SystemTime,
) -> DerivedCachePruned {
    if job_id.is_empty() || job_id.contains(['/', '\\']) || job_id.starts_with('.') {
        return DerivedCachePruned::default();
    }
    let dir = data_root.join("jobs").join(job_id).join("artifacts");
    prune_matching(&dir, older_than, |name| is_job_derived_cache(job_id, name))
}

/// 终态任务的派生缓存都过一遍。排队、在跑的任务不碰：它们可能正要读这些文件。
pub(crate) fn prune_terminal_job_caches(
    db: &Db,
    data_root: &Path,
    older_than: SystemTime,
) -> anyhow::Result<DerivedCachePruned> {
    let mut pruned = DerivedCachePruned::default();
    for status in [
        JobStatusKind::Succeeded,
        JobStatusKind::Failed,
        JobStatusKind::Canceled,
    ] {
        for job in db.list_jobs_with_status(&status)? {
            // 合并阅读的虚拟任务没有 `jobs/<id>/` 目录，缓存跟着不可变的合并目录走，不归这里管。
            if crate::services::merge::reading::is_virtual_job_id(&job.job_id) {
                continue;
            }
            pruned.add(prune_job_derived_cache(data_root, &job.job_id, older_than));
        }
    }
    Ok(pruned)
}

fn prune_matching(
    dir: &Path,
    older_than: SystemTime,
    matches: impl Fn(&str) -> bool,
) -> DerivedCachePruned {
    let mut pruned = DerivedCachePruned::default();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return pruned;
    };
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !matches(&name) {
            continue;
        }
        // 不跟符号链接：只删普通文件本身。
        let Ok(metadata) = entry.path().symlink_metadata() else {
            continue;
        };
        if !metadata.is_file()
            || metadata
                .modified()
                .map_or(true, |modified| modified >= older_than)
        {
            continue;
        }
        match std::fs::remove_file(entry.path()) {
            Ok(()) => {
                pruned.files += 1;
                pruned.bytes += metadata.len();
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => pruned.failed += 1,
        }
    }
    pruned
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::time::Duration;

    use super::*;

    struct TempTree {
        root: PathBuf,
        artifacts: PathBuf,
    }

    impl TempTree {
        fn new() -> Self {
            let root = std::env::temp_dir()
                .join(format!("retain-derived-retention-{}", fastrand::u64(..)));
            let artifacts = root.join("jobs").join("job-1").join("artifacts");
            fs::create_dir_all(&artifacts).expect("create artifacts dir");
            Self { root, artifacts }
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn write_with_age(dir: &Path, name: &str, age: Duration) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, b"cache").expect("write cache file");
        let modified = SystemTime::now() - age;
        fs::File::options()
            .write(true)
            .open(&path)
            .expect("open for timestamp")
            .set_modified(modified)
            .expect("set mtime");
        path
    }

    #[test]
    fn only_old_recognised_caches_are_removed() {
        let tree = TempTree::new();
        let old = Duration::from_secs(10 * 24 * 3600);
        let fresh = Duration::from_secs(60);
        let old_side = write_with_age(&tree.artifacts, "job-1-side-by-side.pdf", old);
        let old_docx = write_with_age(&tree.artifacts, "job-1-layout-a1b2.docx", old);
        let old_linearized = write_with_age(&tree.artifacts, "source.linearized.pdf", old);
        let old_preview = write_with_age(
            &tree.artifacts,
            "preview-translated-p0002-w1200-d0.jpg",
            old,
        );
        let fresh_side = write_with_age(&tree.artifacts, "job-1-side-by-side.pdf.tmp", fresh);
        let summary = write_with_age(&tree.artifacts, "summary.json", old);
        let cover = write_with_age(&tree.artifacts, "cover.jpg", old);
        let other_preview = write_with_age(&tree.artifacts, "preview-p0002.jpg", old);

        #[cfg(unix)]
        let link = {
            use std::os::unix::fs::symlink;
            let link = tree.artifacts.join("job-1-side-by-side.pdf.link");
            symlink(&old_side, &link).expect("symlink");
            link
        };

        let cutoff = SystemTime::now() - Duration::from_secs(7 * 24 * 3600);
        let pruned = prune_job_derived_cache(&tree.root, "job-1", cutoff);
        assert_eq!(pruned.files, 4, "{pruned:?}");
        assert_eq!(pruned.failed, 0);
        for removed in [&old_side, &old_docx, &old_linearized, &old_preview] {
            assert!(!removed.exists(), "{} should be removed", removed.display());
        }
        for kept in [&fresh_side, &summary, &cover, &other_preview] {
            assert!(kept.exists(), "{} must be kept", kept.display());
        }
        #[cfg(unix)]
        assert!(
            fs::symlink_metadata(&link).is_ok(),
            "symlinks are never followed or removed"
        );
    }

    #[test]
    fn invalid_job_ids_are_ignored() {
        let tree = TempTree::new();
        let cutoff = SystemTime::now();
        for job_id in ["", "../escape", ".hidden"] {
            let pruned = prune_job_derived_cache(&tree.root, job_id, cutoff);
            assert_eq!(pruned.files, 0, "{job_id}");
        }
    }

    #[test]
    fn terminal_job_sweep_reaches_caches_but_skips_running_jobs() {
        let root =
            std::env::temp_dir().join(format!("retain-derived-retention-db-{}", fastrand::u64(..)));
        let data_root = root.join("data");
        fs::create_dir_all(&data_root).expect("create data root");
        let db = Db::new(root.join("db").join("jobs.db"), data_root.clone());
        db.init().expect("init db");

        let old = Duration::from_secs(10 * 24 * 3600);
        for (job_id, status) in [
            ("done-job", JobStatusKind::Succeeded),
            ("running-job", JobStatusKind::Running),
        ] {
            let mut job = crate::models::domain::JobSnapshot::new(
                job_id.to_string(),
                crate::models::request::CreateJobInput::default(),
                vec!["python".to_string()],
            );
            job.status = status;
            db.save_job(&job).expect("save job");
            let artifacts = data_root.join("jobs").join(job_id).join("artifacts");
            fs::create_dir_all(&artifacts).expect("create artifacts");
            write_with_age(&artifacts, &format!("{job_id}-side-by-side.pdf"), old);
        }

        let cutoff = SystemTime::now() - Duration::from_secs(7 * 24 * 3600);
        let pruned = prune_terminal_job_caches(&db, &data_root, cutoff).expect("sweep");
        assert_eq!(pruned.files, 1, "{pruned:?}");
        assert!(!data_root
            .join("jobs/done-job/artifacts/done-job-side-by-side.pdf")
            .exists());
        assert!(data_root
            .join("jobs/running-job/artifacts/running-job-side-by-side.pdf")
            .exists());
        let _ = fs::remove_dir_all(&root);
    }
}
