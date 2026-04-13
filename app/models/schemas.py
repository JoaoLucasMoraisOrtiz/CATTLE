"""Pydantic request/response schemas for the API."""

from pydantic import BaseModel


class AgentIn(BaseModel):
    id: str
    name: str
    persona: str
    color: str = "white"
    model: str | None = None
    mcps: dict = {}
    cli_type: str = 'kiro'
    yolo: bool = False


class FlowIn(BaseModel):
    nodes: list[dict]
    edges: list[dict]
    start_node: str = ''


class FlowDefIn(BaseModel):
    id: str
    name: str
    nodes: list[dict] = []
    edges: list[dict] = []
    start_node: str = ''
    default_header_ids: list[str] = []


class ProjectIn(BaseModel):
    id: str
    name: str
    path: str


class MessageIn(BaseModel):
    project_id: str | None = None
    text: str
    agent_id: str | None = None


class HeaderIn(BaseModel):
    id: str
    name: str
    content: str
    description: str = ''
    type: str = 'protocol'
    is_default: bool = False


class OpenSessionIn(BaseModel):
    flow_id: str | None = None


class SettingIn(BaseModel):
    key: str
    value: bool | str | int | float
