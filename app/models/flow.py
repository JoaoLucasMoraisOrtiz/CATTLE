"""Flow graph data models."""

from dataclasses import dataclass, field


@dataclass
class Node:
    agent_id: str
    x: float = 0
    y: float = 0
    header_ids: list[str] = field(default_factory=list)


@dataclass
class Edge:
    src: str
    dst: str
    returns: bool = False


@dataclass
class Flow:
    nodes: list[Node] = field(default_factory=list)
    edges: list[Edge] = field(default_factory=list)
    start_node: str = ''

    def targets_for(self, agent_id: str) -> list[str]:
        return [e.dst for e in self.edges if e.src == agent_id]

    def edge_returns(self, src: str, dst: str) -> bool:
        return any(e.src == src and e.dst == dst and e.returns for e in self.edges)

    def start_agent(self) -> str | None:
        if self.start_node:
            return self.start_node
        incoming = {e.dst for e in self.edges}
        for n in self.nodes:
            if n.agent_id not in incoming:
                return n.agent_id
        return self.nodes[0].agent_id if self.nodes else None


@dataclass
class FlowDef:
    id: str
    name: str
    flow: Flow = field(default_factory=Flow)
    default_header_ids: list[str] = field(default_factory=list)
