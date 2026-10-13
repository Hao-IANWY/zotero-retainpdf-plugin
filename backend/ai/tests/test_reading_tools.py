"""阅读工具：结构化块读取、Markdown 资源 URL 锚定、默认工具注册表。

从原 test_tools_and_app.py 拆出，用例原样搬移。
"""

from retainpdf_ai.blocks import read_page_blocks
from retainpdf_ai.config import Settings
from retainpdf_ai.tools import _markdown_asset_url, build_default_registry

from app_fakes import FakeRust, write_job_dir


def test_read_page_blocks_aligns_translation_by_numeric_index(tmp_path):
    job_root = write_job_dir(tmp_path)
    blocks = read_page_blocks(job_root, 2)
    assert [block.block_id for block in blocks] == ["p003-b0000", "p003-b0001", "p003-b0002"]
    assert blocks[1].translated_text == "第二个块的译文"
    assert blocks[1].bbox == (10.0, 50.0, 180.0, 80.0)
    assert blocks[2].asset_id == "page-3/imgs/figure.jpg"
    assert blocks[2].asset_ids == (
        "page-3/imgs/figure.jpg",
        "page-3/imgs/figure-detail.jpg",
    )
    assert blocks[2].asset_uris == (
        "md/images/page-3/imgs/figure.jpg",
        "md/images/page-3/imgs/figure-detail.jpg",
    )
    windowed = read_page_blocks(job_root, 2, around_block_id="p003-b0001", max_blocks=1)
    assert [block.block_id for block in windowed] == ["p003-b0001"]


def test_markdown_asset_url_accepts_canonical_and_legacy_page_local_ids(tmp_path):
    job_root = write_job_dir(tmp_path)
    canonical = _markdown_asset_url(job_root, "job-1", 2, "page-3/imgs/figure.jpg")
    legacy = _markdown_asset_url(job_root, "job-1", 2, "imgs/figure.jpg")
    catalog_uri = _markdown_asset_url(
        job_root,
        "job-1",
        2,
        "opaque-provider-id",
        "md/images/page-3/imgs/figure.jpg",
    )

    assert canonical == legacy == catalog_uri
    # URL 末尾多了 `?doc=<document_id>`:图片常常不在阅读中的那个 job 里，前端拿它和
    # 本次回答引用里的 document_id 比对，免得把「任意 job 都放行」当成修法。
    # 这里钉的仍然是「路径锚定正确」，所以只比对路径部分。
    assert canonical.split("?")[0].endswith("page-3/imgs/figure.jpg")
    encoded_once = _markdown_asset_url(
        job_root, "job-1", 2, "images/page-3/imgs/figure%20detail.jpg"
    )
    assert encoded_once.split("?")[0].endswith("page-3/imgs/figure%20detail.jpg")
    assert "%2520" not in encoded_once
    assert _markdown_asset_url(job_root, "job-1", 2, "../secret.png") == ""
    assert (
        _markdown_asset_url(
            job_root,
            "job-1",
            2,
            "opaque-provider-id",
            "../../outside.png",
        )
        == ""
    )


