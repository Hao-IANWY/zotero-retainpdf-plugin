"""会话持久化：自动建会话、历史注入、摘要压缩、落库失败告知、结束原因与取消。

从原 test_tools_and_app.py 拆出，用例原样搬移。
"""


from fastapi.testclient import TestClient
from retainpdf_ai.app import build_app
from retainpdf_ai.request_control import AIRequestCancelled

from app_fakes import FakeAgent, FakeRust, api_settings, sse_events


def test_ask_auto_creates_conversation_and_persists_history():
    """B1: 无 conversation_id 时 auto-create;第二轮注入 history 并回传同一 id。"""
    settings = api_settings(llm_api_key="env-llm-key")
    rust = FakeRust()
    agent = FakeAgent()
    client = TestClient(build_app(settings, agent=agent, rust=rust))

    first = client.post(
        "/v1/ask",
        json={"question": "第一问", "document_id": "doc-a"},
        headers={"X-API-Key": "test-key"},
    )
    assert first.status_code == 200
    data1 = first.json()["data"]
    conversation_id = data1["conversation_id"]
    assert conversation_id.startswith("conv-")
    assert conversation_id in rust.conversations
    # 已回写 user+assistant
    assert len(rust.conversations[conversation_id]["messages"]) == 2
    assert agent.last_history == []

    second = client.post(
        "/v1/ask",
        json={
            "question": "追问",
            "document_id": "doc-a",
            "conversation_id": conversation_id,
        },
        headers={"X-API-Key": "test-key"},
    )
    assert second.status_code == 200
    data2 = second.json()["data"]
    assert data2["conversation_id"] == conversation_id
    assert len(agent.last_history) == 2
    assert agent.last_history[0]["role"] == "user"
    assert "第一问" in agent.last_history[0]["content"]
    assert "(hist=2)" in data2["answer"]
    assert len(rust.conversations[conversation_id]["messages"]) == 4


def test_ask_stream_done_includes_conversation_id():
    settings = api_settings(llm_api_key="env-llm-key")
    rust = FakeRust()
    client = TestClient(build_app(settings, agent=FakeAgent(), rust=rust))

    with client.stream(
        "POST",
        "/v1/ask",
        json={"question": "流式会话?", "stream": True, "document_id": "doc-a"},
        headers={"X-API-Key": "test-key"},
    ) as response:
        events = sse_events(response)
    done = events[-1]
    assert done["type"] == "done"
    assert done["conversation_id"].startswith("conv-")


def test_summary_lands_on_head_path_and_feeds_next_turn():
    """审计 A2 回归锁:摘要必须接进 head 路径——第二问的 history 要能读回
    【对话摘要】,而不是每轮重压缩 + 累积孤儿摘要。

    关键:seed 与两次 ask 都显式传 parent 链(模拟真实前端),否则 FakeRust 的
    空 parent 线性合成会掩盖死分支。"""
    settings = api_settings(
        llm_api_key="env-llm-key",
        memory_window_turns=2,
        memory_compress_after_turns=2,
    )
    rust = FakeRust()
    created = rust.create_conversation(title="t", document_id="doc-a")
    cid = created["conversation_id"]
    prev = ""
    for i in range(6):
        u = rust.append_conversation_message(cid, role="user", content=f"U{i}", parent_id=prev)
        a = rust.append_conversation_message(
            cid, role="assistant", content=f"A{i} 结论 [1]", parent_id=u["message_id"],
        )
        prev = a["message_id"]

    agent = FakeAgent()
    client = TestClient(build_app(settings, agent=agent, rust=rust))

    first = client.post(
        "/v1/ask",
        json={"question": "第一问", "document_id": "doc-a", "conversation_id": cid, "parent_id": prev},
        headers={"X-API-Key": "test-key"},
    )
    assert first.status_code == 200

    conv = rust.conversations[cid]
    # 摘要在 head 路径上:从 head 沿显式 parent 回溯必经过【对话摘要】节点
    by_id = {m["message_id"]: m for m in conv["messages"]}
    cur = by_id.get(conv["head_id"])
    on_path = []
    while cur is not None:
        on_path.append(cur)
        cur = by_id.get(cur.get("parent_id") or "")
    assert any(
        str(m.get("content") or "").startswith("【对话摘要】") for m in on_path
    ), "摘要不在 head 路径上(死分支回归)"

    second = client.post(
        "/v1/ask",
        json={"question": "第二问", "document_id": "doc-a", "conversation_id": cid, "parent_id": conv["head_id"]},
        headers={"X-API-Key": "test-key"},
    )
    assert second.status_code == 200
    assert agent.last_history, "第二问应携带 history"
    # assemble_history 把摘要包装成"已知背景"伪轮(assemble.py),不保留原前缀
    assert any(
        "更早对话的摘要" in str(t.get("content") or "") for t in agent.last_history
    ), "第二问的 history 读不回摘要(孤儿摘要回归)"


