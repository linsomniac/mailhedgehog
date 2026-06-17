# MailHedgehog Bulletproof Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the MailHedgehog SMTP-sink backend as a tested, typed `uv` package that never crashes on real-world mail and bounds its own memory.

**Architecture:** A pure `parser` (raw bytes → MailHog-compatible message dict, crash-proof), a bounded in-memory `MessageStore` (count + total-byte caps), an `smtp` ingestion handler that always returns `250`, and a `web` Quart app factory exposing the full MailHog API + a bounded-queue websocket. The proven Angular frontend is reused unchanged.

**Tech Stack:** Python ≥3.10, Quart, aiosmtpd, pytest + pytest-asyncio + aiosmtplib, mypy (strict), ruff, uv.

## Global Constraints

- Python `requires-python = ">=3.10"`. Target `py310` for ruff/mypy.
- Use **uv** only — no pip / poetry / requirements.txt.
- Every function has type annotations; `mypy --strict src` must pass.
- Format with `ruff format`; `ruff check` must pass.
- Runtime deps: `quart>=0.17`, `aiosmtpd`. Dev deps: `pytest`, `pytest-asyncio`, `aiosmtplib`, `mypy`, `ruff`.
- Encoding rule: parsing **never raises** on any input; all emitted strings are JSON-safe (surrogate-scrubbed via `safe_str`).
- SMTP rule: `handle_DATA` **always returns `250`**; SMTP configured with `enable_SMTPUTF8=True`, `decode_data=False`.
- Storage is **in-memory only**; no persistence; no time-based TTL.
- The frontend (`static/`, `templates/index.html`) is **not modified**, only relocated.
- Add `AIDEV-NOTE:` anchor comments on the complex/important encoding and eviction code.
- `pytest-asyncio` runs in `asyncio_mode = "auto"` (async tests need no marker).

---

### Task 1: Scaffold the `uv` package, tooling, and relocate frontend assets

**Files:**
- Create: `pyproject.toml`
- Create: `src/mailhedgehog/__init__.py`
- Create: `tests/__init__.py`
- Create: `tests/conftest.py`
- Move: `static/` → `src/mailhedgehog/web/static/`, `templates/` → `src/mailhedgehog/web/templates/`

**Interfaces:**
- Consumes: nothing.
- Produces: an importable, installable `mailhedgehog` package; `uv run` toolchain; package data location `src/mailhedgehog/web/{static,templates}`.

- [ ] **Step 1: Create `pyproject.toml`**

```toml
[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[project]
name = "mailhedgehog"
version = "0.2.0"
description = "A simple, robust SMTP sink with a MailHog-compatible web UI"
readme = "README.md"
requires-python = ">=3.10"
dependencies = ["quart>=0.17", "aiosmtpd"]

[project.scripts]
mailhedgehog = "mailhedgehog.app:main"

[dependency-groups]
dev = ["pytest", "pytest-asyncio", "aiosmtplib", "mypy", "ruff"]

[tool.hatch.build.targets.wheel]
packages = ["src/mailhedgehog"]

[tool.ruff]
target-version = "py310"
line-length = 88

[tool.ruff.lint]
select = ["E", "F", "I", "UP", "B"]

[tool.mypy]
python_version = "3.10"
strict = true
files = ["src"]

[[tool.mypy.overrides]]
module = ["aiosmtpd.*", "aiosmtplib.*"]
ignore_missing_imports = true

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]
```

- [ ] **Step 2: Create package + test scaffolding**

`src/mailhedgehog/__init__.py`:
```python
"""MailHedgehog: a simple, robust SMTP sink with a MailHog-compatible web UI."""

__version__ = "0.2.0"
```

`tests/__init__.py`: (empty file)

`tests/conftest.py`:
```python
"""Shared pytest fixtures."""
```

- [ ] **Step 3: Relocate the frontend assets with git**

```bash
mkdir -p src/mailhedgehog/web
git mv static src/mailhedgehog/web/static
git mv templates src/mailhedgehog/web/templates
```

- [ ] **Step 4: Sync the environment and verify the toolchain**

Run:
```bash
uv sync
uv run python -c "import mailhedgehog; print(mailhedgehog.__version__)"
uv run ruff check .
uv run mypy
```
Expected: `uv sync` creates `.venv` and `uv.lock`; the import prints `0.2.0`; ruff reports "All checks passed"; mypy reports "Success: no issues found" (it checks `src`, currently just `__init__.py`).

- [ ] **Step 5: Commit**

```bash
git add pyproject.toml uv.lock src/mailhedgehog/__init__.py tests/__init__.py tests/conftest.py
git add -A src/mailhedgehog/web
git commit -m "chore: scaffold uv package and relocate frontend assets"
```

---

### Task 2: `config.py` — environment-driven configuration

**Files:**
- Create: `src/mailhedgehog/config.py`
- Test: `tests/test_config.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `Config` frozen dataclass with fields `smtp_host: str`, `smtp_port: int`, `http_host: str`, `http_port: int`, `max_messages: int`, `max_bytes: int`, `max_message_size: int`, `ws_queue_size: int`, `debug: bool`, `tls_cert: str | None`, `tls_key: str | None`; classmethod `Config.from_env() -> Config`.

- [ ] **Step 1: Write the failing tests**

`tests/test_config.py`:
```python
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


@pytest.mark.parametrize("value,expected", [("1", True), ("yes", True), ("on", True), ("0", False), ("false", False), ("", False)])
def test_bool_parsing(monkeypatch, value, expected):
    monkeypatch.setenv("MH_DEBUG", value)
    assert Config.from_env().debug is expected


def test_invalid_int_raises(monkeypatch):
    monkeypatch.setenv("MH_SMTP_PORT", "notanumber")
    with pytest.raises(ValueError):
        Config.from_env()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_config.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'mailhedgehog.config'`.

- [ ] **Step 3: Implement `config.py`**

`src/mailhedgehog/config.py`:
```python
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
```

- [ ] **Step 4: Run tests + type/lint to verify pass**

Run: `uv run pytest tests/test_config.py -v && uv run mypy && uv run ruff check .`
Expected: all tests PASS; mypy success; ruff clean.

- [ ] **Step 5: Commit**

```bash
git add src/mailhedgehog/config.py tests/test_config.py
git commit -m "feat: env-driven Config"
```

---

### Task 3: `parser.py` foundations — `safe_str`, `parse_addr`, `extract_headers`

**Files:**
- Create: `src/mailhedgehog/parser.py`
- Test: `tests/test_parser_foundations.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `Message = dict[str, Any]` type alias.
  - `safe_str(value: str | bytes) -> str` — JSON-safe; never raises; recovers surrogate-escaped bytes and re-decodes as UTF-8 with replacement.
  - `parse_addr(addr: str) -> dict[str, Any]` — returns `{"Mailbox", "Domain", "Params": "", "Relays": None}`.
  - `extract_headers(msg: EmailMessage) -> dict[str, list[str]]` — name → list of raw values, order and duplicates preserved.

- [ ] **Step 1: Write the failing tests**

