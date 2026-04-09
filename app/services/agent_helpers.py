"""Shared helpers used by both orchestrator and session_service."""

from app.models.header import DEFAULT_PROTOCOL_ID
from app.services import header_service
from app.config import PROTOCOL_INSTRUCTIONS


def resolve_header_ids(node_id, flow, flow_def=None):
    """Pick header IDs for a node: node-level → flow-level → default."""
    node = next((n for n in flow.nodes if n.agent_id == node_id), None)
    if node and node.header_ids:
        return node.header_ids
    if flow_def and getattr(flow_def, 'default_header_ids', None):
        return flow_def.default_header_ids
    return [DEFAULT_PROTOCOL_ID]


def compose_persona(defn, header_ids, agent_list):
    """Build persona string from headers, falling back to raw persona + protocol."""
    ctx = {'agent_name': defn.name, 'agent_persona': defn.persona, 'agent_list': agent_list}
    composed = header_service.compose(header_ids, ctx)
    if composed.strip():
        return composed
    return defn.persona + '\n\n' + PROTOCOL_INSTRUCTIONS.format(agent_list=agent_list)


def build_agent_list_for(agent_id, agents, flow):
    """Visible agent list string for a given agent based on flow edges."""
    targets = flow.targets_for(agent_id)
    visible = [a for a in agents if a.id in targets]
    if not visible:
        return "(nenhum — você é o agente final, use @done)"
    return '\n'.join(f'- {a.id}: {a.name} — {a.persona[:80]}...' for a in visible)
