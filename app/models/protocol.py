"""Protocol signal data model."""

from dataclasses import dataclass


@dataclass
class Signal:
    kind: str          # 'handoff', 'done', or 'none'
    target: str        # agent_id for handoff, '' otherwise
    summary: str       # context/summary text
    clean_response: str  # response with signal stripped
