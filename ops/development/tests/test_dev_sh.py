"""`dev.sh` 的结构不变量。

这是个 shell 脚本，没法像模块那样单测；但它错了的后果很重（整个本地栈起不来，
而且报错往往指向别处）。所以守几条**读文本就能查**的：

- 不能把 API key 写进脚本（它会被提交）
- 必须 nohup（不 nohup 的话进程跟着会话走，这正是要解决的问题）
- 起之前必须先停（端口占用导致的失败最难查）
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "dev.sh"


@pytest.fixture(scope="module")
def source() -> str:
    assert SCRIPT.is_file(), f"找不到 {SCRIPT}"
    return SCRIPT.read_text(encoding="utf-8")


def test_the_api_key_is_read_at_runtime_not_baked_in(source: str) -> None:
    """key 必须从 gitignored 的 runtime-config.local.js 里读。

    写死在脚本里就等于提交了凭据 —— 这个脚本是进仓库的。
    """
    assert "runtime-config.local.js" in source
    assert "grep -oE 'xApiKey" in source
    # 任何看起来像真 key 的东西都不该出现。
    import re

    assert not re.search(r"sk-[A-Za-z0-9]{16}", source), "脚本里有疑似真实 key"


def test_processes_are_detached(source: str) -> None:
    """不 nohup 的话进程跟着终端会话走 —— 那正是这个脚本要解决的问题。

    实测过：会话结束后本地栈四次全没，每次重来等一分钟 cargo。
    """
    assert source.count("nohup ") >= 2, "两个进程都要 nohup"
    assert "disown" in source


def test_background_jobs_get_their_own_process_group(source: str) -> None:
    """`nohup` 只挡 SIGHUP，挡不住给整个进程组发的 SIGTERM。

    实测：只有 nohup + disown 时，调用方收尾会把后台栈一起带走 ——
    日志里是 "received signal 15"，而表面现象是「刚说起来了，下一秒就没了」。
    `set -m` 让后台任务进自己的进程组。
    """
    assert "set -m" in source, "没开 job control，后台进程会跟着调用方一起死"


def test_up_stops_first(source: str) -> None:
    """端口被占着起不来，而「起不来」的报错常常指向别处。

    有过一次：另一个 checkout 的 jobsd 残留在 41002，表现是 502/503 风暴。
    """
    up = source[source.index("cmd_up()") : source.index("cmd_status()")]
    assert "cmd_down" in up, "up 没有先停"


def test_it_binds_all_interfaces(source: str) -> None:
    """产品决定：开发服务绑 0.0.0.0，不改成 127.0.0.1。"""
    assert source.count("--host 0.0.0.0") == 2


def test_failure_shows_the_log_instead_of_just_timing_out(source: str) -> None:
    """起不来时最没用的输出是「超时」。得把日志尾巴打出来。"""
    up = source[source.index("cmd_up()") : source.index("cmd_status()")]
    assert up.count("tail -n") >= 2, "退出和超时两条路径都要打日志"


def test_the_readme_documents_both_commands(source: str) -> None:
    """记不住就等于没有。两条命令都要在 ops/README.md 里。"""
    readme = (SCRIPT.parents[1] / "README.md").read_text(encoding="utf-8")
    assert "dev.sh up" in readme
    assert "npm run verify" in readme
    # 那张「哪条命令覆盖什么」的表是这次的重点，不能丢。
    assert "重建 bundle" in readme


# ---------------------------------------------------------------- 真跑一遍 bash


def _argv(*extra: str) -> subprocess.CompletedProcess[str]:
    """跑 `dev.sh argv`，它只组装参数,不碰端口也不起进程。"""
    return subprocess.run(
        ["bash", str(SCRIPT), "argv", *extra],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )


def test_the_backend_argv_assembles_under_the_system_bash() -> None:
    """**这一条是真跑 bash,不是读文本。**

    起因:`dev.sh up`（不带 --fast,也就是改过 Rust 之后必须走的那条）一直是坏的。
    macOS 自带 bash 3.2,`set -u` 下展开**空数组**会报 `unbound variable`,而
    `--fast` 那条因为数组非空反而正常 —— 于是只在最需要它的时候失败。

    读文本的门禁挡不住这个:`"${build_flag[@]}"` 看起来完全正常。只有在真正的
    bash 里跑一遍才会红。
    """
    done = _argv()
    assert done.returncode == 0, f"不带 --fast 的参数组装失败了:\n{done.stderr}"
    args = done.stdout.split()
    assert "--no-build" not in args, "不带 --fast 却跳过了构建 —— 改了 Rust 不会重编"
    for flag in ("--host", "--port", "--data-root", "--no-sync"):
        assert flag in args, f"少了 {flag}"

    fast = _argv("--fast")
    assert fast.returncode == 0, fast.stderr
    assert "--no-build" in fast.stdout.split(), "--fast 没有跳过构建"


def test_up_actually_uses_the_function_that_is_guarded(source: str) -> None:
    """门禁守的是 `stack_argv`,所以 `cmd_up` 必须真的走它。

    反证时发现的洞:把参数内联回 cmd_up,上面那条照样绿 —— 它验的是一个没人用的
    函数。真实路径不经过被守的代码,等于没守。
    """
    up_block = source[source.index("cmd_up() {") : source.index("cmd_status() {")]
    assert "stack_argv" in up_block, "cmd_up 不再走 stack_argv,门禁管不到真实路径了"
    assert "--data-root" not in up_block, "参数又被内联回 cmd_up 了"


def test_the_system_bash_is_the_one_that_has_this_trap() -> None:
    """把「为什么要上面那条」钉死,而不是只留一句注释。

    bash 3.2 下 `set -u` + 空数组展开会失败,4.4+ 已经不会了。哪天 macOS 换了
    默认 bash,上面那条仍然绿,但这一条会红 —— 那时可以把这两条一起删掉,而不是
    让一条没人记得为什么存在的规则留在仓库里。
    """
    probe = subprocess.run(
        ["bash", "-c", 'set -u; arr=(); printf "%s" "${arr[@]}"'],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    if probe.returncode == 0:
        pytest.skip("这个系统的 bash 已经不会在空数组上炸了,上面那条门禁可以退休")
    assert "unbound" in probe.stderr.lower()
