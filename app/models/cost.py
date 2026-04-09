"""Cost tracking data model."""

from dataclasses import dataclass, field


@dataclass
class CostRecord:
    agent_id: str
    agent_name: str
    input_tokens: int
    output_tokens: int
    cost_usd: float
    round_num: int = 0
