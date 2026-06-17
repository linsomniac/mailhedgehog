"""Bounded in-memory message storage (count + total-byte caps)."""

from __future__ import annotations

from builtins import list as list_builtin
from dataclasses import dataclass

from mailhedgehog.parser import Message

# Type alias to shorten return types
SearchResult = tuple[list_builtin[Message], int]


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

    def list(self, start: int, limit: int) -> SearchResult:
        entries = self._newest_first()
        start = max(start, 0)
        page = entries[start : start + limit]
        return [e.message for e in page], len(entries)

    def search(self, kind: str, query: str, start: int, limit: int) -> SearchResult:
        needle = query.lower()
        matches = [
            e.message
            for e in self._newest_first()
            if self._matches(e.message, kind, needle)
        ]
        start = max(start, 0)
        return matches[start : start + limit], len(matches)

    @staticmethod
    def _matches(message: Message, kind: str, needle: str) -> bool:
        if kind == "from":
            hay = f"{message['Raw']['From']} {_addr_text(message['From'])}"
        elif kind == "to":
            raw_tos = " ".join(message["Raw"]["To"])
            parsed_tos = " ".join(_addr_text(a) for a in message["To"])
            hay = raw_tos + " " + parsed_tos
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
