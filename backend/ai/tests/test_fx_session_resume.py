"""终端接上上一次的对话。

## 这个功能在修什么

在这之前，WebSocket 一断（刷新页面、后端重启、网络抖动）`fx_terminal_routes` 的
`finally: pty_session.close()` 就把 fx 杀了，整段对话没了。

而 fx **一直在存会话** —— 本机 shared-home 里躺着 10 个。只是从来没人 resume。

## 为什么不能用 `fx session resume last`

实测：10 个会话里 6 个 `history_len=0`。fx 每次启动都会建一个会话并保存，哪怕你
一个字没打。所以「最新的」经常是个空壳，resume 它等于没恢复。
"""

from __future__ import annotations

from pathlib import Path

from retainpdf_ai.fx_terminal import pick_resumable_session

WS = Path("/books/a/ai")


def s(sid: str, *, history: int, updated: int, workspace: Path = WS) -> dict:
    return {
        "id": sid,
        "history_len": history,
        "updated_at_ms": updated,
        "workspace_root": str(workspace),
    }


def test_empty_sessions_are_skipped_even_when_they_are_the_newest() -> None:
    """这条是整个功能成立的前提。

    fx 每次启动都存一个空会话，所以「最新」几乎总是空的 —— 实测本机 10 个里
    6 个空，而最新那个正好空。直接 `resume last` 会恢复一个空壳。
    """
    assert pick_resumable_session(
        [s("empty", history=0, updated=999), s("real", history=3, updated=100)],
        workspace=WS,
    ) == "real"


def test_the_newest_non_empty_wins() -> None:
    assert pick_resumable_session(
        [s("old", history=9, updated=100), s("new", history=1, updated=200)],
        workspace=WS,
    ) == "new"


def test_other_books_sessions_are_never_picked() -> None:
    """串到别的书的会话上是最难查的那种错：内容对不上，而两边看起来都正常。

    fx 自己按 cwd 隔离（实测：没跑过的工作区返回 NoSavedSessions），这里多一道。
    """
    assert pick_resumable_session(
        [s("other", history=9, updated=999, workspace=Path("/books/b/ai"))],
        workspace=WS,
    ) is None


def test_a_session_held_by_a_live_process_is_skipped() -> None:
    """两个标签页开同一本书时，第二个 fx 会直接报
    `another fx process may be using this session` 然后退出 —— 终端只剩一行错误。
    实测过。

    注意**刷新页面不走这条**：旧 PTY close 之后就从集合里移掉了，fx 的锁文件
    虽然残留但它按 PID 判活会放行（也实测过）。
    """
    sessions = [s("busy", history=5, updated=999), s("free", history=2, updated=100)]
    assert pick_resumable_session(sessions, workspace=WS, busy_ids={"busy"}) == "free"
    assert pick_resumable_session(sessions, workspace=WS, busy_ids={"busy", "free"}) is None


def test_garbage_entries_are_skipped_not_fatal() -> None:
    """这份 JSON 来自外部程序，换个版本字段就可能变。

    一条读不懂不该让终端打不开 —— 顶多是这次不恢复。
    """
    assert pick_resumable_session(
        [
            {},
            {"id": "", "history_len": 9, "updated_at_ms": 9},
            {"id": "x", "history_len": "两条", "updated_at_ms": 9},
            {"id": "y", "history_len": 1, "updated_at_ms": "刚刚"},
            s("ok", history=1, updated=5),
        ],
        workspace=WS,
    ) == "ok"
    assert pick_resumable_session([], workspace=WS) is None


def test_missing_workspace_root_is_accepted() -> None:
    """老版本的 fx 可能不给这个字段。宁可恢复也不要因为字段缺失就放弃 ——
    fx 那边本来就按 cwd 隔离过一次了。"""
    assert pick_resumable_session(
        [{"id": "old", "history_len": 2, "updated_at_ms": 5}], workspace=WS
    ) == "old"


# ---------------------------------------------------------------- 启动参数


def test_resume_is_on_by_default_and_can_be_turned_off(tmp_path: Path) -> None:
    """默认开：不开的话这个功能等于没做。

    留开关是因为「每次干净启动」是个合理的偏好，不是因为怕它出问题。
    """
    from retainpdf_ai.config import Settings

    assert Settings().fx_resume_session is True
    assert Settings(fx_resume_session=False).fx_resume_session is False


def test_the_session_probe_cannot_inherit_stdin() -> None:
    """问 fx 要会话清单时必须掐断 stdin。

    不掐的话子进程继承本进程的 stdin，任何等输入的程序都会把它挂到超时为止 ——
    而这一步挡在终端启动前面。测试里拿 /bin/cat 当假 fx 时当场炸出来过。
    """
    source = (Path(__file__).resolve().parents[1] / "retainpdf_ai/fx_terminal.py").read_text(
        encoding="utf-8"
    )
    block = source[source.index("def list_fx_sessions") : source.index("def build_terminal_launch")]
    assert "stdin=subprocess.DEVNULL" in block
    assert "timeout=_SESSIONS_TIMEOUT_S" in block


def test_listing_failures_never_break_the_terminal(tmp_path: Path) -> None:
    """fx 没装 / 换了输出格式 / 超时 —— 都只是「这次不恢复」，不是打不开终端。"""
    from retainpdf_ai.fx_terminal import list_fx_sessions

    assert list_fx_sessions("/nonexistent/fx", tmp_path, {}) == []
    assert list_fx_sessions("/bin/false", tmp_path, {"PATH": "/usr/bin:/bin"}) == []
    # 返回 0 但吐的不是 JSON
    assert list_fx_sessions("/bin/echo", tmp_path, {"PATH": "/usr/bin:/bin"}) == []


def test_resumed_session_id_reads_back_what_was_launched() -> None:
    """路由靠它登记「正在用」。argv 形状变了这里要红。"""
    from retainpdf_ai.fx_terminal import TerminalLaunch, resumed_session_id

    def launch(argv: tuple[str, ...]) -> TerminalLaunch:
        return TerminalLaunch(argv=argv, cwd=Path("/tmp"), env={})

    assert resumed_session_id(launch(("fx", "session", "resume", "abc"))) == "abc"
    assert resumed_session_id(launch(("fx",))) is None
    assert resumed_session_id(launch(("fx", "ask", "hi"))) is None


def test_the_route_registers_and_releases_live_sessions() -> None:
    """登记了不注销 = 刷新一次之后再也恢复不了（自己把自己挡在外面）。"""
    source = (
        Path(__file__).resolve().parents[1] / "retainpdf_ai/fx_terminal_routes.py"
    ).read_text(encoding="utf-8")
    assert "_live_sessions.add(resumed)" in source
    assert "_live_sessions.discard(resumed)" in source
    # 注销必须在 finally 里，否则异常路径会永久占着。
    finally_block = source[source.index("        finally:") :]
    assert "_live_sessions.discard(resumed)" in finally_block
    assert "busy_session_ids=_live_sessions" in source
