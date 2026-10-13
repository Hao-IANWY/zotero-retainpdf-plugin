"""文档操作轮次：提问先落库再交给运行时、确认请求的结构化投影。

从原 test_tools_and_app.py 拆出，用例原样搬移。
"""

from fastapi.testclient import TestClient
from retainpdf_ai.agent import AskResult
from retainpdf_ai.app import _confirmation_requests, build_app
from retainpdf_ai.runtime import RuntimeCapabilities

from app_fakes import FakeAgent, FakeRust, api_settings


def test_fx_request_message_is_durable_before_runtime_and_not_duplicated():
    rust = FakeRust()
    observed: dict = {}

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
            del job_id, on_event, chat_fn, history
            detail = rust.get_conversation(conversation_id)
            observed["messages_during_runtime"] = list(detail["messages"])
            observed["request_message_id"] = request_message_id
            observed["document_id"] = document_id
            observed["confirmed"] = confirmed
            return AskResult(
                answer=f"fx:{question}",
                citations=[],
                tool_trace=[],
                rounds=1,
                operation_refs=[
                    {
                        "operation_id": "op-recorded-a",
                        "status": "draft",
                        "current_attempt": 1,
                        "latest_event_seq": 1,
                    }
                ],
            )

    settings = api_settings(
        llm_api_key="llm-test-key",
        llm_model="reading-model",
        fx_gateway_api_key="gateway-test-key",
        fx_model="fx-model",
    )
    client = TestClient(
        build_app(
            settings,
            agent=FakeAgent(),
            rust=rust,
            runtime=RecordingFxRuntime(),
        )
    )
    response = client.post(
        "/v1/ask",
        json={
            "question": "创建一个候选版本",
            "document_id": "doc-a",
            "user_message_id": "msg-stable-a",
            "confirm_document_operation": True,
            "assistant_mode": "operations",
        },
        headers={"X-API-Key": "test-key"},
    )

    assert response.status_code == 200
    assert observed["request_message_id"] == "msg-stable-a"
    assert observed["document_id"] == "doc-a"
    assert observed["confirmed"] is True
    assert response.json()["data"]["operation_refs"] == [
        {
            "operation_id": "op-recorded-a",
            "status": "draft",
            "current_attempt": 1,
            "latest_event_seq": 1,
        }
    ]
    assert response.json()["data"]["confirmation_mode"] == "explicit"
    assert response.json()["data"]["confirmation_requests"] == [
        {
            "schema": "retainpdf_agent_confirmation_v1",
            "operation_id": "op-recorded-a",
            "action": "run",
            "status": "draft",
            "current_attempt": 1,
            "latest_event_seq": 1,
            "requires_risk_acceptance": False,
        }
    ]
    assert [message["role"] for message in observed["messages_during_runtime"]] == [
        "user"
    ]
    conversation_id = response.json()["data"]["conversation_id"]
    final_messages = rust.get_conversation(conversation_id)["messages"]
    assert [message["role"] for message in final_messages] == ["user", "assistant"]
    assert sum(message["message_id"] == "msg-stable-a" for message in final_messages) == 1
    assert final_messages[-1]["model"] == "fx-model"

    reading = client.post(
        "/v1/ask",
        json={
            "question": "总结正文",
            "document_id": "doc-a",
            "assistant_mode": "reading",
        },
        headers={"X-API-Key": "test-key"},
    )
    assert reading.status_code == 200
    reading_conversation = reading.json()["data"]["conversation_id"]
    reading_messages = rust.get_conversation(reading_conversation)["messages"]
    assert reading_messages[-1]["model"] == "reading-model"


def test_confirmation_projection_is_structured_and_green_light_suppresses_it():
    result = AskResult(
        answer="",
        operation_refs=[
            {
                "operation_id": "op-a",
                "status": "result_ready",
                "current_attempt": 2,
                "latest_event_seq": 9,
            },
            {
                "operation_id": "op-b",
                "status": "ambiguous",
                "current_attempt": 1,
                "latest_event_seq": 4,
            },
        ],
    )

    assert _confirmation_requests(result, "explicit") == [
        {
            "schema": "retainpdf_agent_confirmation_v1",
            "operation_id": "op-a",
            "action": "commit",
            "status": "result_ready",
            "current_attempt": 2,
            "latest_event_seq": 9,
            "requires_risk_acceptance": False,
        },
        {
            "schema": "retainpdf_agent_confirmation_v1",
            "operation_id": "op-b",
            "action": "retry",
            "status": "ambiguous",
            "current_attempt": 1,
            "latest_event_seq": 4,
            "requires_risk_acceptance": True,
        },
    ]
    assert _confirmation_requests(result, "green_light") == []
