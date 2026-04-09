"""Communication protocol — parse handoff/done signals from agent responses."""

import re
from app.models.protocol import Signal

HANDOFF_RE = re.compile(r'@handoff\((\w+)\)\s*:\s*(.+)', re.DOTALL)
DONE_RE = re.compile(r'@done\s*:\s*(.+)', re.DOTALL)


def parse(response: str) -> Signal:
    last_handoff = None
    for m in HANDOFF_RE.finditer(response):
        last_handoff = m
    if last_handoff:
        target, summary = last_handoff.group(1).strip(), last_handoff.group(2).strip()
        clean = response[:last_handoff.start()].rstrip()
        return Signal('handoff', target, summary, clean)

    last_done = None
    for m in DONE_RE.finditer(response):
        last_done = m
    if last_done:
        summary = last_done.group(1).strip()
        clean = response[:last_done.start()].rstrip()
        return Signal('done', '', summary, clean)

    return Signal('none', '', '', response)
