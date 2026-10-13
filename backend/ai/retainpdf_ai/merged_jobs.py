"""合并译文的虚拟任务 id：`merged-<64 位十六进制文档 id>-<16 位十六进制指纹>`。

同一本书的多次范围翻译被合成一个整本长度、任务形状的目录
`data/documents/<文档>/merged/<指纹>/`，阅读器把它当成一个任务打开。这里的格式和目录规则
**照抄** Rust 的 `storage_paths::MergedJobId`（backend/packages/retain-core/src/
storage_paths/merged_job.rs），两边必须一致：Rust 决定 AI 工作区在哪，这里决定终端落在哪。

格式卡得很死：id 来自浏览器和模型的工具参数（提示注入面），会被拼进文件路径，任何不是
定长小写十六进制的东西都不放行。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

_MERGED_JOB_ID = re.compile(r"^merged-(?P<document_id>[0-9a-f]{64})-(?P<fingerprint>[0-9a-f]{16})$")


@dataclass(frozen=True)
class MergedJobId:
    document_id: str
    fingerprint: str

    def root(self, data_root: Path) -> Path:
        """合并目录：`data/documents/<文档>/merged/<指纹>`。"""
        return data_root / "documents" / self.document_id / "merged" / self.fingerprint

    def ai_dir(self, data_root: Path) -> Path:
        """AI 工作区：`data/documents/<文档>/ai`。按文档、不按指纹 —— 换一次合并不能丢历史。"""
        return data_root / "documents" / self.document_id / "ai"


def parse_merged_job_id(job_id: str) -> MergedJobId | None:
    match = _MERGED_JOB_ID.fullmatch(job_id or "")
    if match is None:
        return None
    return MergedJobId(match.group("document_id"), match.group("fingerprint"))
