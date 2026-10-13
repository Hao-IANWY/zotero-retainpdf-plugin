//! job_runner 各子模块单测共用的小工具。
//!
//! 这些函数原先在 stage_contract / process_contract / process_runner /
//! translation_flow_support / worker_process / ocr_flow::provider_transport
//! 里各抄一份，逐字相同；收在这里，测试正文只留各自在意的差异。

use std::fs;
use std::path::{Path, PathBuf};

use crate::models::domain::{JobRuntimeState, JobSnapshot};
use crate::models::request::CreateJobInput;

/// 最朴素的运行态任务：id `job-test`、默认输入、命令只有 `python`。
/// 只关心状态流转、不关心命令内容的测试都用它。
pub(crate) fn runtime_job() -> JobRuntimeState {
    JobSnapshot::new(
        "job-test".to_string(),
        CreateJobInput::default(),
        vec!["python".to_string()],
    )
    .into_runtime()
}

/// 建一个唯一的临时目录并返回；`name` 只为出问题时好认，唯一性靠随机后缀。
pub(crate) fn temp_root(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "retain-jobs-test-{name}-{}",
        fastrand::u64(..)
    ));
    fs::create_dir_all(&root).expect("create temp root");
    root
}

/// 带 `secrets/` 子目录的临时 data root，给凭据解析类测试用。
pub(crate) fn credential_test_root(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "retain-jobs-credential-{name}-{}",
        fastrand::u64(..)
    ));
    fs::create_dir_all(root.join("secrets")).expect("create credential test root");
    root
}

/// 写一份只含单条凭据的 vault。权限收到 0600：解析端会拒绝组/其他人可读的文件，
/// 不收紧的话测到的是权限错误而不是凭据解析。
pub(crate) fn write_credential_vault(
    root: &Path,
    credential_ref: &str,
    kind: &str,
    provider: &str,
    secret: &str,
) {
    let path = root.join("secrets").join("credentials.json");
    fs::write(
        &path,
        serde_json::json!({
            "schema": "retainpdf_credential_vault_v1",
            "credentials": {
                (credential_ref): {
                    "kind": kind,
                    "provider": provider,
                    "secret": secret
                }
            }
        })
        .to_string(),
    )
    .expect("write credential vault");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
            .expect("secure credential vault");
    }
}
