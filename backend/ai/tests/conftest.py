"""AI 服务测试的公共夹具。

假对象（FakeRust / FakeAgent 等）放在同目录的 ``app_fakes.py``：测试里要继承它们
（``class BrokenPersistRust(FakeRust)``），夹具给不了类；而 ``from conftest import``
在同时收集多个测试目录时会撞上别处的 conftest，所以单独成模块。
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

# 用 uv workspace 跑时 retainpdf_ai 已经装进环境；这里兜住「随手拿个解释器直接
# pytest 某个文件」的情况。以前每个测试文件各写一遍 sys.path.insert，收拢到这一处。
_AI_ROOT = Path(__file__).resolve().parents[1]
if str(_AI_ROOT) not in sys.path:
    sys.path.insert(0, str(_AI_ROOT))

# 读配置的入口（load_settings）只认这两类环境变量。
_SERVICE_ENV_PREFIX = "RETAIN_AI_"
_SERVICE_ENV_EXTRA = ("RETAIN_API_KEYS",)


@pytest.fixture(autouse=True)
def _isolated_service_env(monkeypatch, tmp_path_factory):
    """每条用例都从一份干净的服务环境开始。

    load_settings() 在没设 RETAIN_AI_DATA_ROOT 时会去读仓库根的 ``data/``，
    包括那里的 runtime 凭据文件——在开发机上跑测试，等于让断言依赖本机保存过的
    API Key。开发者 shell 里留着的 RETAIN_AI_API_KEYS 之类也会盖过测试设的
    RETAIN_API_KEYS。这里先全部清掉，再把 data root 指到一个空临时目录；
    需要特定值的用例照旧自己 setenv，会覆盖这里的默认。
    """
    for name in list(os.environ):
        if name.startswith(_SERVICE_ENV_PREFIX) or name in _SERVICE_ENV_EXTRA:
            monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv(
        "RETAIN_AI_DATA_ROOT", str(tmp_path_factory.mktemp("isolated-data-root"))
    )


@pytest.fixture
def service_env(monkeypatch, tmp_path):
    """load_settings() 的最小可启动环境：data root 指向本用例的 tmp_path。

    凭据相关的用例都要先写 tmp_path 里的凭据文件、再让 load_settings 去读，
    这三行此前在每条用例里重复一遍。
    """
    monkeypatch.setenv("RETAIN_AI_DATA_ROOT", str(tmp_path))
    monkeypatch.setenv("RETAIN_API_KEYS", "test-key")
    monkeypatch.setenv("RETAIN_AI_RUST_API_KEY", "rust-key")
    return monkeypatch