`tests/test_parser_foundations.py`:
```python
from email import message_from_bytes

from mailhedgehog.parser import extract_headers, parse_addr, safe_str


def test_safe_str_passes_ascii():
    assert safe_str("hello") == "hello"
    assert safe_str(b"hello") == "hello"


def test_safe_str_decodes_utf8_bytes():
    assert safe_str("café".encode("utf-8")) == "café"


def test_safe_str_replaces_invalid_bytes_without_raising():
    # 0xe9 is 'é' in latin-1 but invalid as standalone UTF-8.
    assert safe_str(b"caf\xe9") == "caf�"


def test_safe_str_recovers_surrogate_escaped_utf8():
    # How email's BytesFeedParser represents 8-bit input internally.
    surrogate = b"caf\xc3\xa9".decode("ascii", "surrogateescape")
    assert safe_str(surrogate) == "café"


def test_safe_str_handles_lone_surrogate():
    surrogate = b"\xe9".decode("ascii", "surrogateescape")
    assert safe_str(surrogate) == "�"


def test_parse_addr_normal():
    assert parse_addr("Alice <alice@example.com>") == {
        "Mailbox": "alice",
        "Domain": "example.com",
        "Params": "",
        "Relays": None,
    }


def test_parse_addr_bare():
    assert parse_addr("bob@host.test")["Mailbox"] == "bob"


def test_parse_addr_handles_missing_at():
    result = parse_addr("garbage")
    assert result["Mailbox"] == "garbage"
    assert result["Domain"] == ""


def test_parse_addr_handles_empty():
    assert parse_addr("") == {"Mailbox": "", "Domain": "", "Params": "", "Relays": None}


def test_extract_headers_preserves_duplicates_and_order():
    raw = b"Received: one\r\nReceived: two\r\nSubject: hi\r\n\r\nbody"
    headers = extract_headers(message_from_bytes(raw))
    assert headers["Received"] == ["one", "two"]
    assert headers["Subject"] == ["hi"]
    assert list(headers.keys()) == ["Received", "Subject"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_parser_foundations.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'mailhedgehog.parser'`.

- [ ] **Step 3: Implement the foundations**

`src/mailhedgehog/parser.py`:
```python
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
    return {"Mailbox": safe_str(mailbox), "Domain": safe_str(domain), "Params": "", "Relays": None}


def extract_headers(msg: EmailMessage) -> dict[str, list[str]]:
    headers: dict[str, list[str]] = {}
    for key, value in msg.items():
        headers.setdefault(safe_str(key), []).append(safe_str(value))
    return headers
```

- [ ] **Step 4: Run tests + type/lint to verify pass**

Run: `uv run pytest tests/test_parser_foundations.py -v && uv run mypy && uv run ruff check .`
Expected: all PASS; mypy success; ruff clean.

- [ ] **Step 5: Commit**

```bash
git add src/mailhedgehog/parser.py tests/test_parser_foundations.py
git commit -m "feat: parser foundations (safe_str, parse_addr, extract_headers)"
```

---

### Task 4: `parser.py` — `parse()` for single-part messages

**Files:**
- Create: `tests/sample_emails.py`
- Modify: `src/mailhedgehog/parser.py`
- Test: `tests/test_parser_single.py`

**Interfaces:**
- Consumes: `safe_str`, `parse_addr`, `extract_headers` (Task 3).
- Produces: `parse(raw: bytes, mail_from: str, rcpt_tos: list[str], helo: str | None) -> Message`. The returned dict has keys `ID`, `From`, `To`, `Created`, `Content` (`{Headers, Body, Size, MIME}`), `MIME` (top-level; `None` for single-part), `Raw` (`{From, To, Helo, Data}`).

- [ ] **Step 1: Create the shared sample-email corpus**

`tests/sample_emails.py`:
```python
"""Raw email byte corpus shared across parser and web tests."""

ASCII = (
    b"From: alice@example.com\r\n"
    b"To: bob@example.com\r\n"
    b"Subject: Plain hello\r\n"
    b"\r\n"
    b"Hello, world.\r\n"
)

UTF8_8BIT = (
    b"From: a@x.test\r\n"
    b"To: b@x.test\r\n"
    b"Subject: utf8\r\n"
    b"Content-Type: text/plain; charset=utf-8\r\n"
    b"Content-Transfer-Encoding: 8bit\r\n"
    b"\r\n"
    b"caf\xc3\xa9 \xe2\x98\x83\r\n"
)

LATIN1_8BIT = (
    b"From: a@x.test\r\n"
    b"To: b@x.test\r\n"
    b"Subject: latin1\r\n"
    b"Content-Type: text/plain; charset=iso-8859-1\r\n"
    b"Content-Transfer-Encoding: 8bit\r\n"
    b"\r\n"
    b"caf\xe9\r\n"
)

BASE64_BODY = (
    b"From: a@x.test\r\n"
    b"To: b@x.test\r\n"
    b"Subject: b64\r\n"
    b"Content-Type: text/plain; charset=utf-8\r\n"
    b"Content-Transfer-Encoding: base64\r\n"
    b"\r\n"
    b"Y2Fmw6kK\r\n"
)

RFC2047_SUBJECT = (
    b"From: a@x.test\r\n"
    b"To: b@x.test\r\n"
    b"Subject: =?UTF-8?B?Y2Fmw6k=?=\r\n"
    b"\r\n"
    b"body\r\n"
)

MISSING_FROM = b"To: b@x.test\r\nSubject: no from\r\n\r\nbody\r\n"

MULTIPART_ALTERNATIVE = (
    b"From: a@x.test\r\n"
    b"To: b@x.test\r\n"
    b"Subject: alt\r\n"
    b'Content-Type: multipart/alternative; boundary="BB"\r\n'
    b"\r\n"
    b"--BB\r\n"
    b"Content-Type: text/plain; charset=utf-8\r\n"
    b"\r\n"
    b"plain part\r\n"
    b"--BB\r\n"
    b"Content-Type: text/html; charset=utf-8\r\n"
    b"\r\n"
    b"<p>html part</p>\r\n"
    b"--BB--\r\n"
)

MULTIPART_ATTACHMENT = (
    b"From: a@x.test\r\n"
    b"To: b@x.test\r\n"
    b"Subject: attach\r\n"
    b'Content-Type: multipart/mixed; boundary="MM"\r\n'
    b"\r\n"
    b"--MM\r\n"
    b"Content-Type: text/plain; charset=utf-8\r\n"
    b"\r\n"
    b"see attachment\r\n"
    b"--MM\r\n"
    b"Content-Type: application/octet-stream\r\n"
    b"Content-Transfer-Encoding: base64\r\n"
    b'Content-Disposition: attachment; filename="hi.bin"\r\n'
    b"\r\n"
    b"AAECAwQF\r\n"
    b"--MM--\r\n"
)

NESTED_MULTIPART = (
    b"From: a@x.test\r\n"
    b"To: b@x.test\r\n"
    b"Subject: nested\r\n"
    b'Content-Type: multipart/mixed; boundary="OUT"\r\n'
    b"\r\n"
    b"--OUT\r\n"
    b'Content-Type: multipart/alternative; boundary="IN"\r\n'
    b"\r\n"
    b"--IN\r\n"
    b"Content-Type: text/plain\r\n"
    b"\r\n"
    b"inner plain\r\n"
    b"--IN\r\n"
    b"Content-Type: text/html\r\n"
    b"\r\n"
    b"<p>inner html</p>\r\n"
    b"--IN--\r\n"
    b"--OUT--\r\n"
)

GARBAGE = b"\x00\x01\x02 not even close to an email \xff\xfe"
```

- [ ] **Step 2: Write the failing tests**

