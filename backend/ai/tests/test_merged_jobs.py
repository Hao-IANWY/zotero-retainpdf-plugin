"""合并译文的虚拟任务 id：Python 这边和 Rust 的 storage_paths::MergedJobId 必须是同一套规则。"""

from __future__ import annotations

from pathlib import Path

import pytest

from retainpdf_ai.fx_workspace import (
    build_merged_workspace_instructions,
    resolve_job_workspace,
    resolve_merged_workspace,
)
from retainpdf_ai.merged_jobs import MergedJobId, parse_merged_job_id
from retainpdf_ai.tools import _safe_job_root

DOC = "a" * 64
FP = "0123456789abcdef"
MERGED = f"merged-{DOC}-{FP}"


def test_parses_the_same_format_as_rust() -> None:
    assert parse_merged_job_id(MERGED) == MergedJobId(DOC, FP)


@pytest.mark.parametrize(
    "hostile",
    [
        "20260921091127-99568a",
        f"merged-{DOC}-../../etc/x",
        f"merged-{DOC}-0123456789abcdeF",
        f"merged-{DOC}-0123456789abcde",
        f"merged-{DOC[:63]}-{FP}",
        f"merged-../{DOC[3:]}-{FP}",
        f"merged-{DOC}-{FP}/x",
        f"merged-{DOC}-{FP}\n",
        "merged--",
        "",
    ],
)
def test_anything_that_could_escape_its_directory_is_not_a_merged_id(hostile: str) -> None:
    assert parse_merged_job_id(hostile) is None


def test_tools_read_a_merged_book_from_its_merged_directory(tmp_path: Path) -> None:
    class Settings:
        data_root = tmp_path

    assert _safe_job_root(Settings(), MERGED) == tmp_path / "documents" / DOC / "merged" / FP
    # 普通任务不受影响。
    assert _safe_job_root(Settings(), "20260921091127-99568a") == tmp_path / "jobs" / "20260921091127-99568a"


def test_the_terminal_of_a_merged_book_lands_in_the_document_level_ai_dir(tmp_path: Path) -> None:
    # 按文档放，不按指纹：新翻了几页就换一个指纹，agent 的笔记不能跟着丢。
    root = tmp_path / "documents" / DOC / "merged" / FP
    root.mkdir(parents=True)
    assert resolve_merged_workspace(tmp_path, MERGED) == (tmp_path / "documents" / DOC / "ai", root)
    newer = f"merged-{DOC}-{'f' * 16}"
    (tmp_path / "documents" / DOC / "merged" / ("f" * 16)).mkdir()
    assert resolve_merged_workspace(tmp_path, newer)[0] == tmp_path / "documents" / DOC / "ai"


def test_a_merged_id_whose_directory_does_not_exist_gets_no_workspace(tmp_path: Path) -> None:
    # 不给一个不存在的合并凭空建目录树。
    assert resolve_merged_workspace(tmp_path, MERGED) is None
    assert not (tmp_path / "documents").exists()


def test_a_merged_id_is_not_mistaken_for_a_job_under_jobs(tmp_path: Path) -> None:
    (tmp_path / "jobs").mkdir()
    assert resolve_job_workspace(tmp_path, MERGED) is None


def test_the_merged_instructions_point_at_the_current_merged_directory(tmp_path: Path) -> None:
    root = tmp_path / "documents" / DOC / "merged" / FP
    workspace = tmp_path / "documents" / DOC / "ai"
    text = build_merged_workspace_instructions(workspace, root)
    assert f"../merged/{FP}/ocr/normalized/document.v1.json" in text
    assert f"../merged/{FP}/translated/" in text
    # 单本书的「数据在 ../」不能残留：那在合并书这里是文档目录，不是数据。
    stray = [line for line in text.splitlines() if "../" in line and f"../merged/{FP}/" not in line]
    assert stray == [], stray
    assert "多次翻译拼成" in text
    assert "detached:" in text


class _Rust:
    def __init__(self, reading, active="job-latest-range"):
        self._reading = reading
        self._active = active

    def get_document_reading(self, document_id):
        if isinstance(self._reading, Exception):
            raise self._reading
        return self._reading

    def get_document(self, document_id):
        return {"document_id": document_id, "active_job_id": self._active}


def test_a_document_scoped_question_reads_the_whole_merged_book_not_the_latest_range() -> None:
    from retainpdf_ai.tools import _reading_job_id

    assert _reading_job_id(_Rust({"job_id": MERGED}), "doc-1") == MERGED


def test_without_a_reading_entry_it_falls_back_to_the_active_job() -> None:
    from retainpdf_ai.tools import _reading_job_id

    assert _reading_job_id(_Rust({"job_id": None}), "doc-1") == "job-latest-range"
    assert _reading_job_id(_Rust(RuntimeError("404")), "doc-1") == "job-latest-range"
