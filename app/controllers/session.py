"""Session management routes — open, close, message, SSE stream."""

import asyncio
import json
import threading

from fastapi import APIRouter, HTTPException
from sse_starlette.sse import EventSourceResponse

from app.models.schemas import MessageIn, OpenSessionIn
from app.services import project_service
from app.services.session_service import SwarmSession, EventCallback

router = APIRouter(prefix="/api/session", tags=["session"])

# ── Module-level state ────────────────────────────────────────────────────
active_session: SwarmSession | None = None
session_events: asyncio.Queue | None = None
session_loop: asyncio.AbstractEventLoop | None = None


@router.post("/open/{project_id}")
async def open_session(project_id: str, body: OpenSessionIn | None = None):
    global active_session, session_events, session_loop
    proj = project_service.get(project_id)
    if not proj:
        raise HTTPException(404, 'Project not found')

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

    active_session = SwarmSession(proj.path, SSECallback(), flow_id=body.flow_id if body else None)
    threading.Thread(target=active_session.open, daemon=True).start()
    return {"ok": True}


@router.post("/close")
def close_session():
    global active_session
    if active_session and active_session.alive:
        active_session.close()
    active_session = None
    return {"ok": True}


@router.post("/abort")
def abort_session():
    if active_session:
        active_session.abort()
    return {"ok": True}


@router.post("/interrupt/{agent_id}")
def interrupt_agent(agent_id: str):
    if not active_session or not active_session.alive:
        raise HTTPException(400, 'No active session')
    active_session.interrupt_agent(agent_id)
    return {"ok": True}


@router.get("/status")
def session_status():
    if not active_session or not active_session.alive:
        return {"open": False}
    return {
        "open": True,
        "agents": list(active_session.agents.keys()),
        "round": active_session.round_num,
    }


@router.post("/message")
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


@router.get("/events")
async def session_event_stream():
    if not session_events:
        raise HTTPException(400, 'No active session')

    async def stream():
        while True:
            item = await session_events.get()
            yield item

    return EventSourceResponse(stream())
