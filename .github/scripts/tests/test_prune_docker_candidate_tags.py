"""候选标签清理只删足够老的 candidate-*，绝不碰版本标签 / latest / 缓存。"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys

import pytest


SCRIPTS_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_ROOT))

from prune_docker_candidate_tags import main, select_stale_tags  # noqa: E402


NOW = datetime(2026, 10, 7, tzinfo=timezone.utc)
SHA = "a" * 40


def tag(name, days_old):
    return {"name": name, "last_updated": (NOW - timedelta(days=days_old)).isoformat().replace("+00:00", "Z")}


def test_only_old_candidate_tags_are_selected():
    tags = [
        tag(f"candidate-{SHA}", 30),
        tag(f"candidate-{'b' * 40}-123456", 12),
        tag(f"candidate-{'c' * 40}", 3),  # 仍在 artifact 保留期内，可能被提升
        tag("v4.2.6", 400),
        tag("4.2.6", 400),
        tag("latest", 400),
        tag("edge", 400),
        tag("buildcache-amd64", 400),
        tag("current-abc1234", 400),
        tag("candidate-notasha", 400),
        tag(f"candidate-{SHA}-x", 400),
    ]
    assert select_stale_tags(tags, now=NOW, max_age=timedelta(days=10)) == [
        f"candidate-{SHA}",
        f"candidate-{'b' * 40}-123456",
    ]


def test_keep_list_and_limit_are_honoured():
    tags = [tag(f"candidate-{c * 40}", 20 + i) for i, c in enumerate("abcd")]
    selected = select_stale_tags(tags, now=NOW, max_age=timedelta(days=10), keep={f"candidate-{'d' * 40}"}, limit=2)
    # 最老的先删。
    assert selected == [f"candidate-{'c' * 40}", f"candidate-{'b' * 40}"]


def test_tags_without_timestamps_are_left_alone():
    assert select_stale_tags([{"name": f"candidate-{SHA}"}], now=NOW, max_age=timedelta(days=10)) == []


def test_max_age_must_outlive_artifact_retention():
    with pytest.raises(SystemExit):
        main(["--namespace", "x", "--repo", "retainpdf-app", "--max-age-days", "7"])


def test_missing_credentials_skip_without_failing(monkeypatch, capsys):
    monkeypatch.delenv("DOCKERHUB_USERNAME", raising=False)
    monkeypatch.delenv("DOCKERHUB_TOKEN", raising=False)
    assert main(["--namespace", "x", "--repo", "retainpdf-app"]) == 0
    assert "skipping" in capsys.readouterr().out
