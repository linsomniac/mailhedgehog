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

Using Python3/pip:

* Clone this repo
* pip install -r requirements.txt
* python3 mailhedgehog
* Open a browser to: http://127.0.0.1:8025/
* Send an e-mail to SMTP port 1025

### MailHedgehog Features

* This uses a simple FIFO memory storage.
* It is very simple and readable, ~140 lines of Python.
* It is an asyncio Python3 app.
* It includes H2 support.
* It makes a good Python Quart example.
* Can run as a Docker container.

### Anti-features

* No authentication
* No persistent storage of messages

### Licence

Portions Copyright (c) 2014 - 2017, Ian Kent (http://iankent.uk)

Released under MIT license, see [LICENSE](LICENSE.md) for details.
