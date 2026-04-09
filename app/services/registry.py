"""Agent registry — CRUD + JSON persistence."""

import json
import os
from dataclasses import asdict
from pathlib import Path

from app.models.agent import AgentDef

REGISTRY_FILE = Path.home() / '.kiro-swarm' / 'agents.json'


def load() -> list[AgentDef]:
    if not REGISTRY_FILE.exists():
        return []
    return [AgentDef(**a) for a in json.loads(REGISTRY_FILE.read_text())]


def save(agents: list[AgentDef]) -> None:
    REGISTRY_FILE.parent.mkdir(parents=True, exist_ok=True)
    data = json.dumps([asdict(a) for a in agents], indent=2, ensure_ascii=False)
    tmp = REGISTRY_FILE.with_suffix('.tmp')
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    tmp.replace(REGISTRY_FILE)


def add(agent: AgentDef) -> list[AgentDef]:
    agents = load()
    if any(a.id == agent.id for a in agents):
        raise ValueError(f'Agent "{agent.id}" already exists')
    agents.append(agent)
    save(agents)
    return agents


def remove(agent_id: str) -> list[AgentDef]:
    agents = [a for a in load() if a.id != agent_id]
    save(agents)
    return agents


def update(agent: AgentDef) -> list[AgentDef]:
    agents = load()
    agents = [agent if a.id == agent.id else a for a in agents]
    save(agents)
    return agents


def get(agent_id: str) -> AgentDef | None:
    return next((a for a in load() if a.id == agent_id), None)
