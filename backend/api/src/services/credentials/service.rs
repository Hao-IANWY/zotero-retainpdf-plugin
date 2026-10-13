//! Credential vault operations and usage-lock lifecycle.

use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{RwLock, RwLockReadGuard};

use axum::http::StatusCode;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};

use crate::db::Db;
use crate::error::AppError;
use crate::models::domain::now_iso;

const VAULT_SCHEMA: &str = "retainpdf_credential_vault_v1";
const VAULT_LOCK_NAME: &str = ".credentials.lock";
const MAX_VAULT_BYTES: u64 = 256 * 1024;
const MAX_SECRET_BYTES: usize = 8192;
const MANAGED_BY_LEGACY_JOB_IMPORT: &str = "legacy_job_import";
static VAULT_ACCESS_LOCK: Lazy<RwLock<()>> = Lazy::new(|| RwLock::new(()));

struct VaultFileLock {
    file: fs::File,
}

#[cfg(unix)]
impl Drop for VaultFileLock {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;

        // SAFETY: `file` remains open for the lifetime of this guard and flock
        // only reads the descriptor value. Unlock failure cannot be recovered
        // during Drop; closing the descriptor releases the lock as a fallback.
        let _ = unsafe { libc::flock(self.file.as_raw_fd(), libc::LOCK_UN) };
    }
}

#[cfg(not(unix))]
impl Drop for VaultFileLock {
    fn drop(&mut self) {}
}

