"""/v1/ask 路由：鉴权、SSE 事件、阅读/操作分流、超时与空回答的终止事件、文档定位。

从原 test_tools_and_app.py 拆出，用例原样搬移。
"""

import time

from fastapi.testclient import TestClient
from retainpdf_ai.agent import AskResult, RetrievalAgent
from retainpdf_ai.app import build_app
from retainpdf_ai.config import Settings
from retainpdf_ai.runtime import RuntimeCapabilities
from retainpdf_ai.tools import build_default_registry

from app_fakes import FakeAgent, FakeRust, api_settings, sse_events


def test_reading_request_fails_before_model_when_no_content_source_exists(tmp_path):
    rust = FakeRust()
    registry = build_default_registry(Settings(data_root=tmp_path), rust)
    called = False

    def chat(_messages, _tools):
        nonlocal called
        called = True
        return {"role": "assistant", "content": "unexpected"}

    agent = RetrievalAgent(registry, chat)
    client = TestClient(
        build_app(
            api_settings(
                llm_api_key="env-llm-key",
                data_root=tmp_path,
            ),
            agent=agent,
            rust=rust,
        )
    )
    response = client.post(
        "/v1/ask",
        json={"question": "总结文档", "document_id": "doc-a"},
        headers={"X-API-Key": "test-key"},
    )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "AI_DOCUMENT_CONTENT_UNAVAILABLE"
    assert called is False


def test_ask_endpoint_requires_api_key_and_returns_citations():
    settings = api_settings(llm_api_key="env-llm-key")
    app = build_app(settings, agent=FakeAgent())
    client = TestClient(app)

    health = client.get("/healthz").json()
    assert health["ok"] is True
    assert health["capabilities"]["document_reading"] is True
    assert health["capabilities"]["document_operations"] is False

    denied = client.post("/v1/ask", json={"question": "q"})
    assert denied.status_code == 401

    response = client.post(
        "/v1/ask",
        json={"question": "库里讲什么?"},
        headers={"X-API-Key": "test-key"},
    )
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["answer"].startswith("回答:")
    assert data["citations"][0]["block_id"] == "p003-b0001"
    assert data["rounds"] == 2


def test_ask_endpoint_streams_sse_events():
    settings = api_settings(llm_api_key="env-llm-key")
    app = build_app(settings, agent=FakeAgent())
    client = TestClient(app)

    with client.stream(
        "POST",
        "/v1/ask",
        json={"question": "流式?", "stream": True},
        headers={"X-API-Key": "test-key"},
    ) as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        events = sse_events(response)
    assert events[0] == {
        "type": "progress",
        "stage": "routing",
        "message": "正在判断任务类型",
    }
    session = next(event for event in events if event["type"] == "agent_session")
    assert session["agent_runtime"] == "python-retrieval-v1"
    assert session["assistant_mode"] == "auto"
    assert session["resolved_mode"] == "reading"
    assert session["content_source"] == "unscoped"
    assert session["capabilities"] == {
        "calculation": False,
        "confirmation_modes": [],
        "document_reading": True,
        "document_operations": False,
        "document_operation_confirmation_mode": "explicit",
        "durable_calculations": False,
        "durable_sessions": False,
        "model_transport": "host_chat",
        "python_analysis": False,
        "streaming": True,
    }
    tool_event = next(event for event in events if event["type"] == "tool")
    assert tool_event["tool"] == "search_fulltext"
    assert events[-1]["type"] == "done"
    assert events[-1]["answer"].startswith("回答:")
    assert events[-1]["citations"][0]["block_id"] == "p003-b0001"


