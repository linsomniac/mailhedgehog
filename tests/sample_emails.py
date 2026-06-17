"""Raw email byte corpus shared across parser and web tests."""

ASCII = (
    b"From: alice@example.com\r\n"
    b"To: bob@example.com\r\n"
    b"Subject: Plain hello\r\n"
    b"\r\n"
    b"Hello, world.\r\n"
)

UTF8_8BIT = (
    b"From: a@x.test\r\n"
    b"To: b@x.test\r\n"
    b"Subject: utf8\r\n"
    b"Content-Type: text/plain; charset=utf-8\r\n"
    b"Content-Transfer-Encoding: 8bit\r\n"
    b"\r\n"
    b"caf\xc3\xa9 \xe2\x98\x83\r\n"
)

LATIN1_8BIT = (
    b"From: a@x.test\r\n"
    b"To: b@x.test\r\n"
    b"Subject: latin1\r\n"
    b"Content-Type: text/plain; charset=iso-8859-1\r\n"
    b"Content-Transfer-Encoding: 8bit\r\n"
    b"\r\n"
    b"caf\xe9\r\n"
)

BASE64_BODY = (
    b"From: a@x.test\r\n"
    b"To: b@x.test\r\n"
    b"Subject: b64\r\n"
    b"Content-Type: text/plain; charset=utf-8\r\n"
    b"Content-Transfer-Encoding: base64\r\n"
    b"\r\n"
    b"Y2Fmw6kK\r\n"
)

RFC2047_SUBJECT = (
    b"From: a@x.test\r\nTo: b@x.test\r\nSubject: =?UTF-8?B?Y2Fmw6k=?=\r\n\r\nbody\r\n"
)

MISSING_FROM = b"To: b@x.test\r\nSubject: no from\r\n\r\nbody\r\n"

MULTIPART_ALTERNATIVE = (
    b"From: a@x.test\r\n"
    b"To: b@x.test\r\n"
    b"Subject: alt\r\n"
    b'Content-Type: multipart/alternative; boundary="BB"\r\n'
    b"\r\n"
    b"--BB\r\n"
    b"Content-Type: text/plain; charset=utf-8\r\n"
    b"\r\n"
    b"plain part\r\n"
    b"--BB\r\n"
    b"Content-Type: text/html; charset=utf-8\r\n"
    b"\r\n"
    b"<p>html part</p>\r\n"
    b"--BB--\r\n"
)

MULTIPART_ATTACHMENT = (
    b"From: a@x.test\r\n"
    b"To: b@x.test\r\n"
    b"Subject: attach\r\n"
    b'Content-Type: multipart/mixed; boundary="MM"\r\n'
    b"\r\n"
    b"--MM\r\n"
    b"Content-Type: text/plain; charset=utf-8\r\n"
    b"\r\n"
    b"see attachment\r\n"
    b"--MM\r\n"
    b"Content-Type: application/octet-stream\r\n"
    b"Content-Transfer-Encoding: base64\r\n"
    b'Content-Disposition: attachment; filename="hi.bin"\r\n'
    b"\r\n"
    b"AAECAwQF\r\n"
    b"--MM--\r\n"
)

NESTED_MULTIPART = (
    b"From: a@x.test\r\n"
    b"To: b@x.test\r\n"
    b"Subject: nested\r\n"
    b'Content-Type: multipart/mixed; boundary="OUT"\r\n'
    b"\r\n"
    b"--OUT\r\n"
    b'Content-Type: multipart/alternative; boundary="IN"\r\n'
    b"\r\n"
    b"--IN\r\n"
    b"Content-Type: text/plain\r\n"
    b"\r\n"
    b"inner plain\r\n"
    b"--IN\r\n"
    b"Content-Type: text/html\r\n"
    b"\r\n"
    b"<p>inner html</p>\r\n"
    b"--IN--\r\n"
    b"--OUT--\r\n"
)

GARBAGE = b"\x00\x01\x02 not even close to an email \xff\xfe"

MULTIPART_EVIL_FILENAME = (
    b"From: a@x.test\r\n"
    b"To: b@x.test\r\n"
    b"Subject: evil-filename\r\n"
    b'Content-Type: multipart/mixed; boundary="EE"\r\n'
    b"\r\n"
    b"--EE\r\n"
    b"Content-Type: text/plain; charset=utf-8\r\n"
    b"\r\n"
    b"see attachment\r\n"
    b"--EE\r\n"
    b"Content-Type: application/octet-stream\r\n"
    b"Content-Transfer-Encoding: base64\r\n"
    b"Content-Disposition: attachment;"
    b" filename*=UTF-8''bad%0D%0Aname.bin\r\n"
    b"\r\n"
    b"SGVsbG8=\r\n"
    b"--EE--\r\n"
)
