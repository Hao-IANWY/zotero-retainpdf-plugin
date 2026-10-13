"""排版记忆不能形成反馈环：同一份输入连续渲染多次，块字号必须不变。

旧行为：typography_memory 默认开启，把 unify / collision 等后处理**压缩后**的
最终字号写进全局 sqlite；同一特征桶攒够 3 次观测后，下一次渲染直接拿历史均值
当种子字号（并跳过 adjust_body_seed_font_size），后处理又在它基础上再压一轮，
于是同一份输入越渲字越小（实测 10.43 → 9.65pt），A 文档的历史还会影响 B 文档。
"""

from __future__ import annotations

import copy

from retainpdf_pipeline.render.layout.payload.blocks import build_render_blocks
from retainpdf_pipeline.render.layout.typography_memory import store as memory_store


def _paragraph(index: int, *, top: float, words: int, translated_chars: int) -> dict:
    source = " ".join(f"word{n}" for n in range(words))
    line_count = max(2, words // 9)
    lines = [
        {
            "bbox": [56.0, top + row * 13.0, 540.0, top + row * 13.0 + 11.0],
            "spans": [{"type": "text", "content": source[:60]}],
        }
        for row in range(line_count)
    ]
    return {
        "item_id": f"p001-b{index:03d}",
        "block_type": "text",
        "block_kind": "text",
        "layout_role": "paragraph",
        "semantic_role": "body",
        "structure_role": "body",
        "source_text": source,
        "protected_source_text": source,
        "protected_translated_text": ("这是一个用于测试排版记忆反馈环的正文段落，" * 20)[:translated_chars],
        "bbox": [56.0, top, 540.0, top + line_count * 13.0],
        "lines": lines,
    }


def _page_items() -> list[dict]:
    items: list[dict] = []
    top = 72.0
    for index, (words, chars) in enumerate(
        [(60, 150), (45, 160), (70, 120), (40, 170), (55, 200), (80, 140)]
    ):
        item = _paragraph(index, top=top, words=words, translated_chars=chars)
        items.append(item)
        top = item["bbox"][3] + 10.0
    return items


def _render_fonts(items: list[dict]) -> dict[str, tuple[float, float]]:
    blocks = build_render_blocks(copy.deepcopy(items), page_width=595.0, page_height=842.0)
    return {
        str(block.block_id): (round(block.font_size_pt, 3), round(block.leading_em, 4))
        for block in blocks
    }


def test_repeated_renders_keep_block_typography_stable(tmp_path, monkeypatch) -> None:
    # 走默认配置（不设开关），排版记忆库指向 tmp，绝不碰真实 data/。
    monkeypatch.delenv("RETAIN_RENDER_TYPOGRAPHY_MEMORY", raising=False)
    monkeypatch.setattr(memory_store.typography_memory, "db_path", tmp_path / "memory.sqlite3")
    monkeypatch.setattr(memory_store.typography_memory, "_ready", False)

    items = _page_items()
    runs = [_render_fonts(items) for _ in range(6)]

    assert runs[0], "测试输入应当产出渲染块"
    for later in runs[1:]:
        assert later == runs[0]

    monkeypatch.setenv("RETAIN_RENDER_TYPOGRAPHY_MEMORY", "0")
    assert _render_fonts(items) == runs[0]


def test_typography_memory_is_disabled_by_default(tmp_path, monkeypatch) -> None:
    monkeypatch.delenv("RETAIN_RENDER_TYPOGRAPHY_MEMORY", raising=False)
    memory = memory_store.TypographyMemory(tmp_path / "memory.sqlite3")

    assert memory.enabled is False
    memory.observe(feature_key="k", font_size_pt=10.0, leading_em=0.8)
    assert not (tmp_path / "memory.sqlite3").exists()

    monkeypatch.setenv("RETAIN_RENDER_TYPOGRAPHY_MEMORY", "1")
    assert memory.enabled is True


def test_legacy_v1_statistics_are_never_read(tmp_path, monkeypatch) -> None:
    # 生产库里 font_leading_stats_v1 的行全是反馈环压缩出来的值，显式开启也不能读到。
    monkeypatch.setenv("RETAIN_RENDER_TYPOGRAPHY_MEMORY", "1")
    memory = memory_store.TypographyMemory(tmp_path / "memory.sqlite3")
    memory._ensure_schema()
    with memory._connect() as conn:
        conn.execute(
            "insert into typography_stats values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("legacy-key", "font_leading_stats_v1", "typography_memory_v1", 50, 9.6, 0.5, 0.0, 0.0, 0, 0),
        )

    assert memory_store.TYPOGRAPHY_MEMORY_ALGORITHM_VERSION != "font_leading_stats_v1"
    assert memory.lookup("legacy-key") is None
