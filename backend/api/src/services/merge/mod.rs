//! 同一本书的多个范围翻译任务合成一本。
//!
//! - `plan`：纯函数，每个文档页取哪个任务的哪一页
//! - `sources`：从任务读出排序、页号和产物路径（唯一读磁盘的一层）
//!
//! 拿计划和产物路径去生成合并目录的是 `derived_artifacts::merged`。

pub(crate) mod coverage;
pub(crate) mod plan;
pub(crate) mod reading;
pub(crate) mod sources;
