"""Resolve the application version a commit declares in its manifests.

发版流程是先提交一个「align application versions」commit，把下面三个清单里的
版本号统一改成即将发布的版本，再在这个 commit 上打 tag。main 上的预构建没有
tag 可读，就用这里解析出的「声明版本」作为 RETAIN_PDF_VERSION 注入构建 ——
前端 APP_VERSION、Docker 镜像的 build-arg 和 OCI version label 全部来自这一个变量。

打 tag 时只有「tag 版本 == 该 commit 的声明版本」才允许提升预构建产物，
这样提升出去的产物里的每一处版本字符串都和「打了 tag 再构建」完全一致；
不相等（例如 hotfix tag 没有对齐版本号）就回退到完整构建。
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import tomllib


sys.path.insert(0, str(Path(__file__).resolve().parent))

from resolve_release_version import SEMVER_TAG  # noqa: E402


# 「align application versions」commit 会同时改这三处。
DECLARED_VERSION_FILES = (
    "package.json",
    "backend/pyproject.toml",
    "backend/pipeline/pyproject.toml",
)


def _read_version(path: Path) -> str:
    if path.suffix == ".json":
        value = json.loads(path.read_text(encoding="utf-8")).get("version", "")
    else:
        value = tomllib.loads(path.read_text(encoding="utf-8")).get("project", {}).get("version", "")
    return f"{value or ''}".strip()


def read_declared_versions(repo_root: Path) -> dict[str, str]:
    return {relative: _read_version(repo_root / relative) for relative in DECLARED_VERSION_FILES}


def resolve_declared_version(repo_root: Path) -> str:
    versions = read_declared_versions(repo_root)
    distinct = set(versions.values())
    if len(distinct) != 1:
        detail = ", ".join(f"{name}={value or '<empty>'}" for name, value in versions.items())
        raise ValueError(f"application versions are not aligned: {detail}")
    (version,) = distinct
    match = SEMVER_TAG.fullmatch(version)
    if match is None or version.startswith("v"):
        raise ValueError(f"declared application version {version!r} is not a semantic version")
    return version


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repo-root", type=Path, default=Path("."))
    parser.add_argument(
        "--github-output",
        type=Path,
        default=Path(os.environ["GITHUB_OUTPUT"]) if "GITHUB_OUTPUT" in os.environ else None,
    )
    args = parser.parse_args()
    try:
        version = resolve_declared_version(args.repo_root)
    except ValueError as exc:
        parser.error(str(exc))
    print(f"declared application version: {version}")
    if args.github_output is not None:
        with args.github_output.open("a", encoding="utf-8") as output:
            output.write(f"version={version}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
