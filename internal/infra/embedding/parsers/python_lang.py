"""Python parser — imports, exports, symbols, call extraction."""
from __future__ import annotations
from tree_sitter import Node
from .base import text, signature, find_children, collect_calls

CALL_TYPE = "call"


def extract_call_name(node: Node) -> str | None:
    fn = node.children[0] if node.children else None
    if not fn:
        return None
    if fn.type == "identifier":
        return text(fn)
    if fn.type == "attribute":
        attr = fn.child_by_field_name("attribute")
        return text(attr) if attr else None
    return None


def extract_imports(root: Node) -> list[dict]:
    imports = []
    for node in find_children(root, {"import_from_statement"}):
        mod = node.child_by_field_name("module_name")
        source = text(mod) if mod else ""
        syms = [text(c) for c in node.children if c.type == "dotted_name" and c != mod]
        if not syms:
            syms = [text(c) for c in find_children(node, {"identifier"}) if c.parent and c.parent.type != "dotted_name"]
        imports.append({"source": source, "symbols": syms or ["*"]})
    for node in find_children(root, {"import_statement"}):
        for c in node.children:
            if c.type == "dotted_name":
                imports.append({"source": text(c), "symbols": ["*"]})
    return imports


def extract_exports(root: Node) -> list[str]:
    exports = []
    for node in root.children:
        if node.type in ("function_definition", "class_definition"):
            name = node.child_by_field_name("name")
            if name and not text(name).startswith("_"):
                exports.append(text(name))
    return exports


def _extract_decorators(node: Node) -> list[str]:
    return [text(c) for c in node.children if c.type == "decorator"]


def extract_symbols(root: Node) -> dict[str, dict]:
    symbols: dict[str, dict] = {}
    for node in root.children:
        # Unwrap decorated_definition
        actual = node
        if node.type == "decorated_definition":
            for c in node.children:
                if c.type in ("function_definition", "class_definition"):
                    actual = c
                    break

        if actual.type == "function_definition":
            name_node = actual.child_by_field_name("name")
            if name_node:
                symbols[text(name_node)] = {
                    "kind": "function", "signature": signature(actual),
                    "line_start": node.start_point[0] + 1, "line_end": node.end_point[0] + 1,
                    "calls": collect_calls(actual, CALL_TYPE, extract_call_name),
                    "decorators": _extract_decorators(node),
                }

        if actual.type == "class_definition":
            cls_name_node = actual.child_by_field_name("name")
            if not cls_name_node:
                continue
            cls_name = text(cls_name_node)
            symbols[cls_name] = {
                "kind": "class", "signature": signature(actual),
                "line_start": actual.start_point[0] + 1, "line_end": actual.end_point[0] + 1,
                "calls": [], "decorators": _extract_decorators(node),
            }
            body = actual.child_by_field_name("body")
            if body:
                for m in body.children:
                    act_m = m
                    if m.type == "decorated_definition":
                        for c in m.children:
                            if c.type == "function_definition":
                                act_m = c
                                break
                    if act_m.type == "function_definition":
                        mn = act_m.child_by_field_name("name")
                        if mn:
                            symbols[f"{cls_name}.{text(mn)}"] = {
                                "kind": "method", "signature": signature(act_m),
                                "line_start": m.start_point[0] + 1, "line_end": m.end_point[0] + 1,
                                "calls": collect_calls(act_m, CALL_TYPE, extract_call_name),
                                "decorators": _extract_decorators(m),
                            }
    return symbols
