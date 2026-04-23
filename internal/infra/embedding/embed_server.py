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


@app.get("/health")
def health():
    return "ok"


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 9999
    app.run(host="127.0.0.1", port=port)
