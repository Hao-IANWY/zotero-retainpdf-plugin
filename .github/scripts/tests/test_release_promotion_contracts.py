"""「打 tag 只提升 main 预构建产物」的契约。

- main 预构建：只在 push main / 手动 dispatch（main）上跑，不取消正在跑的那份，
  用声明版本、复用与回退构建同一份 reusable workflow；
- 提升：只在 tag push 且 resolve 判定 promote 时运行，跨 run 下载要 run-id +
  github-token，提升前有硬校验（身份 / digest / 平台 / OCI 标签 / tag 未移动）；
- 回退：完整构建路径保留，且只在 mode == build 时运行；
- 权限最小化：actions: read 只给需要查 run / 下载 artifact 的 job。
"""
from __future__ import annotations

from pathlib import Path
import re
import sys

import pytest


GITHUB_ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = GITHUB_ROOT / "workflows"
ACTIONS = GITHUB_ROOT / "actions"
sys.path.insert(0, str(GITHUB_ROOT / "scripts"))

import find_release_candidate  # noqa: E402


PREBUILD = "prebuild-release-candidates.yml"
TAG_PUSH_PROMOTE = (
    "github.event_name == 'push' && github.ref_type == 'tag' && needs.resolve.outputs.mode == 'promote'"
)


def text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def workflow(name: str) -> str:
    return text(WORKFLOWS / name)


def job(workflow_name: str, name: str) -> str:
    match = re.search(
        rf"^  {re.escape(name)}:\n(.*?)(?=^  [\w-]+:|\Z)", workflow(workflow_name), re.M | re.S
    )
    assert match is not None, f"missing {name} in {workflow_name}"
    return match.group(1)


def jobs(workflow_name: str) -> dict[str, str]:
    source = workflow(workflow_name)
    jobs_block = source[source.index("\njobs:\n") + len("\njobs:\n"):]
    names = re.findall(r"^  ([\w-]+):\n", jobs_block, re.M)
    return {name: job(workflow_name, name) for name in names}


def on_block(workflow_name: str) -> str:
    match = re.search(r'^"?on"?:\n(.*?)(?=^\S)', workflow(workflow_name), re.M | re.S)
    assert match is not None
    return match.group(1)


def step(job_text: str, name: str) -> str:
    match = re.search(
        rf"^      - name: {re.escape(name)}\n(.*?)(?=^      - name: |\Z)", job_text, re.M | re.S
    )
    assert match is not None, f"missing step {name}"
    return match.group(1)


def condition(job_text: str) -> str | None:
    match = re.search(r"^    if: (.+)$", job_text, re.M)
    return match.group(1) if match else None


# ---------------------------------------------------------------- prebuild


def test_prebuild_runs_only_for_main_pushes_and_manual_main_runs():
    on = on_block(PREBUILD)
    assert re.search(r"^  push:\n    branches:\n      - main\n", on, re.M)
    assert "tags:" not in on
    assert "pull_request" not in on
    assert "workflow_dispatch" in on
    # 只改文档的 commit 不预构建（这样的 commit 打 tag 会回退到完整构建）。
    assert '"docs/**"' in on and '"**/*.md"' in on
    # dispatch 到别的分支时整条链路跳过（提升判定也只认 main 上的 run）。
    assert condition(job(PREBUILD, "prepare")) == "github.ref == 'refs/heads/main'"


def test_prebuild_never_cancels_a_running_candidate_build():
    """正在跑的预构建可能正是马上要打 tag 的 release commit，不能被新的 push 取消。"""
    source = workflow(PREBUILD)
    assert "group: prebuild-release-candidates-${{ github.ref }}" in source
    assert "cancel-in-progress: false" in source
    assert "cancel-in-progress: true" not in source


def test_prebuild_uses_the_declared_version_and_the_shared_build_definitions():
    prepare = job(PREBUILD, "prepare")
    assert "resolve_declared_version.py" in prepare
    assert "version: ${{ steps.declared.outputs.version }}" in prepare

    docker = job(PREBUILD, "docker")
    assert "uses: ./.github/workflows/build-docker-images.yml" in docker
    assert "version: ${{ needs.prepare.outputs.version }}" in docker
    assert "push: true" in docker
    # 每个 sha 一个可覆盖的候选标签，旧的由 prune 清理。
    assert "candidate_tag: candidate-${{ github.sha }}\n" in docker
    assert "secrets: inherit" not in docker


def test_prebuild_does_not_rerun_the_test_suite():
    """预构建与 Tests 并行、不阻塞 Tests；测试门禁由提升前查询 Tests run 承担。"""
    assert "tests.yml" not in workflow(PREBUILD)


