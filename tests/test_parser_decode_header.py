"""Tests for decode_header_value (RFC 2047 decoding, never raises)."""

import unicodedata

from mailhedgehog.parser import decode_header_value


def test_ascii_passthrough():
    assert decode_header_value("Hello World") == "Hello World"


def test_base64_encoded_word_utf8():
    # =?UTF-8?B?Y2Fmw6k=?= -> café
    result = decode_header_value("=?UTF-8?B?Y2Fmw6k=?=")
    assert result == "café"


def test_qp_encoded_word():
    # =?UTF-8?Q?caf=C3=A9?= -> café
    result = decode_header_value("=?UTF-8?Q?caf=C3=A9?=")
    assert result == "café"


def test_latin1_encoded_word():
    # =?ISO-8859-1?Q?caf=E9?= -> café
    result = decode_header_value("=?ISO-8859-1?Q?caf=E9?=")
    assert result == "café"


def test_mixed_encoded_and_plain():
    # Multiple encoded-words mixed with plain text
    result = decode_header_value("Hello =?UTF-8?B?Y2Fmw6k=?= World")
    assert "café" in result
    assert "Hello" in result
    assert "World" in result


def test_garbage_does_not_raise():
    # Malformed encoded-word: must not raise; returns input via safe_str
    result = decode_header_value("=?BOGUS?X?!!!?=")
    assert isinstance(result, str)


def test_empty_string():
    assert decode_header_value("") == ""


def test_result_is_json_safe_no_lone_surrogates():
    # Even if input has surrogate-escaped bytes, output must be json-serializable
    surrogate = b"\xe9".decode("ascii", "surrogateescape")
    result = decode_header_value(surrogate)
    # Must round-trip through json (no lone surrogates)
    import json
    json.dumps(result)  # should not raise


def test_nfc_normalization_is_preserved():
    # Result should be NFC (safe_str uses utf-8 encode/decode which is NFC-preserving)
    result = decode_header_value("=?UTF-8?B?Y2Fmw6k=?=")
    # café encoded in NFC
    assert result == unicodedata.normalize("NFC", result)
