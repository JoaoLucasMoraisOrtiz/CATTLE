"""Header templates — CRUD + composition + persistence."""

import json
import os
from dataclasses import asdict
from pathlib import Path

from app.models.header import HeaderDef, DEFAULT_PROTOCOL_ID, DEFAULT_WRAPPER_ID, DEFAULT_HANDOFF_ID

HEADERS_FILE = Path.home() / '.kiro-swarm' / 'headers.json'


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
    h = get(header_id)
    if h and h.is_default:
        raise ValueError(f'Cannot remove default header "{header_id}". Unset as default first.')
    headers = [h for h in load_all() if h.id != header_id]
    _save(headers)
    return headers


def get_default(header_type: str) -> HeaderDef | None:
    return next((h for h in load_all() if h.type == header_type and h.is_default), None)


def set_default(header_id: str) -> list[HeaderDef]:
    headers = load_all()
    target = next((h for h in headers if h.id == header_id), None)
    if not target:
        raise ValueError(f'Header "{header_id}" not found')
    for h in headers:
        if h.type == target.type:
            h.is_default = (h.id == header_id)
    _save(headers)
    return headers


# ── Composition ───────────────────────────────────────────────────────────

def compose(header_ids: list[str], context_vars: dict[str, str] | None = None) -> str:
    headers = {h.id: h for h in load_all()}
    parts = []
    for hid in header_ids:
        h = headers.get(hid)
        if h:
            parts.append(h.content)
    text = '\n\n'.join(parts)
    if context_vars:
        safe = {k: context_vars.get(k, '{' + k + '}') for k in
                ('agent_name', 'agent_persona', 'agent_list', 'task', 'handoff_context')}
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

_DEFAULT_HANDOFF_CONTENT = """[Handoff de {agent_name}]
Instrução: {task}

Contexto do trabalho anterior:
{handoff_context}"""


def ensure_defaults() -> None:
    headers = load_all()
    ids = {h.id for h in headers}
    changed = False
    defaults = [
        HeaderDef(id=DEFAULT_PROTOCOL_ID, name='Protocolo Padrão', type='protocol', is_default=True,
                  content=_DEFAULT_PROTOCOL_CONTENT, description='Instruções de protocolo @handoff/@done'),
        HeaderDef(id=DEFAULT_WRAPPER_ID, name='Wrapper Padrão', type='wrapper', is_default=True,
                  content=_DEFAULT_WRAPPER_CONTENT, description='Envolve a 1ª mensagem com [SISTEMA] e [TAREFA]'),
        HeaderDef(id=DEFAULT_HANDOFF_ID, name='Handoff Padrão', type='handoff', is_default=True,
                  content=_DEFAULT_HANDOFF_CONTENT, description='Mensagem enviada ao próximo agente no handoff'),
    ]
    for d in defaults:
        if d.id not in ids:
            headers.append(d)
            changed = True
    if changed:
        _save(headers)
