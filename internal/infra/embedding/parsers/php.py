"""PHP parser — imports, exports, symbols, call extraction."""
from __future__ import annotations
from tree_sitter import Node
from .base import text, signature, find_children, collect_calls

CALL_TYPES = {"function_call_expression", "member_call_expression"}


def extract_call_name(node: Node) -> str | None:
    fn = node.child_by_field_name("function") if node.type == "function_call_expression" else None
    if fn and fn.type in ("name", "qualified_name"):
        return text(fn)
    # member_call_expression
    name = node.child_by_field_name("name")
    return text(name) if name else None


def _collect_php_calls(body_node: Node) -> list[str]:
    nodes = find_children(body_node, CALL_TYPES)
    calls = []
    for n in nodes:
        name = extract_call_name(n)
        if name and name not in calls:
            calls.append(name)
    return calls


def extract_imports(root: Node) -> list[dict]:
    imports = []
    for node in find_children(root, {"namespace_use_declaration"}):
        for clause in find_children(node, {"namespace_use_clause"}):
            name = text(clause).strip("\\")
            parts = name.rsplit("\\", 1)
            imports.append({
                "source": parts[0] if len(parts) > 1 else name,
                "symbols": [parts[-1]] if len(parts) > 1 else ["*"],
            })
    return imports


def extract_exports(root: Node) -> list[str]:
    exports = []
    for node in find_children(root, {"class_declaration"}):
        name = node.child_by_field_name("name")
        if name:
            exports.append(text(name))
    return exports


def extract_symbols(root: Node) -> dict[str, dict]:
    symbols: dict[str, dict] = {}
    for node in root.children:
        if node.type == "function_definition":
            name_node = node.child_by_field_name("name")
            if name_node:
                symbols[text(name_node)] = {
                    "kind": "function", "signature": signature(node),
                    "line_start": node.start_point[0] + 1, "line_end": node.end_point[0] + 1,
                    "calls": _collect_php_calls(node), "decorators": [],
                }
        if node.type == "class_declaration":
            cls_name_node = node.child_by_field_name("name")
            if not cls_name_node:
                continue
            cls_name = text(cls_name_node)
            decos = [text(c) for c in node.children if c.type == "attribute_list"]
            symbols[cls_name] = {
                "kind": "class", "signature": signature(node),
                "line_start": node.start_point[0] + 1, "line_end": node.end_point[0] + 1,
                "calls": [], "decorators": decos,
            }
            body = node.child_by_field_name("body")
            if body:
                for m in body.children:
                    if m.type == "method_declaration":
                        mn = m.child_by_field_name("name")
                        if mn:
                            symbols[f"{cls_name}.{text(mn)}"] = {
                                "kind": "method", "signature": signature(m),
                                "line_start": m.start_point[0] + 1, "line_end": m.end_point[0] + 1,
                                "calls": _collect_php_calls(m), "decorators": [],
                            }
    return symbols
