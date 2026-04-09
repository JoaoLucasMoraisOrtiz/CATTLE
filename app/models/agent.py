"""Agent data model."""

from dataclasses import dataclass, field


@dataclass
class AgentDef:
    id: str
    name: str
    persona: str
    color: str = 'white'
    model: str | None = None
    workdir: str = '.'
    mcps: dict = field(default_factory=dict)
