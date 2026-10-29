"""Executable paths remain usable without repository cwd or inherited secrets."""
import hashlib
import os
from pathlib import Path
import subprocess
import sys

import pytest

from support.paths import BACKEND, HERE, PIPELINE, ROOT
from support.translation_io_support import PROBE
from support.offline import child_command, child_environment


ENTRYPOINTS = (
    "run.py", "live_smoke.py", "offline_profile.py", "checkpoint_benchmark.py",
    "audit_prompts.py", "compare.py", "compare_optimization.py", "inspect_capture.py",
    "replay_capture.py", "probe_thinking.py",
    "tools/analysis/audit_prompts.py", "tools/analysis/compare.py",
    "tools/analysis/compare_optimization.py", "tools/analysis/inspect_capture.py",
    "tools/analysis/replay_capture.py", "tools/experiments/probe_thinking.py",
)


@pytest.mark.parametrize("entrypoint", ENTRYPOINTS)
def test_cli_help_from_unrelated_cwd_without_pythonpath(entrypoint, tmp_path):
    env = child_environment(tmp_path)
    env.pop("PYTHONPATH")
    process = subprocess.run(
        child_command(HERE / entrypoint, "--help"),
        cwd=tmp_path, env=env, capture_output=True, text=True, timeout=20,
    )
    assert process.returncode == 0, process.stdout + process.stderr
    assert "usage:" in process.stdout.lower()
    assert list(tmp_path.iterdir()) == []


def test_shared_layout_resolves_probes_and_unchanged_baseline():
    assert (ROOT / "Cargo.toml").is_file()
    assert BACKEND == ROOT / "backend"
    assert PIPELINE == BACKEND / "pipeline"
    assert (PIPELINE / "retainpdf_pipeline").is_dir()
    assert PROBE == HERE / "support/translation_io_probe.py"
    assert PROBE.is_file()
    assert (HERE / "support/production_translation_probe.py").is_file()
    # 基线文件的哈希是第二道守卫:改基线必须同时改这里,防止为了让重构测试变绿
    # 而顺手重生成(见 README「不要为了通过重构测试重新生成基线」)。
    # 更早一次:公式指引改成明确要求 LaTeX 并去掉降级要求后,逐例审阅过范围——
    # 12 个 direct_typst 用例的消息变了,16 个 placeholder 用例只有 prompt_hash 变。
    # 最近一次:引用规则改成「行内方括号 [n] 原样、原文是上标才输出上标」。同样逐例审阅:
    # 12 个用例的消息变化只落在那一行引用规则上,其余 16 个只有 prompt_hash 变,成员与其它指纹不变。
    # 2026-10-29:逐段提示词改成「前后文 → 原文 → 最后一行作答要求」(防模型自己补「译文：」小节头),
    # 批量 tagged 格式的「译文」占位写明「开头不加任何标签」。逐例审阅:13 个用例只变 user 消息——
    # 11 个逐段用例把前后文挪到原文前面并加起止标记、删掉开头两行说明、末尾加作答要求;
    # 2 个 */batch 只变那一行占位。system 消息、engine_identity 与成员不变,其余 19 个一字未动。
    baseline = HERE / "fixtures/refactor_baseline.json"
    assert hashlib.sha256(baseline.read_bytes()).hexdigest() == "c2b84ea8d21053756acd49e7d72b0f8f373dcc86f226b7941a9e1988ac7661d0"
