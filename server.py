"""FastAPI backend — project sessions, chat-style messaging, SSE streaming."""

import asyncio
import json
import threading

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

import registry
from registry import AgentDef
import flow as flowmod
from flow import Flow, Node, Edge, FlowDef
import projects as projmod
from projects import Project
from session import SwarmSession, EventCallback

app = FastAPI(title="ReDo!")
app.mount("/static", StaticFiles(directory="static"), name="static")

# ── Active session ────────────────────────────────────────────────────────
active_session: SwarmSession | None = None
session_events: asyncio.Queue | None = None
session_loop: asyncio.AbstractEventLoop | None = None

# ── Models ────────────────────────────────────────────────────────────────

class AgentIn(BaseModel):
    id: str
    name: str
    persona: str
    color: str = "white"
    model: str | None = None
    mcps: dict = {}

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

class ProjectIn(BaseModel):
    id: str
    name: str
    path: str

class MessageIn(BaseModel):
    text: str
    agent_id: str | None = None  # None = send to swarm, set = direct to agent

class OpenSessionIn(BaseModel):
    flow_id: str | None = None

# ── Agent CRUD ────────────────────────────────────────────────────────────

@app.get("/")
def index():
    return FileResponse("static/index.html")

@app.get("/api/agents")
def list_agents():
    return [a.__dict__ for a in registry.load()]

@app.post("/api/agents")
def create_agent(a: AgentIn):
    try:
        registry.add(AgentDef(**a.model_dump()))
        return {"ok": True}
    except ValueError as e:
        raise HTTPException(400, str(e))

@app.put("/api/agents/{agent_id}")
def update_agent(agent_id: str, a: AgentIn):
    registry.update(AgentDef(**a.model_dump()))
    return {"ok": True}

@app.delete("/api/agents/{agent_id}")
def delete_agent(agent_id: str):
    registry.remove(agent_id)
    return {"ok": True}

# ── Project CRUD ──────────────────────────────────────────────────────────

@app.get("/api/projects")
def list_projects():
    return [p.__dict__ for p in projmod.load()]

@app.post("/api/projects")
def create_project(p: ProjectIn):
    try:
        projmod.add(Project(**p.model_dump()))
        return {"ok": True}
    except ValueError as e:
        raise HTTPException(400, str(e))

@app.delete("/api/projects/{project_id}")
def delete_project(project_id: str):
    projmod.remove(project_id)
    return {"ok": True}

# ── Flow CRUD ─────────────────────────────────────────────────────────────

@app.get("/api/flow")
def get_flow():
    f = flowmod.load()
    return {"nodes": [n.__dict__ for n in f.nodes], "edges": [e.__dict__ for e in f.edges], "start_node": f.start_node}

@app.put("/api/flow")
def save_flow(body: FlowIn):
    flowmod.save(Flow(
        nodes=[Node(**n) for n in body.nodes],
        edges=[Edge(**e) for e in body.edges],
        start_node=body.start_node,
    ))
    return {"ok": True}

# ── Multi-flow CRUD ───────────────────────────────────────────────────────

def _flowdef_to_dict(fd: FlowDef) -> dict:
    return {"id": fd.id, "name": fd.name,
            "nodes": [n.__dict__ for n in fd.flow.nodes],
            "edges": [e.__dict__ for e in fd.flow.edges],
            "start_node": fd.flow.start_node}

@app.get("/api/flows")
def list_flows():
    return [_flowdef_to_dict(fd) for fd in flowmod.load_all()]

@app.post("/api/flows")
def create_flow(body: FlowDefIn):
    try:
        flowmod.add(FlowDef(id=body.id, name=body.name, flow=Flow(
            nodes=[Node(**n) for n in body.nodes],
            edges=[Edge(**e) for e in body.edges],
            start_node=body.start_node,
        )))
        return {"ok": True}
    except ValueError as e:
        raise HTTPException(400, str(e))

@app.put("/api/flows/{flow_id}")
def update_flow(flow_id: str, body: FlowDefIn):
    try:
        flowmod.update(FlowDef(id=flow_id, name=body.name, flow=Flow(
            nodes=[Node(**n) for n in body.nodes],
            edges=[Edge(**e) for e in body.edges],
            start_node=body.start_node,
        )))
        return {"ok": True}
    except KeyError as e:
        raise HTTPException(404, str(e))

@app.delete("/api/flows/{flow_id}")
def delete_flow(flow_id: str):
    try:
        flowmod.remove(flow_id)
        return {"ok": True}
    except KeyError as e:
        raise HTTPException(404, str(e))

# ── Session management ────────────────────────────────────────────────────

@app.post("/api/session/open/{project_id}")
async def open_session(project_id: str, body: OpenSessionIn | None = None):
    global active_session, session_events, session_loop
    proj = projmod.get(project_id)
    if not proj:
        raise HTTPException(404, 'Project not found')

    # Close existing
    if active_session and active_session.alive:
        active_session.close()

    session_loop = asyncio.get_event_loop()
    session_events = asyncio.Queue()

    class SSECallback(EventCallback):
        def _push(self, event, data):
            session_loop.call_soon_threadsafe(session_events.put_nowait,
                {"event": event, "data": json.dumps(data, ensure_ascii=False)})
        def on_orch(self, msg): self._push("orch", {"msg": msg})
        def on_agent(self, name, event, text): self._push("agent", {"name": name, "event": event, "text": text})
        def on_error(self, msg): self._push("error", {"msg": msg})
        def on_summary(self, text): self._push("summary", {"text": text})
        def on_done(self): self._push("done", {})

    active_session = SwarmSession(proj.path, SSECallback())

    def spawn():
        active_session.open()

    threading.Thread(target=spawn, daemon=True).start()
    return {"ok": True}


@app.post("/api/session/close")
def close_session():
    global active_session
    if active_session and active_session.alive:
        active_session.close()
    active_session = None
    return {"ok": True}


@app.get("/api/session/status")
def session_status():
    if not active_session or not active_session.alive:
        return {"open": False}
    return {
        "open": True,
        "agents": list(active_session.agents.keys()),
        "round": active_session.round_num,
    }


@app.post("/api/session/message")
async def send_message(body: MessageIn):
    if not active_session or not active_session.alive:
        raise HTTPException(400, 'No active session')

    def worker():
        if body.agent_id:
            active_session.send_to_agent(body.agent_id, body.text)
        else:
            active_session.send_to_swarm(body.text)

    threading.Thread(target=worker, daemon=True).start()
    return {"ok": True}


@app.get("/api/session/events")
async def session_event_stream():
    """SSE stream — all session events in real time."""
    if not session_events:
        raise HTTPException(400, 'No active session')

    async def stream():
        while True:
            item = await session_events.get()
            yield item

    return EventSourceResponse(stream())


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8420)
