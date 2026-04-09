"""Flow service — CRUD + persistence for multi-flow system."""

import json
import os
import uuid
import threading
from dataclasses import asdict
from pathlib import Path

from app.models.flow import Node, Edge, Flow, FlowDef

_SWARM_DIR = Path.home() / '.kiro-swarm'
FLOW_FILE = _SWARM_DIR / 'flow.json'
FLOWS_FILE = _SWARM_DIR / 'flows.json'
_lock = threading.Lock()


def _flow_to_dict(fd: FlowDef) -> dict:
    return {
        'id': fd.id, 'name': fd.name,
        'nodes': [asdict(n) for n in fd.flow.nodes],
        'edges': [asdict(e) for e in fd.flow.edges],
        'start_node': fd.flow.start_node,
        'default_header_ids': fd.default_header_ids,
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
        default_header_ids=d.get('default_header_ids', []),
    )


def migrate() -> list[FlowDef]:
    if not FLOW_FILE.exists():
        return []
    data = json.loads(FLOW_FILE.read_text())
    fd = FlowDef(
        id='default', name='Default',
        flow=Flow(
            nodes=[Node(**n) for n in data.get('nodes', [])],
            edges=[Edge(**e) for e in data.get('edges', [])],
            start_node=data.get('start_node', ''),
        ),
    )
    flows = [fd]
    save_all(flows)
    return flows


def load_all() -> list[FlowDef]:
    if not FLOWS_FILE.exists():
        return migrate()
    return [_dict_to_flowdef(d) for d in json.loads(FLOWS_FILE.read_text())]


def save_all(flows: list[FlowDef]) -> None:
    with _lock:
        _SWARM_DIR.mkdir(parents=True, exist_ok=True)
        data = json.dumps([_flow_to_dict(fd) for fd in flows], indent=2)
        tmp = FLOWS_FILE.with_suffix('.tmp')
        with open(tmp, 'w', encoding='utf-8') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        tmp.replace(FLOWS_FILE)


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


def load() -> Flow:
    flows = load_all()
    return flows[0].flow if flows else Flow()


def save(flow: Flow) -> None:
    flows = load_all()
    if flows:
        flows[0].flow = flow
    else:
        flows = [FlowDef(id='default', name='Default', flow=flow)]
    save_all(flows)
