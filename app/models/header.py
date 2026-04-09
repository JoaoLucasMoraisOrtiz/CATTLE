"""Header template data model."""

from dataclasses import dataclass

HEADER_TYPES = ('protocol', 'wrapper', 'handoff')

DEFAULT_PROTOCOL_ID = 'default-protocol'
DEFAULT_WRAPPER_ID = 'default-wrapper'
DEFAULT_HANDOFF_ID = 'default-handoff'

AVAILABLE_PLACEHOLDERS = {
    'protocol': ['{agent_name}', '{agent_persona}', '{agent_list}'],
    'wrapper': ['{agent_persona}', '{task}', '{agent_name}', '{agent_list}'],
    'handoff': ['{agent_name}', '{task}', '{handoff_context}'],
}


@dataclass
class HeaderDef:
    id: str
    name: str
    content: str
    type: str = 'protocol'
    is_default: bool = False
    description: str = ''
