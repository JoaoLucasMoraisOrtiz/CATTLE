"""Communication protocol — parse handoff/done signals from agent responses."""

import re
from dataclasses import dataclass

# @handoff(agent_id): context for the next agent
HANDOFF_RE = re.compile(r'@handoff\((\w+)\)\s*:\s*(.+)', re.DOTALL)
# @done: summary of completed work
DONE_RE = re.compile(r'@done\s*:\s*(.+)', re.DOTALL)


@dataclass
class Signal:
    kind: str          # 'handoff', 'done', or 'none'
    target: str        # agent_id for handoff, '' otherwise
    summary: str       # context/summary text
    clean_response: str  # response with signal stripped


def parse(response: str) -> Signal:
    """Parse the last signal from an agent response."""
    # Search from the end — the signal should be at the tail
    lines = response.rstrip().split('\n')
    # Check last 5 lines for a signal (agent might add trailing whitespace)
    tail = '\n'.join(lines[-5:])

    m = HANDOFF_RE.search(tail)
    if m:
        target, summary = m.group(1).strip(), m.group(2).strip()
        clean = response[:response.rfind('@handoff')].rstrip()
        return Signal('handoff', target, summary, clean)

    m = DONE_RE.search(tail)
    if m:
        summary = m.group(1).strip()
        clean = response[:response.rfind('@done')].rstrip()
        return Signal('done', '', summary, clean)

    return Signal('none', '', '', response)
