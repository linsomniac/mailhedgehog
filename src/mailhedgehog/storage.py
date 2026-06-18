"""Bounded in-memory message storage (count + total-byte caps)."""

from __future__ import annotations

import unicodedata
from builtins import list as list_builtin
from dataclasses import dataclass

from mailhedgehog.parser import Message, decode_header_value

# Type alias to shorten return types
SearchResult = tuple[list_builtin[Message], int]

# AIDEV-NOTE: allow-list of supported search kinds. Validated in search() and web.py.
# Unknown kinds raise ValueError rather than silently falling back to an expensive scan.
KNOWN_SEARCH_KINDS: frozenset[str] = frozenset(
    {"from", "to", "containing", "subject", "metadata"}
)


def _nfc_fold(text: str) -> str:
    """Casefold and NFC-normalize text for search comparison."""
    return unicodedata.normalize("NFC", text.casefold())


@dataclass
class _SearchCache:
    """Precomputed casefolded+NFC search blobs for a message."""

    subject: str
    frm: str
    to: str
    metadata: str  # subject + frm + to combined


@dataclass
class _Entry:
    message: Message
    raw: bytes
    size: int
    # AIDEV-NOTE: search cache is built once at add() time and dropped automatically
    # when the entry is evicted. It precomputes casefolded+NFC text for subject,
    # from, to, and metadata fields so search is O(1) per field per message.
    search: _SearchCache


def _addr_text(addr: dict[str, object]) -> str:
    return f"{addr['Mailbox']}@{addr['Domain']}"


def _build_search_cache(message: Message) -> _SearchCache:
    """Build the per-entry casefolded+NFC search cache from a parsed message."""
    # Subject: decode RFC 2047 encoded-word, guard missing/empty header.
    headers: dict[str, list[str]] = message.get("Content", {}).get("Headers", {})
    raw_subjects = headers.get("Subject", [])
    subject_text = decode_header_value(raw_subjects[0]) if raw_subjects else ""
    subject = _nfc_fold(subject_text)

    # From: raw SMTP From + decoded display name from Raw.From + parsed addr text.
    raw_from: str = message.get("Raw", {}).get("From", "")
    parsed_from: dict[str, object] = message.get("From", {})
    # decode_header_value handles encoded display names in raw_from gracefully
    from_parts = [raw_from, decode_header_value(raw_from), _addr_text(parsed_from)]
    frm = _nfc_fold(" ".join(from_parts))

    # To: raw SMTP To list + decoded display names + parsed addr texts.
    raw_tos: list[str] = message.get("Raw", {}).get("To", [])
    parsed_tos: list[dict[str, object]] = message.get("To", [])
    to_parts: list[str] = list(raw_tos)
    for raw_to in raw_tos:
        to_parts.append(decode_header_value(raw_to))
    for addr in parsed_tos:
        to_parts.append(_addr_text(addr))
    to = _nfc_fold(" ".join(to_parts))

    metadata = subject + " " + frm + " " + to
    return _SearchCache(subject=subject, frm=frm, to=to, metadata=metadata)


class MessageStore:
    def __init__(self, max_messages: int, max_bytes: int) -> None:
        self.max_messages = max_messages
        self.max_bytes = max_bytes
        self._entries: dict[str, _Entry] = {}  # insertion order: oldest -> newest
        # AIDEV-NOTE: _order mirrors the insertion order of _entries (oldest first).
        # It enables O(limit) newest-first paging via a reverse slice without building
        # a full reversed list on each request. Must be kept in sync with _entries.
        self._order: list_builtin[str] = []
        self._total_bytes = 0

    def __len__(self) -> int:
        return len(self._entries)

    @property
    def total_bytes(self) -> int:
        return self._total_bytes

    def add(self, message: Message, raw: bytes) -> None:
        search = _build_search_cache(message)
        entry = _Entry(message=message, raw=raw, size=len(raw), search=search)
        msg_id = message["ID"]
        self._entries[msg_id] = entry
        self._order.append(msg_id)
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
        # AIDEV-NOTE: _order[0] is the oldest message and authoritative oldest id.
        # Pop from _order first, then use that id for dict + byte accounting to ensure
        # _entries and _order stay in sync. Do not reintroduce next(iter(_entries)).
        oldest_id = self._order.pop(0)
        self._total_bytes -= self._entries.pop(oldest_id).size

    def get(self, msg_id: str) -> Message | None:
        entry = self._entries.get(msg_id)
        return entry.message if entry else None

    def get_raw(self, msg_id: str) -> bytes | None:
        entry = self._entries.get(msg_id)
        return entry.raw if entry else None

    def list(self, start: int, limit: int) -> SearchResult:
        """Return (items, total) newest-first in O(limit) time.

        Uses a reverse slice of _order so no full list reversal is needed.
        start is clamped to >= 0 by the caller (web.py) but also guarded here.
        """
        total = len(self._order)
        start = max(start, 0)
        if start >= total:
            return [], total
        # _order is oldest-first. Newest-first page at offset `start`:
        #   The newest is at index total-1, so page starts at total-1-start
        #   and goes back `limit` items.
        hi = total - start  # exclusive upper bound in _order (oldest-first)
        lo = max(0, hi - limit)  # inclusive lower bound
        ids = self._order[lo:hi][::-1]  # slice then reverse → newest-first, O(limit)
        return [self._entries[i].message for i in ids], total

    def search(self, kind: str, query: str, start: int, limit: int) -> SearchResult:
        """Return (items, total) for kind/query, newest-first. Validates kind first."""
        if kind not in KNOWN_SEARCH_KINDS:
            raise ValueError(f"unknown search kind: {kind!r}")
        needle = _nfc_fold(query)
        # AIDEV-NOTE: search() is called via asyncio.to_thread, so it runs concurrently
        # with the event loop, which may call add()/delete()/clear() on _entries/_order.
        # Taking a snapshot with list(_order) is a single GIL-atomic copy, giving us a
        # consistent view of the id sequence. Using .get() instead of direct dict access
        # then safely skips any ids evicted between snapshot time and lookup time.
        # This is what makes search thread-safe against concurrent eviction without a
        # lock.
        matches = []
        for i in reversed(list(self._order)):
            entry = self._entries.get(i)
            if entry is not None and self._matches(entry, kind, needle):
                matches.append(entry.message)
        start = max(start, 0)
        return matches[start : start + limit], len(matches)

    @staticmethod
    def _matches(entry: _Entry, kind: str, needle: str) -> bool:
        sc = entry.search
        if kind == "from":
            return needle in sc.frm
        if kind == "to":
            return needle in sc.to
        if kind == "subject":
            return needle in sc.subject
        if kind == "metadata":
            return needle in sc.metadata
        # "containing": on-demand, not cached (body can be large)
        hay = _nfc_fold(entry.message["Raw"]["Data"])
        return needle in hay

    def delete(self, msg_id: str) -> bool:
        entry = self._entries.pop(msg_id, None)
        if entry is None:
            return False
        self._total_bytes -= entry.size
        self._order.remove(msg_id)
        return True

    def clear(self) -> None:
        self._entries.clear()
        self._order = []
        self._total_bytes = 0
