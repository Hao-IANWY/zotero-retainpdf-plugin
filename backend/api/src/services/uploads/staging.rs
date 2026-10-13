use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use super::pdf::load_pdf_page_count;
use super::{UploadError, UploadedPdfInput};
use crate::db::Db;
use crate::models::domain::{build_job_id, now_iso, UploadRecord};
use std::path::{Path, PathBuf};

struct PendingUpload(PathBuf);

impl Drop for PendingUpload {
    fn drop(&mut self) {
        if !self.0.as_os_str().is_empty() {
            if let Err(error) = std::fs::remove_dir_all(&self.0) {
                tracing::warn!(error_kind = ?error.kind(), "failed to remove rejected upload directory");
            }
        }
    }
}

/// Reduces a client-supplied multipart filename to a bare file-name component
/// so it can never be used to escape the per-upload directory (e.g. via
/// `../../etc/x.pdf` or an absolute path like `/etc/x.pdf`).
pub(super) fn sanitize_upload_filename(filename: &str) -> Result<PathBuf, UploadError> {
    if filename.contains('\0') {
        return Err(UploadError::bad_request("uploaded filename is invalid"));
    }
    let candidate = Path::new(filename)
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| UploadError::bad_request("uploaded filename is invalid"))?;
    if candidate.is_empty()
        || candidate == "."
        || candidate == ".."
        || candidate.contains('/')
        || candidate.contains('\\')
    {
        return Err(UploadError::bad_request("uploaded filename is invalid"));
    }
    Ok(PathBuf::from(candidate))
}

pub(super) struct PreparedUpload {
    pending: PendingUpload,
    pub(super) path: PathBuf,
    record: UploadRecord,
    pub(super) page_count: Option<u32>,
}

/// 请求读取阶段的流式暂存写入器:文件分块落盘,不在内存攒整份文件。
/// 持有暂存目录守卫,超限/断开/校验失败时随 drop 统一清理。
pub(super) struct StagedUploadWriter {
    pending: PendingUpload,
    file: tokio::fs::File,
    pub(super) upload_id: String,
    pub(super) filename: String,
    pub(super) path: PathBuf,
    byte_count: u64,
    hasher: Sha256,
}

impl StagedUploadWriter {
    /// 新建本上传独占的暂存目录与目标文件。目录冲突即失败(绝不复用别人的目录)。
    pub(super) async fn create(
        uploads_dir: &Path,
        safe_filename: &Path,
        filename: String,
    ) -> Result<Self, UploadError> {
        std::fs::create_dir_all(uploads_dir)?;
        let upload_id = build_job_id();
        let upload_dir = uploads_dir.join(&upload_id);
        std::fs::create_dir(&upload_dir)?;
        let pending = PendingUpload(upload_dir.clone());
        let path = upload_dir.join(safe_filename);
        let file = tokio::fs::File::create(&path).await?;
        Ok(Self {
            pending,
            file,
            upload_id,
            filename,
            path,
            byte_count: 0,
            hasher: Sha256::new(),
        })
    }

    /// 追加一块并按实际收到的字节累计检查上限。超限返回 413,
    /// 目录守卫随 drop 清理,不留下半个文件。
    pub(super) async fn write_chunk(
        &mut self,
        chunk: &[u8],
        max_bytes: u64,
    ) -> Result<(), UploadError> {
        let chunk_len = u64::try_from(chunk.len()).map_err(|_| multipart_too_large())?;
        let byte_count = self
            .byte_count
            .checked_add(chunk_len)
            .ok_or_else(multipart_too_large)?;
        if byte_count > max_bytes {
            return Err(multipart_too_large());
        }
        self.byte_count = byte_count;
        self.hasher.update(chunk);
        self.file.write_all(chunk).await?;
        Ok(())
    }

    /// 结束写入:冲刷句柄,冻结为待处理的暂存文件。
    pub(super) async fn finish(mut self) -> Result<StagedUpload, UploadError> {
        self.file.flush().await?;
        drop(self.file);
        Ok(StagedUpload {
            pending: self.pending,
            upload_id: self.upload_id,
            filename: self.filename,
            path: self.path,
            byte_count: self.byte_count,
            content_hash: finalize_hasher(self.hasher),
        })
    }
}

fn multipart_too_large() -> UploadError {
    UploadError::payload_too_large("request body is too large")
}

fn finalize_hasher(hasher: Sha256) -> String {
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// 已写完、待进入解析队列的暂存文件。守卫仍在本结构手里,
/// 发布成功才释放,任何失败路径都由 drop 清理。
pub(crate) struct StagedUpload {
    pending: PendingUpload,
    pub(super) upload_id: String,
    pub(super) filename: String,
    pub(super) path: PathBuf,
    pub(super) byte_count: u64,
    pub(super) content_hash: String,
}

/// 暂存文件进入解析准备:页数探测 + 记录组装。不再搬运字节——
/// 文件已经在暂存目录的最终位置。
pub(super) fn prepare_staged_upload(
    staged: StagedUpload,
    developer_mode: bool,
) -> Result<PreparedUpload, UploadError> {
    let page_count = load_pdf_page_count(&staged.path).ok();
    let record = UploadRecord {
        upload_id: staged.upload_id,
        filename: staged.filename,
        stored_path: staged.path.to_string_lossy().to_string(),
        bytes: staged.byte_count,
        page_count: page_count.unwrap_or(0),
        uploaded_at: now_iso(),
        developer_mode,
        content_hash: staged.content_hash,
    };
    Ok(PreparedUpload {
        pending: staged.pending,
        path: staged.path,
        record,
        page_count,
    })
}

pub(super) fn prepare_upload(
    uploads_dir: &Path,
    upload: UploadedPdfInput,
    safe_filename: PathBuf,
    byte_count: u64,
) -> Result<PreparedUpload, UploadError> {
    let upload_id = build_job_id();
    let upload_dir = uploads_dir.join(&upload_id);
    std::fs::create_dir_all(uploads_dir)?;
    // Own only a newly created directory; a collision must not delete others' data.
    std::fs::create_dir(&upload_dir)?;
    let pending = PendingUpload(upload_dir.clone());
    let upload_path: PathBuf = upload_dir.join(&safe_filename);
    std::fs::write(&upload_path, &upload.bytes)?;

    let page_count = load_pdf_page_count(&upload_path).ok();
    let content_hash = crate::db::documents::sha256_hex(&upload.bytes);
    let record = UploadRecord {
        upload_id,
        filename: upload.filename,
        stored_path: upload_path.to_string_lossy().to_string(),
        bytes: byte_count,
        page_count: page_count.unwrap_or(0),
        uploaded_at: now_iso(),
        developer_mode: upload.developer_mode,
        content_hash,
    };
    Ok(PreparedUpload {
        pending,
        path: upload_path,
        record,
        page_count,
    })
}

pub(super) fn publish_upload(
    db: &Db,
    mut prepared: PreparedUpload,
    upload_max_pages: u32,
) -> Result<UploadRecord, UploadError> {
    let page_count = prepared
        .page_count
        .ok_or_else(|| UploadError::internal("PDF validation incomplete"))?;
    if upload_max_pages > 0 && page_count > upload_max_pages {
        return Err(UploadError::bad_request(format!(
            "当前服务限制：PDF 页数必须不超过 {} 页",
            upload_max_pages
        )));
    }
    prepared.record.page_count = page_count;
    db.save_upload_with_document(&prepared.record)
        .map_err(|_| UploadError::internal("Failed to publish uploaded PDF"))?;
    prepared.pending.0 = PathBuf::new();
    Ok(prepared.record)
}
