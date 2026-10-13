"""把 provider 自己的参数透传到上游。

fx 0.0.5 的网关协议只发 prompt / tools / toolChoice —— 没有 temperature、
没有 max_tokens、没有任何思考强度参数（抓包确认过）。想调 provider 的旋钮
只能从宿主这边加。

不做成「思考强度」这种命名参数：各家开关形状完全不同，翻译语义等于把 provider
知识塞进桥里。实测 DeepSeek 的 {"thinking":{"type":"disabled"}} 确定生效
（reasoning_tokens 归零，两次一致）；reasoning_effort 三档 API 接受但样本太小
没测出可靠差异。所以只搬运，不翻译，也不在命名上承诺语义。
"""

from __future__ import annotations

import pytest

from retainpdf_ai.config import _env_json_object
from retainpdf_ai.fx_openai_bridge import merge_safe_extra_body, translate_gateway_request

PROMPT = {"prompt": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}]}


def test_extra_fields_reach_the_upstream_body() -> None:
    body = translate_gateway_request(
        PROMPT, model="m", extra_body={"thinking": {"type": "disabled"}}
    )
    assert body["thinking"] == {"type": "disabled"}


def test_no_extra_body_changes_nothing() -> None:
    assert translate_gateway_request(PROMPT, model="m") == translate_gateway_request(
        PROMPT, model="m", extra_body={}
    )


@pytest.mark.parametrize("field", ["model", "messages", "stream"])
def test_the_bridge_owned_fields_cannot_be_overridden(field: str) -> None:
    """model / messages / stream 是桥对 fx 的协议契约。

    被外部配置改掉会让「fx 收到的」和「它以为的」对不上，而且不报错 ——
    比如把 stream 打开，桥的非流式解析会当场拿到一堆 SSE 文本。
    """
    body = translate_gateway_request(
        PROMPT, model="real-model", extra_body={field: "hijacked"}
    )
    assert body[field] != "hijacked"


def test_merge_ignores_non_objects() -> None:
    assert merge_safe_extra_body({"a": 1}, None) == {"a": 1}
    assert merge_safe_extra_body({"a": 1}, "not-an-object") == {"a": 1}  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ('{"thinking":{"type":"disabled"}}', {"thinking": {"type": "disabled"}}),
        ("", {}),
        ("not json", {}),
        ("[1,2]", {}),      # 是 JSON 但不是对象
        ('"a string"', {}),
        ("null", {}),
    ],
)
def test_the_env_var_only_accepts_a_json_object(
    monkeypatch: pytest.MonkeyPatch, raw: str, expected: dict
) -> None:
    """写错了不该让整个服务起不来，但也不能猜 —— 不是对象就当没配。"""
    monkeypatch.setenv("RETAIN_AI_TEST_EXTRA", raw)
    assert _env_json_object("RETAIN_AI_TEST_EXTRA") == expected


def test_the_env_var_is_empty_when_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("RETAIN_AI_TEST_EXTRA", raising=False)
    assert _env_json_object("RETAIN_AI_TEST_EXTRA") == {}


def test_max_output_tokens_reaches_the_upstream() -> None:
    """fx 0.0.10 起会带 maxOutputTokens，要翻成 OpenAI 的 max_tokens。

    丢掉它不是「少一个可选参数」—— fx 按这个上限规划上下文，上游不受限就可能
    回一段超出它预期的内容。0.0.5 不发这个字段，所以这段在旧版上是死代码。
    """
    body = translate_gateway_request({**PROMPT, "maxOutputTokens": 4096}, model="m")
    assert body["max_tokens"] == 4096


@pytest.mark.parametrize("bad", [0, -1, "4096", None, 1.5])
def test_a_bad_max_output_tokens_is_ignored(bad: object) -> None:
    """非正整数一律不转发 —— 上游收到 max_tokens=0 会直接拒。"""
    body = translate_gateway_request({**PROMPT, "maxOutputTokens": bad}, model="m")
    assert "max_tokens" not in body


def test_extra_body_can_override_max_tokens() -> None:
    """max_tokens 不是桥的契约字段，用户想覆盖就让他覆盖。"""
    body = translate_gateway_request(
        {**PROMPT, "maxOutputTokens": 4096}, model="m", extra_body={"max_tokens": 100}
    )
    assert body["max_tokens"] == 100


# ------------------------------------------------- 向 fx 声明 reasoning effort


def _catalog(**kwargs):
    from retainpdf_ai.fx_openai_bridge import FxOpenAIChatBridge

    bridge = FxOpenAIChatBridge(
        base_url="https://api.example/v1", model="m", **kwargs
    )
    return bridge._catalog_entry()  # noqa: SLF001 - 没有公开访问点，起服务代价太大


def test_no_efforts_declared_keeps_the_plain_entry() -> None:
    entry = _catalog()
    assert "reasoning_options" not in entry
    assert entry["tags"] == ["tool-use"]


def test_declared_efforts_use_the_shape_fx_actually_parses() -> None:
    """键名是 reasoning_options，值是带 type 的对象数组。

    照字段名猜了两轮（reasoning_efforts / has_reasoning / tags:["reasoning"]）
    都没出现选项，最后是从 fx 源码 src/builtins/gateway.zig 的解析器和测试夹具
    里翻出来的真格式。写错 fx **不报错**，只是「Reasoning Effort」这一项不出现
    —— 所以这条测试守的是一个静默失败。
    """
    entry = _catalog(reasoning_efforts=("low", "high", "max"))
    assert entry["reasoning_options"] == [
        {"type": "effort", "values": ["low", "high", "max"]}
    ]
    assert "reasoning" in entry["tags"], "没有 reasoning 标签时 fx 不认这个能力"


def test_effort_order_is_preserved() -> None:
    """fx 的选择器按声明顺序显示。"""
    entry = _catalog(reasoning_efforts=("max", "low"))
    assert entry["reasoning_options"][0]["values"] == ["max", "low"]


def test_blank_efforts_are_dropped() -> None:
    entry = _catalog(reasoning_efforts=("low", "  ", "", "max"))
    assert entry["reasoning_options"][0]["values"] == ["low", "max"]


def test_the_catalog_is_what_unlocks_the_tui_effort_picker() -> None:
    """这条是提醒，不是断言新行为：TUI 里的档位列表是靠这份目录解锁的。

    入口是 `/model <模型id> `（尾部空格），不是 ctrl+p —— 后者只选模型。
    删掉 reasoning_options 的话，`/model deepseek-flash ` 后面会是空的，
    而 fx 不会报任何错。
    """
    entry = _catalog(reasoning_efforts=("low", "high", "max"))
    assert entry.get("reasoning_options"), "没有它，TUI 的 /model 档位列表是空的"
