import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from mailhedgehog.fetcher import FetchError, fetch_remote_image, is_public_ip

# A 1x1 PNG.
PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108020000009077"
    "53de0000000c4944415408d76360000000020001e221bc330000000049454e44ae426082"
)

# AIDEV-NOTE: permissive policy used by happy-path tests so the real fetch path
# can run against the loopback test server. The DEFAULT policy (is_public_ip)
# blocks loopback, which is exercised separately.
ALLOW_LOOPBACK = lambda ip: ip in {"127.0.0.1", "::1"}  # noqa: E731


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # silence test server logging
        pass

    def do_GET(self):
        if self.path == "/img.png":
            self._send(200, "image/png", PNG)
        elif self.path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "/img.png")
            self.end_headers()
        elif self.path == "/redirect-evil":
            self.send_response(302)
            # cloud-metadata address: must be rejected on the next hop
            self.send_header("Location", "http://169.254.169.254/latest/")
            self.end_headers()
        elif self.path == "/big":
            self._send(200, "image/png", b"\x00" * 5000)
        elif self.path == "/notimage":
            self._send(200, "text/html", b"<h1>nope</h1>")
        elif self.path == "/svg":
            self._send(200, "image/svg+xml", b"<svg></svg>")
        else:
            self._send(404, "text/plain", b"nope")

    def _send(self, code, ctype, body):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


@pytest.fixture
def server():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


@pytest.mark.parametrize(
    "ip,expected",
    [
        ("8.8.8.8", True),
        ("1.1.1.1", True),
        ("127.0.0.1", False),
        ("10.0.0.1", False),
        ("192.168.1.5", False),
        ("172.16.0.1", False),
        ("169.254.169.254", False),
        ("::1", False),
        ("fc00::1", False),
        ("not-an-ip", False),
    ],
)
def test_is_public_ip(ip, expected):
    assert is_public_ip(ip) is expected


def test_fetch_happy_path(server):
    data, ctype = fetch_remote_image(
        f"{server}/img.png",
        max_bytes=1_000_000,
        timeout=5,
        max_redirects=5,
        is_ip_allowed=ALLOW_LOOPBACK,
    )
    assert data == PNG
    assert ctype == "image/png"


def test_fetch_follows_redirect(server):
    data, ctype = fetch_remote_image(
        f"{server}/redirect",
        max_bytes=1_000_000,
        timeout=5,
        max_redirects=5,
        is_ip_allowed=ALLOW_LOOPBACK,
    )
    assert data == PNG


def test_fetch_redirect_to_blocked_ip_rejected(server):
    # First hop (loopback) allowed; redirect target 169.254.169.254 is not in the
    # permissive set, so the second hop is rejected.
    with pytest.raises(FetchError):
        fetch_remote_image(
            f"{server}/redirect-evil",
            max_bytes=1_000_000,
            timeout=5,
            max_redirects=5,
            is_ip_allowed=ALLOW_LOOPBACK,
        )


def test_fetch_too_large(server):
    with pytest.raises(FetchError):
        fetch_remote_image(
            f"{server}/big",
            max_bytes=1000,
            timeout=5,
            max_redirects=5,
            is_ip_allowed=ALLOW_LOOPBACK,
        )


def test_fetch_non_image_rejected(server):
    with pytest.raises(FetchError):
        fetch_remote_image(
            f"{server}/notimage",
            max_bytes=1_000_000,
            timeout=5,
            max_redirects=5,
            is_ip_allowed=ALLOW_LOOPBACK,
        )


def test_fetch_svg_downgraded(server):
    data, ctype = fetch_remote_image(
        f"{server}/svg",
        max_bytes=1_000_000,
        timeout=5,
        max_redirects=5,
        is_ip_allowed=ALLOW_LOOPBACK,
    )
    assert ctype == "application/octet-stream"


def test_fetch_default_policy_blocks_loopback(server):
    # Default is_ip_allowed=is_public_ip blocks 127.0.0.1.
    with pytest.raises(FetchError):
        fetch_remote_image(
            f"{server}/img.png", max_bytes=1_000_000, timeout=5, max_redirects=5
        )


def test_fetch_rejects_non_http_scheme():
    with pytest.raises(FetchError):
        fetch_remote_image(
            "file:///etc/passwd", max_bytes=1000, timeout=5, max_redirects=5
        )


def test_fetch_redirect_cap(server):
    # max_redirects=0 means the single 302 cannot be followed.
    with pytest.raises(FetchError):
        fetch_remote_image(
            f"{server}/redirect",
            max_bytes=1_000_000,
            timeout=5,
            max_redirects=0,
            is_ip_allowed=ALLOW_LOOPBACK,
        )
