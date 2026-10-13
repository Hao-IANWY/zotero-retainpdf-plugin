"""AI 服务测试共用的假对象与小工具（夹具在 conftest.py）。

FakeRust 只模拟阅读和会话这两组 Rust API；计算、运行时会话等接口各测试文件
另有窄的 fake，故意不往这里堆——一个什么都会的 fake 会让测试看不出自己依赖了哪个接口。
"""

from __future__ import annotations

import json
from pathlib import Path

from retainpdf_ai.agent import AskResult, Citation, RetrievalAgent
from retainpdf_ai.config import Settings

API_KEY = "test-key"


def api_settings(**overrides) -> Settings:
    """带服务 API Key 的 Settings；LLM key 等差异由调用方显式给出。"""
    return Settings(api_keys=frozenset({API_KEY}), **overrides)


def sse_events(response) -> list[dict]:
    """把 SSE 响应里的 data 行解析成事件列表（只取 data 行）。"""
    return [
        json.loads(line[len("data: "):])
        for line in response.iter_lines()
        if line.startswith("data: ")
    ]


class UnusedAgent:
    """只打配置/设置路由的用例用它占位：真被调用就说明请求走错了路。"""

    def ask(self, *_args, **_kwargs):  # pragma: no cover - settings routes only
        raise AssertionError("agent should not run")


class FakeRust:
    def __init__(self):
        self.documents = [
            {
                "document_id": "doc-a",
                "title": "光谱计算方法",
                "page_count": 12,
                "tags": ["化学"],
                "reading_status": "reading",
                "active_job_id": "job-1",
            }
        ]
        self.conversations: dict[str, dict] = {}
        self._conv_seq = 0

    def search_fulltext(self, query, limit=20, *, document_id=""):
        hits = [
            {
                "document_id": "doc-a",
                "job_id": "job-1",
                "page_idx": 2,
                "block_id": "p003-b0002",
                "source_snippet": "spectra",
                "translated_snippet": f"关于{query}的片段",
            },
            {
                "document_id": "doc-other",
                "job_id": "job-9",
                "page_idx": 0,
                "block_id": "p001-b0001",
                "source_snippet": "other",
                "translated_snippet": "其它文档",
            },
        ]
        if document_id:
            hits = [h for h in hits if h["document_id"] == document_id]
        return hits

    def list_documents(self, *, tag="", reading_status="", limit=50):
        return self.documents

    def get_document(self, document_id):
        return self.documents[0]

    def get_document_by_job(self, job_id):
        for doc in self.documents:
            if doc.get("active_job_id") == job_id:
                return doc
        return None

    def list_favorites(self, document_id=""):
        return [
            {
                "favorite_id": "fav-1",
                "document_id": "doc-a",
                "job_id": "job-1",
                "page_idx": 4,
                "block_id": "p005-b0008",
                "kind": "sentence",
                "quote_text": "reaction rate",
                "translated_quote_text": "反应速率相关引文",
                "note": "重要",
            }
        ]

    def create_conversation(self, *, title="", document_id=""):
        self._conv_seq += 1
        conversation_id = f"conv-{self._conv_seq}"
        record = {
            "conversation_id": conversation_id,
            "title": title,
            "document_id": document_id or None,
            "head_id": "",
            "messages": [],
        }
        self.conversations[conversation_id] = record
        return {
            "conversation_id": conversation_id,
            "title": title,
            "document_id": document_id or None,
            "head_id": "",
        }

    def get_conversation(self, conversation_id):
        return self.conversations.get(conversation_id)

    def append_conversation_message(
        self,
        conversation_id,
        *,
        role,
        content,
        citations_json="",
        tool_trace_json="",
        model="",
        parent_id="",
        message_id="",
        set_head=True,
        finish_reason="",
    ):
        record = self.conversations.setdefault(
            conversation_id,
            {
                "conversation_id": conversation_id,
                "title": "",
                "document_id": None,
                "head_id": "",
                "messages": [],
            },
        )
        mid = (message_id or "").strip() or f"msg-{len(record['messages']) + 1}"
        msg = {
            "message_id": mid,
            "role": role,
            "content": content,
            "citations_json": citations_json,
            "tool_trace_json": tool_trace_json,
            "model": model,
            "parent_id": (parent_id or "").strip(),
            "finish_reason": (finish_reason or "").strip(),
            "seq": len(record["messages"]) + 1,
        }
        record["messages"].append(msg)
        if set_head:
            record["head_id"] = mid
        return msg