`tests/test_parser_single.py`:
```python
from datetime import datetime

from mailhedgehog.parser import parse
from tests import sample_emails as s


def test_basic_structure():
    m = parse(s.ASCII, "alice@example.com", ["bob@example.com"], "helo.test")
    assert m["ID"].endswith("@mailhedgehog.example")
    assert m["From"] == {"Mailbox": "alice", "Domain": "example.com", "Params": "", "Relays": None}
    assert m["To"][0]["Mailbox"] == "bob"
    assert m["Content"]["Headers"]["Subject"] == ["Plain hello"]
    assert m["Content"]["Body"] == "Hello, world.\r\n"
    assert m["Content"]["MIME"] is None
    assert m["MIME"] is None
    assert m["Raw"]["From"] == "alice@example.com"
    assert m["Raw"]["To"] == ["bob@example.com"]
    assert m["Raw"]["Helo"] == "helo.test"
    assert m["Raw"]["Data"] == s.ASCII.decode("ascii")
    datetime.fromisoformat(m["Created"])  # parses without error


def test_from_and_to_come_from_envelope_not_headers():
    # Header says alice/bob; envelope says different — envelope wins.
    m = parse(s.ASCII, "envelope@from.test", ["env@to.test"], None)
    assert m["From"]["Domain"] == "from.test"
    assert m["To"][0]["Domain"] == "to.test"
    assert m["Raw"]["Helo"] == ""


def test_utf8_8bit_body_roundtrips():
    m = parse(s.UTF8_8BIT, "a@x.test", ["b@x.test"], "h")
    assert m["Content"]["Body"] == "café ☃\r\n"


def test_latin1_8bit_body_does_not_crash():
    m = parse(s.LATIN1_8BIT, "a@x.test", ["b@x.test"], "h")
    # 0xe9 isn't valid UTF-8 -> replacement char, but no exception.
    assert "caf" in m["Content"]["Body"]


def test_base64_body_left_encoded_for_frontend():
    m = parse(s.BASE64_BODY, "a@x.test", ["b@x.test"], "h")
    assert m["Content"]["Headers"]["Content-Transfer-Encoding"] == ["base64"]
    assert "Y2Fmw6kK" in m["Content"]["Body"]


def test_rfc2047_subject_left_encoded_for_frontend():
    m = parse(s.RFC2047_SUBJECT, "a@x.test", ["b@x.test"], "h")
    assert m["Content"]["Headers"]["Subject"] == ["=?UTF-8?B?Y2Fmw6k=?="]


def test_missing_from_header_does_not_crash():
    m = parse(s.MISSING_FROM, "env@from.test", ["b@x.test"], "h")
    assert m["From"]["Mailbox"] == "env"
    assert "From" not in m["Content"]["Headers"]
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `uv run pytest tests/test_parser_single.py -v`
Expected: FAIL with `ImportError: cannot import name 'parse'`.

- [ ] **Step 4: Implement `parse()` and the body splitter**

Add to `src/mailhedgehog/parser.py` (imports at top, functions at bottom):
```python
# add to the existing imports
from datetime import datetime, timezone
from email import message_from_bytes
from uuid import uuid4
```
```python
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
```

- [ ] **Step 5: Run tests + type/lint to verify pass**

Run: `uv run pytest tests/test_parser_single.py -v && uv run mypy && uv run ruff check .`
Expected: all PASS; mypy success; ruff clean.

- [ ] **Step 6: Commit**

```bash
git add src/mailhedgehog/parser.py tests/sample_emails.py tests/test_parser_single.py
git commit -m "feat: parse() single-part messages with crash-proof encoding"
```

---

### Task 5: `parser.py` — multipart MIME tree + `get_mime_part()`

**Files:**
- Modify: `src/mailhedgehog/parser.py`
- Test: `tests/test_parser_multipart.py`

**Interfaces:**
- Consumes: `parse` (Task 4), `extract_headers`, `safe_str`.
- Produces:
  - `parse()` now sets top-level `MIME` to `{"Parts": [...]}` for multipart messages; each part is `{Headers, Body, Size, MIME}` (recursive).
  - `get_mime_part(raw: bytes, index: int) -> tuple[bytes, str, str | None] | None` — decoded bytes, content-type, and filename of the Nth **top-level** part; `None` if out of range.

- [ ] **Step 1: Write the failing tests**

`tests/test_parser_multipart.py`:
```python
from mailhedgehog.parser import get_mime_part, parse
from tests import sample_emails as s


def test_alternative_has_two_parts():
    m = parse(s.MULTIPART_ALTERNATIVE, "a@x.test", ["b@x.test"], "h")
    parts = m["MIME"]["Parts"]
    assert len(parts) == 2
    assert parts[0]["Headers"]["Content-Type"] == ["text/plain; charset=utf-8"]
    assert parts[0]["Body"] == "plain part\r\n"
    assert parts[1]["Body"] == "<p>html part</p>\r\n"
    assert parts[0]["MIME"] is None


def test_single_part_has_no_mime_tree():
    m = parse(s.ASCII, "a@x.test", ["b@x.test"], "h")
    assert m["MIME"] is None


def test_attachment_part_size_is_decoded_length():
    m = parse(s.MULTIPART_ATTACHMENT, "a@x.test", ["b@x.test"], "h")
    attachment = m["MIME"]["Parts"][1]
    # base64 "AAECAwQF" decodes to 6 bytes.
    assert attachment["Size"] == 6
    assert attachment["Headers"]["Content-Disposition"] == ['attachment; filename="hi.bin"']


def test_nested_multipart_recurses():
    m = parse(s.NESTED_MULTIPART, "a@x.test", ["b@x.test"], "h")
    outer = m["MIME"]["Parts"]
    assert len(outer) == 1
    inner = outer[0]["MIME"]["Parts"]
    assert len(inner) == 2
    assert inner[0]["Body"] == "inner plain\r\n"


def test_get_mime_part_returns_decoded_bytes_type_and_filename():
    content, content_type, filename = get_mime_part(s.MULTIPART_ATTACHMENT, 1)
    assert content == bytes([0, 1, 2, 3, 4, 5])
    assert content_type == "application/octet-stream"
    assert filename == "hi.bin"


def test_get_mime_part_out_of_range_returns_none():
    assert get_mime_part(s.MULTIPART_ATTACHMENT, 99) is None
    assert get_mime_part(s.ASCII, 0) is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_parser_multipart.py -v`
Expected: FAIL — `test_alternative_has_two_parts` fails (`m["MIME"]` is `None`) and `get_mime_part` import fails.

- [ ] **Step 3: Implement the MIME tree + part extractor**

Add to `src/mailhedgehog/parser.py`:
```python
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
    parts = children if isinstance(children, list) else []
    return {"Parts": [_part_dict(p) for p in parts]}


def get_mime_part(raw: bytes, index: int) -> tuple[bytes, str, str | None] | None:
    msg = message_from_bytes(raw)
    if not msg.is_multipart():
        return None
    payload = msg.get_payload()
    if not isinstance(payload, list) or index < 0 or index >= len(payload):
        return None
    part = payload[index]
    content = part.get_payload(decode=True) or b""
    return content, part.get_content_type(), part.get_filename()
```

Then modify `parse()` to populate the top-level `MIME`:
```python
        "MIME": _mime_tree(msg) if msg.is_multipart() else None,
```
(Replace the `"MIME": None,  # populated for multipart in Task 5` line.)

- [ ] **Step 4: Run tests + type/lint to verify pass**

Run: `uv run pytest tests/test_parser_multipart.py tests/test_parser_single.py -v && uv run mypy && uv run ruff check .`
Expected: all PASS (single-part tests still green); mypy success; ruff clean.

- [ ] **Step 5: Commit**

```bash
git add src/mailhedgehog/parser.py tests/test_parser_multipart.py
git commit -m "feat: recursive multipart MIME tree and get_mime_part"
```

---

### Task 6: `parser.py` — `unparseable_message()` placeholder

**Files:**
- Modify: `src/mailhedgehog/parser.py`
- Test: `tests/test_parser_placeholder.py`

**Interfaces:**
- Consumes: `safe_str`, `parse_addr`, `_new_id`, `_now_iso`.
- Produces: `unparseable_message(raw: bytes, mail_from: str, rcpt_tos: list[str], helo: str | None, error: str) -> Message` — a valid message dict carrying the raw data and an `X-MailHedgehog-Error` header note.