def test_default_registry_tools_return_anchored_results(tmp_path):
    job_root = write_job_dir(tmp_path)
    settings = Settings(data_root=tmp_path)
    registry = build_default_registry(settings, FakeRust())
    assert registry.content_source("doc-a", "job-1") == "structured"

    hits = registry.invoke("search_fulltext", {"query": "光谱"})["hits"]
    assert len(hits) == 2
    assert hits[0]["block_id"] == "p003-b0002"
    assert hits[0]["asset_ids"] == [
        "page-3/imgs/figure.jpg",
        "page-3/imgs/figure-detail.jpg",
    ]
    assert len(hits[0]["image_urls"]) == 2
    assert all("unrelated.jpg" not in url for url in hits[0]["image_urls"])

    # 整本：document_id 过滤掉其它文档
    scoped = registry.invoke(
        "search_fulltext",
        {"query": "光谱", "document_id": "doc-a"},
    )
    assert len(scoped["hits"]) == 1
    assert scoped["hits"][0]["document_id"] == "doc-a"
    assert scoped["document_id"] == "doc-a"
    assert scoped["structured_data_available"] is True

    empty_scoped = registry.invoke(
        "search_fulltext",
        {"query": "光谱", "document_id": "doc-missing"},
    )
    assert empty_scoped["hits"] == []
    assert empty_scoped["structured_data_available"] is False
    assert "没有可读取的结构化数据" in empty_scoped.get("hint", "")

    documents = registry.invoke("list_documents", {})["documents"]
    assert documents[0]["document_id"] == "doc-a"
    # 注入 document_id 时 list_documents 只返回该文档
    only = registry.invoke("list_documents", {"document_id": "doc-a"})["documents"]
    assert len(only) == 1

    blocks = registry.invoke("read_blocks", {"document_id": "doc-a", "page_idx": 2})
    assert blocks["job_id"] == "job-1"
    assert blocks["blocks"][1]["translated_text"] == "第二个块的译文"
    assert blocks["blocks"][1]["bbox"] == [10.0, 50.0, 180.0, 80.0]
    assert blocks["blocks"][2]["block_type"] == "image"
    assert blocks["blocks"][2]["image_url"].split("?")[0].endswith("page-3/imgs/figure.jpg")
    assert len(blocks["blocks"][2]["asset_image_urls"]) == 2
    assert blocks["blocks"][1]["source_text_length"] == len("second block")

    paged = registry.invoke(
        "read_blocks",
        {
            "document_id": "doc-a",
            "page_idx": 2,
            "around_block_id": "p003-b0001",
            "max_blocks": 1,
            "char_start": 3,
            "char_limit": 200,
        },
    )
    assert paged["blocks"][0]["source_text"] == "ond block"
    assert paged["blocks"][0]["char_start"] == 3

    favorites = registry.invoke("search_favorites", {"keyword": "速率"})["favorites"]
    assert favorites[0]["favorite_id"] == "fav-1"
    assert registry.invoke("search_favorites", {"keyword": "不存在"})["favorites"] == []

    assert "query must not be empty" in registry.invoke("search_fulltext", {})["error"]

    # 旧任务若缺 normalized block 关系，不能退化成同页图片枚举。
    (job_root / "ocr" / "normalized" / "document.v1.json").unlink()
    assert registry.content_source("doc-a", "job-1") == "markdown"
    legacy_hits = registry.invoke("search_fulltext", {"query": "光谱"})["hits"]
    assert "image_urls" not in legacy_hits[0]


def test_default_registry_markdown_tools_only_read_full_markdown(tmp_path):
    job_root = write_job_dir(tmp_path)
    registry = build_default_registry(Settings(data_root=tmp_path), FakeRust())

    searched = registry.invoke(
        "search_markdown",
        {"query": "共轭效应", "document_id": "doc-a", "job_id": "job-1"},
    )
    assert searched["document_id"] == "doc-a"
    assert searched["job_id"] == "job-1"
    assert searched["hits"][0]["block_id"].startswith("md-")
    assert searched["hits"][0]["source"] == "markdown"
    assert "反应选择性" in searched["hits"][0]["source_snippet"]
    assert "figure%20detail" not in searched["hits"][0]["source_snippet"]
    assert searched["hits"][0]["page_idx"] is None
    assert searched["hits"][0]["assets"] == [
        {
            "image_url": "/api/v1/jobs/job-1/markdown/images/page-3/imgs/figure%20detail.jpg?doc=doc-a",
            "alt": "反应图",
        }
    ]

    chunk_id = searched["hits"][0]["chunk_id"]
    read = registry.invoke(
        "read_markdown_chunk",
        {"chunk_id": chunk_id, "document_id": "doc-a", "job_id": "job-1"},
    )
    assert read["blocks"][0]["block_id"] == chunk_id
    assert read["blocks"][0]["heading"] == "光谱计算方法 > 主要结论"
    assert "共轭效应" in read["blocks"][0]["source_text"]
    assert read["page_idx"] is None
    assert read["blocks"][0]["assets"] == searched["hits"][0]["assets"]

    unknown_job = registry.invoke(
        "search_markdown",
        {"query": "光谱", "document_id": "doc-a", "job_id": "job-missing"},
    )
    assert "accessible document" in unknown_job["error"]

    (job_root / "md" / "full.md").unlink()
    missing = registry.invoke(
        "search_markdown",
        {"query": "光谱", "document_id": "doc-a", "job_id": "job-1"},
    )
    assert "Markdown not found" in missing["error"]

    mismatch = registry.invoke(
        "search_markdown",
        {"query": "光谱", "document_id": "doc-other", "job_id": "job-1"},
    )
    assert "do not refer to the same document" in mismatch["error"]
