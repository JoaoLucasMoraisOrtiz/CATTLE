"""Header templates — CRUD + JSON persistence + composition."""

import json, os
from dataclasses import dataclass, asdict
from pathlib import Path

HEADERS_FILE = Path.home() / '.kiro-swarm' / 'headers.json'

DEFAULT_PROTOCOL_ID = 'default-protocol'
DEFAULT_WRAPPER_ID = 'default-wrapper'

AVAILABLE_PLACEHOLDERS = ['{agent_name}', '{agent_persona}', '{agent_list}', '{task}']


@dataclass
class HeaderDef:
    id: str
    name: str
    content: str
    description: str = ''


# ── Persistence ───────────────────────────────────────────────────────────

def load_all() -> list[HeaderDef]:
    if not HEADERS_FILE.exists():
        return []
    return [HeaderDef(**h) for h in json.loads(HEADERS_FILE.read_text())]


def _save(headers: list[HeaderDef]) -> None:
    HEADERS_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = HEADERS_FILE.with_suffix('.tmp')
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump([asdict(h) for h in headers], f, indent=2, ensure_ascii=False)
        f.flush(); os.fsync(f.fileno())
    tmp.replace(HEADERS_FILE)


# ── CRUD ──────────────────────────────────────────────────────────────────

def get(header_id: str) -> HeaderDef | None:
    return next((h for h in load_all() if h.id == header_id), None)


def add(header: HeaderDef) -> list[HeaderDef]:
    headers = load_all()
    if any(h.id == header.id for h in headers):
        raise ValueError(f'Header "{header.id}" already exists')
    headers.append(header)
    _save(headers)
    return headers


def update(header: HeaderDef) -> list[HeaderDef]:
    headers = load_all()
    headers = [header if h.id == header.id else h for h in headers]
    _save(headers)
    return headers


def remove(header_id: str) -> list[HeaderDef]:
    if header_id in (DEFAULT_PROTOCOL_ID, DEFAULT_WRAPPER_ID):
        raise ValueError(f'Cannot remove default header "{header_id}"')
    headers = [h for h in load_all() if h.id != header_id]
    _save(headers)
    return headers


# ── Composition ───────────────────────────────────────────────────────────

def compose(header_ids: list[str], context_vars: dict[str, str] | None = None) -> str:
    """Concatenate headers by id, resolving {placeholders} with context_vars."""
    headers = {h.id: h for h in load_all()}
    parts = []
    for hid in header_ids:
        h = headers.get(hid)
        if h:
            parts.append(h.content)
    text = '\n\n'.join(parts)
    if context_vars:
        safe = {k: context_vars.get(k, '{' + k + '}') for k in
                ('agent_name', 'agent_persona', 'agent_list', 'task')}
        text = text.format_map(safe)
    return text


# ── Defaults ──────────────────────────────────────────────────────────────

_DEFAULT_PROTOCOL_CONTENT = """## Protocolo de comunicação

Você faz parte de um swarm de agentes especializados. Ao finalizar sua tarefa:

- Se precisar que OUTRO agente continue o trabalho, termine sua resposta com:
  @handoff(id_do_agente): breve descrição do que ele precisa fazer

- Se sua tarefa estiver COMPLETA e não precisar de mais ninguém, termine com:
  @done: breve resumo do que foi feito

Agentes disponíveis no swarm:
{agent_list}

IMPORTANTE: Sempre termine com @handoff ou @done. Nunca deixe sem sinalização."""

_DEFAULT_WRAPPER_CONTENT = """[SISTEMA — SUA IDENTIDADE E REGRAS]
{agent_persona}

[TAREFA]
{task}"""


def ensure_defaults() -> None:
    """Create default headers if they don't exist."""
    headers = load_all()
    ids = {h.id for h in headers}
    changed = False
    if DEFAULT_PROTOCOL_ID not in ids:
        headers.append(HeaderDef(
            id=DEFAULT_PROTOCOL_ID, name='Protocolo Padrão',
            content=_DEFAULT_PROTOCOL_CONTENT,
            description='Instruções de protocolo de comunicação do swarm'))
        changed = True
    if DEFAULT_WRAPPER_ID not in ids:
        headers.append(HeaderDef(
            id=DEFAULT_WRAPPER_ID, name='Wrapper Padrão',
            content=_DEFAULT_WRAPPER_CONTENT,
            description='Template que envolve cada mensagem com [SISTEMA] e [TAREFA]'))
        changed = True
    if changed:
        _save(headers)