- [ ] **Step 1: Write the failing tests**

`tests/test_parser_placeholder.py`:
```python
import json

from mailhedgehog.parser import parse, unparseable_message
from tests import sample_emails as s


def test_garbage_still_parses_without_raising():
    m = parse(s.GARBAGE, "a@x.test", ["b@x.test"], "h")
    assert m["Raw"]["Data"]  # best-effort, lossy but present
    json.dumps(m)  # must be JSON-serializable


def test_placeholder_has_error_note_and_raw():
    m = unparseable_message(b"\xff\xfe junk", "a@x.test", ["b@x.test"], "h", "boom")
    assert m["Content"]["Headers"]["X-MailHedgehog-Error"] == ["boom"]
    assert m["From"]["Mailbox"] == "a"
    assert m["MIME"] is None
    assert "junk" in m["Raw"]["Data"]
    json.dumps(m)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_parser_placeholder.py -v`
Expected: FAIL with `ImportError: cannot import name 'unparseable_message'`.

- [ ] **Step 3: Implement the placeholder builder**

Add to `src/mailhedgehog/parser.py`:
```python
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
```

- [ ] **Step 4: Run tests + type/lint to verify pass**

Run: `uv run pytest tests/ -v && uv run mypy && uv run ruff check .`
Expected: all PASS; mypy success; ruff clean.

- [ ] **Step 5: Commit**

```bash
git add src/mailhedgehog/parser.py tests/test_parser_placeholder.py
git commit -m "feat: unparseable_message placeholder"
```

---

### Task 7: `storage.py` — bounded `MessageStore` with search

**Files:**
- Create: `src/mailhedgehog/storage.py`
- Test: `tests/test_storage.py`

**Interfaces:**
- Consumes: `Message` (parser).
- Produces: `MessageStore(max_messages: int, max_bytes: int)` with:
  - `add(message: Message, raw: bytes) -> None`
  - `get(msg_id: str) -> Message | None`
  - `get_raw(msg_id: str) -> bytes | None`
  - `list(start: int, limit: int) -> tuple[list[Message], int]` (newest-first; returns `(items, total)`)
  - `search(kind: str, query: str, start: int, limit: int) -> tuple[list[Message], int]` (`kind` ∈ `containing`/`to`/`from`)
  - `delete(msg_id: str) -> bool`
  - `clear() -> None`
  - `__len__() -> int`
  - `total_bytes: int` (property)

- [ ] **Step 1: Write the failing tests**

`tests/test_storage.py`:
```python
from mailhedgehog.storage import MessageStore


def _msg(msg_id, raw_from="a@x.test", raw_to="b@x.test", data="hello"):
    return {
        "ID": msg_id,
        "From": {"Mailbox": raw_from.split("@")[0], "Domain": raw_from.split("@")[1], "Params": "", "Relays": None},
        "To": [{"Mailbox": raw_to.split("@")[0], "Domain": raw_to.split("@")[1], "Params": "", "Relays": None}],
        "Raw": {"From": raw_from, "To": [raw_to], "Helo": "h", "Data": data},
    }


def test_add_and_get():
    store = MessageStore(max_messages=10, max_bytes=1_000_000)
    store.add(_msg("id1"), b"raw1")
    assert store.get("id1")["ID"] == "id1"
    assert store.get_raw("id1") == b"raw1"
    assert store.get("missing") is None
    assert len(store) == 1


def test_list_is_newest_first_with_pagination():
    store = MessageStore(max_messages=10, max_bytes=1_000_000)
    for i in range(5):
        store.add(_msg(f"id{i}"), b"x")
    items, total = store.list(0, 2)
    assert total == 5
    assert [m["ID"] for m in items] == ["id4", "id3"]
    items, total = store.list(2, 2)
    assert [m["ID"] for m in items] == ["id2", "id1"]


def test_eviction_by_count():
    store = MessageStore(max_messages=3, max_bytes=1_000_000)
    for i in range(5):
        store.add(_msg(f"id{i}"), b"x")
    assert len(store) == 3
    ids = [m["ID"] for m in store.list(0, 10)[0]]
    assert ids == ["id4", "id3", "id2"]  # oldest evicted


def test_eviction_by_total_bytes():
    store = MessageStore(max_messages=100, max_bytes=10)
    store.add(_msg("id0"), b"aaaaa")  # 5 bytes
    store.add(_msg("id1"), b"bbbbb")  # 10 total
    store.add(_msg("id2"), b"ccccc")  # would be 15 -> evict id0
    assert [m["ID"] for m in store.list(0, 10)[0]] == ["id2", "id1"]
    assert store.total_bytes == 10


def test_retains_most_recent_even_if_over_byte_cap():
    store = MessageStore(max_messages=100, max_bytes=4)
    store.add(_msg("big"), b"0123456789")  # 10 bytes, exceeds cap alone
    assert len(store) == 1
    assert store.get("big") is not None


def test_delete_and_clear():
    store = MessageStore(max_messages=10, max_bytes=1_000_000)
    store.add(_msg("id1"), b"raw")
    assert store.delete("id1") is True
    assert store.delete("id1") is False
    assert store.total_bytes == 0
    store.add(_msg("id2"), b"raw")
    store.clear()
    assert len(store) == 0
    assert store.total_bytes == 0


def test_search_kinds():
    store = MessageStore(max_messages=10, max_bytes=1_000_000)
    store.add(_msg("id1", raw_from="alice@a.test", raw_to="bob@b.test", data="hello alice"), b"x")
    store.add(_msg("id2", raw_from="carol@c.test", raw_to="dave@d.test", data="hi dave"), b"y")
    assert [m["ID"] for m in store.search("from", "alice", 0, 10)[0]] == ["id1"]
    assert [m["ID"] for m in store.search("to", "dave", 0, 10)[0]] == ["id2"]
    assert [m["ID"] for m in store.search("containing", "hello", 0, 10)[0]] == ["id1"]
    assert store.search("containing", "nomatch", 0, 10)[1] == 0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_storage.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'mailhedgehog.storage'`.

- [ ] **Step 3: Implement `MessageStore`**

`src/mailhedgehog/storage.py`:
```python
"""Bounded in-memory message storage (count + total-byte caps)."""

from __future__ import annotations

from dataclasses import dataclass

from mailhedgehog.parser import Message


@dataclass
class _Entry:
    message: Message
    raw: bytes
    size: int


def _addr_text(addr: dict[str, object]) -> str:
    return f"{addr['Mailbox']}@{addr['Domain']}"


class MessageStore:
    def __init__(self, max_messages: int, max_bytes: int) -> None:
        self.max_messages = max_messages
        self.max_bytes = max_bytes
        self._entries: dict[str, _Entry] = {}  # insertion order: oldest -> newest
        self._total_bytes = 0

    def __len__(self) -> int:
        return len(self._entries)

    @property
    def total_bytes(self) -> int:
        return self._total_bytes

    def add(self, message: Message, raw: bytes) -> None:
        entry = _Entry(message=message, raw=raw, size=len(raw))
        self._entries[message["ID"]] = entry
        self._total_bytes += entry.size
        self._evict()

    # AIDEV-NOTE: two independent caps; always keep the newest message even if it
    # alone exceeds max_bytes (guarded by len > 1) so a single huge mail can't
    # evict itself into nothing.
    def _evict(self) -> None:
        while len(self._entries) > self.max_messages:
            self._pop_oldest()
        while self._total_bytes > self.max_bytes and len(self._entries) > 1:
            self._pop_oldest()

    def _pop_oldest(self) -> None:
        oldest_id = next(iter(self._entries))
        self._total_bytes -= self._entries.pop(oldest_id).size

    def get(self, msg_id: str) -> Message | None:
        entry = self._entries.get(msg_id)
        return entry.message if entry else None

    def get_raw(self, msg_id: str) -> bytes | None:
        entry = self._entries.get(msg_id)
        return entry.raw if entry else None

    def _newest_first(self) -> list[_Entry]:
        return list(reversed(self._entries.values()))

    def list(self, start: int, limit: int) -> tuple[list[Message], int]:
        entries = self._newest_first()
        start = max(start, 0)
        page = entries[start : start + limit]
        return [e.message for e in page], len(entries)

    def search(self, kind: str, query: str, start: int, limit: int) -> tuple[list[Message], int]:
        needle = query.lower()
        matches = [e.message for e in self._newest_first() if self._matches(e.message, kind, needle)]
        start = max(start, 0)
        return matches[start : start + limit], len(matches)

    @staticmethod
    def _matches(message: Message, kind: str, needle: str) -> bool:
        if kind == "from":
            hay = f"{message['Raw']['From']} {_addr_text(message['From'])}"
        elif kind == "to":
            tos = " ".join(message["Raw"]["To"]) + " " + " ".join(_addr_text(a) for a in message["To"])
            hay = tos
        else:  # "containing"
            hay = message["Raw"]["Data"]
        return needle in hay.lower()

    def delete(self, msg_id: str) -> bool:
        entry = self._entries.pop(msg_id, None)
        if entry is None:
            return False
        self._total_bytes -= entry.size
        return True

    def clear(self) -> None:
        self._entries.clear()
        self._total_bytes = 0
```

