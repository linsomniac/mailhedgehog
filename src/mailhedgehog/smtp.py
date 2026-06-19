"""SMTP ingestion: parse -> store -> broadcast. Never rejects a message."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

from aiosmtpd.smtp import SMTP

from mailhedgehog.parser import Message, parse, unparseable_message
from mailhedgehog.storage import MessageStore


class SmtpHandler:
    def __init__(
        self, store: MessageStore, on_message: Callable[[Message], Awaitable[None]]
    ) -> None:
        self._store = store
        self._on_message = on_message

    # AIDEV-NOTE: a sink must accept everything. Any parse failure becomes a stored
    # placeholder; broadcast failures are swallowed. We always return 250.
    async def handle_DATA(self, server: Any, session: Any, envelope: Any) -> str:
        content = envelope.content
        raw = (
            content
            if isinstance(content, bytes)
            else str(content).encode("utf-8", "replace")
        )
        rcpts = list(envelope.rcpt_tos)
        helo = session.host_name
        # AIDEV-NOTE: parse() is CPU-bound (message_from_bytes + recursive MIME walk +
        # per-part base64/QP decode) and the SMTP server shares the Quart/Hypercorn
        # event loop, so parsing a large message inline would head-of-line-block all
        # HTTP/WS/SMTP for its duration. Offload it to a worker thread, mirroring the
        # search route (web.py uses asyncio.to_thread for the same reason). store.add()
        # stays on the loop: it only touches tiny header strings (~microseconds).
        try:
            message = await asyncio.to_thread(
                parse, raw, envelope.mail_from, rcpts, helo
            )
        except Exception as exc:  # noqa: BLE001 - intentional catch-all for a sink
            message = unparseable_message(
                raw, envelope.mail_from, rcpts, helo, str(exc)
            )
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
