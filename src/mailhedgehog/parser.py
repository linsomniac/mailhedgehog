"""Crash-proof parsing of raw email bytes into MailHog-compatible message dicts."""

from __future__ import annotations

from datetime import datetime, timezone
from email import message_from_bytes
from email.message import Message as EmailMessage
from email.utils import parseaddr
from typing import Any
from uuid import uuid4

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


# AIDEV-NOTE: a bare \n\n inside a header value (rare but RFC-legal under 8-bit
# SMTP) would cause a false early split, leaving headers in the body. Acceptable
# for single-part; Task 5 must not reuse _split_body for part bodies without
# guarding against this.
def _split_body(raw: bytes) -> bytes:
    """Return the bytes after the first blank line (the message/part body)."""
    found = [(raw.find(sep), len(sep)) for sep in (b"\r\n\r\n", b"\n\n")]
    found = [(idx, length) for idx, length in found if idx != -1]
    if not found:
        return b""
    idx, length = min(found)
    return raw[idx + length :]


def _new_id() -> str:
    return f"{uuid4().hex}@mailhedgehog.example"


# AIDEV-NOTE: .astimezone() renders the instant in the server's local timezone,
# so the ISO offset varies by host TZ (same instant, different string). Callers
# that need a stable UTC offset should drop .astimezone().
def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat()


def parse(raw: bytes, mail_from: str, rcpt_tos: list[str], helo: str | None) -> Message:
    msg = message_from_bytes(raw)
    body_bytes = _split_body(raw)
    return {
        "ID": _new_id(),
        "From": parse_addr(mail_from),
        "To": [parse_addr(r) for r in rcpt_tos],
        "Created": _now_iso(),
        "Content": {
            "Headers": extract_headers(msg),
            "Body": safe_str(body_bytes),
            "Size": len(body_bytes),
            "MIME": None,
        },
        "MIME": None,  # populated for multipart in Task 5
        "Raw": {
            "From": safe_str(mail_from),
            "To": [safe_str(r) for r in rcpt_tos],
            "Helo": safe_str(helo or ""),
            "Data": safe_str(raw),
        },
    }
