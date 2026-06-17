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
