from mailhedgehog.parser import get_mime_part, parse
from tests import sample_emails as s


def test_alternative_has_two_parts():
    m = parse(s.MULTIPART_ALTERNATIVE, "a@x.test", ["b@x.test"], "h")
    parts = m["MIME"]["Parts"]
    assert len(parts) == 2
    assert parts[0]["Headers"]["Content-Type"] == ["text/plain; charset=utf-8"]
    assert parts[0]["Body"] == "plain part"
    assert parts[1]["Body"] == "<p>html part</p>"
    assert parts[0]["MIME"] is None


def test_single_part_has_no_mime_tree():
    m = parse(s.ASCII, "a@x.test", ["b@x.test"], "h")
    assert m["MIME"] is None


def test_attachment_part_size_is_decoded_length():
    m = parse(s.MULTIPART_ATTACHMENT, "a@x.test", ["b@x.test"], "h")
    attachment = m["MIME"]["Parts"][1]
    # base64 "AAECAwQF" decodes to 6 bytes.
    assert attachment["Size"] == 6
    assert attachment["Headers"]["Content-Disposition"] == [
        'attachment; filename="hi.bin"'
    ]


def test_nested_multipart_recurses():
    m = parse(s.NESTED_MULTIPART, "a@x.test", ["b@x.test"], "h")
    outer = m["MIME"]["Parts"]
    assert len(outer) == 1
    inner = outer[0]["MIME"]["Parts"]
    assert len(inner) == 2
    assert inner[0]["Body"] == "inner plain"


def test_get_mime_part_returns_decoded_bytes_type_and_filename():
    content, content_type, filename = get_mime_part(s.MULTIPART_ATTACHMENT, 1)
    assert content == bytes([0, 1, 2, 3, 4, 5])
    assert content_type == "application/octet-stream"
    assert filename == "hi.bin"


def test_get_mime_part_out_of_range_returns_none():
    assert get_mime_part(s.MULTIPART_ATTACHMENT, 99) is None
    assert get_mime_part(s.ASCII, 0) is None