def test_persist_failure_surfaces_in_done_payload():
    """审计 C2 回归锁:回写失败必须经 persisted=false 告知前端,不再静默丢轮。"""
    settings = api_settings(llm_api_key="env-llm-key")

    class BrokenPersistRust(FakeRust):
        def append_conversation_message(self, conversation_id, **kwargs):
            raise RuntimeError("db locked")

    rust = BrokenPersistRust()
    created = rust.conversations.setdefault(
        "conv-x",
        {"conversation_id": "conv-x", "title": "t", "document_id": "doc-a", "head_id": "", "messages": []},
    )
    del created
    client = TestClient(build_app(settings, agent=FakeAgent(), rust=rust))
    response = client.post(
        "/v1/ask",
        json={"question": "问", "document_id": "doc-a", "conversation_id": "conv-x"},
        headers={"X-API-Key": "test-key"},
    )
    assert response.status_code == 200
    assert response.json()["data"]["persisted"] is False

    # 正常路径 persisted=True
    ok_rust = FakeRust()
    ok_client = TestClient(build_app(settings, agent=FakeAgent(), rust=ok_rust))
    ok = ok_client.post(
        "/v1/ask",
        json={"question": "问", "document_id": "doc-a"},
        headers={"X-API-Key": "test-key"},
    )
    assert ok.json()["data"]["persisted"] is True


def test_ask_force_compress_emits_compress_event_and_summary():
    """B2: force_compress 时 SSE 先 compress，再 tool/done；摘要落库。"""
    settings = api_settings(
        llm_api_key="env-llm-key",
        memory_window_turns=2,
        memory_compress_after_turns=100,
    )
    rust = FakeRust()
    # 预置长对话
    created = rust.create_conversation(title="t", document_id="doc-a")
    cid = created["conversation_id"]
    for i in range(6):
        rust.append_conversation_message(cid, role="user", content=f"U{i}")
        rust.append_conversation_message(
            cid,
            role="assistant",
            content=f"A{i} 结论 [1]",
            citations_json='[{"ref":1,"page_idx":0,"snippet":"s"}]',
        )

    agent = FakeAgent()
    client = TestClient(build_app(settings, agent=agent, rust=rust))
    with client.stream(
        "POST",
        "/v1/ask",
        json={
            "question": "压缩后再问",
            "stream": True,
            "document_id": "doc-a",
            "conversation_id": cid,
            "force_compress": True,
        },
        headers={"X-API-Key": "test-key"},
    ) as response:
        events = sse_events(response)

    types = [e.get("type") for e in events]
    assert "compress" in types
    compress = next(e for e in events if e["type"] == "compress")
    assert compress["policy"] == "extractive_v1"
    assert compress["dropped_turns"] >= 1
    assert events[-1]["type"] == "done"
    assert events[-1]["memory"]["had_summary"] is True
    # 摘要已写入
    assert any(
        str(m.get("content") or "").startswith("【对话摘要】")
        for m in rust.conversations[cid]["messages"]
    )
    # agent 收到带摘要的 history
    assert agent.last_history
    assert any("摘要" in m["content"] for m in agent.last_history if m["role"] == "user")


def test_ask_injects_conversation_history_and_persists_turn():
    calls = {"history": None, "appended": []}

    class HistoryAgent(FakeAgent):
        def ask(self, question, *, document_id="", job_id="", on_event=None, chat_fn=None, history=None):
            calls["history"] = history
            return super().ask(
                question,
                document_id=document_id,
                job_id=job_id,
                on_event=on_event,
                chat_fn=chat_fn,
            )

    class ConvRust(FakeRust):
        def get_conversation(self, conversation_id):
            assert conversation_id == "conv-1"
            return {
                "conversation_id": "conv-1",
                "messages": [
                    {"role": "user", "content": "之前的问题", "seq": 1},
                    {"role": "assistant", "content": "之前的回答 [1]", "seq": 2},
                ],
            }

        def append_conversation_message(self, conversation_id, *, role, content, **kwargs):
            calls["appended"].append((conversation_id, role, content[:20], kwargs.get("citations_json", "")))
            return {"message_id": f"msg-{role}"}

    settings = api_settings()
    app = build_app(settings, agent=HistoryAgent(), rust=ConvRust())
    client = TestClient(app)
    response = client.post(
        "/v1/ask",
        json={"question": "接着上个问题继续", "conversation_id": "conv-1", "llm_api_key": "sk-test"},
        headers={"X-API-Key": "test-key"},
    )
    assert response.status_code == 200
    # 历史注入
    assert calls["history"] == [
        {"role": "user", "content": "之前的问题"},
        {"role": "assistant", "content": "之前的回答 [1]"},
    ]
    # 回写 user + assistant 两条,assistant 带引用快照
    assert [(c[1], c[0]) for c in calls["appended"]] == [("user", "conv-1"), ("assistant", "conv-1")]
    assert "block_id" in calls["appended"][1][3]


