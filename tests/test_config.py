import pytest

from mailhedgehog.config import Config


def test_defaults_when_env_empty(monkeypatch):
    for name in list(vars(Config()).keys()):
        monkeypatch.delenv("MH_" + name.upper(), raising=False)
    cfg = Config.from_env()
    assert cfg.smtp_port == 1025
    assert cfg.http_port == 8025
    assert cfg.max_messages == 100
    assert cfg.max_bytes == 50 * 1024 * 1024
    assert cfg.max_message_size == 25 * 1024 * 1024
    assert cfg.ws_queue_size == 256
    assert cfg.debug is False
    assert cfg.tls_cert is None


def test_reads_from_environment(monkeypatch):
    monkeypatch.setenv("MH_SMTP_PORT", "2525")
    monkeypatch.setenv("MH_MAX_MESSAGES", "5")
    monkeypatch.setenv("MH_DEBUG", "true")
    monkeypatch.setenv("MH_TLS_CERT", "/tmp/cert.pem")
    cfg = Config.from_env()
    assert cfg.smtp_port == 2525
    assert cfg.max_messages == 5
    assert cfg.debug is True
    assert cfg.tls_cert == "/tmp/cert.pem"


@pytest.mark.parametrize(
    "value,expected",
    [
        ("1", True),
        ("yes", True),
        ("on", True),
        ("0", False),
        ("false", False),
        ("", False),
    ],
)
def test_bool_parsing(monkeypatch, value, expected):
    monkeypatch.setenv("MH_DEBUG", value)
    assert Config.from_env().debug is expected


def test_invalid_int_raises(monkeypatch):
    monkeypatch.setenv("MH_SMTP_PORT", "notanumber")
    with pytest.raises(ValueError):
        Config.from_env()


@pytest.mark.parametrize("value", ["0", "-1"])
@pytest.mark.parametrize(
    "name",
    ["MH_MAX_MESSAGES", "MH_MAX_BYTES", "MH_MAX_MESSAGE_SIZE", "MH_WS_QUEUE_SIZE"],
)
def test_nonpositive_memory_caps_rejected(monkeypatch, name, value):
    # These knobs are the memory-safety bounds; 0/negative would disable the
    # websocket queue bound or break store eviction, so they must fail fast.
    monkeypatch.setenv(name, value)
    field = name[3:].lower()  # MH_MAX_MESSAGES -> max_messages
    with pytest.raises(ValueError, match=field):
        Config.from_env()


def test_minimum_valid_caps_accepted(monkeypatch):
    for name in (
        "MH_MAX_MESSAGES",
        "MH_MAX_BYTES",
        "MH_MAX_MESSAGE_SIZE",
        "MH_WS_QUEUE_SIZE",
    ):
        monkeypatch.setenv(name, "1")
    cfg = Config.from_env()
    assert cfg.max_messages == 1
    assert cfg.max_bytes == 1
    assert cfg.max_message_size == 1
    assert cfg.ws_queue_size == 1


def test_direct_construction_rejects_nonpositive_cap():
    # The invariant lives on Config, so it holds for direct construction too.
    with pytest.raises(ValueError, match="max_messages"):
        Config(max_messages=0)


def test_ws_ping_interval_default():
    from mailhedgehog.config import Config

    assert Config().ws_ping_interval == 20.0


def test_ws_ping_interval_from_env(monkeypatch):
    from mailhedgehog.config import Config

    monkeypatch.setenv("MH_WS_PING_INTERVAL", "5.5")
    assert Config.from_env().ws_ping_interval == 5.5


def test_ws_ping_interval_empty_uses_default(monkeypatch):
    from mailhedgehog.config import Config

    monkeypatch.setenv("MH_WS_PING_INTERVAL", "")
    assert Config.from_env().ws_ping_interval == 20.0


def test_ws_ping_interval_allows_non_positive_to_disable(monkeypatch):
    # AIDEV-NOTE: <= 0 is intentionally allowed; it disables the heartbeat at
    # the launcher (maps to hypercorn websocket_ping_interval=None).
    from mailhedgehog.config import Config

    monkeypatch.setenv("MH_WS_PING_INTERVAL", "0")
    assert Config.from_env().ws_ping_interval == 0.0


def test_proxy_defaults(monkeypatch):
    for name in (
        "MH_PROXY_REMOTE_IMAGES",
        "MH_PROXY_TIMEOUT",
        "MH_PROXY_MAX_BYTES",
        "MH_PROXY_MAX_REDIRECTS",
    ):
        monkeypatch.delenv(name, raising=False)
    cfg = Config.from_env()
    assert cfg.proxy_remote_images is False
    assert cfg.proxy_timeout == 10.0
    assert cfg.proxy_max_bytes == 10_485_760
    assert cfg.proxy_max_redirects == 5


def test_proxy_reads_from_environment(monkeypatch):
    monkeypatch.setenv("MH_PROXY_REMOTE_IMAGES", "1")
    monkeypatch.setenv("MH_PROXY_TIMEOUT", "3.5")
    monkeypatch.setenv("MH_PROXY_MAX_BYTES", "2048")
    monkeypatch.setenv("MH_PROXY_MAX_REDIRECTS", "0")
    cfg = Config.from_env()
    assert cfg.proxy_remote_images is True
    assert cfg.proxy_timeout == 3.5
    assert cfg.proxy_max_bytes == 2048
    assert cfg.proxy_max_redirects == 0


def test_proxy_max_bytes_must_be_positive():
    with pytest.raises(ValueError, match="proxy_max_bytes"):
        Config(proxy_max_bytes=0)


def test_proxy_timeout_must_be_positive():
    with pytest.raises(ValueError, match="proxy_timeout"):
        Config(proxy_timeout=0)


def test_proxy_max_redirects_rejects_negative():
    with pytest.raises(ValueError, match="proxy_max_redirects"):
        Config(proxy_max_redirects=-1)
