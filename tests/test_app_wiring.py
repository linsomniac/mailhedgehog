from quart import Quart

from mailhedgehog.app import build
from mailhedgehog.config import Config


def test_build_returns_config_and_app(monkeypatch):
    monkeypatch.setenv("MH_MAX_MESSAGES", "7")
    config, app = build()
    assert isinstance(config, Config)
    assert isinstance(app, Quart)
    assert config.max_messages == 7
