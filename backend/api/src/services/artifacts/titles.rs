//! 书名：一个任务 / 一本书在界面上叫什么。
//!
//! 书籍详情、书架卡片、任务列表、下载文件名用的都是这一个规则：所属文档的标题优先（会被
//! 自动改名 / 手改），其次上传文件名（或来源 URL 的文件名），最后才是 job_id。
//!
//! 放在 artifacts（共享展示）而不是 book_projection：jobs 不能依赖 book_projection
//! （check_architecture.py），而任务列表和下载命名都要用它。

use std::collections::HashMap;

use crate::db::Db;
use crate::models::domain::{JobSnapshot, UploadRecord};

/// `document_id`（= 上传内容的 sha256）→ 文档当前标题。
pub(crate) type DocumentTitles = HashMap<String, String>;

pub(crate) fn document_title(upload: Option<&UploadRecord>, titles: &DocumentTitles) -> Option<String> {
    let hash = upload?.content_hash.trim();
    (!hash.is_empty()).then(|| titles.get(hash).cloned()).flatten()
}

/// 给一批上传记录查它们所属文档的标题。查询失败就当没有 —— 退回文件名，不影响列表。
pub(crate) fn document_titles_for<'a>(
    db: &Db,
    uploads: impl IntoIterator<Item = &'a UploadRecord>,
) -> DocumentTitles {
    let ids: Vec<String> = uploads
        .into_iter()
        .map(|upload| upload.content_hash.trim().to_string())
        .filter(|hash| !hash.is_empty())
        .collect();
    db.document_titles(&ids).unwrap_or_default()
}

/// 单个任务的书名（下载文件名用）。
pub(crate) fn job_display_title(db: &Db, job: &JobSnapshot) -> String {
    let upload_id = job.upload_id.as_deref().map(str::trim).filter(|id| !id.is_empty());
    let ids: Vec<&str> = upload_id.into_iter().collect();
    let uploads = db.get_uploads(&ids).unwrap_or_default();
    let upload = upload_id.and_then(|id| uploads.get(id));
    let titles = document_titles_for(db, upload);
    document_title(upload, &titles)
        .or_else(|| upload.map(|u| u.filename.trim().to_string()).filter(|name| !name.is_empty()))
        .or_else(|| source_url_file_name(&job.request_payload.source.source_url))
        .unwrap_or_else(|| job.job_id.clone())
}

/// 来源 URL 的最后一段（去掉 `#…` 和 `?…`）。书架、任务列表、下载命名共用这一份。
pub(crate) fn source_url_file_name(source_url: &str) -> Option<String> {
    let trimmed = source_url.trim();
    let no_fragment = trimmed.split('#').next().unwrap_or(trimmed);
    let no_query = no_fragment.split('?').next().unwrap_or(no_fragment);
    let candidate = no_query.rsplit('/').next().unwrap_or(no_query).trim();
    (!candidate.is_empty()).then(|| candidate.to_string())
}
