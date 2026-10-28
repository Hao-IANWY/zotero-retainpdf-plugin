use std::path::PathBuf;
use std::sync::Arc;

use super::capacity::{busy, UploadCapacity};
use super::pdf::{load_pdf_page_count, repair_pdf_with_pymupdf};
use super::staging::{
    prepare_staged_upload, prepare_upload, publish_upload, sanitize_upload_filename,
    StagedUpload, StagedUploadWriter,
};
use super::UploadError;
use crate::db::Db;
use crate::models::domain::UploadRecord;
use retain_core::config::{effective_upload_max_bytes, UploadProcessingConfig};

#[derive(Debug)]
pub(crate) struct UploadedPdfInput {
    pub(crate) filename: String,
    pub(crate) bytes: Vec<u8>,
    pub(crate) developer_mode: bool,
}

pub(crate) struct UploadServiceConfig {
    pub(crate) uploads_dir: PathBuf,
    pub(crate) python_bin: String,
    pub(crate) upload_max_bytes: u64,
    pub(crate) upload_max_pages: u32,
    /// 上传目录所在磁盘至少留多少空间（字节）；0 是不查。
    pub(crate) min_free_disk_bytes: u64,
    pub(crate) processing: UploadProcessingConfig,
}

struct UploadServiceInner {
    db: Arc<Db>,
    config: UploadServiceConfig,
    capacity: Arc<UploadCapacity>,
}

/// An application-owned upload executor. Clones share the same resource limits.
#[derive(Clone)]
pub(crate) struct UploadService {
    inner: Arc<UploadServiceInner>,
}

/// 接入许可:覆盖「请求读取 → 暂存 → 排队 → 解析 → 发布」全过程,
/// 由上传路由在读取任何文件字节之前取得。
pub(crate) type Admission = tokio::sync::OwnedSemaphorePermit;

impl UploadService {
    pub(crate) fn new(db: Arc<Db>, config: UploadServiceConfig) -> Self {
        let capacity = Arc::new(UploadCapacity::new(config.processing.clone()));
        Self {
            inner: Arc::new(UploadServiceInner {
                db,
                config,
                capacity,
            }),
        }
    }

    #[cfg(test)]
    pub(super) fn capacity(&self) -> Arc<UploadCapacity> {
        self.inner.capacity.clone()
    }

    /// 在读取任何文件字节之前取得接入许可。饱和即 503,让并发上传的
    /// 读取阶段(而不只是解析阶段)受控。
    pub(super) fn admit(&self) -> Result<Admission, UploadError> {
        self.inner
            .capacity
            .admitted
            .clone()
            .try_acquire_owned()
            .map_err(|_| busy())
    }

    /// 上传目录所在磁盘的剩余空间够不够再放 `incoming` 字节（加上配置的下限）。处理函数在读请求体之前用
    /// `incoming = 0` 先查一次，免得把几百 MB 收完才说放不下。
    pub(crate) fn ensure_free_space(&self, incoming: u64) -> Result<(), UploadError> {
        let config = &self.inner.config;
        if config.min_free_disk_bytes == 0 {
            return Ok(());
        }
        crate::services::disk_space::ensure_free_space(
            &config.uploads_dir,
            config.min_free_disk_bytes.saturating_add(incoming),
            "store this upload",
        )
        .map_err(|error| UploadError::InsufficientStorage(error.to_string()))
    }

    /// 为一次上传建立暂存目录与流式写入器。扩展名与文件名先于任何落盘
    /// 校验,非法输入零痕迹。
    pub(super) async fn begin_stage(
        &self,
        filename: &str,
    ) -> Result<StagedUploadWriter, UploadError> {
        if !filename.to_lowercase().ends_with(".pdf") {
            return Err(UploadError::bad_request("uploaded file must be a PDF"));
        }
        let safe_filename = sanitize_upload_filename(filename)?;
        StagedUploadWriter::create(
            &self.inner.config.uploads_dir,
            &safe_filename,
            filename.to_string(),
        )
        .await
    }

