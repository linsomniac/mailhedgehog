MailHedgehog
============

A Python rewrite of the [MailHog](https://github.com/mailhog/MailHog) backend.

### Overview

MailHedgehog is a "SMTP sink" server for development use with a web-based UI
for viewing messages.  For example, in your development or staging
environment, set up MailHedgehog as the SMTP server, and you can view the
messages via a web interface.

### Quickstart

Using Docker:

* Clone this repo.
* Run: docker build -t mailhedgehog .
* Run: docker run -p 1025:1025 -p 8025:8025 -it --name mailhedgehog mailhedgehog
* Open a browser to: http://127.0.0.1:8025/
* Send an e-mail to SMTP port 1025

Using Python 3 / uv:

* Clone this repo
* uv run mailhedgehog
* Open a browser to: http://127.0.0.1:8025/
* Send an e-mail to SMTP port 1025

### MailHedgehog Features

* In-memory SMTP sink — messages are never relayed.
* Bounded storage: auto-expires by message count and total size.
* Web UI for viewing received messages.
* JSON/WebSocket API compatible with the original MailHog.
* asyncio Python 3 app built on [Quart](https://quart.palletsprojects.com/).
* Can run as a Docker container.

### Anti-features

* No authentication
* No persistent storage of messages (in-memory, auto-expired by count and total size)
* No message release / outgoing relay (it is a sink)

### Configuration

All settings are controlled via environment variables:

| Variable              | Default      | Description                                      |
|-----------------------|--------------|--------------------------------------------------|
| `MH_SMTP_HOST`        | `""` (all)   | SMTP bind address                                |
| `MH_SMTP_PORT`        | `1025`       | SMTP port                                        |
| `MH_HTTP_HOST`        | `""` (all)   | HTTP bind address                                |
| `MH_HTTP_PORT`        | `8025`       | HTTP port                                        |
| `MH_MAX_MESSAGES`     | `100`        | Maximum number of messages to keep in memory     |
| `MH_MAX_BYTES`        | `52428800`   | Total storage cap in bytes (default 50 MiB)      |
| `MH_MAX_MESSAGE_SIZE` | `26214400`   | Per-message size limit in bytes (default 25 MiB) |
| `MH_WS_QUEUE_SIZE`    | `256`        | WebSocket broadcast queue depth per client       |
| `MH_DEBUG`            | `false`      | Enable Quart debug mode                          |
| `MH_TLS_CERT`         | *(unset)*    | Path to TLS certificate file (optional)          |
| `MH_TLS_KEY`          | *(unset)*    | Path to TLS private key file (optional)          |

The Docker image additionally sets `MH_HTTP_HOST=0.0.0.0` and
`MH_SMTP_HOST=0.0.0.0` so both servers bind on all interfaces by default.

### Licence

Portions Copyright (c) 2014 - 2017, Ian Kent (http://iankent.uk)

Released under MIT license, see [LICENSE](LICENSE.md) for details.
