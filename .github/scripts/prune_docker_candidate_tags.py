"""Delete stale `candidate-*` tags from the Docker Hub image repositories.

main 每次预构建都会给 retainpdf-app / retainpdf-web 打一个 `candidate-<sha>` 标签
（发版回退路径还会打 `candidate-<sha>-<run_id>`）。标签一直留着就越积越多，
所以预构建结束后顺手删掉「超过 N 天没更新」的候选标签。

为什么按时间而不是「只留最近 N 个」：候选能不能被提升取决于它的 candidate JSON
artifact 是否还在（保留 7 天，且提升判定要求离过期还有 2 小时余量）。只删
比 artifact 保留期更老的标签，就不会删掉一个还可能被提升的候选。

只会删除完全匹配 `candidate-<40 位 sha>` 或 `candidate-<40 位 sha>-<run_id>` 的
标签，版本标签 / latest / edge / buildcache-* 永远不碰。删除只删标签，manifest
仍被版本标签引用时不受影响。整个步骤是尽力而为：Docker Hub 令牌没有删除权限
或 API 出错时只打警告，不让预构建失败。
"""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import json
import os
import re
import sys
import urllib.error
import urllib.request


HUB_API = "https://hub.docker.com/v2"
CANDIDATE_TAG = re.compile(r"^candidate-[0-9a-f]{40}(?:-[0-9]+)?$")


def select_stale_tags(
    tags: list[dict],
    *,
    now: datetime,
    max_age: timedelta,
    keep: set[str] = frozenset(),
    limit: int = 50,
) -> list[str]:
    cutoff = now - max_age
    stale = []
    for tag in tags:
        name = f"{tag.get('name', '')}"
        updated = tag.get("last_updated") or tag.get("tag_last_pushed")
        if not CANDIDATE_TAG.fullmatch(name) or name in keep or not updated:
            continue
        try:
            updated_at = datetime.fromisoformat(f"{updated}".replace("Z", "+00:00"))
        except ValueError:
            continue
        if updated_at.tzinfo is None:
            updated_at = updated_at.replace(tzinfo=timezone.utc)
        if updated_at < cutoff:
            stale.append((updated_at, name))
    stale.sort()
    return [name for _, name in stale[:limit]]


def _request(method: str, url: str, *, token: str = "", body: dict | None = None) -> dict:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Accept": "application/json", "User-Agent": "retainpdf-candidate-prune"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, data=data, method=method, headers=headers)
    with urllib.request.urlopen(request, timeout=30) as response:
        raw = response.read()
    return json.loads(raw.decode("utf-8")) if raw else {}


def _login(username: str, secret: str) -> str:
    return _request("POST", f"{HUB_API}/users/login", body={"username": username, "password": secret})["token"]


def _list_tags(namespace: str, repo: str, token: str) -> list[dict]:
    url = f"{HUB_API}/namespaces/{namespace}/repositories/{repo}/tags?page_size=100"
    tags: list[dict] = []
    while url and len(tags) < 5000:
        payload = _request("GET", url, token=token)
        tags.extend(payload.get("results") or [])
        url = payload.get("next")
    return tags


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--namespace", required=True)
    parser.add_argument("--repo", action="append", required=True)
    parser.add_argument("--max-age-days", type=int, default=10)
    parser.add_argument("--keep", action="append", default=[])
    parser.add_argument("--limit", type=int, default=50)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    if args.max_age_days < 8:
        parser.error("--max-age-days must exceed the 7-day candidate artifact retention")

    username = os.environ.get("DOCKERHUB_USERNAME", "")
    secret = os.environ.get("DOCKERHUB_TOKEN", "")
    if not username or not secret:
        print("::warning::Docker Hub credentials unavailable; skipping candidate tag pruning")
        return 0
    try:
        token = _login(username, secret)
    except (urllib.error.URLError, KeyError, ValueError) as exc:
        print(f"::warning::Docker Hub login for pruning failed: {type(exc).__name__}")
        return 0

    now = datetime.now(timezone.utc)
    for repo in args.repo:
        try:
            tags = _list_tags(args.namespace, repo, token)
        except (urllib.error.URLError, ValueError) as exc:
            print(f"::warning::listing {args.namespace}/{repo} tags failed: {type(exc).__name__}")
            continue
        stale = select_stale_tags(
            tags,
            now=now,
            max_age=timedelta(days=args.max_age_days),
            keep=set(args.keep),
            limit=args.limit,
        )
        print(f"{args.namespace}/{repo}: {len(tags)} tags, {len(stale)} stale candidate tags")
        for name in stale:
            if args.dry_run:
                print(f"  would delete {name}")
                continue
            try:
                _request(
                    "DELETE",
                    f"{HUB_API}/namespaces/{args.namespace}/repositories/{repo}/tags/{name}",
                    token=token,
                )
                print(f"  deleted {name}")
            except urllib.error.HTTPError as exc:
                print(f"::warning::deleting {repo}:{name} failed with HTTP {exc.code}; stopping")
                break
            except urllib.error.URLError as exc:
                print(f"::warning::deleting {repo}:{name} failed: {type(exc).__name__}; stopping")
                break
    return 0


if __name__ == "__main__":
    sys.exit(main())
