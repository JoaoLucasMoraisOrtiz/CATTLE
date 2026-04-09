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


class SessionState:
    """Encapsulates mutable session state (thread-safe per instance)."""
    __slots__ = ('session', 'events', 'loop')

    def __init__(self):
        self.session: SwarmSession | None = None
        self.events: asyncio.Queue | None = None
        self.loop: asyncio.AbstractEventLoop | None = None


_state = SessionState()


@router.post("/open/{project_id}")
async def open_session(project_id: str, body: OpenSessionIn | None = None):
    proj = project_service.get(project_id)
    if not proj:
        raise HTTPException(404, 'Project not found')

    if _state.session and _state.session.alive:
        _state.session.close()

    _state.loop = asyncio.get_event_loop()
    _state.events = asyncio.Queue()

    class SSECallback(EventCallback):
        def _push(self, event, data):
            _state.loop.call_soon_threadsafe(_state.events.put_nowait,
                {"event": event, "data": json.dumps(data, ensure_ascii=False)})
        def on_orch(self, msg): self._push("orch", {"msg": msg})
        def on_agent(self, name, event, text): self._push("agent", {"name": name, "event": event, "text": text})
        def on_error(self, msg): self._push("error", {"msg": msg})
        def on_summary(self, text): self._push("summary", {"text": text})
        def on_done(self): self._push("done", {})

    _state.session = SwarmSession(proj.path, SSECallback(), flow_id=body.flow_id if body else None)
    threading.Thread(target=_state.session.open, daemon=True).start()
    return {"ok": True}


@router.post("/close")
def close_session():
    if _state.session and _state.session.alive:
        _state.session.close()
    _state.session = None
    return {"ok": True}


@router.post("/abort")
def abort_session():
    if _state.session:
        _state.session.abort()
    return {"ok": True}


@router.post("/interrupt/{agent_id}")
def interrupt_agent(agent_id: str):
    if not _state.session or not _state.session.alive:
        raise HTTPException(400, 'No active session')
    _state.session.interrupt_agent(agent_id)
    return {"ok": True}


@router.get("/status")
def session_status():
    if not _state.session or not _state.session.alive:
        return {"open": False}
    return {
        "open": True,
        "agents": list(_state.session.agents.keys()),
        "round": _state.session.round_num,
    }


@router.post("/message")
async def send_message(body: MessageIn):
    if not _state.session or not _state.session.alive:
        raise HTTPException(400, 'No active session')

    def worker():
        if body.agent_id:
            _state.session.send_to_agent(body.agent_id, body.text)
        else:
            _state.session.send_to_swarm(body.text)

    threading.Thread(target=worker, daemon=True).start()
    return {"ok": True}


@router.get("/events")
async def session_event_stream():
    if not _state.events:
        raise HTTPException(400, 'No active session')

    async def stream():
        while True:
            item = await _state.events.get()
            yield item

    return EventSourceResponse(stream())
