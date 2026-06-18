"""SSRF-guarded fetch of remote images for the optional image proxy.

Standard library only — no new runtime dependencies. The public entry point is
fetch_remote_image(); it validates the URL scheme, refuses hosts that resolve to
internal/private addresses, follows redirects manually (re-validating each hop),
caps the response size, and requires an image/* content-type.
"""

from __future__ import annotations

import ipaddress
import socket
import urllib.error
import urllib.request
from collections.abc import Callable
from urllib.parse import urljoin, urlsplit

# AIDEV-NOTE: SECURITY-CRITICAL module. fetch_remote_image() is reachable from
# untrusted email content (the proxy rewrites email <img> URLs to it). Every
# hop's host is resolved and checked against is_ip_allowed BEFORE connecting.
# Residual risk: a small TOCTOU window exists because urllib re-resolves the host
# at connect time (DNS rebinding). Accepted for an operator-opted-in internal sink.

_ALLOWED_SCHEMES = {"http", "https"}
_CHUNK = 65536


class FetchError(Exception):
    """A remote image could not be safely fetched. Carries no sensitive detail."""


def is_public_ip(ip: str) -> bool:
    """Return True only for globally-routable unicast addresses.

    False for loopback, private (RFC1918 / ULA), link-local, multicast,
    reserved, and unspecified addresses — anything the proxy must not be tricked
    into fetching from an internal network (incl. cloud metadata 169.254.169.254).
    """
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return not (
        addr.is_loopback
        or addr.is_private
        or addr.is_link_local
        or addr.is_multicast
        or addr.is_reserved
        or addr.is_unspecified
    )


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Disable urllib's automatic redirect following.

    Returning None from redirect_request makes urllib raise HTTPError for a 3xx,
    which we catch and follow manually so each hop can be re-validated.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        return None


def _check_host(host: str, port: int, is_ip_allowed: Callable[[str], bool]) -> None:
    """Raise FetchError unless every address the host resolves to is allowed."""
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        raise FetchError("dns resolution failed") from exc
    if not infos:
        raise FetchError("host did not resolve")
    for info in infos:
        ip = str(info[4][0])
        if not is_ip_allowed(ip):
            raise FetchError("host resolves to a disallowed address")


def fetch_remote_image(
    url: str,
    *,
    max_bytes: int,
    timeout: float,
    max_redirects: int,
    is_ip_allowed: Callable[[str], bool] = is_public_ip,
) -> tuple[bytes, str]:
    """Fetch a remote image safely.

    Returns (content_bytes, safe_content_type). Raises FetchError on a disallowed
    scheme/host, redirect to a disallowed host, too many redirects, network
    error, non-image content-type, or a body exceeding max_bytes.
    """
    opener = urllib.request.build_opener(_NoRedirect)
    current = url
    for _ in range(max_redirects + 1):
        parts = urlsplit(current)
        if parts.scheme not in _ALLOWED_SCHEMES:
            raise FetchError("scheme not allowed")
        host = parts.hostname
        if not host:
            raise FetchError("missing host")
        port = parts.port or (443 if parts.scheme == "https" else 80)
        _check_host(host, port, is_ip_allowed)

        req = urllib.request.Request(
            current, headers={"User-Agent": "mailhedgehog-image-proxy"}
        )
        try:
            resp = opener.open(req, timeout=timeout)
            status = resp.status
        except urllib.error.HTTPError as exc:
            # 3xx surfaces here because _NoRedirect declined to follow it.
            if 300 <= exc.code < 400:
                location = exc.headers.get("Location")
                exc.close()
                if not location:
                    raise FetchError("redirect without location") from exc
                current = urljoin(current, location)
                continue
            exc.close()
            raise FetchError("unexpected status") from exc
        except OSError as exc:
            raise FetchError("fetch failed") from exc

        try:
            if status != 200:
                raise FetchError("unexpected status")
            ctype = (
                (resp.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            )
            if not ctype.startswith("image/"):
                raise FetchError("not an image")
            data = bytearray()
            while True:
                chunk = resp.read(_CHUNK)
                if not chunk:
                    break
                data.extend(chunk)
                if len(data) > max_bytes:
                    raise FetchError("image too large")
        finally:
            resp.close()

        # AIDEV-NOTE: SVG can carry script; mirror the cid endpoint and serve it
        # as octet-stream so it can never render as active content.
        safe_type = "application/octet-stream" if ctype == "image/svg+xml" else ctype
        return bytes(data), safe_type

    raise FetchError("too many redirects")
