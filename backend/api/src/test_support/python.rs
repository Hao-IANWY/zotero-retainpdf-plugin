//! 调真 Python 的测试共用的解释器/入口查找。

use std::path::{Path, PathBuf};

/// 项目虚拟环境里的可执行文件（`python`、`retainpdf-pipeline`……）。
///
/// UV_PROJECT_ENVIRONMENT 优先 —— worktree 里环境不在 `<repo>/backend/.venv`
/// （那个带绝对路径的符号链接已撤出仓库，见 ops/development/dev_stack.py 的注释）。
/// 环境缺了就红，不静默跳过：这些测试守的正是 Rust 与 Python 的接缝。
pub(crate) fn project_venv_bin(name: &str) -> PathBuf {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let relative = if cfg!(windows) {
        PathBuf::from("Scripts").join(format!("{name}.exe"))
    } else {
        PathBuf::from("bin").join(name)
    };
    std::env::var_os("UV_PROJECT_ENVIRONMENT")
        .map(PathBuf::from)
        .into_iter()
        .chain([root.join("backend/.venv"), root.join(".venv")])
        .map(|venv| venv.join(&relative))
        .find(|path| path.is_file())
        .expect(
            "a project Python environment is required \
             (set UV_PROJECT_ENVIRONMENT or create <repo>/backend/.venv)",
        )
}
