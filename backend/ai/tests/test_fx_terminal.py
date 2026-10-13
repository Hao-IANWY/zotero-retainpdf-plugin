"""PTY 终端层：双向、尺寸、收尾，以及跨块解码。

这一层不关心跑的是什么程序 —— 本机不一定装了 fx，测试也不该依赖它。
所以被试一律用 coreutils，argv 从 build_terminal_launch 的注入点进去。
"""

from __future__ import annotations

import os
import time
from pathlib import Path

import pytest

from retainpdf_ai import fx_terminal
from retainpdf_ai.fx_terminal import (
    PtySession,
    TerminalLaunch,
    build_terminal_launch,
    clamp_window_size,
)


def _launch(*argv: str) -> TerminalLaunch:
    return TerminalLaunch(
        argv=argv,
        cwd=Path("/tmp"),
        env={"PATH": "/usr/bin:/bin", "TERM": "xterm-256color", "LANG": "en_US.UTF-8"},
    )


def _drain(session: PtySession, *, deadline_s: float = 5.0) -> str:
    """读到子进程关闭为止。"""
    collected: list[str] = []
    end = time.monotonic() + deadline_s
    while time.monotonic() < end:
        chunk = session.read()
        if chunk is None:
            break
        collected.append(chunk)
    return "".join(collected)


def _settings(tmp_path: Path, **overrides) -> "Settings":
    from retainpdf_ai.config import Settings

    return Settings(
        fx_state_root=tmp_path / "fx",
        data_root=tmp_path / "data",
        fx_command="/bin/cat",  # 本机不一定装了 fx；这一层不关心跑什么
        **overrides,
    )


def test_the_gateway_key_is_handed_to_the_terminal(tmp_path: Path) -> None:
    """不传凭据的话 TUI 第一屏是「Welcome to fx，请登录」。

    用户已经在设置里填过 Gateway Key，不该在终端里再登一次 —— ACP 那条路
    一直是传的，PTY 这条漏了会让两条路行为不一致。
    """
    launch = build_terminal_launch(
        _settings(tmp_path, fx_gateway_api_key="gw-key"), session_key="s"
    )
    assert launch.env.get("AI_GATEWAY_API_KEY") == "gw-key"


def test_no_gateway_key_means_no_empty_variable(tmp_path: Path) -> None:
    """没配就别塞空串 —— fx 见到空的 AI_GATEWAY_API_KEY 可能当成「配了但无效」。"""
    launch = build_terminal_launch(_settings(tmp_path), session_key="s")
    assert "AI_GATEWAY_API_KEY" not in launch.env


def test_a_custom_gateway_sets_both_url_variables(tmp_path: Path) -> None:
    """fx 0.0.5 不从 base URL 推导 completion 端点。

    只设一个的话，模型请求走公网 Gateway 而目录请求走自定义地址 —— 两边不
    一致，而且不会报错。
    """
    launch = build_terminal_launch(
        _settings(tmp_path, fx_gateway_base_url="http://127.0.0.1:8899"),
        session_key="s",
    )
    assert launch.env.get("FX_GATEWAY_BASE_URL")
    assert launch.env.get("FX_GATEWAY_CHAT_URL")


def test_the_terminal_runs_inside_the_private_workspace(tmp_path: Path) -> None:
    """cwd 必须是私有 workspace，不能是宿主的当前目录。"""
    launch = build_terminal_launch(_settings(tmp_path), session_key="s")
    assert launch.cwd.is_relative_to((tmp_path / "fx").resolve())
    assert (launch.cwd / "AGENTS.md").is_file(), "workspace 说明文件没写出来"
    assert launch.env["HOME"] != os.path.expanduser("~"), "HOME 没指向私有目录"


def test_terminal_sessions_share_one_fx_home(tmp_path: Path) -> None:
    """换一本书不该要求用户重新登录一次 fx。

    HOME 放的是 fx 的**账号和配置**，那不是按文档分的东西。第一版每个 session
    一个 HOME，结果在终端里登录之后换本书就又是登录页 —— 对 ACP 那条路无所谓
    （宿主替用户批，本来就没有交互登录），对人用的终端是荒谬的。
    """
    first = build_terminal_launch(_settings(tmp_path), session_key="job-a")
    second = build_terminal_launch(_settings(tmp_path), session_key="job-b")
    assert first.env["HOME"] == second.env["HOME"]


def test_terminal_workspaces_stay_isolated_per_session(tmp_path: Path) -> None:
    """共享的只有账号。工作区里是文件，那是按文档分的。"""
    first = build_terminal_launch(_settings(tmp_path), session_key="job-a")
    second = build_terminal_launch(_settings(tmp_path), session_key="job-b")
    assert first.cwd != second.cwd
    assert first.env["TMPDIR"] != second.env["TMPDIR"]