def test_candidate_pruning_is_best_effort_and_outlives_artifact_retention():
    prune = job(PREBUILD, "prune-docker-candidates")
    assert "    needs: docker\n" in prune
    assert "    continue-on-error: true\n" in prune
    assert "--max-age-days 10" in prune
    assert '--keep "candidate-${GITHUB_SHA}"' in prune
    # prune 仍清 Docker Hub 候选标签需要凭据；docker 构建已改推 GHCR（用内置
    # GITHUB_TOKEN），caller 透传的 DOCKERHUB secrets 仅为 release-docker 兼容保留。
    for name, body in jobs(PREBUILD).items():
        if name not in {"docker", "prune-docker-candidates"}:
            assert "secrets." not in body, name


def test_build_definitions_inject_the_requested_version_everywhere():
    """版本号只来自调用方传入的 version：Docker build-arg + OCI label
    （前端 generate-app-version 也优先读 RETAIN_PDF_VERSION）。"""
    docker = workflow("build-docker-images.yml")
    assert 'echo "RETAIN_PDF_VERSION=${{ inputs.version }}"' in docker
    assert "org.opencontainers.image.version=${{ inputs.version }}" in docker
    assert "--arg version \"$RELEASE_VERSION\"" in docker
    assert "RELEASE_VERSION: ${{ inputs.version }}" in docker
    assert "github.ref_name" not in docker


# ---------------------------------------------------------------- artifacts


def test_docker_candidate_artifacts_match_what_the_finder_requires():
    merge = job("build-docker-images.yml", "merge")
    assert "name: docker-candidate-${{ matrix.target.name }}-${{ github.run_id }}" in merge
    assert "retention-days: 7" in merge
    assert find_release_candidate.required_artifacts("docker", run_id=9, sha="x") == [
        "docker-candidate-app-9", "docker-candidate-web-9",
    ]


def test_finder_queries_the_real_workflow_files():
    assert (WORKFLOWS / find_release_candidate.TESTS_WORKFLOW).is_file()
    assert (WORKFLOWS / find_release_candidate.PREBUILD_WORKFLOW).is_file()
    assert find_release_candidate.PREBUILD_WORKFLOW == PREBUILD
    tests_on = on_block(find_release_candidate.TESTS_WORKFLOW)
    assert re.search(r"^  push:\n    branches:\n      - main\n", tests_on, re.M)


# ---------------------------------------------------------------- resolve


def test_resolve_checks_version_tests_prebuild_and_artifacts_before_promoting():
    resolve = job("release-docker.yml", "resolve")
    assert "resolve_declared_version.py" in step(resolve, "Resolve declared application version")
    find = step(resolve, "Find promotable prebuild")
    assert "--kind docker" in find
    assert '--tag "$GITHUB_REF_NAME"' in find
    assert '--declared-version "$DECLARED_VERSION"' in find
    assert "GITHUB_TOKEN: ${{ github.token }}" in find
    # 查找本身不能 continue-on-error：它崩了就整个发布失败，不会在没有判定时发布。
    assert "continue-on-error" not in find

    download = step(resolve, next(n for n in re.findall(r"^      - name: (.+)$", resolve, re.M) if n.startswith("Download candidate")))
    assert "run-id: ${{ steps.find.outputs.run_id }}" in download
    assert "github-token: ${{ github.token }}" in download
    assert "continue-on-error: true" in download

    decision = step(resolve, "Decide release path")
    assert 'mode="build"' in decision
    assert '[ "$DOWNLOAD_OUTCOME" = "success" ]' in decision
    assert '[ "$VERIFY_OUTCOME" = "success" ]' in decision
    assert "falls back" in decision or "full build" in decision
    assert "GITHUB_STEP_SUMMARY" in decision
    assert "mode: ${{ steps.decision.outputs.mode }}" in resolve
    assert "run_id: ${{ steps.decision.outputs.run_id }}" in resolve


def test_resolve_job_outlives_the_finder_wait_so_timeouts_fall_back():
    """脚本等待超时会回退到完整构建；job 自己的 timeout 必须更长，否则 job 先被杀、
    发布直接失败。"""
    resolve = job("release-docker.yml", "resolve")
    timeout = int(re.search(r"^    timeout-minutes: (\d+)$", resolve, re.M).group(1))
    wait = find_release_candidate.decide.__kwdefaults__["wait_seconds"] // 60
    assert "--wait-minutes" not in resolve
    assert timeout >= wait + 10


def test_docker_resolve_checks_the_registry_without_promoting():
    resolve = job("release-docker.yml", "resolve")
    verify = step(resolve, "Verify candidate images are promotable")
    assert "uses: ./.github/actions/docker-candidates" in verify
    assert "release-tag" not in verify
    assert "expected-revision: ${{ github.sha }}" in verify
    assert "expected-platforms: linux/amd64,linux/arm64" in verify
    assert "imagetools create" not in resolve


