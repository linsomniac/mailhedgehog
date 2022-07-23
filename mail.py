#!/usr/bin/env python3

import time
import datetime
from email.utils import parseaddr
from email import message_from_bytes
from uuid import uuid4


def format_message(session, envelope):
    def iso_time():
        utc_offset_sec = time.altzone if time.localtime().tm_isdst else time.timezone
        utc_offset = datetime.timedelta(seconds=-utc_offset_sec)
        return datetime.datetime.now().replace(
            tzinfo=datetime.timezone(offset=utc_offset)).isoformat()

    def format_address(addr):
        realname, email = parseaddr(addr)
        lhs, rhs = email.split('@')
        return {
            'Domain': rhs,
            'Mailbox': lhs,
            'Params': '',
            'Relays': None,
        }

    data = message_from_bytes(envelope.content)
    return {
        'Content': {
            'Headers': dict({x: [y] for (x, y) in data.items()}),
            'Body': data.get_payload(),
            'MIME': None,
            'Size': len(envelope.content),
            },
        'Created': iso_time(),
        'From': format_address(data['From']),
        'ID': str(uuid4()) + '@mailweasel.example',
        'To': [format_address(data['To'])],
        'Raw': {
            'Data': envelope.content.decode(),
            'From': envelope.mail_from,
            'To': envelope.rcpt_tos,
            'Helo': session.host_name,
        }
    }