def test_the_acp_path_keeps_its_per_session_home(tmp_path: Path) -> None:
    """共享 HOME 只给交互式终端。ACP 那条路的隔离是有意的，不能被顺手改掉。"""
    from retainpdf_ai.runtimes.fx_process import prepare_fx_state

    _, home_a, _, _ = prepare_fx_state(_settings(tmp_path), session_key="conv-a")
    _, home_b, _, _ = prepare_fx_state(_settings(tmp_path), session_key="conv-b")
    assert home_a != home_b


def test_input_reaches_the_child_and_output_comes_back() -> None:
    session = PtySession(_launch("/bin/cat"))
    session.open(cols=100, rows=30)
    try:
        session.write("hello\n")
        time.sleep(0.3)
        assert "hello" in (session.read() or "")
    finally:
        session.close()


def test_a_multibyte_character_split_across_reads_survives(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """一个中文字符占 3 字节，跨读边界必被切开。

    逐块 decode 会在切口吐出替换字符，而且再也补不回来 —— 用户看到的就是
    满屏乱码。把 chunk 压到 1 字节，让每个字符都切开，逼出这个问题。
    """
    monkeypatch.setattr(fx_terminal, "_READ_CHUNK_BYTES", 1)
    text = "中文终端测试"
    session = PtySession(_launch("/bin/echo", text))
    session.open()
    try:
        assert text in _drain(session)
    finally:
        session.close()
    assert "�" not in text  # 源串本身没有替换字符，断言才有意义


def test_reading_after_the_child_exits_reports_closure_instead_of_raising() -> None:
    """子进程退出后读 PTY 主端会拿到 EIO。那是正常收尾，不是故障。"""
    session = PtySession(_launch("/bin/echo", "bye"))
    session.open()
    try:
        _drain(session)
        assert session.read() is None
    finally:
        session.close()


def test_close_is_idempotent_and_reaps_the_child() -> None:
    session = PtySession(_launch("/bin/cat"))
    session.open()
    pid = session.pid
    assert pid > 0
    session.close()
    assert session.closed
    session.close()  # 重复调用必须安全
    deadline = time.monotonic() + 3.0
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        time.sleep(0.05)
    pytest.fail("子进程没有被回收，close 留下了僵尸")


def test_a_child_that_ignores_hangup_is_still_killed_and_reaped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """扛住 SIGHUP 的子进程必须被 SIGKILL 掉，并且收尸。

    这条和上面那条不是重复 —— 上面用 /bin/cat，它收到 SIGHUP 就死，在宽限期
    内就被回收，**SIGKILL 那条路根本走不到**。反证跑出来才发现：把结尾的
    阻塞 waitpid 改回 WNOHANG，上面那条照样绿。
    fx 的 TUI 正是会捕获挂断自己收尾的那类程序，所以这条路必须有人守。
    """
    monkeypatch.setattr(fx_terminal, "_HANGUP_GRACE_SECONDS", 0.2)
    session = PtySession(
        _launch("/bin/sh", "-c", 'trap "" HUP; while :; do sleep 0.1; done')
    )
    session.open()
    pid = session.pid
    time.sleep(0.2)  # 等 trap 装上
    session.close()
    deadline = time.monotonic() + 3.0
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        time.sleep(0.05)
    pytest.fail("扛 SIGHUP 的子进程没被回收，close 留下了僵尸")


def test_writing_to_a_closed_session_is_a_no_op() -> None:
    session = PtySession(_launch("/bin/cat"))
    session.open()
    session.close()
    session.write("这行没人收")  # 不该抛
    assert session.read() is None


def test_opening_twice_is_refused() -> None:
    """重复 open 会把第一个 fd 和 pid 覆盖掉，留下一个收不了尾的子进程。"""
    session = PtySession(_launch("/bin/cat"))
    session.open()
    try:
        with pytest.raises(RuntimeError):
            session.open()
    finally:
        session.close()


@pytest.mark.parametrize(
    ("cols", "rows", "expected"),
    [
        (80, 24, (80, 24)),
        (0, 0, (2, 1)),
        (-5, -5, (2, 1)),
        (99999, 99999, (1000, 500)),
        ("abc", None, (2, 1)),
    ],
)
def test_window_size_is_clamped(cols, rows, expected) -> None:
    """尺寸直接进 TIOCSWINSZ 的 struct，前端传什么都不能信。"""
    assert clamp_window_size(cols, rows) == expected


def test_the_child_sees_the_window_size_we_set() -> None:
    """行列不能写反。TIOCSWINSZ 是 (rows, cols)，写反了终端按转置尺寸重绘，
    而且不报任何错 —— 只能靠让子进程自己报出来。"""
    session = PtySession(
        _launch("/bin/sh", "-c", "stty size < /dev/tty")
    )
    session.open(cols=123, rows=45)
    try:
        assert "45 123" in _drain(session), "行列写反了"
    finally:
        session.close()


# ---------------------------------------------------------------- OpenAI 兼容桥


def test_a_configured_openai_endpoint_replaces_the_gateway(tmp_path: Path) -> None:
    """配了自己的 OpenAI 兼容端点就不该再要 Vercel Gateway 的 key。

    ACP 那条路一直支持，PTY 这条原来没有 —— 于是有自己端点的用户在终端里只能
    去登录 Vercel，而他明明已经配好了一个能用的模型。
    """
    launch = build_terminal_launch(
        _settings(
            tmp_path,
            fx_openai_base_url="https://api.deepseek.com/v1",
            fx_openai_api_key="sk-test",
            llm_model="deepseek-flash",
        ),
        session_key="s",
    )
    try:
        assert launch.env.get("FX_GATEWAY_CHAT_URL", "").startswith("http://127.0.0.1:")
        assert launch.env.get("FX_GATEWAY_BASE_URL", "").startswith("http://127.0.0.1:")
        assert launch.env.get("AI_GATEWAY_API_KEY"), "桥要给 fx 一把占位 key"
        assert launch.env.get("FX_MODEL") == "deepseek-flash"
        assert launch.cleanup is not None, "桥必须带一个关闭钩子"
    finally:
        if launch.cleanup:
            launch.cleanup()


def test_closing_the_session_shuts_the_bridge_down(tmp_path: Path) -> None:
    """桥是个回环 HTTP 服务。不跟着会话关，每开一次终端漏一个监听端口。"""
    import socket as socket_module
    from urllib.parse import urlparse

    launch = build_terminal_launch(
        _settings(
            tmp_path,
            fx_openai_base_url="https://api.deepseek.com/v1",
            fx_openai_api_key="sk-test",
            llm_model="deepseek-flash",
        ),
        session_key="s",
    )
    parsed = urlparse(launch.env["FX_GATEWAY_BASE_URL"])
    port = parsed.port
    assert port

    def reachable() -> bool:
        with socket_module.socket() as probe:
            probe.settimeout(0.5)
            return probe.connect_ex(("127.0.0.1", port)) == 0

    assert reachable(), "桥没起来"
    session = PtySession(
        TerminalLaunch(argv=("/bin/cat",), cwd=Path("/tmp"), env={}, cleanup=launch.cleanup)
    )
    session.open()
    session.close()
    deadline = time.monotonic() + 3.0
    while time.monotonic() < deadline:
        if not reachable():
            return
        time.sleep(0.05)
    launch.cleanup and launch.cleanup()
    pytest.fail("会话关了桥还在监听 —— 端口泄漏")


def test_no_endpoint_means_no_bridge_and_no_cleanup(tmp_path: Path) -> None:
    """没配就别起。起一个空转的回环服务只是白占端口。"""
    launch = build_terminal_launch(_settings(tmp_path), session_key="s")
    assert launch.cleanup is None
    assert "FX_GATEWAY_CHAT_URL" not in launch.env


def test_the_terminal_falls_back_to_the_agent_llm_config(tmp_path: Path) -> None:
    """没配 fx 专用端点时，用 agent 自己的 LLM 配置。

    用户在「设置 → AI Agent」里配好的就是他给这个 agent 选的模型；终端跑的是
    同一个 agent，不该要求他再配一套。不回退的话，唯一能用的路是去登录
    Vercel —— 而他明明已经有一个能用的模型。
    """
    launch = build_terminal_launch(
        _settings(
            tmp_path,
            llm_base_url="https://api.deepseek.com/v1",
            llm_api_key="sk-agent",
            llm_model="deepseek-flash",
        ),
        session_key="s",
    )
    try:
        assert launch.cleanup is not None, "应当起桥"
        assert launch.env.get("FX_MODEL") == "deepseek-flash"
    finally:
        if launch.cleanup:
            launch.cleanup()


def test_the_fx_specific_endpoint_wins_over_the_agent_one(tmp_path: Path) -> None:
    """显式给终端配的端点是更强的意图，不能被 agent 的配置盖掉。"""
    from retainpdf_ai.fx_terminal import _terminal_inference_endpoint

    base, key = _terminal_inference_endpoint(
        _settings(
            tmp_path,
            fx_openai_base_url="https://fx.example/v1",
            fx_openai_api_key="sk-fx",
            llm_base_url="https://api.deepseek.com/v1",
            llm_api_key="sk-agent",
        )
    )
    assert base == "https://fx.example/v1"
    assert key == "sk-fx"


def test_an_agent_endpoint_without_a_key_does_not_start_a_bridge(tmp_path: Path) -> None:
    """只有地址没有 key 起桥没用 —— 上游一定 401，而且错误信息看不出原因。"""
    from retainpdf_ai.fx_terminal import _terminal_inference_endpoint

    base, _ = _terminal_inference_endpoint(
        _settings(tmp_path, llm_base_url="https://api.deepseek.com/v1", llm_api_key="")
    )
    assert base == ""
