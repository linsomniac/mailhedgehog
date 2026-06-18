from mailhedgehog.storage import MessageStore


def _msg(
    msg_id,
    raw_from="a@x.test",
    raw_to="b@x.test",
    data="hello",
    subject: str | None = None,
    display_from: str | None = None,
    display_to: str | None = None,
):
    mailbox_from, domain_from = raw_from.split("@")
    mailbox_to, domain_to = raw_to.split("@")
    headers: dict = {}
    if subject is not None:
        headers["Subject"] = [subject]
    return {
        "ID": msg_id,
        "From": {
            "Mailbox": mailbox_from,
            "Domain": domain_from,
            "Params": "",
            "Relays": None,
        },
        "To": [
            {
                "Mailbox": mailbox_to,
                "Domain": domain_to,
                "Params": "",
                "Relays": None,
            }
        ],
        "Raw": {"From": raw_from, "To": [raw_to], "Helo": "h", "Data": data},
        "Content": {"Headers": headers, "Body": "", "Size": 0, "MIME": None},
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
    msg1 = _msg("id1", raw_from="alice@a.test", raw_to="bob@b.test", data="hello alice")
    msg2 = _msg("id2", raw_from="carol@c.test", raw_to="dave@d.test", data="hi dave")
    store.add(msg1, b"x")
    store.add(msg2, b"y")
    result = [m["ID"] for m in store.search("from", "alice", 0, 10)[0]]
    assert result == ["id1"]
    result = [m["ID"] for m in store.search("to", "dave", 0, 10)[0]]
    assert result == ["id2"]
    result = [m["ID"] for m in store.search("containing", "hello", 0, 10)[0]]
    assert result == ["id1"]
    assert store.search("containing", "nomatch", 0, 10)[1] == 0


# ---------------------------------------------------------------------------
# New tests: subject search, metadata search, casefolded matching, RFC 2047
# ---------------------------------------------------------------------------


def test_search_subject_encoded_word():
    """Search kind='subject' finds a message whose Subject is RFC 2047 encoded."""
    store = MessageStore(max_messages=10, max_bytes=1_000_000)
    msg = _msg("id1", subject="=?UTF-8?B?Y2Fmw6k=?=")  # "café"
    store.add(msg, b"raw")
    # Exact match
    result, total = store.search("subject", "café", 0, 10)
    assert total == 1
    assert result[0]["ID"] == "id1"
    # Case-insensitive match
    result, total = store.search("subject", "CAFÉ", 0, 10)
    assert total == 1
    # No match
    result, total = store.search("subject", "banana", 0, 10)
    assert total == 0


def test_search_subject_plain():
    """Search kind='subject' on a plain (non-encoded) subject."""
    store = MessageStore(max_messages=10, max_bytes=1_000_000)
    msg = _msg("id1", subject="Hello World")
    store.add(msg, b"raw")
    result, total = store.search("subject", "hello", 0, 10)
    assert total == 1
    result, total = store.search("subject", "WORLD", 0, 10)
    assert total == 1


def test_search_subject_missing_header():
    """Messages without a Subject header must not crash and must not match."""
    store = MessageStore(max_messages=10, max_bytes=1_000_000)
    # subject=None means no Subject key in headers
    msg = _msg("id1")
    store.add(msg, b"raw")
    result, total = store.search("subject", "anything", 0, 10)
    assert total == 0


def test_search_metadata_matches_subject():
    store = MessageStore(max_messages=10, max_bytes=1_000_000)
    msg = _msg("id1", subject="Important Newsletter")
    store.add(msg, b"raw")
    result, total = store.search("metadata", "newsletter", 0, 10)
    assert total == 1


def test_search_metadata_matches_from():
    store = MessageStore(max_messages=10, max_bytes=1_000_000)
    msg = _msg("id1", raw_from="alice@example.com")
    store.add(msg, b"raw")
    result, total = store.search("metadata", "alice", 0, 10)
    assert total == 1


def test_search_metadata_matches_to():
    store = MessageStore(max_messages=10, max_bytes=1_000_000)
    msg = _msg("id1", raw_to="bob@example.com")
    store.add(msg, b"raw")
    result, total = store.search("metadata", "bob", 0, 10)
    assert total == 1


def test_search_metadata_no_match():
    store = MessageStore(max_messages=10, max_bytes=1_000_000)
    msg = _msg("id1", subject="Hello", raw_from="alice@a.test", raw_to="bob@b.test")
    store.add(msg, b"raw")
    result, total = store.search("metadata", "nomatch", 0, 10)
    assert total == 0


def test_search_composed_vs_decomposed_normalization():
    """NFC normalization allows composed and decomposed forms to match."""
    import unicodedata

    store = MessageStore(max_messages=10, max_bytes=1_000_000)

    # Message 1: subject in DECOMPOSED form (NFD): e + combining acute
    decomposed = unicodedata.normalize("NFD", "café")
    msg1 = _msg("id1", subject=decomposed)
    store.add(msg1, b"raw1")

    # Message 2: subject in COMPOSED form (NFC): é as single codepoint
    composed = unicodedata.normalize("NFC", "café")
    msg2 = _msg("id2", subject=composed)
    store.add(msg2, b"raw2")

    # Verify they are genuinely different byte representations
    assert decomposed != composed, "Test setup: decomposed and composed must differ"

    # Search with COMPOSED query finds the DECOMPOSED stored subject
    result, total = store.search("subject", composed, 0, 10)
    assert total == 2, f"Composed query should find both messages; got {total}"
    assert any(m["ID"] == "id1" for m in result), "Should find decomposed message"
    assert any(m["ID"] == "id2" for m in result), "Should find composed message"

    # Search with DECOMPOSED query also finds the COMPOSED stored subject
    result, total = store.search("subject", decomposed, 0, 10)
    assert total == 2, f"Decomposed query should find both messages; got {total}"

    # Case-insensitive match also works across forms
    result, total = store.search("subject", "CAFÉ", 0, 10)
    assert total == 2, "Case-insensitive search should find both forms"


def test_search_from_case_insensitive():
    """kind='from' search is now case-insensitive via casefold."""
    store = MessageStore(max_messages=10, max_bytes=1_000_000)
    msg = _msg("id1", raw_from="Alice@Example.COM")
    store.add(msg, b"raw")
    result, total = store.search("from", "alice@example.com", 0, 10)
    assert total == 1


def test_search_to_case_insensitive():
    """kind='to' search is now case-insensitive via casefold."""
    store = MessageStore(max_messages=10, max_bytes=1_000_000)
    msg = _msg("id1", raw_to="Bob@Example.COM")
    store.add(msg, b"raw")
    result, total = store.search("to", "bob@example.com", 0, 10)
    assert total == 1


def test_search_containing_still_works_case_insensitive():
    """kind='containing' on-demand search still works."""
    store = MessageStore(max_messages=10, max_bytes=1_000_000)
    msg = _msg("id1", data="Hello World")
    store.add(msg, b"raw")
    result, total = store.search("containing", "HELLO", 0, 10)
    assert total == 1


def test_subject_headers_stay_raw():
    """Content.Headers must not be mutated — they stay in raw RFC 2047 form."""
    store = MessageStore(max_messages=10, max_bytes=1_000_000)
    raw_subject = "=?UTF-8?B?Y2Fmw6k=?="
    msg = _msg("id1", subject=raw_subject)
    store.add(msg, b"raw")
    retrieved = store.get("id1")
    assert retrieved is not None
    assert retrieved["Content"]["Headers"]["Subject"][0] == raw_subject
