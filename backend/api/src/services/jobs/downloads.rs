use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::db::Db;
use crate::services::download_generation::DownloadGeneration;

use self::deps::DownloadJobsDeps;

// Keep this file as the small public facade for job downloads. Concrete
// handlers live in submodules so PDF, markdown, preview, and artifact behavior
// can evolve without turning one route helper into another large grab bag.
mod artifact_deps;
mod artifacts;
mod deps;
mod documents;
mod markdown;
mod paths;
mod pdf;
mod previews;
mod service;
mod side_by_side;
mod word;

#[cfg(all(test, unix))]
#[cfg(all(test, unix))]
mod tests;

use artifacts::{bundle_download, registered_artifact_download};
use documents::document_download;
pub(crate) use documents::DocumentDownloadKind;
use markdown::{
    markdown_document_view, markdown_download, markdown_image_download, markdown_raw_download,
};
use previews::{cover_download, page_preview_download, thumbnail_download};
use side_by_side::side_by_side_pdf_download;
use word::layout_docx_download;

/// Download capabilities contain no launcher, upload, control, or replay state.
pub struct JobDownloads<'a> {
    deps: DownloadJobsDeps<'a>,
}

impl<'a> JobDownloads<'a> {
    pub(crate) fn new(
        db: &'a Db,
        data_root: &'a Path,
        downloads_dir: &'a Path,
        download_generation: &'a Arc<DownloadGeneration>,
        python_bin: &'a str,
        pipeline_command: &'a str,
    ) -> Self {
        Self {
            deps: DownloadJobsDeps {
                db,
                data_root,
                downloads_dir,
                download_generation,
                python_bin,
                pipeline_command,
            },
        }
    }
}

#[derive(Clone, Debug)]
pub struct FileDownload {
    pub path: PathBuf,
    pub content_type: String,
    pub download_name: Option<String>,
    /// 不强制下载（照常在浏览器里打开）但给个文件名：`inline; filename=…`。
    /// 译文 PDF、Markdown 这类「查看」和「下载」共用一个端点的，用这个。
    pub inline_name: Option<String>,
    pub job_id_header: Option<String>,
}

impl FileDownload {
    pub fn new(
        path: PathBuf,
        content_type: impl Into<String>,
        download_name: Option<String>,
    ) -> Self {
        Self {
            path,
            content_type: content_type.into(),
            download_name,
            inline_name: None,
            job_id_header: None,
        }
    }

    pub fn with_inline_name(mut self, name: impl Into<String>) -> Self {
        self.inline_name = Some(name.into());
        self
    }

    pub fn with_job_id_header(mut self, job_id: impl Into<String>) -> Self {
        self.job_id_header = Some(job_id.into());
        self
    }
}

#[derive(Debug)]
pub struct MarkdownDownload {
    pub job_id: String,
    pub content: String,
}