# ---------------------------------------------------------------- promote


def test_promotion_only_runs_for_tag_pushes_judged_promotable():
    body = job("release-docker.yml", "promote")
    assert condition(body) == TAG_PUSH_PROMOTE
    assert "    needs: resolve\n" in body
    assert re.search(r"^    continue-on-error:", body, re.M) is None
    download = step(body, next(n for n in re.findall(r"^      - name: (.+)$", body, re.M) if n.startswith("Download prebuilt")))
    assert "run-id: ${{ needs.resolve.outputs.run_id }}" in download
    assert "github-token: ${{ github.token }}" in download


def test_pull_requests_can_never_reach_promotion():
    on = on_block("release-docker.yml")
    assert "pull_request" in on  # PR 只做构建冒烟
    assert "github.event_name == 'push'" in condition(job("release-docker.yml", "promote"))
    # 判定脚本对非 tag push 直接返回 build（单元测试覆盖），并且不查任何 run。
    decision = find_release_candidate.decide(
        object(), kind="docker", repo="r", sha="a" * 40, tag="v1.0.0",
        event_name="pull_request", ref_type="branch", declared_version="1.0.0",
    )
    assert decision.mode == "build"


def test_docker_promotion_verifies_before_tagging_and_never_rebuilds():
    promote = job("release-docker.yml", "promote")
    assert "build-push-action" not in promote and "uses: ./.github/workflows" not in promote
    assert promote.index("Verify release tag still targets this revision") < promote.index(
        "Verify and promote prebuilt Docker release"
    )
    final = step(promote, "Verify and promote prebuilt Docker release")
    assert "uses: ./.github/actions/docker-candidates" in final
    assert "expected-revision: ${{ github.sha }}" in final
    assert "expected-version: ${{ needs.resolve.outputs.version }}" in final
    assert "release-tag: ${{ needs.resolve.outputs.tag }}" in final

    action = text(ACTIONS / "docker-candidates" / "action.yml")
    assert "verify-docker" in action
    assert action.index("Verify both candidate images") < action.index("Promote complete Docker release")
    assert "if: inputs.release-tag != ''" in action
    assert 'docker buildx imagetools create --tag "${image}:${RELEASE_TAG}" "${image}@${digest}"' in action


# ---------------------------------------------------------------- fallback


def test_full_build_fallback_paths_remain():
    docker = jobs("release-docker.yml")
    assert condition(docker["build"]) == "needs.resolve.outputs.mode == 'build'"
    assert "uses: ./.github/workflows/build-docker-images.yml" in docker["build"]
    assert "candidate_tag: candidate-${{ github.sha }}-${{ github.run_id }}" in docker["build"]
    assert "push: ${{ needs.prepare.outputs.push == 'true' }}" in docker["build"]


# ---------------------------------------------------------------- permissions


RELEASE_WORKFLOWS = ("release-docker.yml", PREBUILD, "build-docker-images.yml")


@pytest.mark.parametrize("workflow_name", RELEASE_WORKFLOWS)
def test_workflow_default_permissions_are_read_only(workflow_name):
    assert re.search(r"^permissions:\n  contents: read\n", workflow(workflow_name), re.M)


def test_no_job_gets_contents_write():
    """Docker 发布只推镜像，不创建 GitHub Release，任何 job 都不该拿写权限。"""
    for workflow_name in RELEASE_WORKFLOWS:
        for name, body in jobs(workflow_name).items():
            assert re.search(r"^      contents: write$", body, re.M) is None, (workflow_name, name)


def test_actions_read_is_only_granted_where_runs_or_artifacts_are_queried():
    granted = set()
    for workflow_name in RELEASE_WORKFLOWS:
        for name, body in jobs(workflow_name).items():
            if re.search(r"^      actions: read$", body, re.M):
                granted.add((workflow_name, name))
    assert granted == {
        ("release-docker.yml", "resolve"),
        ("release-docker.yml", "promote"),
    }
    for workflow_name in RELEASE_WORKFLOWS:
        assert "write-all" not in workflow(workflow_name)
        assert "actions: write" not in workflow(workflow_name)


def test_no_new_secrets_are_introduced():
    # GITHUB_TOKEN 是 Actions 内置 token，不算新引入的仓库 secret
    #（本仓库 GHCR 推送就靠它的 packages:write）。
    allowed = {"DOCKERHUB_USERNAME", "DOCKERHUB_TOKEN", "GITHUB_TOKEN"}
    for workflow_name in RELEASE_WORKFLOWS:
        used = set(re.findall(r"secrets\.(\w+)", workflow(workflow_name)))
        assert used <= allowed, (workflow_name, used - allowed)
    assert "secrets." not in text(ACTIONS / "docker-candidates" / "action.yml")
