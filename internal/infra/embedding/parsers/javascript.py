"""JS/TS/TSX parser — imports, exports, symbols, call extraction."""
from __future__ import annotations
from tree_sitter import Node
from .base import text, signature, find_children, find_direct, collect_calls

CALL_TYPE = "call_expression"


def extract_call_name(node: Node) -> str | None:
    fn = node.child_by_field_name("function")
    if not fn:
        return None
    if fn.type == "identifier":
        return text(fn)
    if fn.type == "member_expression":
        prop = fn.child_by_field_name("property")
        return text(prop) if prop else None
    return None


def extract_imports(root: Node) -> list[dict]:
    imports = []
    for node in find_children(root, {"import_statement"}):
        source_node = node.child_by_field_name("source")
        source = text(source_node).strip("'\"") if source_node else ""
        syms = []
        for spec in find_children(node, {"import_specifier"}):
            name_node = spec.child_by_field_name("name")
            if name_node:
                syms.append(text(name_node))
        clause = find_direct(node, "import_clause")
        if clause:
            for c in clause.children:
                if c.type == "identifier":
                    syms.append(text(c))
                if c.type == "namespace_import":
                    syms.append("*")
        imports.append({"source": source, "symbols": syms or ["*"]})
    return imports


def extract_exports(root: Node) -> list[str]:
    exports = []
    for node in find_children(root, {"export_statement"}):
        decl = node.child_by_field_name("declaration")
        if decl:
            name = decl.child_by_field_name("name")
            if name:
                exports.append(text(name))
            elif decl.type == "lexical_declaration":
                # Only direct variable_declarators, not nested ones inside arrow bodies
                for d in decl.children:
                    if d.type == "variable_declarator":
                        n = d.child_by_field_name("name")
                        if n:
                            exports.append(text(n))
        if "default" in text(node).split()[:3]:
            exports.append("default")
    return exports


def _extract_fn(node: Node, wrapper: Node, symbols: dict):
    """Extract a function/arrow-function symbol."""
    name_node = node.child_by_field_name("name") if node.type in ("function_declaration", "generator_function_declaration") else None
    if name_node:
        symbols[text(name_node)] = {
            "kind": "function", "signature": signature(node),
            "line_start": wrapper.start_point[0] + 1, "line_end": wrapper.end_point[0] + 1,
            "calls": collect_calls(node, CALL_TYPE, extract_call_name), "decorators": [],
        }
        return
    # const Foo = () => {} / const Foo = function() {}
    if node.type == "lexical_declaration":
        for decl in node.children:
            if decl.type != "variable_declarator":
                continue
            val = decl.child_by_field_name("value")
            if val and val.type in ("arrow_function", "function_expression"):
                n = decl.child_by_field_name("name")
                if n:
                    symbols[text(n)] = {
                        "kind": "function", "signature": signature(node),
                        "line_start": wrapper.start_point[0] + 1, "line_end": wrapper.end_point[0] + 1,
                        "calls": collect_calls(val, CALL_TYPE, extract_call_name), "decorators": [],
                    }


FN_TYPES = {"function_declaration", "generator_function_declaration"}
CLS_TYPES = {"class_declaration"}


def extract_symbols(root: Node) -> dict[str, dict]:
    symbols: dict[str, dict] = {}
    for node in root.children:
        # Top-level functions and arrow functions
        if node.type in FN_TYPES or node.type == "lexical_declaration":
            _extract_fn(node, node, symbols)

        # export statement wrapping
        if node.type == "export_statement":
            decl = node.child_by_field_name("declaration")
            if decl:
                if decl.type in FN_TYPES or decl.type == "lexical_declaration":
                    _extract_fn(decl, decl, symbols)
                elif decl.type in CLS_TYPES:
                    _extract_class(decl, symbols)

        # Classes
        if node.type in CLS_TYPES:
            _extract_class(node, symbols)
    return symbols


def _extract_class(node: Node, symbols: dict):
    cls_name_node = node.child_by_field_name("name")
    if not cls_name_node:
        return
    cls_name = text(cls_name_node)
    symbols[cls_name] = {
        "kind": "class", "signature": signature(node),
        "line_start": node.start_point[0] + 1, "line_end": node.end_point[0] + 1,
        "calls": [], "decorators": [],
    }
    body = node.child_by_field_name("body")
    if body:
        for m in body.children:
            if m.type == "method_definition":
                mn = m.child_by_field_name("name")
                if mn:
                    symbols[f"{cls_name}.{text(mn)}"] = {
                        "kind": "method", "signature": signature(m),
                        "line_start": m.start_point[0] + 1, "line_end": m.end_point[0] + 1,
                        "calls": collect_calls(m, CALL_TYPE, extract_call_name), "decorators": [],
                    }