def test_ask_routes_reading_and_operations_without_changing_global_runtime():
    observed: list[str] = []

    class FakeOperationRuntime:
        runtime_id = "openai-compatible-agent-v1"
        capabilities = RuntimeCapabilities(
            document_reading=True,
            document_operations=True,
            streaming=True,
            durable_sessions=False,
            model_transport="host_chat",
            confirmation_modes=frozenset({"explicit", "green_light"}),
        )

        def ask(
            self,
            question,
            *,
            conversation_id="",
            document_id="",
            job_id="",
            request_message_id="",
            confirmed=False,
            on_event=None,
            chat_fn=None,
            history=None,
        ):
            del conversation_id, document_id, job_id, request_message_id
            del confirmed, on_event, chat_fn, history
            observed.append(question)
            return AskResult(answer=f"operation:{question}", rounds=1)

    settings = api_settings(llm_api_key="env-llm-key")
    client = TestClient(
        build_app(
            settings,
            agent=FakeAgent(),
            rust=FakeRust(),
            runtime=FakeOperationRuntime(),
        )
    )
    headers = {"X-API-Key": "test-key"}

    reading = client.post(
        "/v1/ask",
        json={"question": "总结本文", "assistant_mode": "reading"},
        headers=headers,
    )
    operations = client.post(
        "/v1/ask",
        json={"question": "旋转第一页", "assistant_mode": "operations"},
        headers=headers,
    )
    auto_reading = client.post(
        "/v1/ask",
        json={"question": "总结第三页", "assistant_mode": "auto"},
        headers=headers,
    )
    auto_operations = client.post(
        "/v1/ask",
        json={"question": "把第一页旋转 90 度", "assistant_mode": "auto"},
        headers=headers,
    )

    assert reading.status_code == 200
    assert reading.json()["data"]["answer"].startswith("回答:总结本文")
    assert reading.json()["data"]["agent_runtime"] == "python-retrieval-v1"
    assert operations.status_code == 200
    assert operations.json()["data"]["answer"] == "operation:旋转第一页"
    assert operations.json()["data"]["agent_runtime"] == "openai-compatible-agent-v1"
    assert auto_reading.json()["data"]["answer"].startswith("回答:总结第三页")
    assert auto_operations.json()["data"]["answer"] == "operation:把第一页旋转 90 度"
    assert observed == ["旋转第一页", "把第一页旋转 90 度"]


def test_stream_timeout_emits_heartbeats_and_one_structured_terminal():
    class SlowOperationRuntime:
        runtime_id = "slow-operation-runtime"
        capabilities = RuntimeCapabilities(
            document_reading=False,
            document_operations=True,
            streaming=True,
            durable_sessions=False,
            model_transport="host_chat",
        )

        def ask(self, _question, *, request_control=None, **_kwargs):
            while True:
                request_control.raise_if_stopped()
                time.sleep(0.01)

    # 预算不能按 heartbeat_interval 的几倍来估。经 TestClient → starlette 的
    # SSE 转发,每次 `yield` 都要跨线程同步一次,实测一轮循环约 0.2 秒——远大于
    # 这里设的 interval,所以真正的心跳条数是 deadline / 0.2,与 interval 基本
    # 无关(把 interval 从 0.05 调到 0.03、或把 runtime 的 sleep 从 0.01 调到
    # 0.05,心跳条数都不变)。
    #
    # 原先 deadline=0.12 连一轮都不够,一条心跳也发不出来,于是这条用例在整套
    # 跑时红、单独跑时绿。现在 1.0 秒约产出 5 条心跳,留够 5 倍余量。
    #
    # 要调小请先量:把 deadline 降到 0.4 以下就只剩 2 条,再降就归零。
    settings = api_settings(
        llm_api_key="env-llm-key",
        ai_request_deadline_s=1.0,
        ai_heartbeat_interval_s=0.05,
    )
    client = TestClient(
        build_app(settings, agent=FakeAgent(), runtime=SlowOperationRuntime())
    )
    with client.stream(
        "POST",
        "/v1/ask",
        json={
            "question": "旋转第一页",
            "assistant_mode": "operations",
            "stream": True,
        },
        headers={"X-API-Key": "test-key"},
    ) as response:
        events = sse_events(response)

    assert any(event["type"] == "heartbeat" for event in events), (
        "长操作期间必须发心跳,否则中间的代理会把连接当死连接掐掉;"
        f"实际收到的事件:{[event['type'] for event in events]}"
    )
    terminals = [
        event for event in events if event["type"] in {"done", "error", "cancelled"}
    ]
    assert terminals == [
        {
            "type": "error",
            "code": "AI_RESPONSE_TIMEOUT",
            "message": "AI 响应超时，请重试",
            "retryable": True,
        }
    ]


