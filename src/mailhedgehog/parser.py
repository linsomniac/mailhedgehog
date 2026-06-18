"""Crash-proof parsing of raw email bytes into MailHog-compatible message dicts."""

from __future__ import annotations

from datetime import datetime, timezone
from email import message_from_bytes
from email.header import decode_header as _decode_header
from email.header import make_header as _make_header
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


def decode_header_value(raw: str) -> str:
    """Decode an RFC 2047 encoded-word header value to a plain unicode string.

    Never raises: any failure falls back to safe_str(raw). Result is always
    safe_str-clean (no lone surrogates, json-serializable).
    """
    # AIDEV-NOTE: _decode_header returns a list of (bytes_or_str, charset) pairs.
    # _make_header reassembles them into a str, handling charset decoding.
    # We wrap the whole thing in try/except so garbage input never raises.
    try:
        decoded = str(_make_header(_decode_header(raw)))
    except Exception:
        return safe_str(raw)
    return safe_str(decoded)


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


# AIDEV-NOTE: A "part" mirrors the shape of Content {Headers, Body, Size, MIME}.
# Bodies are left in their raw on-the-wire (transfer-encoded) form on purpose —
# the frontend (strutil.js) decodes base64/quoted-printable/charset itself.
def _part_dict(part: EmailMessage) -> Message:
    if part.is_multipart():
        return {
            "Headers": extract_headers(part),
            "Body": "",
            "Size": 0,
            "MIME": _mime_tree(part),
        }
    payload = part.get_payload(decode=False)
    decoded = part.get_payload(decode=True) or b""
    return {
        "Headers": extract_headers(part),
        "Body": safe_str(payload if isinstance(payload, (str, bytes)) else ""),
        "Size": len(decoded),
        "MIME": None,
    }


def _mime_tree(msg: EmailMessage) -> Message:
    children = msg.get_payload()
    parts = (
        [p for p in children if isinstance(p, EmailMessage)]
        if isinstance(children, list)
        else []
    )
    return {"Parts": [_part_dict(p) for p in parts]}


def get_mime_part_by_cid(raw: bytes, cid: str) -> tuple[bytes, str, str | None] | None:
    """Walk the full MIME tree and return the first part whose Content-ID matches cid.

    Normalization: strip one leading '<' and trailing '>' if present, then casefold.
    Applied to both the part's Content-ID header and the requested cid.

    Returns (payload_bytes, content_type, filename) on match, None if no part matches.
    Multipart container parts are skipped — only leaf parts are inspected.
    """

    # AIDEV-NOTE: msg.walk() yields every part depth-first, including the root.
    # We skip multipart/* parts because they have no decodable payload and their
    # Content-ID (if any) is not meaningful for direct data retrieval.
    def _normalize(value: str) -> str:
        v = value.strip()
        if v.startswith("<") and v.endswith(">"):
            v = v[1:-1]
        return v.casefold()

    want = _normalize(cid)
    msg = message_from_bytes(raw)
    for part in msg.walk():
        if part.get_content_maintype() == "multipart":
            continue
        raw_cid: str | None = part.get("Content-ID")
        if raw_cid is None:
            continue
        if _normalize(raw_cid) == want:
            payload = part.get_payload(decode=True) or b""
            if not isinstance(payload, bytes):
                payload = b""
            return payload, part.get_content_type(), part.get_filename()
    return None


def get_mime_part(raw: bytes, index: int) -> tuple[bytes, str, str | None] | None:
    msg = message_from_bytes(raw)
    if not msg.is_multipart():
        return None
    payload = msg.get_payload()
    if not isinstance(payload, list) or index < 0 or index >= len(payload):
        return None
    part = payload[index]
    if not isinstance(part, EmailMessage):
        return None
    content = part.get_payload(decode=True) or b""
    if not isinstance(content, bytes):
        return None
    return content, part.get_content_type(), part.get_filename()


def unparseable_message(
    raw: bytes, mail_from: str, rcpt_tos: list[str], helo: str | None, error: str
) -> Message:
    """A safe fallback dict for input that could not be parsed at all."""
    return {
        "ID": _new_id(),
        "From": parse_addr(mail_from),
        "To": [parse_addr(r) for r in rcpt_tos],
        "Created": _now_iso(),
        "Content": {
            "Headers": {"X-MailHedgehog-Error": [safe_str(error)]},
            "Body": safe_str(raw),
            "Size": len(raw),
            "MIME": None,
        },
        "MIME": None,
        "Raw": {
            "From": safe_str(mail_from),
            "To": [safe_str(r) for r in rcpt_tos],
            "Helo": safe_str(helo or ""),
            "Data": safe_str(raw),
        },
    }


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
        "MIME": _mime_tree(msg) if msg.is_multipart() else None,
        "Raw": {
            "From": safe_str(mail_from),
            "To": [safe_str(r) for r in rcpt_tos],
            "Helo": safe_str(helo or ""),
            "Data": safe_str(raw),
        },
    }
