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


_sessions: dict[str, SessionState] = {}
_sessions_lock = threading.Lock()


def _get_state(project_id: str) -> SessionState | None:
    with _sessions_lock:
        return _sessions.get(project_id)


def _get_or_create_state(project_id: str) -> SessionState:
    with _sessions_lock:
        if project_id not in _sessions:
            _sessions[project_id] = SessionState()
        return _sessions[project_id]


def _remove_state(project_id: str):
    with _sessions_lock:
        _sessions.pop(project_id, None)


@router.post("/open/{project_id}")
async def open_session(project_id: str, body: OpenSessionIn | None = None):
    proj = project_service.get(project_id)
    if not proj:
        raise HTTPException(404, 'Project not found')

    state = _get_or_create_state(project_id)
    if state.session and state.session.alive:
        state.session.close()

    state.loop = asyncio.get_event_loop()
    state.events = asyncio.Queue()

    class SSECallback(EventCallback):
        def _push(self, event, data):
            state.loop.call_soon_threadsafe(state.events.put_nowait,
                {"event": event, "data": json.dumps(data, ensure_ascii=False)})
        def on_orch(self, msg): self._push("orch", {"msg": msg})
        def on_agent(self, name, event, text): self._push("agent", {"name": name, "event": event, "text": text[:4000] if text else ""})
        def on_error(self, msg): self._push("error", {"msg": msg})
        def on_summary(self, text): self._push("summary", {"text": text})
        def on_done(self): self._push("done", {})
        def on_cost(self, data): self._push("cost", data)

    state.session = SwarmSession(proj.path, SSECallback(), flow_id=body.flow_id if body else None)
    threading.Thread(target=state.session.open, daemon=True).start()
    return {"ok": True}


@router.post("/close/{project_id}")
def close_session(project_id: str):
    state = _get_state(project_id)
    if state and state.session and state.session.alive:
        state.session.close()
    _remove_state(project_id)
    return {"ok": True}


@router.post("/close")
def close_session_legacy():
    """Backward-compatible: close all sessions."""
    with _sessions_lock:
        all_states = list(_sessions.values())
    for s in all_states:
        if s.session and s.session.alive:
            s.session.close()
    with _sessions_lock:
        _sessions.clear()
    return {"ok": True}


@router.post("/abort/{project_id}")
def abort_session(project_id: str):
    state = _get_state(project_id)
    if state and state.session:
        state.session.abort()
    return {"ok": True}


@router.post("/interrupt/{agent_id}")
def interrupt_agent(agent_id: str, project_id: str | None = None):
    state = _find_active_state(project_id)
    if not state or not state.session or not state.session.alive:
        raise HTTPException(400, 'No active session')
    state.session.interrupt_agent(agent_id)
    return {"ok": True}


@router.post("/restart/{agent_id}")
def restart_agent(agent_id: str, project_id: str | None = None):
    state = _find_active_state(project_id)
    if not state or not state.session or not state.session.alive:
        raise HTTPException(400, 'No active session')
    state.session.restart_agent(agent_id)
    return {"ok": True}


@router.get("/status")
def session_status(project_id: str | None = None):
    state = _find_active_state(project_id)
    if not state or not state.session or not state.session.alive:
        return {"open": False}
    return {
        "open": True,
        "agents": list(state.session.agents.keys()),
        "round": state.session.round_num,
    }


@router.get("/costs")
def session_costs(project_id: str | None = None):
    state = _find_active_state(project_id)
    if not state or not state.session:
        return {"agents": {}, "total_usd": 0}
    return state.session.cost_tracker.get_summary()


@router.post("/message")
async def send_message(body: MessageIn):
    state = _find_active_state(body.project_id)
    if not state or not state.session or not state.session.alive:
        raise HTTPException(400, 'No active session')

    def worker():
        if body.agent_id:
            state.session.send_to_agent(body.agent_id, body.text)
        else:
            state.session.send_to_swarm(body.text)

    threading.Thread(target=worker, daemon=True).start()
    return {"ok": True}


@router.get("/events/{project_id}")
async def session_event_stream(project_id: str):
    state = _get_state(project_id)
    if not state or not state.events:
        raise HTTPException(400, 'No active session')

    async def stream():
        while True:
            item = await state.events.get()
            yield item

    return EventSourceResponse(stream())


@router.get("/events")
async def session_event_stream_legacy():
    """Backward-compatible: stream events from first active session."""
    state = _find_active_state(None)
    if not state or not state.events:
        raise HTTPException(400, 'No active session')

    async def stream():
        while True:
            item = await state.events.get()
            yield item

    return EventSourceResponse(stream())


def _find_active_state(project_id: str | None) -> SessionState | None:
    """Find session by project_id, or return first session with events queue."""
    if project_id:
        return _get_state(project_id)
    with _sessions_lock:
        for s in _sessions.values():
            if s.events:
                return s
    return None