def test_stream_rejects_empty_done_answer_with_structured_error():
    class EmptyAgent(FakeAgent):
        def ask(self, question, **kwargs):
            del question, kwargs
            return AskResult(answer="", rounds=1)

    client = TestClient(
        build_app(
            api_settings(llm_api_key="env-llm-key"),
            agent=EmptyAgent(),
        )
    )
    with client.stream(
        "POST",
        "/v1/ask",
        json={"question": "总结", "stream": True},
        headers={"X-API-Key": "test-key"},
    ) as response:
        events = sse_events(response)

    assert events[-1] == {
        "type": "error",
        "code": "AI_EMPTY_RESPONSE",
        "message": "模型未返回有效回答，请重试",
        "retryable": True,
    }


def test_ask_endpoint_requires_llm_key_from_env_or_request():
    # env 与请求都无 LLM key:提前 400,不打到上游
    settings = api_settings()
    client = TestClient(build_app(settings, agent=FakeAgent()))
    missing = client.post(
        "/v1/ask",
        json={"question": "q"},
        headers={"X-API-Key": "test-key"},
    )
    assert missing.status_code == 400
    assert "LLM API Key" in missing.json()["detail"]

    # 请求携带 LLM key:即使 env 为空也放行(FakeAgent 忽略 chat_fn)
    ok = client.post(
        "/v1/ask",
        json={"question": "q", "llm_api_key": "sk-from-frontend"},
        headers={"X-API-Key": "test-key"},
    )
    assert ok.status_code == 200
    assert ok.json()["data"]["answer"].startswith("回答:")


def test_fx_auto_with_document_scope_fails_closed_before_runtime_call():
    called = False

    class RecordingFxRuntime:
        runtime_id = "vercel-fx-acp-v1"
        capabilities = RuntimeCapabilities(
            document_reading=False,
            document_operations=True,
            streaming=True,
            durable_sessions=True,
            model_transport="runtime_managed",
            confirmation_modes=frozenset({"explicit", "green_light"}),
        )

        def ask(self, _question, **_kwargs):
            nonlocal called
            called = True
            return AskResult(answer="unexpected")

    client = TestClient(
        build_app(
            api_settings(
                fx_gateway_api_key="gateway-test-key",
            ),
            rust=FakeRust(),
            runtime=RecordingFxRuntime(),
        )
    )

    response = client.post(
        "/v1/ask",
        json={"question": "这份文档讲什么？", "document_id": "doc-a"},
        headers={"X-API-Key": "test-key"},
    )

    assert response.status_code == 409
    assert "没有可用的文档阅读运行时" in response.json()["detail"]
    assert called is False


def test_ask_resolves_document_id_from_job_id():
    # 历史 job 也能定位文档:job_id → 服务端解析 document_id,
    # 不再依赖前端的 active_job_id 反查
    captured = {}

    class RecordingAgent(FakeAgent):
        def ask(self, question, *, document_id="", job_id="", on_event=None, chat_fn=None, history=None):
            captured["document_id"] = document_id
            captured["job_id"] = job_id
            return super().ask(
                question,
                document_id=document_id,
                job_id=job_id,
                on_event=on_event,
                chat_fn=chat_fn,
            )

    class JobAwareRust(FakeRust):
        def get_document_by_job(self, job_id):
            assert job_id == "job-old"
            return {"document_id": "doc-a"}

    settings = api_settings()
    app = build_app(settings, agent=RecordingAgent(), rust=JobAwareRust())
    client = TestClient(app)
    response = client.post(
        "/v1/ask",
        json={"question": "历史任务的问题", "job_id": "job-old", "llm_api_key": "sk-test"},
        headers={"X-API-Key": "test-key"},
    )
    assert response.status_code == 200
    assert captured["document_id"] == "doc-a"
    assert captured["job_id"] == "job-old"


def test_ask_keeps_explicit_document_id_over_job_id():
    captured = {}

    class RecordingAgent(FakeAgent):
        def ask(self, question, *, document_id="", job_id="", on_event=None, chat_fn=None, history=None):
            captured["document_id"] = document_id
            captured["job_id"] = job_id
            return super().ask(
                question,
                document_id=document_id,
                job_id=job_id,
                on_event=on_event,
                chat_fn=chat_fn,
            )

    settings = api_settings()
    app = build_app(settings, agent=RecordingAgent(), rust=FakeRust())
    client = TestClient(app)
    client.post(
        "/v1/ask",
        json={"question": "q", "document_id": "doc-explicit", "job_id": "job-x", "llm_api_key": "sk-test"},
        headers={"X-API-Key": "test-key"},
    )
    assert captured["document_id"] == "doc-explicit"
    assert captured["job_id"] == "job-x"
