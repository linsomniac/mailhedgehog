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