- [ ] **Step 4: Run tests + type/lint to verify pass**

Run: `uv run pytest tests/test_storage.py -v && uv run mypy && uv run ruff check .`
Expected: all PASS; mypy success; ruff clean.

- [ ] **Step 5: Commit**

```bash
git add src/mailhedgehog/storage.py tests/test_storage.py
git commit -m "feat: bounded MessageStore with count+size eviction and search"
```

---

### Task 8: `smtp.py` — ingestion handler with error isolation

**Files:**
- Create: `src/mailhedgehog/smtp.py`
- Test: `tests/test_smtp_integration.py`

**Interfaces:**
- Consumes: `parse`, `unparseable_message` (parser); `MessageStore` (storage).
- Produces:
  - `SmtpHandler(store: MessageStore, on_message: Callable[[Message], Awaitable[None]])` with async `handle_DATA(server, session, envelope) -> str`.
  - `create_smtp_server(loop, handler, host: str, port: int, data_size_limit: int) -> asyncio.AbstractServer` (awaitable).

- [ ] **Step 1: Write the failing tests**

`tests/test_smtp_integration.py`:
```python
import asyncio

import aiosmtplib

from mailhedgehog import smtp as smtp_module
from mailhedgehog.smtp import SmtpHandler, create_smtp_server
from mailhedgehog.storage import MessageStore
from tests import sample_emails as s


async def _serve(handler):
    loop = asyncio.get_event_loop()
    server = await create_smtp_server(loop, handler, "127.0.0.1", 0, 1024 * 1024)
    port = server.sockets[0].getsockname()[1]
    return server, port


async def _send_raw(port, sender, recipients, data: bytes):
    async with aiosmtplib.SMTP(hostname="127.0.0.1", port=port) as client:
        return await client.sendmail(sender, recipients, data)


async def test_roundtrip_stores_message():
    store = MessageStore(max_messages=10, max_bytes=1_000_000)

    async def on_message(_m):
        return None

    server, port = await _serve(SmtpHandler(store, on_message))
    try:
        await _send_raw(port, "alice@example.com", ["bob@example.com"], s.ASCII)
        assert len(store) == 1
        items, _ = store.list(0, 10)
        assert items[0]["Content"]["Headers"]["Subject"] == ["Plain hello"]
    finally:
        server.close()
        await server.wait_closed()


async def test_nonutf8_multipart_message_accepted():
    store = MessageStore(max_messages=10, max_bytes=1_000_000)

    async def on_message(_m):
        return None

    server, port = await _serve(SmtpHandler(store, on_message))
    try:
        code, _ = await _send_raw(port, "a@x.test", ["b@x.test"], s.LATIN1_8BIT)
        assert code == 250
        await _send_raw(port, "a@x.test", ["b@x.test"], s.MULTIPART_ATTACHMENT)
        assert len(store) == 2
    finally:
        server.close()
        await server.wait_closed()


async def test_parser_failure_stores_placeholder_and_returns_250(monkeypatch):
    store = MessageStore(max_messages=10, max_bytes=1_000_000)

    async def on_message(_m):
        return None

    def boom(*_args, **_kwargs):
        raise RuntimeError("forced failure")

    monkeypatch.setattr(smtp_module, "parse", boom)
    server, port = await _serve(SmtpHandler(store, on_message))
    try:
        code, _ = await _send_raw(port, "a@x.test", ["b@x.test"], s.ASCII)
        assert code == 250
        assert len(store) == 1
        msg = store.list(0, 1)[0][0]
        assert msg["Content"]["Headers"]["X-MailHedgehog-Error"]
    finally:
        server.close()
        await server.wait_closed()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_smtp_integration.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'mailhedgehog.smtp'`.

- [ ] **Step 3: Implement `smtp.py`**

`src/mailhedgehog/smtp.py`:
```python
"""SMTP ingestion: parse -> store -> broadcast. Never rejects a message."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

from aiosmtpd.smtp import SMTP

from mailhedgehog.parser import Message, parse, unparseable_message
from mailhedgehog.storage import MessageStore


class SmtpHandler:
    def __init__(self, store: MessageStore, on_message: Callable[[Message], Awaitable[None]]) -> None:
        self._store = store
        self._on_message = on_message

    # AIDEV-NOTE: a sink must accept everything. Any parse failure becomes a stored
    # placeholder; broadcast failures are swallowed. We always return 250.
    async def handle_DATA(self, server: Any, session: Any, envelope: Any) -> str:
        content = envelope.content
        raw = content if isinstance(content, bytes) else str(content).encode("utf-8", "replace")
        rcpts = list(envelope.rcpt_tos)
        helo = session.host_name
        try:
            message = parse(raw, envelope.mail_from, rcpts, helo)
        except Exception as exc:  # noqa: BLE001 - intentional catch-all for a sink
            message = unparseable_message(raw, envelope.mail_from, rcpts, helo, str(exc))
        self._store.add(message, raw)
        try:
            await self._on_message(message)
        except Exception:  # noqa: BLE001 - a broken websocket client must not fail delivery
            pass
        return "250 Message accepted for delivery"


async def create_smtp_server(
    loop: asyncio.AbstractEventLoop,
    handler: SmtpHandler,
    host: str,
    port: int,
    data_size_limit: int,
) -> asyncio.AbstractServer:
    def factory() -> SMTP:
        return SMTP(
            handler,
            enable_SMTPUTF8=True,
            decode_data=False,
            data_size_limit=data_size_limit,
        )

    return await loop.create_server(factory, host=host or None, port=port)
```

- [ ] **Step 4: Run tests + type/lint to verify pass**

Run: `uv run pytest tests/test_smtp_integration.py -v && uv run mypy && uv run ruff check .`
Expected: all PASS; mypy success; ruff clean.

- [ ] **Step 5: Commit**

```bash
git add src/mailhedgehog/smtp.py tests/test_smtp_integration.py
git commit -m "feat: SMTP ingestion handler with error isolation"
```

---

### Task 9: `web.py` — app factory + message list/get/delete endpoints

**Files:**
- Create: `src/mailhedgehog/web.py`
- Test: `tests/test_api_messages.py`

