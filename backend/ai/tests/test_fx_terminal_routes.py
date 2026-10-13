"""/v1/fx/terminal 的端到端：鉴权、开关、双向、收尾。

这里起的是真 WebSocket 接真 PTY，只把 argv 换掉 —— 本机不一定装了 fx。
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from retainpdf_ai import fx_terminal_routes
from retainpdf_ai.config import Settings
from retainpdf_ai.fx_terminal import TerminalLaunch
from retainpdf_ai.fx_terminal_routes import (
    authorize_terminal_request,
    register_fx_terminal_routes,
)

API_KEY = "test-key"


def _settings(tmp_path: Path, *, shell_mode: bool = True) -> Settings:
    return Settings(
        api_keys=(API_KEY,),
        fx_shell_mode=shell_mode,
        fx_state_root=tmp_path / "fx",
        data_root=tmp_path / "data",
    )


def _client(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, *, shell_mode: bool = True
) -> TestClient:
    # PTY 层不关心跑什么程序；这里换成 cat，回显即可证明双向都通。
    monkeypatch.setattr(
        fx_terminal_routes,
        "build_terminal_launch",
        # 签名要和真的一样（含 busy_session_ids）—— 替身漂了的表现是路由抛
        # TypeError，被 except 吞成 1011，测试报 WebSocketDisconnect，
        # 完全看不出真正原因。
        lambda settings, *, session_key, argv=None, busy_session_ids=(): TerminalLaunch(
            argv=argv or ("/bin/cat",),
            cwd=Path("/tmp"),
            env={"PATH": "/usr/bin:/bin", "TERM": "xterm-256color"},
        ),
    )
    app = FastAPI()
    register_fx_terminal_routes(app, settings=_settings(tmp_path, shell_mode=shell_mode))
    return TestClient(app)


def _until(websocket, kind: str, *, limit: int = 40) -> dict:
    for _ in range(limit):
        message = websocket.receive_json()
        if message.get("type") == kind:
            return message
    raise AssertionError(f"没等到 {kind}")


# ---------------------------------------------------------------- 鉴权


@pytest.mark.parametrize(
    ("keys", "header", "query", "expected"),
    [
        (("k",), "k", "", True),
        (("k",), "", "k", True),  # 浏览器的 WebSocket 构造函数设不了请求头
        (("k",), "wrong", "wrong", False),
        (("k",), "", "", False),
        ((), "k", "k", False),  # 没配 key 不等于谁都能进
        (("",), "", "", False),  # 空字符串不是一把 key
    ],
)
def test_handshake_authorization(keys, header, query, expected) -> None:
    assert authorize_terminal_request(keys, header, query) is expected


def test_a_bad_key_cannot_open_a_terminal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    with pytest.raises(Exception):  # noqa: B017,PT011 - starlette 关闭连接的异常类型
        with client.websocket_connect("/v1/fx/terminal?api_key=nope") as websocket:
            websocket.receive_json()


# ---------------------------------------------------------------- 开关


def test_the_shell_mode_switch_also_governs_this_route(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """关着时不许开 PTY。

    否则这条路会绕开 shell_mode —— 那个开关的意义是「能不能在本机跑任意
    命令」，从 WS 进来和从 ACP 进来是同一件事。
    """
    client = _client(tmp_path, monkeypatch, shell_mode=False)
    with client.websocket_connect(f"/v1/fx/terminal?api_key={API_KEY}") as websocket:
        message = websocket.receive_json()
    assert message["type"] == "exit"
    assert "disabled" in message["reason"]


# ---------------------------------------------------------------- 双向


def test_input_reaches_the_pty_and_output_comes_back(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    with client.websocket_connect(f"/v1/fx/terminal?api_key={API_KEY}") as websocket:
        ready = _until(websocket, "ready")
        assert ready["pid"] > 0
        websocket.send_json({"type": "input", "data": "终端双向\n"})
        seen = ""
        for _ in range(40):
            message = websocket.receive_json()
            if message.get("type") == "output":
                seen += message["data"]
                if "终端双向" in seen:
                    return
        pytest.fail(f"没读回输入，收到的是 {seen!r}")


def test_resize_is_accepted_without_tearing_the_session_down(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    with client.websocket_connect(f"/v1/fx/terminal?api_key={API_KEY}") as websocket:
        _until(websocket, "ready")
        websocket.send_json({"type": "resize", "cols": 200, "rows": 60})
        websocket.send_json({"type": "resize", "cols": -1, "rows": "x"})  # 非法值
        websocket.send_json({"type": "input", "data": "still alive\n"})
        seen = ""
        for _ in range(40):
            message = websocket.receive_json()
            if message.get("type") == "output":
                seen += message["data"]
                if "still alive" in seen:
                    return
        pytest.fail("resize 之后会话断了")


def test_unknown_message_types_are_ignored(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """前端可能比后端新。未知 type 忽略即可，不该踢掉连接。"""
    client = _client(tmp_path, monkeypatch)
    with client.websocket_connect(f"/v1/fx/terminal?api_key={API_KEY}") as websocket:
        _until(websocket, "ready")
        websocket.send_json({"type": "from-the-future", "payload": 1})
        websocket.send_json({"type": "input", "data": "ok\n"})
        seen = ""
        for _ in range(40):
            message = websocket.receive_json()
            if message.get("type") == "output":
                seen += message["data"]
                if "ok" in seen:
                    return
        pytest.fail("未知 type 把连接搞断了")


# Windows 没有这几个模块。在子进程里把它们屏蔽掉，模拟 Windows 的导入环境（#143）。
_WINDOWS_IMPORT_SIMULATION = """
import sys
for name in ("fcntl", "pty", "termios"):
    sys.modules[name] = None  # 之后 import 它们会抛 ImportError，和 Windows 上一样

import retainpdf_ai.app  # 以前在这里就崩：fx_terminal 无条件 import fcntl

from pathlib import Path
from fastapi import FastAPI
from fastapi.testclient import TestClient
from retainpdf_ai.config import Settings
from retainpdf_ai.fx_terminal_routes import register_fx_terminal_routes

root = Path(sys.argv[1])
app = FastAPI()
register_fx_terminal_routes(
    app,
    settings=Settings(api_keys=("k",), fx_shell_mode=True, fx_state_root=root / "fx", data_root=root / "data"),
)
with TestClient(app).websocket_connect("/v1/fx/terminal?api_key=k") as websocket:
    message = websocket.receive_json()
print(message["type"], message["reason"])
"""


def test_ai_service_starts_without_unix_only_modules(tmp_path: Path) -> None:
    """Windows 桌面版：AI 服务要能起来，只有终端说明暂不支持，不能把整个服务带崩。"""
    import subprocess
    import sys

    result = subprocess.run(
        [sys.executable, "-c", _WINDOWS_IMPORT_SIMULATION, str(tmp_path)],
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, result.stderr[-2000:]
    kind, reason = result.stdout.strip().splitlines()[-1].split(" ", 1)
    assert kind == "exit"
    assert "Windows" in reason
