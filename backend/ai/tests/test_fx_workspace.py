"""终端落在哪个目录。

session 参数是**浏览器传来的**，所以这里一半的测试在守路径穿越 —— 不校验的话
`?session=../../../../etc` 会让 fx 一开机就在任意目录里，而 permission_mode 是
auto（产品决定），没有第二道闸拦它。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from retainpdf_ai.fx_workspace import (
    build_collection_workspace_instructions,
    build_job_workspace_instructions,
    resolve_job_workspace,
)


def _job(data_root: Path, job_id: str) -> Path:
    job = data_root / "jobs" / job_id
    (job / "ocr").mkdir(parents=True, exist_ok=True)
    return job


def test_a_real_job_resolves_to_its_ai_subdirectory(tmp_path: Path) -> None:
    _job(tmp_path, "20260921092508-fe8d63")
    resolved = resolve_job_workspace(tmp_path, "20260921092508-fe8d63")
    assert resolved == tmp_path / "jobs" / "20260921092508-fe8d63" / "ai"


@pytest.mark.parametrize(
    "hostile",
    [
        "../../../../etc",
        "..",
        "../20260921092508-fe8d63",
        "foo/../../bar",
        "/etc/passwd",
        "job/../../..",
        ".",
        "",
        "   ",
    ],
)
def test_path_traversal_is_refused(tmp_path: Path, hostile: str) -> None:
    """session 来自浏览器。放过任何一个，fx 就在别人的目录里开机了。"""
    _job(tmp_path, "20260921092508-fe8d63")
    assert resolve_job_workspace(tmp_path, hostile) is None


def test_a_nonexistent_job_is_refused(tmp_path: Path) -> None:
    """不给一个不存在的 id 凭空建目录树 —— 那等于让任何字符串都能造出工作区。"""
    (tmp_path / "jobs").mkdir()
    assert resolve_job_workspace(tmp_path, "not-a-real-job") is None


def test_a_symlinked_job_that_escapes_is_refused(tmp_path: Path) -> None:
    """id 合法、目录也存在，但它是个指向外面的符号链接。

    只查 id 形状挡不住这个 —— 得在解析之后再确认一次仍在 jobs 里。
    """
    outside = tmp_path / "outside"
    outside.mkdir()
    jobs = tmp_path / "jobs"
    jobs.mkdir()
    (jobs / "escaped").symlink_to(outside, target_is_directory=True)
    assert resolve_job_workspace(tmp_path, "escaped") is None


# ---------------------------------------------------------------- 说明文件


def test_the_instructions_name_every_directory_that_exists(tmp_path: Path) -> None:
    """说明是 agent 唯一的约束（permission_mode=auto，没有闸门）。

    漏掉一个目录，它要么看不见那份数据，要么自己乱猜路径。
    """
    text = build_job_workspace_instructions(_job(tmp_path, "job-1"))
    for directory in (
        "../ocr/",
        "../translated/",
        "../md/",
        "../source/",
        "../rendered/",
        "../artifacts/",
        "../specs/",
        "../logs/",
    ):
        assert directory in text, f"说明里没提 {directory}"


def test_the_instructions_warn_that_compound_commands_produce_no_output(
    tmp_path: Path,
) -> None:
    """这条是整份文档里最值钱的一句。

    实测：`echo A && echo B`、`echo A; echo B`、`echo A | tr a-z A-Z` 全都拿不到
    输出，而且失败表现是「没有任何输出」而不是报错 —— agent 分不清「命令没输出」
    和「被拒了」，于是换着法子重试。一次真实会话里为此烧掉 32 次工具调用。

    不写进来它没法自己发现。
    """
    text = build_job_workspace_instructions(_job(tmp_path, "job-1"))
    assert "单条命令" in text
    for forbidden in ("&&", ";", "|"):
        assert forbidden in text, f"没举例说明 {forbidden} 不能用"


def test_the_instructions_map_the_json_shapes(tmp_path: Path) -> None:
    """同一次会话里 agent 花了七八次调用 `jq keys` 去摸结构。

    这些结构是固定的，直接给出来就不用摸。抽查每个文件的关键字段。
    """
    text = build_job_workspace_instructions(_job(tmp_path, "job-1"))
    for field in (
        "page_count",      # document.v1.json
        "blocks[]",
        "item_id",         # page-XXX-*.json
        "final_status",
        "translated_text",
        "issue_count",     # translation_review.json
        "severity",
    ):
        assert field in text, f"数据地图里没写 {field}"


def test_the_instructions_give_runnable_single_commands(tmp_path: Path) -> None:
    """给的例子必须是能直接抄的单条命令。

    只查 **shell 管道** —— jq 程序里的 `|` 是 jq 自己的语法，在单引号里，
    完全合法。第一版这条把两者混为一谈，误判了正确的例子。
    """
    import re

    text = build_job_workspace_instructions(_job(tmp_path, "job-1"))
    examples = [
        line.strip()
        for line in text.splitlines()
        if line.strip().startswith("jq ") and "../" in line
    ]
    assert len(examples) >= 4, "可抄的 jq 例子太少"
    for example in examples:
        outside_quotes = re.sub(r"'[^']*'", "", example)
        assert "|" not in outside_quotes, f"例子里带了 shell 管道: {example}"
        assert "&&" not in example and ";" not in example, f"例子是复合命令: {example}"


def test_the_instructions_say_what_breaks_not_just_do_not_touch(tmp_path: Path) -> None:
    """含糊的「请勿修改」对 agent 没有约束力。得说清楚代价。"""
    text = build_job_workspace_instructions(_job(tmp_path, "job-1"))
    assert "page_hash" in text, "没说校验会失败"
    assert "重跑" in text or "重新付费" in text, "没说重跑的代价"


def test_the_instructions_mark_the_writable_place(tmp_path: Path) -> None:
    text = build_job_workspace_instructions(_job(tmp_path, "job-1"))
    assert "只有当前目录" in text


def test_the_instructions_keep_the_untrusted_input_rule(tmp_path: Path) -> None:
    """文档正文来自任意来源的 PDF。这条规则原来的 AGENTS.md 里有，不能丢。"""
    text = build_job_workspace_instructions(_job(tmp_path, "job-1"))
    assert "数据" in text and "指令" in text


# ---------------------------------------------------------------- 权限规则
#
# 注意这一节守的是**形状**，不是「规则生效」。实测没能证明任何一条 deny 拦得住
# 东西（见 fx_workspace 里 DEFAULT_DENIED_COMMANDS 上方的记录）。断言到此为止，
# 免得后来人从测试名里读出一个不存在的保证。


def test_the_shell_tool_class_is_the_real_name() -> None:
    """fx 的工具类名是 `shell`，不是文档里那个 `bash`。

    这条最值钱：**fx 不校验类名**。写错了它不报错，规则静默失效，而
    `fx permissions` 还会把它逐条列出来 —— 看起来完全正常。我第一版写的就是
    bash/edit/write，全错，是从 fx 发给模型的工具清单里才拿到真名的。
    """
    from retainpdf_ai.fx_workspace import SHELL_TOOL_CLASS, build_terminal_permissions

    assert SHELL_TOOL_CLASS == "shell"
    block = build_terminal_permissions(("rm *",))
    assert "shell" in block
    assert "bash" not in block, "bash 是错的类名，写进去等于什么都没做"


def test_deny_rules_come_after_the_catch_all_allow() -> None:
    """fx 的规则是「最后匹配的赢」，所以 deny 必须排在兜底 allow 之后。

    顺序反了的话整块规则等于没写 —— 而且照样不报错。
    """
    from retainpdf_ai.fx_workspace import build_terminal_permissions

    keys = list(build_terminal_permissions(("rm *", "sudo *"))["shell"])
    assert keys[0] == "*", "兜底 allow 得在最前"
    assert keys.index("rm *") > 0 and keys.index("sudo *") > 0


def test_the_settings_merge_keeps_fx_own_preferences(tmp_path: Path) -> None:
    """settings.json 里还有 fx 自己存的 provider / 模型 / effort 档位。

    整个写掉的话，用户在 TUI 里 `/model ... ` 选的思考档位每次开终端都会丢。
    """
    import json

    from retainpdf_ai.fx_workspace import apply_terminal_permissions

    home = tmp_path / "home"
    (home / ".fx").mkdir(parents=True)
    settings = home / ".fx" / "settings.json"
    settings.write_text(
        json.dumps({"provider": "gateway", "effort": "high", "fast_mode": False})
    )
    apply_terminal_permissions(home, ("rm *",))
    saved = json.loads(settings.read_text())
    assert saved["provider"] == "gateway"
    assert saved["effort"] == "high", "用户选的思考档位被覆盖了"
    assert saved["fast_mode"] is False
    assert saved["permission"]["shell"]["rm *"] == "deny"


def test_a_corrupt_settings_file_is_rebuilt(tmp_path: Path) -> None:
    """坏文件就当空的重建。带着它继续跑会让权限块也写不进去。"""
    import json

    from retainpdf_ai.fx_workspace import apply_terminal_permissions

    home = tmp_path / "home"
    (home / ".fx").mkdir(parents=True)
    (home / ".fx" / "settings.json").write_text("{ not json")
    apply_terminal_permissions(home, ("rm *",))
    assert json.loads((home / ".fx" / "settings.json").read_text())["permission"]


def test_denying_nothing_is_expressible(tmp_path: Path) -> None:
    """空清单是用户明确说「什么都不挡」，不该退回默认。"""
    import json

    from retainpdf_ai.fx_workspace import apply_terminal_permissions

    home = tmp_path / "home"
    apply_terminal_permissions(home, ())
    block = json.loads((home / ".fx" / "settings.json").read_text())["permission"]
    assert block["shell"] == {"*": "allow"}


# ---------------------------------------------------------------- 界面契约
#
# canvas.v1.json / reading-path.v1.json 是 agent 写、前端读的。字段名分别写在两
# 个语言的两个文件里，没有共享定义 —— 所以这里跨文件对一遍。不对的话表现是
# 「agent 照文档写了，界面什么都不显示」，而且两边看起来都没错。


def _reader_domain_dir():
    """前端 reader 功能的 domain 目录。找不到就让测试红 —— 不 skip。

    skip 的话文档漂了没人知道，而这正是这一节唯一要防的事。
    """
    from pathlib import Path as _Path

    here = _Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "frontend/web/src/features/reader/domain"
        if candidate.is_dir():
            return candidate
    raise AssertionError(f"找不到前端 domain 目录（从 {here} 往上找）")


def _parser_source() -> str:
    """画布相关的前端源码，整个目录拼起来。

    **不认具体文件名**：这些模块会被拆分（canvas-doc 就拆成过 doc/render/cards），
    写死文件名的话拆一次这条门禁就指向空气。上一次拆分正是这么把它弄红的，
    而当时只跑了前端测试没跑这边。
    """
    return "\n".join(
        path.read_text(encoding="utf-8")
        for path in sorted(_reader_domain_dir().glob("reading-canvas*.ts"))
    )


def _indented_json_example(text: str, marker: str) -> dict:
    r"""把说明里那段缩进 4 格的 JSON 例子抠出来解析。

    不用正则找结尾：`.*?\]\}` 这种非贪婪写法会在**内层**的 `}]}` 提前收尾，
    例子只截到一半（notes 的例子就是这么漏的；canvas 的例子当时碰巧没踩到）。
    按缩进取到块尾才可靠。
    """
    import json

    lines = text.splitlines()
    start = next(i for i, line in enumerate(lines) if marker in line)
    body = []
    for line in lines[start:]:
        if line.strip() and not line.startswith("    "):
            break
        body.append(line[4:])
        # 逐行试解析，第一次成功就收尾。按缩进取到块尾会一路吃进后面的字段表
        # （那张表也缩进 4 格）。
        try:
            return json.loads("\n".join(body))
        except ValueError:
            continue
    raise AssertionError(f"{marker} 的例子解析不出来：\n" + "\n".join(body))


def _board_section(tmp_path: Path) -> str:
    text = build_job_workspace_instructions(_job(tmp_path, "job-1"))
    start = text.index("丢进 `./board/`")
    end = text.index("## `../` 只读 —— 不要修改或删除")
    return text[start:end]


def _board_accepted_line(tmp_path: Path) -> str:
    """「认这些后缀」那一行。

    **必须单独取这一行**：整段里到处都是 `.pdf`、`.png`（例子命令里就有），
    拿整段去查「pdf 在不在」的话，把白名单里的 pdf 删掉测试照样绿 —— 反证当场
    抓到过这个，两条门禁都中招。
    """
    for line in _board_section(tmp_path).splitlines():
        if "认这些后缀" in line:
            return line
    raise AssertionError("画板那节没有「认这些后缀」这一行了，门禁要跟着改")


def test_the_board_is_pitched_as_use_the_shell_you_already_have(
    tmp_path: Path,
) -> None:
    """产物条的全部价值是「不用学新格式」。

    不把这点说透，模型会继续去找 schema —— 它被早先那三个有 schema 的产物
    训练成那样了。
    """
    section = _board_section(tmp_path)
    assert "已经有 shell" in section, "没说清楚用现有工具就行"
    # 给可抄的例子，而不是只描述。模型照着抄比照着想靠谱。
    assert "cat > ./board/" in section, "没给一条可以直接抄的写文件命令"
    assert "<!doctype html" in section.lower(), "没给 HTML 的样子"


def test_the_board_examples_only_name_tools_that_exist(tmp_path: Path) -> None:
    """例子里点名的命令必须真的在 agent 的 PATH 上。

    这条不是洁癖：之前说明书举的是 `python3 -c "import matplotlib..."` 和
    `pdftoppm ...`，而这台机器上 **matplotlib 没装、pdftoppm 根本没有**。模型
    照抄就是直接失败，而它没有任何线索能猜到是环境缺东西。改用 HTML 之后连
    这两个都不需要了 —— `cat > x.html` 零依赖。
    """
    import shutil

    import re

    section = _board_section(tmp_path)
    # 只看命令行例子（缩进四格那些），不看散文里提到的名字。
    # heredoc 的**内容和结束符**要跳过 —— 不跳的话 `<<'HTML'` 后面那段正文的
    # 第一个词会被当成命令名（实测：结束符 HTML 被当成一条命令）。
    named: set[str] = set()
    heredoc: str | None = None
    for line in section.splitlines():
        if not line.startswith("    "):
            continue
        body = line.strip()
        if heredoc is not None:
            if body == heredoc:
                heredoc = None
            continue
        match = re.search(r"<<'?([A-Za-z_][A-Za-z0-9_]*)'?", body)
        if match:
            heredoc = match.group(1)
        word = body.split()[0] if body.split() else ""
        # 只认像命令名的：那一段缩进里还有「认这些后缀 / 文件名 / 大小」这种
        # 中文对照表，它们不是命令。
        if re.fullmatch(r"[a-z][a-z0-9_.-]*", word):
            named.add(word)
    for tool in sorted(named):
        assert shutil.which(tool), f"例子里用了 {tool}，但它不在 PATH 上，照抄会失败"


def test_the_board_docs_state_the_accepted_shapes(tmp_path: Path) -> None:
    """后缀、文件名字符集、大小 —— 不写清楚的表现是「我放进去了却没显示」，
    而那时候模型没有任何线索能自己查出来。"""
    section = _board_section(tmp_path)
    for token in ("png", "md", "json", "16 MB"):
        assert token in section, f"没写 {token}"
    assert "svg" in section.lower(), "没说 svg 不收"


def test_the_board_accepted_kinds_match_the_backend(tmp_path: Path) -> None:
    """文档说收哪些后缀，必须和后端真正收的一致。

    两边分处 Python 文档和 Rust 代码，没有共享定义。漂了的表现是「照文档放进去
    却不显示」—— 和 canvas / notes 字段名同一类问题。
    """
    import re
    from pathlib import Path as _Path

    here = _Path(__file__).resolve()
    board_rs = None
    for parent in here.parents:
        candidate = parent / "backend/api/src/services/jobs/downloads/ai_board.rs"
        if candidate.is_file():
            board_rs = candidate.read_text(encoding="utf-8")
            break
    assert board_rs, "找不到后端的 ai_board.rs"

    # board_kind 的 match 臂里那些后缀就是真源。
    block = board_rs[board_rs.index("fn board_kind") : board_rs.index("/// 只认单层")]
    accepted = set(re.findall(r'^\s*"([a-z]+)"(?:\s*\|\s*"([a-z]+)")?\s*=>', block, re.M))
    flat = {ext for pair in accepted for ext in pair if ext}
    assert flat >= {"png", "md", "json"}, flat

    accepted = _board_accepted_line(tmp_path)
    for ext in flat:
        assert ext in accepted, f"后端收 .{ext}，但白名单那一行里没写"
    assert "svg" not in flat, "后端开始收 svg 了 —— 要先做消毒，并更新这条断言"


def test_the_board_docs_explain_that_the_file_name_is_the_label(
    tmp_path: Path,
) -> None:
    """画板上一堆图，文件名是唯一的区分。不说的话模型会起 out.png 这种名字。"""
    section = _board_section(tmp_path)
    assert "标签" in section
    assert "修改时间" in section, "没说排序规则，模型不知道怎么控制顺序"


def test_the_board_docs_point_at_typst_with_a_runnable_command(
    tmp_path: Path,
) -> None:
    """typst 就在 PATH 上（实测：`shutil.which('typst', path=<fx 的 PATH>)` 命中），
    它是这里唯一能把「一份像样的中文文档」交出去的工具，而且零新依赖。

    不写进说明，模型不会去试一个它不知道存在的命令 —— 这份文档的全部作用就是
    补上「你的环境里有什么」。命令还必须是**单条**，复合命令在这个终端里拿不到
    输出（见文档开头那条）。
    """
    section = _board_section(tmp_path)
    assert "typst" in section, "没提 typst"
    commands = [
        line.strip()
        for line in section.splitlines()
        if line.strip().startswith("typst ")
    ]
    assert commands, "只提了名字，没给能抄的命令"
    for command in commands:
        assert "&&" not in command and ";" not in command and "|" not in command, (
            f"typst 的例子是复合命令，在这个终端里拿不到输出: {command}"
        )
    assert any("./board/" in command for command in commands), (
        "例子没直接渲进 ./board/，模型会渲到别处再忘了搬"
    )


def _collection_section(tmp_path: Path) -> str:
    """合集工作区说明里讲产物呈现的那几节。"""
    import json

    workspace = tmp_path / "collections" / "col-1" / "ai"
    (workspace / "books").mkdir(parents=True, exist_ok=True)
    (workspace / "collection.v1.json").write_text(
        json.dumps({"books": [{"dir": "A Book", "job_id": "job-a"}], "skipped": []}),
        encoding="utf-8",
    )
    text = build_collection_workspace_instructions(workspace)
    return text[text.index("## 可以自由读写的地方"):]


def test_the_collection_docs_do_not_promise_an_endpoint_that_does_not_exist(
    tmp_path: Path,
) -> None:
    """合集这一级没有 board 端点，说明书就不能说「丢进 ./board/ 就能看见」。

    界面上那条产物列表只轮询 `/api/v1/jobs/<任务>/board`。合集的 cwd 是
    `collections/<id>/ai`，它的 `./board/` 没有任何呈现路径 —— agent 照着写、
    报告完成，而用户永远看不到，也不会收到任何错误。

    这条断言**对着真实路由表核**，不靠记忆：collections 的路由文件里但凡出现
    board，就说明端点加上了，那时这条门禁要跟着改。
    """
    import re
    from pathlib import Path as _Path

    here = _Path(__file__).resolve()
    routes = None
    for parent in here.parents:
        candidate = parent / "backend/api/src/app/router/collections.rs"
        if candidate.is_file():
            routes = candidate.read_text(encoding="utf-8")
            break
    assert routes, "找不到 collections 的路由文件"
    has_board_endpoint = re.search(r'"/api/v1/collections/[^"]*board', routes) is not None

    section = _collection_section(tmp_path)
    if has_board_endpoint:
        assert "./board/" in section, "合集有 board 端点了，说明书该告诉 agent 用它"
        return

    # 没有端点：必须明确说当前目录的 board 看不到，并给出真正能显示的那条路。
    assert "用户看不到" in section or "看不见" in section, (
        "说明书没说清合集这一级的 ./board/ 不会被呈现"
    )
    assert "books/<书>/ai/board/" in section, (
        "没给出真正能显示的落点 —— agent 会不知道该往哪写"
    )


def test_the_collection_docs_carve_the_read_only_exception_explicitly(
    tmp_path: Path,
) -> None:
    """让 agent 往 books/ 底下写，就必须把这个例外说清楚。

    那条「books/ 只读」是有分量的：底下是 OCR（按量计费）和翻译（大模型）的
    产物，改坏了要重跑重付。现在唯一允许的是往画板里**新增**文件。
    """
    section = _collection_section(tmp_path)
    # **不能只查「只读」两个字** —— 下面那段讲例外的句子里也有它（「books/ 只读
    # 规则的唯一例外」），把规则本身整段删掉这条照样绿。反证时当场撞上了，
    # 和今天在 CSS 注释、import 行、useState(960) 上踩的是同一个形状。
    #
    # 查的是只出现在那一段里的实质内容：为什么不能改（花了钱）。
    assert "重跑" in section and "重付" in section, (
        "没说清 books/ 底下是花钱跑出来的 —— 只说「只读」而不说代价，模型会自己权衡掉"
    )
    assert "例外" in section, "开了口子却没说这是例外"
    assert "新增" in section or "叠加" in section, "没说清只能新增、不能改删"
    assert "别改" in section or "别删" in section, "没说清例外之外仍然不许动"