**Interfaces:**
- Consumes: `Config` (config), `MessageStore` (storage), `parse` (parser).
- Produces: `create_app(config: Config, store: MessageStore) -> Quart` exposing: `GET /` (index), static files at `/static`, `GET /api/v2/messages?start=&limit=`, `GET /api/v1/messages/<msgid>`, `DELETE /api/v1/messages`, `DELETE /api/v1/messages/<msgid>`.

- [ ] **Step 1: Write the failing tests**

`tests/test_api_messages.py`:
```python
import pytest

from mailhedgehog.config import Config
from mailhedgehog.parser import parse
from mailhedgehog.storage import MessageStore
from mailhedgehog.web import create_app
from tests import sample_emails as s


@pytest.fixture
def app_and_store():
    config = Config(smtp_port=0, http_port=0, max_messages=100, max_bytes=10_000_000)
    store = MessageStore(config.max_messages, config.max_bytes)
    return create_app(config, store), store


def _seed(store, n):
    ids = []
    for _ in range(n):
        m = parse(s.ASCII, "alice@example.com", ["bob@example.com"], "h")
        store.add(m, s.ASCII)
        ids.append(m["ID"])
    return ids


async def test_index_serves_html(app_and_store):
    app, _ = app_and_store
    client = app.test_client()
    resp = await client.get("/")
    assert resp.status_code == 200
    body = await resp.get_data(as_text=True)
    assert "MailHedgehog" in body


async def test_list_messages_pagination(app_and_store):
    app, store = app_and_store
    _seed(store, 3)
    client = app.test_client()
    resp = await client.get("/api/v2/messages?limit=2")
    data = await resp.get_json()
    assert data["total"] == 3
    assert data["count"] == 2
    assert data["start"] == 0
    assert len(data["items"]) == 2


async def test_get_single_message_and_404(app_and_store):
    app, store = app_and_store
    ids = _seed(store, 1)
    client = app.test_client()
    resp = await client.get(f"/api/v1/messages/{ids[0]}")
    assert resp.status_code == 200
    assert (await resp.get_json())["ID"] == ids[0]
    assert (await client.get("/api/v1/messages/nope")).status_code == 404


async def test_delete_one_and_delete_all(app_and_store):
    app, store = app_and_store
    ids = _seed(store, 2)
    client = app.test_client()
    assert (await client.delete(f"/api/v1/messages/{ids[0]}")).status_code == 200
    assert len(store) == 1
    assert (await client.delete("/api/v1/messages/missing")).status_code == 404
    assert (await client.delete("/api/v1/messages")).status_code == 200
    assert len(store) == 0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_api_messages.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'mailhedgehog.web'`.

- [ ] **Step 3: Implement the app factory + message routes**

`src/mailhedgehog/web.py`:
```python
"""Quart application factory: HTTP API, websocket, and SMTP lifecycle."""

from __future__ import annotations

from pathlib import Path

from quart import Quart, abort, request

from mailhedgehog.config import Config
from mailhedgehog.storage import MessageStore

_WEB = Path(__file__).parent / "web"


def create_app(config: Config, store: MessageStore) -> Quart:
    app = Quart(
        __name__,
        static_folder=str(_WEB / "static"),
        static_url_path="/static",
    )

    @app.route("/")
    async def index() -> str:
        return (_WEB / "templates" / "index.html").read_text()

    @app.route("/api/v2/messages")
    async def list_messages() -> dict[str, object]:
        start = request.args.get("start", 0, type=int)
        limit = request.args.get("limit", 50, type=int)
        items, total = store.list(start, limit)
        return {"total": total, "count": len(items), "start": max(start, 0), "items": items}

    @app.route("/api/v1/messages/<msgid>")
    async def get_message(msgid: str) -> dict[str, object]:
        message = store.get(msgid)
        if message is None:
            abort(404)
        return message

    @app.route("/api/v1/messages", methods=["DELETE"])
    async def delete_all() -> str:
        store.clear()
        return "OK"

    @app.route("/api/v1/messages/<msgid>", methods=["DELETE"])
    async def delete_one(msgid: str) -> str:
        if not store.delete(msgid):
            abort(404)
        return "OK"

    return app
```

- [ ] **Step 4: Run tests + type/lint to verify pass**

Run: `uv run pytest tests/test_api_messages.py -v && uv run mypy && uv run ruff check .`
Expected: all PASS; mypy success; ruff clean.

- [ ] **Step 5: Commit**

```bash
git add src/mailhedgehog/web.py tests/test_api_messages.py
git commit -m "feat: Quart app factory with message list/get/delete API"
```

---

### Task 10: `web.py` — search, downloads, and graceful stubs

**Files:**
- Modify: `src/mailhedgehog/web.py`
- Test: `tests/test_api_extras.py`

**Interfaces:**
- Consumes: `get_mime_part` (parser); `store.search`, `store.get_raw`.
- Produces these routes on the app from Task 9: `GET /api/v2/search`, `GET /api/v1/messages/<msgid>/download`, `GET /api/v1/messages/<msgid>/mime/part/<int:part>/download`, `GET /api/v2/outgoing-smtp` (→ `[]`), `POST /api/v1/messages/<msgid>/release` (→ `501`).

- [ ] **Step 1: Write the failing tests**

`tests/test_api_extras.py`:
```python
import pytest

from mailhedgehog.config import Config
from mailhedgehog.parser import parse
from mailhedgehog.storage import MessageStore
from mailhedgehog.web import create_app
from tests import sample_emails as s


@pytest.fixture
def app_and_store():
    config = Config(smtp_port=0, http_port=0)
    store = MessageStore(config.max_messages, config.max_bytes)
    return create_app(config, store), store


async def test_search_endpoint(app_and_store):
    app, store = app_and_store
    m = parse(s.ASCII, "alice@example.com", ["bob@example.com"], "h")
    store.add(m, s.ASCII)
    client = app.test_client()
    resp = await client.get("/api/v2/search?kind=from&query=alice")
    data = await resp.get_json()
    assert data["total"] == 1
    assert data["items"][0]["ID"] == m["ID"]


async def test_download_raw_message(app_and_store):
    app, store = app_and_store
    m = parse(s.ASCII, "a@x.test", ["b@x.test"], "h")
    store.add(m, s.ASCII)
    client = app.test_client()
    resp = await client.get(f"/api/v1/messages/{m['ID']}/download")
    assert resp.status_code == 200
    assert (await resp.get_data()) == s.ASCII
    assert "attachment" in resp.headers["Content-Disposition"]
    assert (await client.get("/api/v1/messages/missing/download")).status_code == 404


async def test_download_mime_part(app_and_store):
    app, store = app_and_store
    m = parse(s.MULTIPART_ATTACHMENT, "a@x.test", ["b@x.test"], "h")
    store.add(m, s.MULTIPART_ATTACHMENT)
    client = app.test_client()
    resp = await client.get(f"/api/v1/messages/{m['ID']}/mime/part/1/download")
    assert resp.status_code == 200
    assert (await resp.get_data()) == bytes([0, 1, 2, 3, 4, 5])
    assert "hi.bin" in resp.headers["Content-Disposition"]
    assert (await client.get(f"/api/v1/messages/{m['ID']}/mime/part/9/download")).status_code == 404


async def test_stubs(app_and_store):
    app, _ = app_and_store
    client = app.test_client()
    assert (await (await client.get("/api/v2/outgoing-smtp")).get_json()) == []
    assert (await client.post("/api/v1/messages/x/release")).status_code == 501
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_api_extras.py -v`
Expected: FAIL — routes return 404 / endpoints missing.

- [ ] **Step 3: Implement the extra routes**

