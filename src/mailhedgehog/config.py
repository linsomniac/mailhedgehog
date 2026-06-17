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


def _float(name: str, default: float) -> float:
    value = os.environ.get(name)
    if value is None or value == "":
        return default
    return float(value)


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
    ws_ping_interval: float = 20.0
    debug: bool = False
    tls_cert: str | None = None
    tls_key: str | None = None

    def __post_init__(self) -> None:
        # AIDEV-NOTE: These four knobs are the memory-safety bounds. A
        # non-positive value silently defeats them (asyncio.Queue(maxsize<=0)
        # is unbounded; max_messages<=0 breaks/empties store eviction), so
        # reject them at construction time rather than failing obscurely at
        # runtime. Ports are intentionally NOT validated (0 = OS-assigned).
        caps = {
            "max_messages": self.max_messages,
            "max_bytes": self.max_bytes,
            "max_message_size": self.max_message_size,
            "ws_queue_size": self.ws_queue_size,
        }
        for name, value in caps.items():
            if value < 1:
                raise ValueError(
                    f"{name} must be a positive integer (>= 1), got {value}"
                )

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
            ws_ping_interval=_float("MH_WS_PING_INTERVAL", 20.0),
            debug=_bool("MH_DEBUG", False),
            tls_cert=os.environ.get("MH_TLS_CERT") or None,
            tls_key=os.environ.get("MH_TLS_KEY") or None,
        )
