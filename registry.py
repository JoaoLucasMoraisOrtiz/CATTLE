"""Agent registry — CRUD + JSON persistence."""

import json
from dataclasses import dataclass, field, asdict
from pathlib import Path

REGISTRY_FILE = Path.home() / '.kiro-swarm' / 'agents.json'


@dataclass
class AgentDef:
    id: str
    name: str
    persona: str
    color: str = 'white'
    model: str | None = None
    workdir: str = '.'
    mcps: dict = field(default_factory=dict)  # {"server-name": {"command":...,"args":...}}


def load() -> list[AgentDef]:
    if not REGISTRY_FILE.exists():
        return []
    data = json.loads(REGISTRY_FILE.read_text())
    return [AgentDef(**a) for a in data]


def save(agents: list[AgentDef]) -> None:
    REGISTRY_FILE.write_text(
        json.dumps([asdict(a) for a in agents], indent=2, ensure_ascii=False)
    )


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