In `src/mailhedgehog/web.py`, update the imports and add routes before `return app`:
```python
# update the quart import line:
from quart import Quart, Response, abort, request
# add to module imports:
from mailhedgehog.parser import get_mime_part
```
```python
    @app.route("/api/v2/search")
    async def search() -> dict[str, object]:
        kind = request.args.get("kind", "containing")
        query = request.args.get("query", "")
        start = request.args.get("start", 0, type=int)
        limit = request.args.get("limit", 50, type=int)
        items, total = store.search(kind, query, start, limit)
        return {"total": total, "count": len(items), "start": max(start, 0), "items": items}

    @app.route("/api/v1/messages/<msgid>/download")
    async def download(msgid: str) -> Response:
        raw = store.get_raw(msgid)
        if raw is None:
            abort(404)
        return Response(
            raw,
            mimetype="message/rfc822",
            headers={"Content-Disposition": f'attachment; filename="{msgid}.eml"'},
        )

    @app.route("/api/v1/messages/<msgid>/mime/part/<int:part>/download")
    async def download_part(msgid: str, part: int) -> Response:
        raw = store.get_raw(msgid)
        if raw is None:
            abort(404)
        result = get_mime_part(raw, part)
        if result is None:
            abort(404)
        content, content_type, filename = result
        disposition = "attachment"
        if filename:
            disposition += f'; filename="{filename}"'
        return Response(content, mimetype=content_type, headers={"Content-Disposition": disposition})

    # AIDEV-NOTE: "release"/outgoing-smtp are intentionally unimplemented (a sink has
    # no relay). Stub them so the UI's Release modal opens without console errors.
    @app.route("/api/v2/outgoing-smtp")
    async def outgoing_smtp() -> list[object]:
        return []

    @app.route("/api/v1/messages/<msgid>/release", methods=["POST"])
    async def release(msgid: str) -> tuple[str, int]:
        return "Not Implemented", 501
```

- [ ] **Step 4: Run tests + type/lint to verify pass**

Run: `uv run pytest tests/test_api_extras.py -v && uv run mypy && uv run ruff check .`
Expected: all PASS; mypy success; ruff clean.

- [ ] **Step 5: Commit**

```bash
git add src/mailhedgehog/web.py tests/test_api_extras.py
git commit -m "feat: search, downloads, and graceful release stubs"
```

---

### Task 11: `web.py` — bounded websocket broadcaster + SMTP lifecycle

**Files:**
- Modify: `src/mailhedgehog/web.py`
- Test: `tests/test_websocket.py`

**Interfaces:**
- Consumes: `create_smtp_server`, `SmtpHandler` (smtp); `config.ws_queue_size`, `config.smtp_host/smtp_port/max_message_size`.
- Produces:
  - `WebSocketBroadcaster(queue_size: int)` with `register() -> asyncio.Queue[str]`, `unregister(q) -> None`, async `broadcast(message: Message) -> None` (drops on `QueueFull`).
  - `GET /api/v2/websocket` streaming endpoint.
  - `before_serving`/`after_serving` hooks that start/stop the SMTP server, wired to broadcast.
  - The broadcaster is reachable in tests as `app.broadcaster`.

- [ ] **Step 1: Write the failing tests**

`tests/test_websocket.py`:
```python
import asyncio
import json

import pytest

from mailhedgehog.config import Config
from mailhedgehog.storage import MessageStore
from mailhedgehog.web import WebSocketBroadcaster, create_app


async def test_broadcaster_is_bounded():
    b = WebSocketBroadcaster(queue_size=2)
    q = b.register()
    for i in range(5):
        await b.broadcast({"ID": str(i)})
    assert q.qsize() == 2  # excess dropped, no unbounded growth
    b.unregister(q)


async def test_broadcaster_delivers_to_registered_clients():
    b = WebSocketBroadcaster(queue_size=10)
    q = b.register()
    await b.broadcast({"ID": "abc"})
    assert json.loads(q.get_nowait())["ID"] == "abc"


async def test_unregister_stops_delivery():
    b = WebSocketBroadcaster(queue_size=10)
    q = b.register()
    b.unregister(q)
    await b.broadcast({"ID": "x"})
    assert q.empty()


@pytest.fixture
def app_and_store():
    config = Config(smtp_port=0, http_port=0, ws_queue_size=10)
    store = MessageStore(config.max_messages, config.max_bytes)
    return create_app(config, store), store


async def test_websocket_receives_broadcast(app_and_store):
    app, _ = app_and_store
    client = app.test_client()
    async with client.websocket("/api/v2/websocket") as ws:
        await asyncio.sleep(0)  # let the handler register its queue
        await app.broadcaster.broadcast({"ID": "live"})
        data = json.loads(await ws.receive())
        assert data["ID"] == "live"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_websocket.py -v`
Expected: FAIL with `ImportError: cannot import name 'WebSocketBroadcaster'`.

- [ ] **Step 3: Implement the broadcaster, websocket route, and lifecycle**

In `src/mailhedgehog/web.py`, update imports:
```python
# update the quart import line:
from quart import Quart, Response, abort, request, websocket
# add to module imports:
import asyncio
import json

from mailhedgehog.parser import Message, get_mime_part
from mailhedgehog.smtp import SmtpHandler, create_smtp_server
```
Add the broadcaster class at module level (after `_WEB`):
```python
# AIDEV-NOTE: bounded per-client queues. A slow/dead UI client drops live frames
# (it reconciles on the next /api/v2/messages refresh) and can never grow memory.
class WebSocketBroadcaster:
    def __init__(self, queue_size: int) -> None:
        self._queue_size = queue_size
        self._clients: set[asyncio.Queue[str]] = set()

    def register(self) -> asyncio.Queue[str]:
        queue: asyncio.Queue[str] = asyncio.Queue(maxsize=self._queue_size)
        self._clients.add(queue)
        return queue

    def unregister(self, queue: asyncio.Queue[str]) -> None:
        self._clients.discard(queue)

    async def broadcast(self, message: Message) -> None:
        data = json.dumps(message)
        for queue in list(self._clients):
            try:
                queue.put_nowait(data)
            except asyncio.QueueFull:
                pass
```
Inside `create_app`, after creating `app`, wire the broadcaster, websocket, and SMTP lifecycle (place the websocket route with the other routes and the lifecycle hooks before `return app`):
```python
    broadcaster = WebSocketBroadcaster(config.ws_queue_size)
    app.broadcaster = broadcaster  # type: ignore[attr-defined]
    smtp_server: list[asyncio.AbstractServer] = []

    @app.websocket("/api/v2/websocket")
    async def ws() -> None:
        queue = broadcaster.register()
        try:
            while True:
                await websocket.send(await queue.get())
        finally:
            broadcaster.unregister(queue)

    @app.before_serving
    async def _start_smtp() -> None:
        handler = SmtpHandler(store, broadcaster.broadcast)
        server = await create_smtp_server(
            asyncio.get_event_loop(),
            handler,
            config.smtp_host,
            config.smtp_port,
            config.max_message_size,
        )
        smtp_server.append(server)

    @app.after_serving
    async def _stop_smtp() -> None:
        for server in smtp_server:
            server.close()
            await server.wait_closed()
```

- [ ] **Step 4: Run tests + type/lint to verify pass**

Run: `uv run pytest tests/test_websocket.py -v && uv run mypy && uv run ruff check .`
Expected: all PASS; mypy success; ruff clean.

- [ ] **Step 5: Run the full suite**

Run: `uv run pytest -v && uv run mypy && uv run ruff check .`
Expected: every test PASSES; mypy success; ruff clean.

- [ ] **Step 6: Commit**

```bash
git add src/mailhedgehog/web.py tests/test_websocket.py
git commit -m "feat: bounded websocket broadcaster and SMTP lifecycle wiring"
```

---

### Task 12: `app.py` + `__main__` wiring; remove legacy files

