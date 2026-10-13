"""Every publishing path must include the same tests and architecture gates.

发版有两条路径：
- 回退 / 完整构建：quality-gate（复用 tests.yml）必须是发布 job 的直接或间接依赖；
- 提升：不再重跑测试，改由 find_release_candidate.py 要求「同 sha 在 main 上的
  push 触发的 Tests run 成功」（见 test_release_promotion_contracts.py /
  test_find_release_candidate.py）。
无论哪条路径，发布都不能绕过测试。
"""
from pathlib import Path
import re

import pytest


WORKFLOWS = Path(__file__).resolve().parents[2] / "workflows"
STATUS_FUNCTIONS = re.compile(r"\b(always|failure|cancelled|success)\(\)")
FALLBACK_CONDITION = "needs.resolve.outputs.mode == 'build'"


def job(workflow: str, name: str) -> str:
    source = (WORKFLOWS / workflow).read_text()
    match = re.search(rf"^  {re.escape(name)}:\n(.*?)(?=^  [\w-]+:|\Z)", source, re.M | re.S)
    assert match is not None, f"missing {name} in {workflow}"
    return match.group(1)


def job_condition(job_text: str) -> str | None:
    match = re.search(r"^    if: (.+)$", job_text, re.M)
    return match.group(1) if match else None


def assert_cannot_bypass_success(job_text: str) -> None:
    """job 级 if 可以比较 outputs，但不能带状态函数（always() 等会绕过 needs 的
    success() 判定），也不能 continue-on-error。"""
    condition = job_condition(job_text)
    if condition is not None:
        assert STATUS_FUNCTIONS.search(condition) is None, condition
    assert re.search(r"^    continue-on-error:", job_text, re.M) is None


@pytest.mark.parametrize("workflow", [
    "release-docker.yml",
])
def test_publish_workflows_require_complete_tests(workflow):
    gate = job(workflow, "quality-gate")
    assert "uses: ./.github/workflows/tests.yml" in gate
    assert "secrets: inherit" not in gate
    # 发版 workflow 只在完整构建路径上跑 quality-gate；条件只能是这一个比较，
    # 提升路径的测试门禁由 resolve 查询 main 上同 sha 的 Tests run 承担。
    assert job_condition(gate) == FALLBACK_CONDITION
    assert re.search(r"^    needs: resolve$", gate, re.M)
    assert re.search(r"^    continue-on-error:", gate, re.M) is None


@pytest.mark.parametrize("workflow,build_job", [
    ("release-docker.yml", "build"),
])
def test_build_and_publish_cannot_bypass_failed_tests(workflow, build_job):
    build = job(workflow, build_job)
    # A build job may also need cheap preparation jobs (release-docker resolves
    # its per-platform matrix in `prepare` and the release path in `resolve`),
    # but quality-gate must stay a direct dependency.
    needs = re.search(r"^    needs: (.+)\n", build, re.M)
    assert needs is not None
    assert needs.group(1) == "quality-gate" or re.fullmatch(
        r"\[(?:[\w-]+, )*quality-gate(?:, [\w-]+)*\]", needs.group(1)
    )
    assert_cannot_bypass_success(build)
    condition = job_condition(build)
    assert condition is None or condition == FALLBACK_CONDITION


def test_docker_publish_waits_for_the_gated_build():
    publish = job("release-docker.yml", "publish")
    assert re.search(r"^    needs: \[prepare, build\]$", publish, re.M)
    assert_cannot_bypass_success(publish)


def test_tests_include_reusable_architecture_gate():
    assert "uses: ./.github/workflows/rust-api-architecture.yml" in job("tests.yml", "architecture")
    source = (WORKFLOWS / "rust-api-architecture.yml").read_text()
    assert "  workflow_call: {}" in source
    assert 'python3 "$RETAIN_PDF_SERVICES_ROOT/api/scripts/check_architecture.py"' in source
    assert 'python3 "$RETAIN_PDF_SERVICES_ROOT/pipeline/devtools/check_pipeline_architecture.py"' in source


@pytest.mark.parametrize("workflow", ["tests.yml", "rust-api-architecture.yml"])
def test_tag_quality_gates_are_not_cancelled_by_other_release_runs(workflow):
    source = (WORKFLOWS / workflow).read_text()
    assert "cancel-in-progress: ${{ github.ref_type != 'tag' }}" in source


def test_docker_matrix_preparation_cannot_skip_the_build():
    """release-docker 的 build 依赖 prepare 产出的平台矩阵；prepare 不能带条件，
    否则它被跳过时 build 也会被跳过，而 publish 挂在 build 后面。"""
    prepare = job("release-docker.yml", "prepare")
    assert re.search(r"^    if:", prepare, re.M) is None
    assert re.search(r"^    continue-on-error:", prepare, re.M) is None
    for downstream in ("build", "publish", "promote"):
        assert re.search(r"^    continue-on-error:", job("release-docker.yml", downstream), re.M) is None
    for downstream in ("build", "merge"):
        assert re.search(r"^    continue-on-error:", job("build-docker-images.yml", downstream), re.M) is None


def test_release_resolve_job_cannot_be_skipped_or_ignored():
    workflow = "release-docker.yml"
    """resolve 决定走哪条路径。它没有条件、不能 continue-on-error：它失败时
    两条路径都不会运行（发布失败，而不是在没有判定的情况下发布）。"""
    resolve = job(workflow, "resolve")
    assert job_condition(resolve) is None
    assert re.search(r"^    continue-on-error:", resolve, re.M) is None
