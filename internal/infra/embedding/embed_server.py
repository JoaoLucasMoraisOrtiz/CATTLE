"""Minimal embedding server for ReDo! v2. Auto-installed by the Go app."""
from sentence_transformers import SentenceTransformer
from flask import Flask, request, jsonify
import sys

model = SentenceTransformer("nomic-ai/nomic-embed-text-v2-moe", trust_remote_code=True)
app = Flask(__name__)

@app.post("/embed")
def embed():
    texts = request.json.get("texts") or request.json.get("input", [])
    if isinstance(texts, str):
        texts = [texts]
    vecs = model.encode(texts, show_progress_bar=False).tolist()
    return jsonify({"embeddings": vecs})

@app.get("/health")
def health():
    return "ok"

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 9999
    app.run(host="127.0.0.1", port=port)