**Files:**
- Create: `src/mailhedgehog/app.py`
- Create: `src/mailhedgehog/__main__.py`
- Delete: `mail.py`, `mailhedgehog` (legacy flat entrypoint), `requirements.txt`
- Test: `tests/test_app_wiring.py`

**Interfaces:**
- Consumes: `Config`, `MessageStore`, `create_app`.
- Produces: `build() -> tuple[Config, Quart]` (testable wiring) and `main() -> None` (console-script entrypoint).

- [ ] **Step 1: Write the failing test**

`tests/test_app_wiring.py`:
```python
from quart import Quart

from mailhedgehog.app import build
from mailhedgehog.config import Config


def test_build_returns_config_and_app(monkeypatch):
    monkeypatch.setenv("MH_MAX_MESSAGES", "7")
    config, app = build()
    assert isinstance(config, Config)
    assert isinstance(app, Quart)
    assert config.max_messages == 7
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_app_wiring.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'mailhedgehog.app'`.

- [ ] **Step 3: Implement `app.py` and `__main__.py`**

`src/mailhedgehog/app.py`:
```python
"""Application wiring and entrypoint."""

from __future__ import annotations

from quart import Quart

from mailhedgehog.config import Config
from mailhedgehog.storage import MessageStore
from mailhedgehog.web import create_app


def build() -> tuple[Config, Quart]:
    config = Config.from_env()
    store = MessageStore(config.max_messages, config.max_bytes)
    return config, create_app(config, store)


def main() -> None:
    config, app = build()
    app.run(
        host=config.http_host,
        port=config.http_port,
        debug=config.debug,
        certfile=config.tls_cert,
        keyfile=config.tls_key,
    )


if __name__ == "__main__":
    main()
```

`src/mailhedgehog/__main__.py`:
```python
from mailhedgehog.app import main

main()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_app_wiring.py -v`
Expected: PASS.

- [ ] **Step 5: Remove legacy files**

```bash
git rm mail.py mailhedgehog requirements.txt
```

- [ ] **Step 6: Manual smoke test**

Run (in one terminal):
```bash
uv run mailhedgehog
```
Expected: starts without error, serving HTTP on `:8025` and SMTP on `:1025`.
In another terminal:
```bash
uv run python -c "import smtplib; s=smtplib.SMTP('127.0.0.1',1025); s.sendmail('a@b.test',['c@d.test'],'Subject: smoke\r\n\r\nhi'); s.quit()"
curl -s http://127.0.0.1:8025/api/v2/messages | head -c 300
```
Expected: the curl output shows JSON with `"total": 1` and the message. Stop the server with Ctrl-C.

- [ ] **Step 7: Run full suite + type/lint, then commit**

Run: `uv run pytest -v && uv run mypy && uv run ruff check .`
Expected: all green.
```bash
git add src/mailhedgehog/app.py src/mailhedgehog/__main__.py tests/test_app_wiring.py
git commit -m "feat: app wiring and console entrypoint; remove legacy files"
```

---

### Task 13: Dockerfile, README, and CI

**Files:**
- Modify: `Dockerfile`
- Modify: `README.md`
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: the finished package.
- Produces: a uv-based container image, updated docs, and CI running ruff + mypy + pytest.

- [ ] **Step 1: Rewrite the `Dockerfile` for uv**

`Dockerfile`:
```dockerfile
FROM python:3.10-alpine

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

RUN adduser -D mailhedgehog
WORKDIR /home/mailhedgehog
USER mailhedgehog

COPY --chown=mailhedgehog:mailhedgehog pyproject.toml uv.lock README.md ./
COPY --chown=mailhedgehog:mailhedgehog src ./src
RUN uv sync --no-dev --frozen

EXPOSE 1025 8025
ENV MH_HTTP_HOST=0.0.0.0 MH_SMTP_HOST=0.0.0.0

ENTRYPOINT ["uv", "run", "--no-dev", "mailhedgehog"]
```

- [ ] **Step 2: Build the image to verify it works**

Run: `docker build -t mailhedgehog .`
Expected: build succeeds through `uv sync` and the final image is created.

- [ ] **Step 3: Update `README.md`**

Replace the **Quickstart** "Using Python3/pip" block and the **Anti-features** list so they match the new reality. Set the Python quickstart to:
```markdown
Using Python 3 / uv:

* Clone this repo
* uv run mailhedgehog
* Open a browser to: http://127.0.0.1:8025/
* Send an e-mail to SMTP port 1025
```
And update **Anti-features** to:
```markdown
* No authentication
* No persistent storage of messages (in-memory, auto-expired by count and total size)
* No message release / outgoing relay (it is a sink)
```
Add a short **Configuration** section listing the `MH_*` environment variables and their defaults (copy the table from the design spec §10).

- [ ] **Step 4: Create the CI workflow**

`.github/workflows/ci.yml`:
```yaml
name: CI

on:
  push:
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v5
      - run: uv sync
      - run: uv run ruff check .
      - run: uv run ruff format --check .
      - run: uv run mypy
      - run: uv run pytest
```

- [ ] **Step 5: Final verification**

Run: `uv run ruff format --check . && uv run ruff check . && uv run mypy && uv run pytest`
Expected: formatting clean, lint clean, types clean, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add Dockerfile README.md .github/workflows/ci.yml
git commit -m "chore: uv-based Dockerfile, updated README, and CI"
```

---

## Self-Review

**1. Spec coverage:**
- §2 root-cause bugs → Task 3 (`safe_str` boundary, header dupes), Task 4 (envelope From/To, no decode crash), Task 5 (top-level MIME tree), Task 6 (placeholder), Task 8 (error isolation + correct server shutdown), Task 11 (bounded WS queue), Task 9 (index served from package path; HTTP/2 push-promise removed entirely rather than guarded — simpler and avoids the throw). ✓
- §3 goals/non-goals → bounded storage (Task 7), full UI API (Tasks 9–11), release/Jim excluded + stubbed (Task 10), in-memory only, no TTL, frontend relocated-not-rewritten (Task 1). ✓
- §6 data model → Tasks 4–5 produce the exact shape; `Content.MIME` always null, top-level `MIME` holds the tree. ✓
- §7 four guards → count+size (Task 7), SMTP `data_size_limit` (Task 8), bounded WS queue (Task 11). ✓
- §9 API table → Tasks 9–11 cover every row. ✓
- §10 config → Task 2 + README (Task 13). ✓
- §11 testing → every module has a test task; encoding matrix in Tasks 3–6. ✓
- §12 packaging → Task 1 + Task 13. ✓

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N"; every code step contains complete code. ✓ (Note: the original spec mentioned `.eml` files under `tests/fixtures/`; this plan instead uses inline byte constants in `tests/sample_emails.py` — simpler, no binary files, same coverage.)

**3. Type consistency:** `parse(raw, mail_from, rcpt_tos, helo)` used identically in Tasks 4, 8, and tests. `MessageStore(max_messages, max_bytes)` and its methods (`add/get/get_raw/list/search/delete/clear`) consistent across Tasks 7–12. `WebSocketBroadcaster(queue_size)` / `register/unregister/broadcast` consistent across Task 11. `get_mime_part(raw, index) -> tuple[bytes, str, str | None] | None` consistent in Tasks 5 and 10. `create_app(config, store)` consistent across Tasks 9–12. `Message = dict[str, Any]` defined once in Task 3, imported elsewhere. ✓

One decision worth flagging during execution: the HTTP/2 `make_push_promise` calls from the old `index()` are **dropped** (not ported). They only helped under HTTP/2+TLS and threw on plain HTTP; the assets load fine without them. If you later run under TLS and want push, re-add them wrapped in `try/except`.
