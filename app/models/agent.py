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
    cli_type: str = 'kiro'  # 'kiro' or 'gemini'
    yolo: bool = False  # allow shell command auto-approval (gemini only)
