"""预构建 Docker 产物的身份校验：版本、revision、digest、platforms 任何一处不符都拒绝。"""
from __future__ import annotations

import json
from pathlib import Path
import sys

import pytest


SCRIPTS_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_ROOT))

from release_candidate_manifest import (  # noqa: E402
    CandidateError,
    main,
    verify_docker,
)


SHA = "c" * 40
VERSION = "4.2.7"


def write_docker(directory: Path, **overrides):
    for target in ("app", "web"):
        data = {
            "target": target,
            "repo": f"retainpdf-{target}",
            "digest": "sha256:" + ("1" if target == "app" else "2") * 64,
            "revision": SHA,
            "version": VERSION,
            "platforms": "linux/amd64,linux/arm64",
        }
        data.update(overrides.get(target, {}))
        (directory / f"{target}.json").write_text(json.dumps(data))


def test_verify_docker_accepts_matching_candidates(tmp_path):
    write_docker(tmp_path)
    candidates = verify_docker(tmp_path, version=VERSION, revision=SHA, platforms="linux/arm64, linux/amd64")
    assert set(candidates) == {"app", "web"}


@pytest.mark.parametrize("override,message", [
    ({"revision": "f" * 40}, "revision"),
    ({"version": "4.2.6"}, "version"),
    ({"repo": "retainpdf-web"}, "repo"),
    ({"target": "web"}, "target"),
    ({"digest": "sha256:xyz"}, "digest"),
    ({"platforms": "linux/amd64"}, "platforms"),
])
def test_verify_docker_rejects_mismatches(tmp_path, override, message):
    write_docker(tmp_path, app=override)
    with pytest.raises(CandidateError, match=message):
        verify_docker(tmp_path, version=VERSION, revision=SHA, platforms="linux/amd64,linux/arm64")


def test_verify_docker_requires_both_images(tmp_path):
    write_docker(tmp_path)
    (tmp_path / "web.json").unlink()
    assert main([
        "verify-docker", "--dir", str(tmp_path), "--version", VERSION, "--revision", SHA,
        "--platforms", "linux/amd64,linux/arm64",
    ]) == 1
