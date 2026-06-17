from email import message_from_bytes

from mailhedgehog.parser import extract_headers, parse_addr, safe_str


def test_safe_str_passes_ascii():
    assert safe_str("hello") == "hello"
    assert safe_str(b"hello") == "hello"


def test_safe_str_decodes_utf8_bytes():
    assert safe_str("café".encode()) == "café"


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
