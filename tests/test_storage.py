from mailhedgehog.storage import MessageStore


def _msg(msg_id, raw_from="a@x.test", raw_to="b@x.test", data="hello"):
    mailbox_from, domain_from = raw_from.split("@")
    mailbox_to, domain_to = raw_to.split("@")
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
