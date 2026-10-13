"""Record and verify the identity of release candidates (Docker images).

预构建产物在「打 tag 时提升」之前必须证明自己就是这个 commit、这个版本构建出来的：

- verify-docker：校验 app / web 两份 candidate identity JSON（merge job 写出）的
  target / repo / revision / version / digest / platforms。

任何不一致都以非零退出：提升路径上它是硬门禁，提升判定（resolve job）里则用它
决定能否提升、不能就回退到完整构建。
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys


DOCKER_TARGETS = {"app": "retainpdf-app", "web": "retainpdf-web"}
IMAGE_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")


class CandidateError(ValueError):
    pass


def _load_json(path: Path) -> dict:
    if not path.is_file() or path.stat().st_size == 0:
        raise CandidateError(f"missing candidate manifest: {path}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise CandidateError(f"invalid JSON in {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise CandidateError(f"candidate manifest {path} is not an object")
    return data


def _platform_set(value: str) -> list[str]:
    return sorted(item.strip() for item in f"{value or ''}".split(",") if item.strip())


def verify_docker(
    directory: Path,
    *,
    version: str,
    revision: str,
    platforms: str,
) -> dict[str, dict]:
    expected_platforms = _platform_set(platforms)
    if not expected_platforms:
        raise CandidateError("expected Docker platforms must not be empty")
    candidates = {}
    for target, repo in DOCKER_TARGETS.items():
        manifest = _load_json(directory / f"{target}.json")
        problems = []
        if manifest.get("target") != target:
            problems.append(f"target={manifest.get('target')!r}")
        if manifest.get("repo") != repo:
            problems.append(f"repo={manifest.get('repo')!r} expected {repo}")
        if manifest.get("revision") != revision:
            problems.append(f"revision={manifest.get('revision')!r} expected {revision}")
        if manifest.get("version") != version:
            problems.append(f"version={manifest.get('version')!r} expected {version}")
        if not IMAGE_DIGEST.fullmatch(f"{manifest.get('digest', '')}"):
            problems.append(f"digest={manifest.get('digest')!r}")
        if _platform_set(manifest.get("platforms", "")) != expected_platforms:
            problems.append(
                f"platforms={manifest.get('platforms')!r} expected {','.join(expected_platforms)}"
            )
        if problems:
            raise CandidateError(f"{target} Docker candidate mismatch: {'; '.join(problems)}")
        candidates[target] = manifest
    return candidates


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    docker = sub.add_parser("verify-docker")
    docker.add_argument("--dir", required=True, type=Path)
    docker.add_argument("--version", required=True)
    docker.add_argument("--revision", required=True)
    docker.add_argument("--platforms", required=True)

    args = parser.parse_args(argv)
    try:
        candidates = verify_docker(
            args.dir, version=args.version, revision=args.revision, platforms=args.platforms
        )
        for target, manifest in candidates.items():
            print(f"{target}: {manifest['repo']}@{manifest['digest']} ({manifest['platforms']})")
    except CandidateError as exc:
        print(f"release candidate check failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