    /// 流式上传的交接:接管接入许可与暂存文件,排队解析、必要时修复、发布。
    /// 许可与目录守卫贯穿整个后台流程,HTTP 调用方断开不影响容量归位。
    pub(crate) async fn commit(
        &self,
        admission: Admission,
        staged: StagedUpload,
        developer_mode: bool,
    ) -> Result<UploadRecord, UploadError> {
        // 读取阶段已按同一上限拦截;这里兜底防绕过。
        let max = effective_upload_max_bytes(self.inner.config.upload_max_bytes).get();
        if staged.byte_count > max {
            return Err(UploadError::payload_too_large("request body is too large"));
        }
        // 原文要落两份（原样一份、修复或规范化后一份），按两倍文件大小加上下限算。
        self.ensure_free_space(staged.byte_count.saturating_mul(2))?;
        let byte_count = staged.byte_count;
        self.run_worker(admission, byte_count, move || {
            prepare_staged_upload(staged, developer_mode)
        })
        .await
    }

    /// 字节路径:任务创建(OCR 上传)仍以整份字节提交。读取侧的接入控制
    /// 由调用方负责,这里只管解析资源预算。
    pub(crate) async fn store(
        &self,
        upload: UploadedPdfInput,
    ) -> Result<UploadRecord, UploadError> {
        if !upload.filename.to_lowercase().ends_with(".pdf") {
            return Err(UploadError::bad_request("uploaded file must be a PDF"));
        }
        let upload_max_bytes = effective_upload_max_bytes(self.inner.config.upload_max_bytes).get();
        let byte_count = upload.bytes.len() as u64;
        if byte_count > upload_max_bytes {
            return Err(UploadError::payload_too_large("request body is too large"));
        }
        let safe_filename = sanitize_upload_filename(&upload.filename)?;
        // 原文要落两份（原样一份、修复或规范化后一份），按两倍文件大小加上下限算。
        self.ensure_free_space(byte_count.saturating_mul(2))?;
        let admission = self.admit()?;
        let uploads_dir = self.inner.config.uploads_dir.clone();
        self.run_worker(admission, byte_count, move || {
            prepare_upload(&uploads_dir, upload, safe_filename, byte_count)
        })
        .await
    }

    /// 解析→修复→发布的共享流程。`prepare` 在解析许可与缓冲预算就位后
    /// 于阻塞线程执行,产出待发布(或待修复)的上传。
    async fn run_worker(
        &self,
        admission: Admission,
        byte_count: u64,
        prepare: impl FnOnce() -> Result<super::staging::PreparedUpload, UploadError> + Send + 'static,
    ) -> Result<UploadRecord, UploadError> {
        let upload_max_pages = self.inner.config.upload_max_pages;
        let capacity = self.inner.capacity.clone();
        let buffer = capacity.reserve_buffer(byte_count)?;
        let permit = capacity.acquire(&capacity.parse).await?;
        let db = self.inner.db.clone();
        let python_bin = self.inner.config.python_bin.to_string();
        // The admitted worker owns the permit and directory even if the HTTP
        // caller disconnects. Never release capacity while a parser is still alive.
        tokio::spawn(async move {
            let _admission = admission;
            let prepared = tokio::task::spawn_blocking(move || {
                let _permit = permit;
                let _buffer = buffer;
                prepare()
            })
            .await
            .map_err(|_| UploadError::internal("PDF upload worker failed"))??;
            let prepared = if prepared.page_count.is_none() {
                // No parsing permit or original file is held while waiting for repair.
                let repair = match capacity.acquire(&capacity.repair).await {
                    Ok(permit) => permit,
                    Err(error) => {
                        let _ = tokio::task::spawn_blocking(move || drop(prepared)).await;
                        return Err(error);
                    }
                };
                tokio::task::spawn_blocking(move || {
                    let _repair = repair;
                    let mut prepared = prepared;
                    repair_pdf_with_pymupdf(&prepared.path, &python_bin)?;
                    prepared.page_count = Some(
                        load_pdf_page_count(&prepared.path)
                            .map_err(|_| UploadError::bad_request("invalid pdf after repair"))?,
                    );
                    Ok::<_, UploadError>(prepared)
                })
                .await
                .map_err(|_| UploadError::internal("PDF repair worker failed"))??
            } else {
                prepared
            };
            tokio::task::spawn_blocking(move || publish_upload(&db, prepared, upload_max_pages))
                .await
                .map_err(|_| UploadError::internal("PDF publication worker failed"))?
        })
        .await
        .map_err(|_| UploadError::internal("PDF upload worker failed"))?
    }
}
