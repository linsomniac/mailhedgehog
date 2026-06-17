"""Application wiring and entrypoint."""

from __future__ import annotations

from quart import Quart

from mailhedgehog.config import Config
from mailhedgehog.storage import MessageStore
from mailhedgehog.web import create_app


def build() -> tuple[Config, Quart]:
    config = Config.from_env()
    store = MessageStore(config.max_messages, config.max_bytes)
    return config, create_app(config, store)


def main() -> None:
    config, app = build()
    app.run(
        host=config.http_host,
        port=config.http_port,
        debug=config.debug,
        certfile=config.tls_cert,
        keyfile=config.tls_key,
    )


if __name__ == "__main__":
    main()
