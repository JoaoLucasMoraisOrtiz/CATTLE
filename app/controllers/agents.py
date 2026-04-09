"""Agent CRUD routes."""

from fastapi import APIRouter, HTTPException
from app.models.agent import AgentDef
from app.models.schemas import AgentIn
from app.services import registry

router = APIRouter(prefix="/api/agents", tags=["agents"])


@router.get("")
def list_agents():
    return [a.__dict__ for a in registry.load()]


@router.post("")
def create_agent(a: AgentIn):
    try:
        registry.add(AgentDef(**a.model_dump()))
        return {"ok": True}
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.put("/{agent_id}")
def update_agent(agent_id: str, a: AgentIn):
    registry.update(AgentDef(**a.model_dump()))
    return {"ok": True}


@router.delete("/{agent_id}")
def delete_agent(agent_id: str):
    registry.remove(agent_id)
    return {"ok": True}
