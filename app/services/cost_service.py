"""Cost tracking service — token estimation and cost calculation."""

import threading
from dataclasses import dataclass, field
from app.models.cost import CostRecord

# Claude Sonnet approximate pricing (USD per 1M tokens)
INPUT_PRICE = 3.0
OUTPUT_PRICE = 15.0


def estimate_tokens(text: str) -> int:
    """Approximate token count (~4 chars per token)."""
    return max(1, len(text) // 4)


def _calc_cost(input_tokens: int, output_tokens: int) -> float:
    return (input_tokens * INPUT_PRICE + output_tokens * OUTPUT_PRICE) / 1_000_000


@dataclass
class AgentCost:
    agent_id: str
    agent_name: str
    total_input: int = 0
    total_output: int = 0
    total_usd: float = 0.0
    calls: int = 0


class CostTracker:
    """Per-session cost tracker. Thread-safe."""

    def __init__(self):
        self._lock = threading.Lock()
        self._agents: dict[str, AgentCost] = {}

    def record(self, agent_id: str, agent_name: str, input_text: str, output_text: str, round_num: int = 0) -> CostRecord:
        inp = estimate_tokens(input_text)
        out = estimate_tokens(output_text)
        cost = _calc_cost(inp, out)
        rec = CostRecord(agent_id, agent_name, inp, out, cost, round_num)
        with self._lock:
            ac = self._agents.setdefault(agent_id, AgentCost(agent_id, agent_name))
            ac.total_input += inp
            ac.total_output += out
            ac.total_usd += cost
            ac.calls += 1
        return rec

    def get_summary(self) -> dict:
        with self._lock:
            agents = {aid: {'name': ac.agent_name, 'input': ac.total_input, 'output': ac.total_output,
                            'cost_usd': round(ac.total_usd, 6), 'calls': ac.calls}
                      for aid, ac in self._agents.items()}
            total = round(sum(ac.total_usd for ac in self._agents.values()), 6)
        return {'agents': agents, 'total_usd': total}

    def reset(self):
        with self._lock:
            self._agents.clear()
