"""Flow CRUD routes."""

from fastapi import APIRouter, HTTPException
from app.models.flow import Flow, Node, Edge, FlowDef
from app.models.schemas import FlowIn, FlowDefIn
from app.services import flow_service

router = APIRouter(prefix="/api", tags=["flows"])


def _flowdef_to_dict(fd: FlowDef) -> dict:
    return {"id": fd.id, "name": fd.name,
            "nodes": [n.__dict__ for n in fd.flow.nodes],
            "edges": [e.__dict__ for e in fd.flow.edges],
            "start_node": fd.flow.start_node,
            "default_header_ids": fd.default_header_ids}


# ── Legacy single flow ────────────────────────────────────────────────────

@router.get("/flow")
def get_flow():
    f = flow_service.load()
    return {"nodes": [n.__dict__ for n in f.nodes], "edges": [e.__dict__ for e in f.edges], "start_node": f.start_node}


@router.put("/flow")
def save_flow(body: FlowIn):
    flow_service.save(Flow(
        nodes=[Node(**n) for n in body.nodes],
        edges=[Edge(**e) for e in body.edges],
        start_node=body.start_node,
    ))
    return {"ok": True}


# ── Multi-flow ────────────────────────────────────────────────────────────

@router.get("/flows")
def list_flows():
    return [_flowdef_to_dict(fd) for fd in flow_service.load_all()]


@router.post("/flows")
def create_flow(body: FlowDefIn):
    try:
        flow_service.add(FlowDef(id=body.id, name=body.name, flow=Flow(
            nodes=[Node(**n) for n in body.nodes],
            edges=[Edge(**e) for e in body.edges],
            start_node=body.start_node,
        ), default_header_ids=body.default_header_ids))
        return {"ok": True}
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.put("/flows/{flow_id}")
def update_flow(flow_id: str, body: FlowDefIn):
    try:
        flow_service.update(FlowDef(id=flow_id, name=body.name, flow=Flow(
            nodes=[Node(**n) for n in body.nodes],
            edges=[Edge(**e) for e in body.edges],
            start_node=body.start_node,
        ), default_header_ids=body.default_header_ids))
        return {"ok": True}
    except KeyError as e:
        raise HTTPException(404, str(e))


@router.delete("/flows/{flow_id}")
def delete_flow(flow_id: str):
    try:
        flow_service.remove(flow_id)
        return {"ok": True}
    except KeyError as e:
        raise HTTPException(404, str(e))