def write_job_dir(root: Path):
    job_root = root / "jobs" / "job-1"
    normalized = job_root / "ocr" / "normalized"
    normalized.mkdir(parents=True)
    (normalized / "document.v1.json").write_text(
        json.dumps(
            {
                "assets": {
                    "page-3/imgs/figure.jpg": {
                        "uri": "md/images/page-3/imgs/figure.jpg"
                    },
                    "page-3/imgs/figure-detail.jpg": {
                        "uri": "md/images/page-3/imgs/figure-detail.jpg"
                    },
                },
                "pages": [
                    {
                        "page_index": 2,
                        "blocks": [
                            {
                                "block_id": "p003-b0000",
                                "text": "first block",
                                "bbox": [10, 20, 110, 40],
                                "geometry": {"bbox": [10, 20, 110, 40]},
                                "type": "text",
                                "content": {"kind": "text"},
                            },
                            {
                                "block_id": "p003-b0001",
                                "text": "second block",
                                "bbox": [10, 50, 180, 80],
                                "geometry": {"bbox": [20, 100, 360, 160]},
                                "type": "text",
                                "content": {"kind": "text"},
                            },
                            {
                                "block_id": "p003-b0002",
                                "text": "",
                                "bbox": [20, 100, 220, 260],
                                "geometry": {"bbox": [20, 100, 220, 260]},
                                "type": "image",
                                "content": {
                                    "kind": "image",
                                    "asset_id": "page-3/imgs/figure.jpg",
                                    "asset_ids": [
                                        "page-3/imgs/figure.jpg",
                                        "page-3/imgs/figure-detail.jpg",
                                    ],
                                },
                            },
                        ],
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    translated = job_root / "translated"
    translated.mkdir(parents=True)
    (translated / "page-003-deepseek.json").write_text(
        json.dumps(
            [
                {"page_idx": "2", "block_idx": "1", "translated_text": "第二个块的译文"},
            ]
        ),
        encoding="utf-8",
    )
    image_dir = job_root / "md" / "images" / "page-3" / "imgs"
    image_dir.mkdir(parents=True)
    (job_root / "md" / "full.md").write_text(
        "# 光谱计算方法\n\n本文使用 density functional theory 计算吸收光谱。\n\n"
        "## 主要结论\n\n共轭效应提高了反应选择性。\n\n"
        "![反应图](images/page-3/imgs/figure%20detail.jpg)\n",
        encoding="utf-8",
    )
    (image_dir / "figure.jpg").write_bytes(b"test-image")
    (image_dir / "figure-detail.jpg").write_bytes(b"test-image-detail")
    (image_dir / "figure detail.jpg").write_bytes(b"test-image-space")
    (image_dir / "unrelated.jpg").write_bytes(b"must-not-be-guessed")
    return job_root


class FakeAgent(RetrievalAgent):
    def __init__(self):
        self.last_history = None

    def ask(self, question, *, document_id="", job_id="", on_event=None, chat_fn=None, history=None):
        self.last_history = list(history or [])
        if on_event is not None:
            on_event({"type": "tool", "round": 1, "tool": "search_fulltext", "arguments": {"query": "q"}})
        history_note = f"(hist={len(self.last_history)})" if self.last_history else ""
        return AskResult(
            answer=f"回答:{question}{history_note} [1]",
            citations=[
                Citation(
                    ref=1,
                    document_id="doc-a",
                    job_id="job-1",
                    page_idx=2,
                    block_id="p003-b0001",
                    snippet="片段",
                )
            ],
            tool_trace=[{"round": 1, "tool": "search_fulltext", "arguments": {"query": "q"}}],
            rounds=2,
        )
