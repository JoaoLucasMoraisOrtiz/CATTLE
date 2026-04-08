"""Flow graph — directed edges between agents + node positions."""

import json
from dataclasses import dataclass, field, asdict
from pathlib import Path

FLOW_FILE = Path(__file__).parent / 'flow.json'


@dataclass
class Node:
    agent_id: str
    x: float = 0
    y: float = 0


@dataclass
class Edge:
    src: str
    dst: str


@dataclass
class Flow:
    nodes: list[Node] = field(default_factory=list)
    edges: list[Edge] = field(default_factory=list)
    start_node: str = ''

    def targets_for(self, agent_id: str) -> list[str]:
        return [e.dst for e in self.edges if e.src == agent_id]

    def start_agent(self) -> str | None:
        if self.start_node:
            return self.start_node
        incoming = {e.dst for e in self.edges}
        for n in self.nodes:
            if n.agent_id not in incoming:
                return n.agent_id
        return self.nodes[0].agent_id if self.nodes else None


def load() -> Flow:
    if not FLOW_FILE.exists():
        return Flow()
    data = json.loads(FLOW_FILE.read_text())
    return Flow(
        nodes=[Node(**n) for n in data.get('nodes', [])],
        edges=[Edge(**e) for e in data.get('edges', [])],
        start_node=data.get('start_node', ''),
    )


def save(flow: Flow) -> None:
    FLOW_FILE.write_text(json.dumps({
        'nodes': [asdict(n) for n in flow.nodes],
        'edges': [asdict(e) for e in flow.edges],
        'start_node': flow.start_node,
    }, indent=2))
