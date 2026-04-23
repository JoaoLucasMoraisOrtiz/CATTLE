"""Embedding + NLP server for ReDo! v2."""
from sentence_transformers import SentenceTransformer
from flask import Flask, request, jsonify
import sys

model = SentenceTransformer("nomic-ai/nomic-embed-text-v2-moe", trust_remote_code=True)
tokenizer = model.tokenizer
app = Flask(__name__)


@app.post("/embed")
def embed():
    texts = request.json.get("texts") or request.json.get("input", [])
    if isinstance(texts, str):
        texts = [texts]
    vecs = model.encode(texts, show_progress_bar=False).tolist()
    return jsonify({"embeddings": vecs})


@app.post("/tokenize")
def tokenize():
    """Count tokens for each text. Returns list of token counts."""
    texts = request.json.get("texts", [])
    if isinstance(texts, str):
        texts = [texts]
    counts = [len(tokenizer.encode(t)) for t in texts]
    return jsonify({"counts": counts, "total": sum(counts)})


@app.post("/summarize")
def summarize():
    """Summarize messages using Gemini API."""
    messages = request.json.get("messages", [])
    gemini_key = request.json.get("gemini_key", "")
    max_tokens = request.json.get("max_tokens", 500)

    if not messages:
        return jsonify({"summary": ""})

    # Format conversation
    conv = "\n".join(f"[{m.get('role','?')}] {m.get('content','')}" for m in messages)

    if gemini_key:
        summary = _summarize_gemini(conv, gemini_key, max_tokens)
    else:
        # Fallback: extractive summary (first + last lines of each message)
        summary = _summarize_extractive(messages, max_tokens)

    return jsonify({"summary": summary})


def _summarize_gemini(conv, key, max_tokens):
    import google.generativeai as genai
    genai.configure(api_key=key)
    m = genai.GenerativeModel("gemini-2.0-flash")
    prompt = (
        f"Summarize this conversation concisely for an AI coding assistant. "
        f"Keep key decisions, file paths, function names, and technical details. "
        f"Max {max_tokens} tokens.\n\n{conv}"
    )
    r = m.generate_content(prompt)
    return r.text


def _summarize_extractive(messages, max_tokens):
    """Simple fallback: keep first sentence of each message."""
    lines = []
    char_budget = max_tokens * 4
    total = 0
    for m in messages:
        first = m.get("content", "").split("\n")[0][:200]
        if total + len(first) > char_budget:
            break
        lines.append(f"[{m.get('role','?')}] {first}")
        total += len(first)
    return "\n".join(lines)


@app.post("/parse")
def parse_file():
    """Parse source file, extract symbols + calls via tree-sitter."""
    file_path = request.json.get("path", "")
    if not file_path:
        return jsonify({"symbols": []})
    import os
    ext = os.path.splitext(file_path)[1].lower()
    lang_map = {".py": "python", ".java": "java", ".go": "go",
                ".js": "javascript", ".jsx": "javascript",
                ".ts": "typescript", ".tsx": "typescript"}
    lang_name = lang_map.get(ext)
    if not lang_name:
        return jsonify({"symbols": []})
    try:
        import tree_sitter_languages
        parser = tree_sitter_languages.get_parser(lang_name)
        with open(file_path, "rb") as f:
            src = f.read()
        tree = parser.parse(src)
        symbols = []
        _walk_symbols(tree.root_node, src, os.path.basename(file_path), lang_name, symbols)
        return jsonify({"symbols": symbols})
    except Exception as e:
        return jsonify({"symbols": [], "error": str(e)})


def _walk_symbols(node, src, filename, lang, out):
    kind, name = None, None
    if lang == "python":
        if node.type == "function_definition": kind, name = "function", _nf(node, "name", src)
        elif node.type == "class_definition": kind, name = "class", _nf(node, "name", src)
    elif lang == "java":
        if node.type == "method_declaration": kind, name = "method", _nf(node, "name", src)
        elif node.type == "class_declaration": kind, name = "class", _nf(node, "name", src)
        elif node.type == "interface_declaration": kind, name = "interface", _nf(node, "name", src)
    elif lang == "go":
        if node.type == "function_declaration": kind, name = "function", _nf(node, "name", src)
        elif node.type == "method_declaration": kind, name = "method", _nf(node, "name", src)
        elif node.type == "type_spec": kind, name = "class", _nf(node, "name", src)
    elif lang in ("javascript", "typescript"):
        if node.type == "function_declaration": kind, name = "function", _nf(node, "name", src)
        elif node.type == "class_declaration": kind, name = "class", _nf(node, "name", src)
        elif node.type == "variable_declarator":
            val = node.child_by_field_name("value")
            if val and val.type in ("arrow_function", "function"):
                kind, name = "function", _nf(node, "name", src)
    if name:
        calls = []
        seen = set()
        _find_calls(node, src, seen, calls)
        out.append({"name": name, "kind": kind, "file": filename,
                     "start_line": node.start_point[0]+1, "end_line": node.end_point[0]+1, "calls": calls})
    for child in node.children:
        _walk_symbols(child, src, filename, lang, out)


def _nf(node, field, src):
    n = node.child_by_field_name(field)
    return n.text.decode() if n else None


def _find_calls(node, src, seen, out):
    # call_expression: Go, JS/TS, Python
    # method_invocation: Java
    if node.type in ("call_expression", "method_invocation"):
        fn = node.child_by_field_name("function") or node.child_by_field_name("name")
        if fn:
            name = fn.text.decode()
            if "." in name:
                name = name.rsplit(".", 1)[-1]
            if name not in seen and len(name) < 60:
                seen.add(name); out.append(name)
    for child in node.children:
        _find_calls(child, src, seen, out)


@app.get("/health")
def health():
    return "ok"


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 9999
    app.run(host="127.0.0.1", port=port)
