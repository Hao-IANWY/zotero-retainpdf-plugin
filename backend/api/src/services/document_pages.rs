//! 「这个任务的第 i 页，是文档的第几页」—— 实现和来由见 `retain_core::document_pages`。
//!
//! 挪到 retain-core 是因为全文索引（retain-db）也要按文档页挑每页取哪个任务。

pub(crate) use retain_core::document_pages::translated_document_pages;
