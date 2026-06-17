"""Crash-proof parsing of raw email bytes into MailHog-compatible message dicts."""

from __future__ import annotations

from email.message import Message as EmailMessage
from email.utils import parseaddr
from typing import Any

Message = dict[str, Any]


# AIDEV-NOTE: safe_str is the single byte->str boundary. It must NEVER raise and
# must NEVER return a string json.dumps can't serialize (no lone surrogates).
# email's BytesFeedParser decodes 8-bit input as ASCII+surrogateescape, so parsed
# strings may carry surrogate-escaped bytes; encoding back with surrogateescape
# recovers the original bytes, which we then re-decode as UTF-8 with replacement.
def safe_str(value: str | bytes) -> str:
    if isinstance(value, str):
        raw = value.encode("utf-8", "surrogateescape")
    else:
        raw = value
    return raw.decode("utf-8", "replace")


def parse_addr(addr: str) -> dict[str, Any]:
    _, email = parseaddr(addr or "")
    email = email or (addr or "")
    if "@" in email:
        mailbox, _, domain = email.rpartition("@")
    else:
        mailbox, domain = email, ""
    return {
        "Mailbox": safe_str(mailbox),
        "Domain": safe_str(domain),
        "Params": "",
        "Relays": None,
    }


def extract_headers(msg: EmailMessage) -> dict[str, list[str]]:
    headers: dict[str, list[str]] = {}
    for key, value in msg.items():
        headers.setdefault(safe_str(key), []).append(safe_str(value))
    return headers
