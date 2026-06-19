import asyncio
import threading

import aiosmtplib

from mailhedgehog import smtp as smtp_module
from mailhedgehog.parser import parse as _real_parse
from mailhedgehog.smtp import SmtpHandler, create_smtp_server
from mailhedgehog.storage import MessageStore
from tests import sample_emails as s


class _Envelope:
    def __init__(self, content: bytes, mail_from: str, rcpt_tos: list[str]) -> None:
        self.content = content
        self.mail_from = mail_from
        self.rcpt_tos = rcpt_tos


class _Session:
    host_name = "h"


async def _serve(handler):
    loop = asyncio.get_event_loop()
    server = await create_smtp_server(loop, handler, "127.0.0.1", 0, 1024 * 1024)
    port = server.sockets[0].getsockname()[1]
    return server, port


async def _send_raw(port, sender, recipients, data: bytes):
    # AIDEV-NOTE: aiosmtplib.sendmail() returns (errors_dict, response_str), not
    # (code_int, response_str). Use step-by-step protocol so the DATA response
    # (an SMTPResponse NamedTuple) unpacks directly as (code, message).
    async with aiosmtplib.SMTP(hostname="127.0.0.1", port=port) as client:
        await client.ehlo()
        await client.mail(sender)
        for rcpt in recipients if isinstance(recipients, list) else [recipients]:
            await client.rcpt(rcpt)
        return await client.data(data)


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


async def test_handle_data_parses_off_the_event_loop_thread(monkeypatch):
    # AIDEV-NOTE: parse() is CPU-bound and the SMTP server shares the HTTP event
    # loop, so handle_DATA must offload it via asyncio.to_thread. Verify parse runs on
    # a worker thread (different ident) rather than blocking the event-loop thread.
    store = MessageStore(max_messages=10, max_bytes=1_000_000)

    async def on_message(_m):
        return None

    main_tid = threading.get_ident()
    captured: dict[str, int] = {}

    def spy(*args, **kwargs):
        captured["tid"] = threading.get_ident()
        return _real_parse(*args, **kwargs)

    monkeypatch.setattr(smtp_module, "parse", spy)
    handler = SmtpHandler(store, on_message)
    envelope = _Envelope(s.ASCII, "a@x.test", ["b@x.test"])
    result = await handler.handle_DATA(None, _Session(), envelope)

    assert result.startswith("250")
    assert len(store) == 1
    assert captured["tid"] != main_tid


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
