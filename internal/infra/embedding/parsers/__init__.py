"""Language parser registry and entry point."""
from __future__ import annotations
from pathlib import Path
from tree_sitter import Language, Parser

import tree_sitter_javascript as _tsjs
import tree_sitter_typescript as _tsts
import tree_sitter_java as _tsjava
import tree_sitter_python as _tspy
import tree_sitter_php as _tsphp

from . import javascript, java, python_lang, php

LANGUAGES: dict[str, Language] = {
    "javascript": Language(_tsjs.language()),
    "typescript": Language(_tsts.language_typescript()),
    "tsx": Language(_tsts.language_tsx()),
    "java": Language(_tsjava.language()),
    "python": Language(_tspy.language()),
    "php": Language(_tsphp.language_php()),
}

# Each module must expose: extract_imports, extract_exports, extract_symbols
_PARSERS = {
    "javascript": javascript,
    "typescript": javascript,  # TS/TSX share JS parser
    "java": java,
    "python": python_lang,
    "php": php,
}


def parse_file(path: str, language: str) -> dict:
    """Parse a file and return structured info: imports, exports, symbols."""
    source = Path(path).read_bytes()
    lang_key = "tsx" if language == "typescript" and path.endswith(".tsx") else language
    lang = LANGUAGES[lang_key]
    parser = Parser(lang)
    tree = parser.parse(source)
    root = tree.root_node

    mod = _PARSERS.get(language)
    if not mod:
        return {"path": path, "language": language, "imports": [], "exports": [], "symbols": {}}

    return {
        "path": path,
        "language": language,
        "imports": mod.extract_imports(root),
        "exports": mod.extract_exports(root),
        "symbols": mod.extract_symbols(root),
    }
