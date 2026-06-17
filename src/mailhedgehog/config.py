"""Environment-driven configuration."""

from __future__ import annotations

import os
from dataclasses import dataclass

_TRUE = {"1", "true", "yes", "on"}


def _int(name: str, default: int) -> int:
    value = os.environ.get(name)
    if value is None or value == "":
        return default
    return int(value)


def _bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in _TRUE


def _str(name: str, default: str) -> str:
    value = os.environ.get(name)
    return default if value is None else value


@dataclass(frozen=True)
class Config:
    smtp_host: str = ""
    smtp_port: int = 1025
    http_host: str = ""
    http_port: int = 8025
    max_messages: int = 100
    max_bytes: int = 50 * 1024 * 1024
    max_message_size: int = 25 * 1024 * 1024
    ws_queue_size: int = 256
    debug: bool = False
    tls_cert: str | None = None
    tls_key: str | None = None

    @classmethod
    def from_env(cls) -> Config:
        return cls(
            smtp_host=_str("MH_SMTP_HOST", ""),
            smtp_port=_int("MH_SMTP_PORT", 1025),
            http_host=_str("MH_HTTP_HOST", ""),
            http_port=_int("MH_HTTP_PORT", 8025),
            max_messages=_int("MH_MAX_MESSAGES", 100),
            max_bytes=_int("MH_MAX_BYTES", 50 * 1024 * 1024),
            max_message_size=_int("MH_MAX_MESSAGE_SIZE", 25 * 1024 * 1024),
            ws_queue_size=_int("MH_WS_QUEUE_SIZE", 256),
            debug=_bool("MH_DEBUG", False),
            tls_cert=os.environ.get("MH_TLS_CERT") or None,
            tls_key=os.environ.get("MH_TLS_KEY") or None,
        )
