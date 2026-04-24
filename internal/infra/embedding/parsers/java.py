"""Java parser — imports, exports, symbols, call extraction."""
from __future__ import annotations
from tree_sitter import Node
from .base import text, signature, find_children, collect_calls

CALL_TYPE = "method_invocation"


def extract_call_name(node: Node) -> str | None:
    name = node.child_by_field_name("name")
    return text(name) if name else None


def extract_imports(root: Node) -> list[dict]:
    imports = []
    for node in find_children(root, {"import_declaration"}):
        path_text = ""
        for c in node.children:
            if c.type in ("scoped_identifier", "identifier"):
                path_text = text(c)
        parts = path_text.rsplit(".", 1)
        imports.append({
            "source": parts[0] if len(parts) > 1 else path_text,
            "symbols": [parts[-1]] if len(parts) > 1 else ["*"],
        })
    return imports


def extract_exports(root: Node) -> list[str]:
    exports = []
    for node in find_children(root, {"class_declaration"}):
        mods = [text(c) for c in node.children if c.type == "modifiers"]
        if any("public" in m for m in mods):
            name = node.child_by_field_name("name")
            if name:
                exports.append(text(name))
    return exports


def _extract_decorators(node: Node) -> list[str]:
    return [text(c) for c in node.children if c.type in ("marker_annotation", "annotation")]


CLS_TYPES = {"class_declaration", "interface_declaration", "enum_declaration"}


def extract_symbols(root: Node) -> dict[str, dict]:
    symbols: dict[str, dict] = {}
    for node in root.children:
        if node.type not in CLS_TYPES:
            continue
        cls_name_node = node.child_by_field_name("name")
        if not cls_name_node:
            continue
        cls_name = text(cls_name_node)
        symbols[cls_name] = {
            "kind": "class", "signature": signature(node),
            "line_start": node.start_point[0] + 1, "line_end": node.end_point[0] + 1,
            "calls": [], "decorators": _extract_decorators(node),
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
                            "calls": collect_calls(m, CALL_TYPE, extract_call_name),
                            "decorators": _extract_decorators(m),
                        }
    return symbols
