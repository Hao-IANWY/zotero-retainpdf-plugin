"""fx 终端模式：两把锁各自的行为，以及默认关时老行为原样。

背景：fx 0.0.5 自带 Terminal Tool，终端一直都在。真正堵死它的是两处宿主设置：
  1. approve_permission 里非 broker 语法一律 return False
  2. PATH 只有 broker shim 目录 + fx 自己所在目录（没有 /usr/bin）
只开一把没用 —— 放行了命令但 PATH 上找不到，或者找得到但被拒。

这份测试盯死三件事：默认必须是关的；开了两把锁都得开；broker 那条固定语法
在两种模式下都不受影响（它有自己的配额和结构化事件，不能被 shell 分支吞掉）。
"""

from __future__ import annotations

import pathlib
import tempfile

import pytest

from retainpdf_ai.agent_broker_contracts import BrokerScope
from retainpdf_ai.agent_command_broker import (
    _MAX_SHELL_CALLS_PER_TURN,
    AgentCommandBroker,
)
from retainpdf_ai.config import Settings, _env_flag


def _broker_kwargs() -> dict:
    return {
        "state_root": pathlib.Path(tempfile.mkdtemp()),
        "cli_command": "retainpdf-agent",
        "rust_api_url": "http://127.0.0.1:41000",
        "rust": None,
        "scope": BrokerScope(
            conversation_id="conv",
            document_id="doc",
            request_message_id="msg",
            intent_summary="intent",
        ),
    }


def _broker(shell_mode: bool) -> AgentCommandBroker:
    return AgentCommandBroker(**_broker_kwargs(), shell_mode=shell_mode)


def _broker_with_default_shell_mode() -> AgentCommandBroker:
    """**不传** shell_mode —— 这是唯一能测到默认值的构造方式。

    显式传 False 的测试守不住默认值：默认改成 True 它照样绿。
    """
    return AgentCommandBroker(**_broker_kwargs())


def _permission(command: str, tool_call_id: str = "tc-1") -> dict:
    return {
        "options": [{"optionId": "allow_once"}],
        "toolCall": {
            "kind": "execute",
            "toolCallId": tool_call_id,
            "rawInput": {"command": command},
        },
    }


SHELL_COMMANDS = [
    "cat /tmp/document.v1.json",
    "grep -n title page-001.json",
    "python3 -c 'print(1)'",
    "ls | jq .",
    "./some/unknown/binary --flag",
]


@pytest.mark.parametrize("command", SHELL_COMMANDS)
def test_shell_commands_are_rejected_when_the_mode_is_off(command: str) -> None:
    assert _broker(shell_mode=False).approve_permission(_permission(command)) is False


@pytest.mark.parametrize("command", SHELL_COMMANDS)
def test_the_default_is_off_at_every_layer(command: str) -> None:
    """不传 shell_mode 时必须是关的，Settings 的默认也必须是关的。

    这条和上面那条看着像重复，其实不是：上面显式传 False，守的是「关的时候
    行为对」；这条不传，守的是「默认值本身没被改成开」。少了这条，把
    `shell_mode: bool = False` 改成 True 全套测试照样绿 —— 这正是反证跑出来的。
    """
    assert (
        _broker_with_default_shell_mode().approve_permission(_permission(command))
        is False
    )
    assert Settings().fx_shell_mode is False, "Settings 的默认值被改成开了"


@pytest.mark.parametrize("command", SHELL_COMMANDS)
def test_shell_commands_are_allowed_when_the_mode_is_on(command: str) -> None:
    assert _broker(shell_mode=True).approve_permission(_permission(command)) is True


@pytest.mark.parametrize("shell_mode", [False, True])
def test_the_broker_grammar_keeps_working_in_both_modes(shell_mode: bool) -> None:
    """broker 那条语法有自己的配额和结构化事件，不能被 shell 分支顺手吞掉。"""
    broker = _broker(shell_mode=shell_mode)
    assert (
        broker.approve_permission(_permission("retainpdf-agent document inspect"))
        is True
    )


def test_shell_calls_do_not_spend_the_operation_budget() -> None:
    """终端里翻几十次文件，不该把 16 次/轮的 operation 配额吃光。

    共用配额的话，用户先让 agent 查一圈再让它改文档，改就没配额了。
    """
    broker = _broker(shell_mode=True)
    for index in range(20):
        assert broker.approve_permission(_permission("cat x", f"tc-{index}")) is True
    assert (
        broker.approve_permission(_permission("retainpdf-agent document inspect"))
        is True
    ), "shell 调用吃掉了 operation 的配额"


def test_shell_calls_still_have_a_ceiling() -> None:
    """放开不等于无限。跑飞的循环得有个头。"""
    broker = _broker(shell_mode=True)
    for index in range(_MAX_SHELL_CALLS_PER_TURN):
        assert broker.approve_permission(_permission("cat x", f"tc-{index}")) is True
    assert broker.approve_permission(_permission("cat x", "tc-over")) is False


def test_shell_events_carry_the_executable_but_not_the_arguments() -> None:
    """参数里有文档正文和路径，不该进事件流跟着日志到处跑。"""
    events: list[dict] = []
    broker = _broker(shell_mode=True)
    broker._on_tool_event = events.append  # noqa: SLF001 - 构造参数无公开注入点
    secret_path = "/Users/someone/private/manuscript.pdf"
    assert broker.approve_permission(_permission(f"cat {secret_path}")) is True
    assert events, "放行了却没有留下审计事件"
    serialized = repr(events)
    assert "shell:cat" in serialized
    assert secret_path not in serialized, "命令参数泄进了事件流"


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("1", True),
        ("true", True),
        ("YES", True),
        ("on", True),
        ("", False),
        ("0", False),
        ("off", False),
        ("maybe", False),
    ],
)
def test_the_env_flag_only_opens_on_an_explicit_true(
    monkeypatch: pytest.MonkeyPatch, value: str, expected: bool
) -> None:
    """拼错、空值、"off" 一律算关 —— 这个开关误读成开的代价太大。"""
    monkeypatch.setenv("RETAIN_AI_TEST_FLAG", value)
    assert _env_flag("RETAIN_AI_TEST_FLAG") is expected


def test_the_env_flag_is_off_when_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("RETAIN_AI_TEST_FLAG", raising=False)
    assert _env_flag("RETAIN_AI_TEST_FLAG") is False