/// Keeps a credential reference stable from validation through job
/// persistence. The process-local read guard permits concurrent submissions;
/// the file guard extends the same ordering across backend processes on POSIX.
pub(crate) struct CredentialUsageLock {
    _process_guard: RwLockReadGuard<'static, ()>,
    _file_guard: VaultFileLock,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredCredential {
    kind: String,
    provider: String,
    label: String,
    secret: String,
    #[serde(default)]
    revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    managed_by: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CredentialVault {
    schema: String,
    revision: u64,
    credentials: BTreeMap<String, StoredCredential>,
}

impl Default for CredentialVault {
    fn default() -> Self {
        Self {
            schema: VAULT_SCHEMA.to_string(),
            revision: 0,
            credentials: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateCredentialInput {
    pub kind: String,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub label: String,
    pub secret: String,
    #[serde(default)]
    pub expected_revision: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateCredentialInput {
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub secret: Option<String>,
    #[serde(default)]
    pub expected_revision: Option<u64>,
    #[serde(default)]
    pub expected_credential_revision: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct DeleteCredentialQuery {
    #[serde(default)]
    pub expected_revision: Option<u64>,
    #[serde(default)]
    pub force: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct CredentialMetadataView {
    pub credential_ref: String,
    pub kind: String,
    pub provider: String,
    pub label: String,
    pub configured: bool,
    pub revision: u64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CredentialListView {
    pub credentials: Vec<CredentialMetadataView>,
    pub revision: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CredentialMutationView {
    pub credential: CredentialMetadataView,
    pub revision: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CredentialDeleteView {
    pub credential_ref: String,
    pub deleted: bool,
    pub revision: u64,
}

/// 列表只回元数据，永不回 secret：这个路由过的是与任务接口同一把
/// X-API-Key 门，浏览器侧部署里这把门防不住页面访客，把值吐出去等于
/// 把密钥库明文挂在 API 上。要看值请在宿主机直接读 data/secrets/credentials.json。
pub fn list_credentials(data_root: &Path) -> Result<CredentialListView, AppError> {
    let vault = load_vault(data_root)?;
    Ok(CredentialListView {
        credentials: vault
            .credentials
            .iter()
            .map(|(credential_ref, credential)| metadata(credential_ref, credential))
            .collect(),
        revision: vault.revision,
    })
}

pub fn get_credential_metadata(
    data_root: &Path,
    credential_ref: &str,
) -> Result<CredentialMutationView, AppError> {
    validate_credential_ref(credential_ref)?;
    let vault = load_vault(data_root)?;
    let credential = vault
        .credentials
        .get(credential_ref)
        .ok_or_else(|| AppError::not_found("credential reference not found"))?;
    Ok(CredentialMutationView {
        credential: metadata(credential_ref, credential),
        revision: vault.revision,
    })
}

pub fn create_credential(
    data_root: &Path,
    input: CreateCredentialInput,
) -> Result<CredentialMutationView, AppError> {
    let kind = validate_kind(&input.kind)?;
    let provider = normalize_short_text("provider", &input.provider, 128)?;
    let label = normalize_short_text("label", &input.label, 256)?;
    let secret = validate_secret(&input.secret)?;
    mutate_vault(data_root, input.expected_revision, move |vault| {
        let credential_ref = next_credential_ref(vault);
        let timestamp = now_iso();
        let credential = StoredCredential {
            kind,
            provider,
            label,
            secret,
            revision: 1,
            managed_by: None,
            created_at: timestamp.clone(),
            updated_at: timestamp,
        };
        vault
            .credentials
            .insert(credential_ref.clone(), credential.clone());
        Ok((credential_ref, credential))
    })
}

pub fn update_credential(
    data_root: &Path,
    credential_ref: &str,
    input: UpdateCredentialInput,
) -> Result<CredentialMutationView, AppError> {
    validate_credential_ref(credential_ref)?;
    let credential_ref = credential_ref.to_string();
    let kind = input.kind.as_deref().map(validate_kind).transpose()?;
    let provider = input
        .provider
        .as_deref()
        .map(|value| normalize_short_text("provider", value, 128))
        .transpose()?;
    let label = input
        .label
        .as_deref()
        .map(|value| normalize_short_text("label", value, 256))
        .transpose()?;
    let secret = input.secret.as_deref().map(validate_secret).transpose()?;
    if kind.is_none() && provider.is_none() && label.is_none() && secret.is_none() {
        return Err(AppError::bad_request("credential update is empty"));
    }
    // New clients fence the specific record. The vault-wide revision remains
    // the fallback for older clients, but must not reject an update merely
    // because an unrelated OCR or Agent credential changed meanwhile.
    let expected_vault_revision = if input.expected_credential_revision.is_some() {
        None
    } else {
        input.expected_revision
    };
    let expected_credential_revision = input.expected_credential_revision;
    mutate_vault(data_root, expected_vault_revision, move |vault| {
        let current = vault
            .credentials
            .get_mut(&credential_ref)
            .ok_or_else(|| AppError::not_found("credential reference not found"))?;
        if expected_credential_revision.is_some_and(|expected| expected != current.revision) {
            return Err(AppError::credential_reference(
                StatusCode::CONFLICT,
                "CREDENTIAL_REVISION_CONFLICT",
                "凭据已在其他窗口更新，请重新加载后再保存",
            ));
        }
        if let Some(value) = kind {
            current.kind = value;
        }
        if let Some(value) = provider {
            current.provider = value;
        }
        if let Some(value) = label {
            current.label = value;
        }
        if let Some(value) = secret {
            current.secret = value;
        }
        // Any explicit API mutation transfers lifecycle ownership to the user.
        // This prevents a later job-deletion GC pass from removing a credential
        // that the user intentionally retained or repurposed.
        current.managed_by = None;
        current.revision = current.revision.saturating_add(1);
        current.updated_at = now_iso();
        Ok((credential_ref.clone(), current.clone()))
    })
}

/// Imports a legacy inline job secret without growing the vault for every
/// submission. Only credentials created by this same import path are eligible
/// for reuse; user-created credentials remain distinct even when their secret
/// and metadata happen to match.
pub(crate) fn get_or_create_managed_credential(
    data_root: &Path,
    kind: &str,
    provider: &str,
    label: &str,
    secret: &str,
) -> Result<CredentialMutationView, AppError> {
    let kind = validate_kind(kind)?;
    let provider = normalize_short_text("provider", provider, 128)?.to_ascii_lowercase();
    let label = normalize_short_text("label", label, 256)?;
    let secret = validate_secret(secret)?;
    let _guard = VAULT_ACCESS_LOCK
        .write()
        .map_err(|_| AppError::internal("credential vault lock is poisoned"))?;
    let _file_guard = acquire_vault_file_lock(data_root, true)?;
    let mut vault = load_vault(data_root)?;

    if let Some((credential_ref, credential)) = vault.credentials.iter().find(|(_, item)| {
        item.managed_by.as_deref() == Some(MANAGED_BY_LEGACY_JOB_IMPORT)
            && item.kind == kind
            && item.provider.trim().eq_ignore_ascii_case(&provider)
            && item.secret == secret
    }) {
        return Ok(CredentialMutationView {
            credential: metadata(credential_ref, credential),
            revision: vault.revision,
        });
    }

    let credential_ref = next_credential_ref(&vault);
    let timestamp = now_iso();
    let credential = StoredCredential {
        kind,
        provider,
        label,
        secret,
        revision: 1,
        managed_by: Some(MANAGED_BY_LEGACY_JOB_IMPORT.to_string()),
        created_at: timestamp.clone(),
        updated_at: timestamp,
    };
    vault
        .credentials
        .insert(credential_ref.clone(), credential.clone());
    vault.revision = vault.revision.saturating_add(1);
    save_vault(data_root, &vault)?;
    Ok(CredentialMutationView {
        credential: metadata(&credential_ref, &credential),
        revision: vault.revision,
    })
}

/// Removes one automatically imported credential when it is no longer
/// replayable from any persisted job and is not selected by the AI runtime.
/// Manual credentials and managed credentials still in use are left intact.
/// The check and removal share the same cross-process vault write lock used by
/// job credential usage guards.
#[allow(dead_code)] // wired by job/document deletion in the lifecycle integration phase
pub(crate) fn delete_unreferenced_managed_credential(
    db: &Db,
    data_root: &Path,
    credential_ref: &str,
) -> Result<bool, AppError> {
    validate_credential_ref(credential_ref)?;
    let _guard = VAULT_ACCESS_LOCK
        .write()
        .map_err(|_| AppError::internal("credential vault lock is poisoned"))?;
    let _file_guard = acquire_vault_file_lock(data_root, true)?;
    let mut vault = load_vault(data_root)?;
    let Some(credential) = vault.credentials.get(credential_ref) else {
        return Ok(false);
    };
    if credential.managed_by.as_deref() != Some(MANAGED_BY_LEGACY_JOB_IMPORT) {
        return Ok(false);
    }
    let referenced_by_job = db
        .count_jobs_referencing_credential(credential_ref)
        .map_err(|_| AppError::internal("credential reference usage cannot be determined"))?
        > 0;
    if referenced_by_job {
        return Ok(false);
    }

    vault.credentials.remove(credential_ref);
    vault.revision = vault.revision.saturating_add(1);
    save_vault(data_root, &vault)?;
    Ok(true)
}

pub fn delete_credential(
    db: &Db,
    data_root: &Path,
    credential_ref: &str,
    expected_revision: Option<u64>,
    force: bool,
) -> Result<CredentialDeleteView, AppError> {
    validate_credential_ref(credential_ref)?;
    let _guard = VAULT_ACCESS_LOCK
        .write()
        .map_err(|_| AppError::internal("credential vault lock is poisoned"))?;
    let _file_guard = acquire_vault_file_lock(data_root, true)?;
    let mut vault = load_vault(data_root)?;
    require_revision(&vault, expected_revision)?;
    if !vault.credentials.contains_key(credential_ref) {
        return Err(AppError::not_found("credential reference not found"));
    }
    let is_referenced = if force {
        false
    } else {
        let referenced_by_job = db
            .count_jobs_referencing_credential(credential_ref)
            .map_err(|_| AppError::internal("credential reference usage cannot be determined"))?
            > 0;
        referenced_by_job
    };
    if is_referenced {
        return Err(AppError::credential_reference(
            StatusCode::CONFLICT,
            "CREDENTIAL_IN_USE",
            "credential is referenced by persisted jobs; use force=true only after confirming the recovery impact",
        ));
    }
    vault.credentials.remove(credential_ref);
    vault.revision = vault.revision.saturating_add(1);
    save_vault(data_root, &vault)?;
    Ok(CredentialDeleteView {
        credential_ref: credential_ref.to_string(),
        deleted: true,
        revision: vault.revision,
    })
}

fn mutate_vault<F>(
    data_root: &Path,
    expected_revision: Option<u64>,
    mutation: F,
) -> Result<CredentialMutationView, AppError>
where
    F: FnOnce(&mut CredentialVault) -> Result<(String, StoredCredential), AppError>,
{
    let _guard = VAULT_ACCESS_LOCK
        .write()
        .map_err(|_| AppError::internal("credential vault lock is poisoned"))?;
    let _file_guard = acquire_vault_file_lock(data_root, true)?;
    let mut vault = load_vault(data_root)?;
    require_revision(&vault, expected_revision)?;
    let (credential_ref, credential) = mutation(&mut vault)?;
    vault.revision = vault.revision.saturating_add(1);
    save_vault(data_root, &vault)?;
    Ok(CredentialMutationView {
        credential: metadata(&credential_ref, &credential),
        revision: vault.revision,
    })
}

fn next_credential_ref(vault: &CredentialVault) -> String {
    loop {
        let candidate = format!("cred_{:016x}", fastrand::u64(..));
        if !vault.credentials.contains_key(&candidate) {
            return candidate;
        }
    }
}

fn require_revision(vault: &CredentialVault, expected: Option<u64>) -> Result<(), AppError> {
    if expected.is_some_and(|expected| expected != vault.revision) {
        return Err(AppError::credential_reference(
            StatusCode::CONFLICT,
            "CREDENTIAL_VAULT_REVISION_CONFLICT",
            "凭据列表已发生变化，请重新加载后再保存",
        ));
    }
    Ok(())
}

fn metadata(credential_ref: &str, credential: &StoredCredential) -> CredentialMetadataView {
    CredentialMetadataView {
        credential_ref: credential_ref.to_string(),
        kind: credential.kind.clone(),
        provider: credential.provider.clone(),
        label: credential.label.clone(),
        configured: !credential.secret.is_empty(),
        revision: credential.revision,
        created_at: credential.created_at.clone(),
        updated_at: credential.updated_at.clone(),
    }
}

fn vault_path(data_root: &Path) -> PathBuf {
    data_root.join("secrets").join("credentials.json")
}

fn load_vault(data_root: &Path) -> Result<CredentialVault, AppError> {
    let path = vault_path(data_root);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(CredentialVault::default())
        }
        Err(_) => return Err(AppError::internal("credential vault is unreadable")),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > MAX_VAULT_BYTES
    {
        return Err(AppError::internal("credential vault path is unsafe"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(AppError::internal(
                "credential vault permissions must be 0600",
            ));
        }
    }
    let bytes =
        fs::read(&path).map_err(|_| AppError::internal("credential vault is unreadable"))?;
    let vault: CredentialVault = serde_json::from_slice(&bytes)
        .map_err(|_| AppError::internal("credential vault is invalid"))?;
    if vault.schema != VAULT_SCHEMA
        || vault.credentials.iter().any(|(credential_ref, item)| {
            validate_credential_ref(credential_ref).is_err()
                || item.secret.is_empty()
                || item.secret.len() > MAX_SECRET_BYTES
                || validate_credential_ref_shape(&item.kind).is_err()
                || item.managed_by.as_deref().is_some_and(|value| {
                    value != MANAGED_BY_LEGACY_JOB_IMPORT
                        || validate_credential_ref_shape(value).is_err()
                })
        })
    {
        return Err(AppError::internal("credential vault is invalid"));
    }
    Ok(vault)
}

fn save_vault(data_root: &Path, vault: &CredentialVault) -> Result<(), AppError> {
    let path = vault_path(data_root);
    let directory = prepare_vault_directory(data_root)?;
    debug_assert_eq!(path.parent(), Some(directory.as_path()));
    let directory = directory.as_path();
    let encoded = serde_json::to_vec(vault)
        .map_err(|_| AppError::internal("credential vault cannot be encoded"))?;
    if encoded.len() as u64 > MAX_VAULT_BYTES {
        return Err(AppError::bad_request("credential vault is full"));
    }
    let temporary = directory.join(format!(
        ".credentials.json.{}-{:016x}.tmp",
        std::process::id(),
        fastrand::u64(..)
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let result = (|| -> Result<(), AppError> {
        let mut file = options
            .open(&temporary)
            .map_err(|_| AppError::internal("credential vault cannot be written"))?;
        file.write_all(&encoded)
            .and_then(|_| file.sync_all())
            .map_err(|_| AppError::internal("credential vault cannot be written"))?;
        fs::rename(&temporary, &path)
            .map_err(|_| AppError::internal("credential vault cannot be published"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
                .map_err(|_| AppError::internal("credential vault cannot be secured"))?;
            let directory_handle = fs::File::open(directory)
                .map_err(|_| AppError::internal("credential vault directory cannot be synced"))?;
            directory_handle
                .sync_all()
                .map_err(|_| AppError::internal("credential vault directory cannot be synced"))?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn prepare_vault_directory(data_root: &Path) -> Result<PathBuf, AppError> {
    let directory = vault_path(data_root)
        .parent()
        .ok_or_else(|| AppError::internal("credential vault path is invalid"))?
        .to_path_buf();
    fs::create_dir_all(&directory)
        .map_err(|_| AppError::internal("credential vault directory cannot be created"))?;
    let directory_metadata = fs::symlink_metadata(&directory)
        .map_err(|_| AppError::internal("credential vault directory is unreadable"))?;
    if directory_metadata.file_type().is_symlink() || !directory_metadata.is_dir() {
        return Err(AppError::internal("credential vault directory is unsafe"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
            .map_err(|_| AppError::internal("credential vault directory cannot be secured"))?;
    }
    Ok(directory)
}

pub(crate) fn acquire_credential_usage_lock(
    data_root: &Path,
) -> Result<CredentialUsageLock, AppError> {
    let process_guard = VAULT_ACCESS_LOCK
        .read()
        .map_err(|_| AppError::internal("credential vault lock is poisoned"))?;
    let file_guard = acquire_vault_file_lock(data_root, false)?;
    Ok(CredentialUsageLock {
        _process_guard: process_guard,
        _file_guard: file_guard,
    })
}

fn acquire_vault_file_lock(data_root: &Path, exclusive: bool) -> Result<VaultFileLock, AppError> {
    let directory = prepare_vault_directory(data_root)?;
    let lock_path = directory.join(VAULT_LOCK_NAME);
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let file = options
        .open(&lock_path)
        .map_err(|_| AppError::internal("credential vault lock cannot be opened"))?;
    let metadata = fs::symlink_metadata(&lock_path)
        .map_err(|_| AppError::internal("credential vault lock is unreadable"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(AppError::internal("credential vault lock path is unsafe"));
    }
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::PermissionsExt;

        fs::set_permissions(&lock_path, fs::Permissions::from_mode(0o600))
            .map_err(|_| AppError::internal("credential vault lock cannot be secured"))?;
        // SAFETY: the descriptor is valid and retained by `VaultFileLock`
        // until the critical section finishes.
        let operation = if exclusive {
            libc::LOCK_EX
        } else {
            libc::LOCK_SH
        };
        if unsafe { libc::flock(file.as_raw_fd(), operation) } != 0 {
            return Err(AppError::internal(
                "credential vault lock cannot be acquired",
            ));
        }
    }
    Ok(VaultFileLock { file })
}

fn validate_credential_ref(value: &str) -> Result<(), AppError> {
    if !value.starts_with("cred_") || validate_credential_ref_shape(value).is_err() {
        return Err(AppError::bad_request("credential_ref is invalid"));
    }
    Ok(())
}

fn validate_credential_ref_shape(value: &str) -> Result<(), ()> {
    if value.is_empty()
        || value.len() > 64
        || !value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_' || byte == b'-'
        })
    {
        return Err(());
    }
    Ok(())
}

fn validate_kind(value: &str) -> Result<String, AppError> {
    let value = value.trim().to_ascii_lowercase();
    validate_credential_ref_shape(&value)
        .map_err(|_| AppError::bad_request("credential kind is invalid"))?;
    Ok(value)
}

fn normalize_short_text(name: &str, value: &str, max: usize) -> Result<String, AppError> {
    let value = value.trim();
    if value.len() > max || value.chars().any(char::is_control) {
        return Err(AppError::bad_request(format!("{name} is invalid")));
    }
    Ok(value.to_string())
}

fn validate_secret(value: &str) -> Result<String, AppError> {
    let value = value.trim();
    if value.is_empty() || value.len() > MAX_SECRET_BYTES || value.contains('\0') {
        return Err(AppError::bad_request("credential secret is invalid"));
    }
    Ok(value.to_string())
}

#[cfg(test)]
mod tests;
