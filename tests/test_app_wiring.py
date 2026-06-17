from quart import Quart

from mailhedgehog.app import build
from mailhedgehog.config import Config


def test_build_returns_config_and_app(monkeypatch):
    monkeypatch.setenv("MH_MAX_MESSAGES", "7")
    config, app = build()
    assert isinstance(config, Config)
    assert isinstance(app, Quart)
    assert config.max_messages == 7


def test_build_hypercorn_config_sets_ping_interval():
    from mailhedgehog.app import build_hypercorn_config

    hcfg = build_hypercorn_config(Config(http_host="", http_port=8025, ws_ping_interval=20.0))
    assert hcfg.websocket_ping_interval == 20.0
    assert hcfg.bind == ["127.0.0.1:8025"]


def test_build_hypercorn_config_disables_ping_when_non_positive():
    from mailhedgehog.app import build_hypercorn_config

    hcfg = build_hypercorn_config(Config(ws_ping_interval=0.0))
    assert hcfg.websocket_ping_interval is None


def test_build_hypercorn_config_binds_explicit_host():
    from mailhedgehog.app import build_hypercorn_config

    hcfg = build_hypercorn_config(Config(http_host="0.0.0.0", http_port=9000))
    assert hcfg.bind == ["0.0.0.0:9000"]


def test_build_hypercorn_config_maps_tls_and_logs():
    from mailhedgehog.app import build_hypercorn_config

    hcfg = build_hypercorn_config(Config(tls_cert="/c.pem", tls_key="/k.pem"))
    assert hcfg.certfile == "/c.pem"
    assert hcfg.keyfile == "/k.pem"
    assert hcfg.accesslog == "-"
