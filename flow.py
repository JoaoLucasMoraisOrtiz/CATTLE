"""Flow graph — directed edges between agents + node positions.

Supports multiple named flows (FlowDef) stored in flows.json,
with automatic migration from the legacy single flow.json.
"""

import json
import uuid
from dataclasses import dataclass, field, asdict
from pathlib import Path

_SWARM_DIR = Path.home() / '.kiro-swarm'
FLOW_FILE = _SWARM_DIR / 'flow.json'       # legacy
FLOWS_FILE = _SWARM_DIR / 'flows.json'     # multi-flow


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


@dataclass
class FlowDef:
    """Named flow definition — uses composition (contains a Flow)."""
    id: str
    name: str
    flow: Flow = field(default_factory=Flow)


# --------------- serialization helpers ---------------

def _flow_to_dict(fd: FlowDef) -> dict:
    return {
        'id': fd.id,
        'name': fd.name,
        'nodes': [asdict(n) for n in fd.flow.nodes],
        'edges': [asdict(e) for e in fd.flow.edges],
        'start_node': fd.flow.start_node,
    }


def _dict_to_flowdef(d: dict) -> FlowDef:
    return FlowDef(
        id=d.get('id', str(uuid.uuid4())),
        name=d.get('name', 'Default'),
        flow=Flow(
            nodes=[Node(**n) for n in d.get('nodes', [])],
            edges=[Edge(**e) for e in d.get('edges', [])],
            start_node=d.get('start_node', ''),
        ),
    )


# --------------- migration ---------------

def migrate() -> list[FlowDef]:
    """Convert legacy flow.json → flows.json. Returns migrated list."""
    if not FLOW_FILE.exists():
        return []
    data = json.loads(FLOW_FILE.read_text())
    fd = FlowDef(
        id='default',
        name='Default',
        flow=Flow(
            nodes=[Node(**n) for n in data.get('nodes', [])],
            edges=[Edge(**e) for e in data.get('edges', [])],
            start_node=data.get('start_node', ''),
        ),
    )
    flows = [fd]
    save_all(flows)
    return flows


# --------------- CRUD ---------------

def load_all() -> list[FlowDef]:
    if not FLOWS_FILE.exists():
        return migrate()
    data = json.loads(FLOWS_FILE.read_text())
    return [_dict_to_flowdef(d) for d in data]


def save_all(flows: list[FlowDef]) -> None:
    _SWARM_DIR.mkdir(parents=True, exist_ok=True)
    FLOWS_FILE.write_text(json.dumps([_flow_to_dict(fd) for fd in flows], indent=2))


def get(flow_id: str) -> FlowDef | None:
    return next((fd for fd in load_all() if fd.id == flow_id), None)


def add(flow_def: FlowDef) -> None:
    flows = load_all()
    if any(fd.id == flow_def.id for fd in flows):
        raise ValueError(f'Flow id already exists: {flow_def.id}')
    flows.append(flow_def)
    save_all(flows)


def update(flow_def: FlowDef) -> None:
    flows = load_all()
    for i, fd in enumerate(flows):
        if fd.id == flow_def.id:
            flows[i] = flow_def
            save_all(flows)
            return
    raise KeyError(f'Flow not found: {flow_def.id}')


def remove(flow_id: str) -> None:
    flows = load_all()
    filtered = [fd for fd in flows if fd.id != flow_id]
    if len(filtered) == len(flows):
        raise KeyError(f'Flow not found: {flow_id}')
    save_all(filtered)


# --------------- backward compat ---------------

def load() -> Flow:
    """Load first available flow (backward compatible)."""
    flows = load_all()
    return flows[0].flow if flows else Flow()


def save(flow: Flow) -> None:
    """Save to first FlowDef (backward compatible)."""
    flows = load_all()
    if flows:
        flows[0].flow = flow
    else:
        flows = [FlowDef(id='default', name='Default', flow=flow)]
    save_all(flows)
