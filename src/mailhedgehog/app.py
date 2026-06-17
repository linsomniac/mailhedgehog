"""Application wiring and entrypoint."""

from __future__ import annotations

import asyncio

from hypercorn.asyncio import serve
from hypercorn.config import Config as HyperConfig
from quart import Quart

from mailhedgehog.config import Config
from mailhedgehog.storage import MessageStore
from mailhedgehog.web import create_app


def build() -> tuple[Config, Quart]:
    config = Config.from_env()
    store = MessageStore(config.max_messages, config.max_bytes)
    return config, create_app(config, store)


def build_hypercorn_config(config: Config) -> HyperConfig:
    # AIDEV-NOTE: serve via hypercorn directly (not Quart's dev server). This is
    # the only way to set websocket_ping_interval (Quart.run ignores kwargs) and
    # is the production-correct ASGI server. websocket_ping_interval emits
    # protocol PING frames so idle connections survive proxy/LB idle timeouts and
    # dead peers are detected; the browser auto-PONGs (invisible to the frontend).
    # <= 0 disables the heartbeat. Mirrors Quart.run_task's bind/tls/log wiring.
    hcfg = HyperConfig()
    hcfg.bind = [f"{config.http_host or '127.0.0.1'}:{config.http_port}"]
    hcfg.accesslog = "-"
    hcfg.errorlog = "-"
    hcfg.certfile = config.tls_cert
    hcfg.keyfile = config.tls_key
    hcfg.websocket_ping_interval = (
        config.ws_ping_interval if config.ws_ping_interval > 0 else None
    )
    return hcfg


def main() -> None:
    config, app = build()
    app.debug = config.debug
    # AIDEV-NOTE: no shutdown_trigger -> hypercorn installs SIGINT/SIGTERM
    # handlers itself, so `docker stop` triggers a graceful ASGI lifespan
    # shutdown (Quart after_serving -> SMTP server cleanup in web.py).
    asyncio.run(serve(app, build_hypercorn_config(config)))


if __name__ == "__main__":
    main()
