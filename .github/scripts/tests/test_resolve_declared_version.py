"""声明版本：四个清单必须一致，且就是仓库当前的版本号。"""
from __future__ import annotations

import json
from pathlib import Path
import sys

import pytest


SCRIPTS_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = SCRIPTS_ROOT.parents[1]
sys.path.insert(0, str(SCRIPTS_ROOT))

from resolve_declared_version import (  # noqa: E402
    DECLARED_VERSION_FILES,
    read_declared_versions,
    resolve_declared_version,
)


def make_repo(root: Path, versions: dict[str, str]) -> Path:
    for relative in DECLARED_VERSION_FILES:
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        version = versions.get(relative, versions.get("*", ""))
        if path.suffix == ".json":
            path.write_text(json.dumps({"name": "x", "version": version}))
        else:
            path.write_text(f'[project]\nname = "x"\nversion = "{version}"\n')
    return root


def test_aligned_versions_resolve(tmp_path):
    assert resolve_declared_version(make_repo(tmp_path, {"*": "4.2.7-beta1"})) == "4.2.7-beta1"


def test_misaligned_versions_are_rejected(tmp_path):
    make_repo(tmp_path, {"*": "4.2.7", "backend/pipeline/pyproject.toml": "4.2.6"})
    with pytest.raises(ValueError, match="not aligned"):
        resolve_declared_version(tmp_path)


@pytest.mark.parametrize("version", ["", "v4.2.7", "4.2"])
def test_non_semver_declared_version_is_rejected(tmp_path, version):
    with pytest.raises(ValueError):
        resolve_declared_version(make_repo(tmp_path, {"*": version}))


def test_repository_versions_are_aligned():
    """align application versions commit 会同时改这四处；main 上必须一直保持一致，
    否则预构建拿不到声明版本，每次发版都只能回退到完整构建。"""
    versions = read_declared_versions(REPO_ROOT)
    assert len(set(versions.values())) == 1, versions
    resolve_declared_version(REPO_ROOT)