def test_agent_places_history_between_system_and_current_question():
    from retainpdf_ai.agent import RetrievalAgent
    from retainpdf_ai.tools import ToolRegistry

    seen = {}

    def chat(messages, tools):
        seen["messages"] = messages
        return {"content": "好的。", "tool_calls": []}

    agent = RetrievalAgent(ToolRegistry([]), chat, max_tool_rounds=2)
    agent.ask(
        "当前问题",
        history=[
            {"role": "user", "content": "上一问"},
            {"role": "assistant", "content": "上一答"},
            {"role": "tool", "content": "should be dropped"},
        ],
    )
    roles = [m["role"] for m in seen["messages"]]
    assert roles == ["system", "user", "assistant", "user"]
    assert seen["messages"][1]["content"] == "上一问"
    assert seen["messages"][-1]["content"] == "当前问题"


class _CutShortAgent(FakeAgent):
    """轮次用尽、被强制收尾的那种回答。"""

    def ask(self, *args, **kwargs):
        result = super().ask(*args, **kwargs)
        result.incomplete_reason = "rounds_exhausted"
        return result


def _assistant_rows(rust, conversation_id):
    return [
        m for m in rust.conversations[conversation_id]["messages"]
        if m["role"] == "assistant"
    ]


def test_persisted_answer_remembers_that_it_was_cut_short():
    """结束原因要跟着回答一起落库。

    只活在当前这一轮的话,刷新回来就看不出它没做完——而它写出来的话和正常回答
    没有区别,用户拿到的是一个看上去正常、其实提前收尾的答案。
    """
    settings = api_settings(llm_api_key="env-llm-key")
    rust = FakeRust()
    client = TestClient(build_app(settings, agent=_CutShortAgent(), rust=rust))
    res = client.post(
        "/v1/ask",
        json={"question": "算一下", "document_id": "doc-a"},
        headers={"X-API-Key": "test-key"},
    )
    assert res.status_code == 200
    conversation_id = res.json()["data"]["conversation_id"]
    rows = _assistant_rows(rust, conversation_id)
    assert rows, "回答没有落库"
    assert rows[-1]["finish_reason"] == "rounds_exhausted"


def test_a_complete_answer_is_persisted_without_a_reason():
    """"完整"是默认,不该在每条消息上都写一遍。"""
    settings = api_settings(llm_api_key="env-llm-key")
    rust = FakeRust()
    client = TestClient(build_app(settings, agent=FakeAgent(), rust=rust))
    res = client.post(
        "/v1/ask",
        json={"question": "普通问题", "document_id": "doc-a"},
        headers={"X-API-Key": "test-key"},
    )
    conversation_id = res.json()["data"]["conversation_id"]
    rows = _assistant_rows(rust, conversation_id)
    assert rows
    assert rows[-1]["finish_reason"] == ""


def test_a_cancelled_agent_leaves_nothing_behind():
    """agent 在中途抛出取消时,不留半截回答。

    注意这条只覆盖「抛在落库之前」这一种;「模型已答完、落库前才被取消」那种交错由
    test_followup_suggestions.py::test_a_stopped_turn_is_not_persisted 钉住（原先说的
    「下面那条源码测试」早已删除）。
    """
    settings = api_settings(llm_api_key="env-llm-key")
    rust = FakeRust()

    class _StoppedAgent(FakeAgent):
        def ask(self, *args, **kwargs):
            raise AIRequestCancelled()

    client = TestClient(build_app(settings, agent=_StoppedAgent(), rust=rust))
    client.post(
        "/v1/ask",
        json={"question": "会被停掉的问题", "document_id": "doc-a"},
        headers={"X-API-Key": "test-key"},
    )
    answers = [
        m
        for conv in rust.conversations.values()
        for m in conv["messages"]
        if m["role"] == "assistant"
    ]
    assert answers == [], f"被停止的那一轮留下了回答:{answers}"
