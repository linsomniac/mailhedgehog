from datetime import datetime

from mailhedgehog.parser import parse
from tests import sample_emails as s


def test_basic_structure():
    m = parse(s.ASCII, "alice@example.com", ["bob@example.com"], "helo.test")
    assert m["ID"].endswith("@mailhedgehog.example")
    assert m["From"] == {
        "Mailbox": "alice",
        "Domain": "example.com",
        "Params": "",
        "Relays": None,
    }
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
