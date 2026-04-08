"""Swarm state persistence — save/restore sessions outside the project dir."""

import hashlib
import json
import os
from dataclasses import dataclass, asdict
from pathlib import Path

from agent import Agent
from output_parser import strip_ansi, PROMPT_RE

SWARM_HOME = Path.home() / '.kiro-swarm'


@dataclass
class SwarmState:
    round_num: int
    current_agent_id: str
    pending_message: str
    agent_ids: list[str]
    commit_hashes: dict
    project_dir: str


def _project_dir(workdir: str) -> Path:
    """Unique session dir per project, stored in ~/.kiro-swarm/sessions/<hash>/"""
    h = hashlib.sha256(os.path.abspath(workdir).encode()).hexdigest()[:12]
    name = os.path.basename(os.path.abspath(workdir))
    d = SWARM_HOME / 'sessions' / f'{name}-{h}'
    d.mkdir(parents=True, exist_ok=True)
    return d


def _agent_save_path(workdir: str, agent_id: str) -> str:
    return str(_project_dir(workdir) / f'agent-{agent_id}')


def save_agent_session(agent: Agent, agent_id: str, workdir: str) -> bool:
    """Send /chat save to an agent. Saves to ~/.kiro-swarm/sessions/..."""
    try:
        path = _agent_save_path(workdir, agent_id)
        agent._pty.write(f'/chat save {path} --force\r')
        import time
        deadline = time.time() + 30
        while time.time() < deadline:
            chunk = agent._pty.read_chunk(timeout=3)
            if chunk and PROMPT_RE.search(strip_ansi(chunk)):
                break
        return True
    except Exception:
        return False


def save_swarm(workdir: str, state: SwarmState, live_agents: dict[str, Agent]) -> str:
    d = _project_dir(workdir)
    saved = []
    for aid, agent in live_agents.items():
        if save_agent_session(agent, aid, workdir):
            saved.append(aid)
    state.agent_ids = saved
    state.project_dir = os.path.abspath(workdir)
    path = d / 'swarm_state.json'
    path.write_text(json.dumps(asdict(state), indent=2, ensure_ascii=False))
    return str(d)


def load_swarm_state(workdir: str) -> SwarmState | None:
    path = _project_dir(workdir) / 'swarm_state.json'
    if not path.exists():
        return None
    data = json.loads(path.read_text())
    return SwarmState(**data)


def resume_agent(agent_id: str, name: str, workdir: str, model: str | None = None) -> Agent:
    """Spawn agent and load its saved session."""
    from pty_agent import make_clean_env
    import pexpect

    agent = Agent(name, workdir, model)
    env, tmp = make_clean_env()
    cmd = 'kiro-cli chat --wrap never -a'
    if model:
        cmd += f' --model {model}'
    agent._pty.proc = pexpect.spawn(
        cmd, cwd=workdir, encoding='utf-8',
        timeout=180, maxread=65536, env=env,
    )
    agent._pty._tmp_home = tmp
    # Wait for startup prompt
    agent._read_until_prompt(timeout=60)
    # Load saved session
    path = _agent_save_path(workdir, agent_id)
    agent._pty.write(f'/chat load {path}\r')
    agent._read_until_prompt(timeout=30)
    return agent


def append_chat_message(workdir: str, msg: dict) -> None:
    path = _project_dir(workdir) / 'chat_history.jsonl'
    with open(path, 'a', encoding='utf-8') as f:
        f.write(json.dumps(msg, ensure_ascii=False) + '\n')


def load_chat_history(workdir: str) -> list[dict]:
    path = _project_dir(workdir) / 'chat_history.jsonl'
    if not path.exists():
        return []
    try:
        return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    except Exception:
        return []
