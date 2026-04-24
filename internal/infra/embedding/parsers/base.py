"""Shared helpers for all language parsers."""
from __future__ import annotations
from tree_sitter import Node


def text(node: Node) -> str:
    return node.text.decode() if node.text else ""


def signature(node: Node) -> str:
    """Extract declaration signature (first line, or up to body)."""
    body = node.child_by_field_name("body")
    if body:
        src = node.text.decode()
        body_start = body.start_byte - node.start_byte
        sig = src[:body_start].strip()
        return sig if sig else src.split("\n")[0]
    return node.text.decode().split("\n")[0]


def find_children(node: Node, types: set[str]) -> list[Node]:
    """Recursively find all descendants of given types."""
    found = []
    for child in node.children:
        if child.type in types:
            found.append(child)
        found.extend(find_children(child, types))
    return found


def find_direct(node: Node, type_: str) -> Node | None:
    for c in node.children:
        if c.type == type_:
            return c
    return None


def collect_calls(body_node: Node, call_type: str, extract_call_name) -> list[str]:
    """Collect unique call names from a body node."""
    nodes = find_children(body_node, {call_type})
    calls = []
    for n in nodes:
        name = extract_call_name(n)
        if name and name not in calls:
            calls.append(name)
    return calls


def make_symbol(kind: str, node: Node, wrapper: Node, language_calls) -> dict:
    """Build a symbol dict. language_calls = (call_type, extract_call_name_fn)."""
    call_type, extract_fn = language_calls
    return {
        "kind": kind,
        "signature": signature(node),
        "line_start": wrapper.start_point[0] + 1,
        "line_end": wrapper.end_point[0] + 1,
        "calls": collect_calls(node, call_type, extract_fn),
        "decorators": [],
    }
