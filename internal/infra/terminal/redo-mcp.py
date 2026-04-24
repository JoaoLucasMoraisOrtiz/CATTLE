"""ReDo MCP Server — bridges AI agents with ReDo's knowledge base.

Tools:
  save_task_analysis: Save/update a task analysis → embed → store in KB
  search_knowledge: Search the KB for relevant context
  list_task_analyses: List existing task analyses for this project
"""
import json
import os
import sys
import hashlib
import sqlite3
import struct
import math
import requests
from mcp.server.fastmcp import FastMCP

REDO_DIR = os.path.expanduser("~/.redo")
DB_PATH = os.path.join(REDO_DIR, "redo.db")
EMBED_URL = "http://127.0.0.1:9999"
PROJECT = os.environ.get("REDO_PROJECT", "default")

mcp = FastMCP("redo")


def get_db():
    return sqlite3.connect(DB_PATH)


def embed_texts(texts):
    try:
        r = requests.post(f"{EMBED_URL}/embed", json={"texts": texts}, timeout=30)
        return r.json().get("embeddings", [])
    except Exception:
        return [None] * len(texts)


def encode_vec(v):
    if not v:
        return None
    return struct.pack(f"{len(v)}f", *v)


def content_hash(text):
    return hashlib.md5(text.encode()).hexdigest()


def chunk_text(text, size=1500):
    """Split by paragraphs, merge into chunks."""
    paragraphs = text.split("\n\n")
    chunks, current = [], []
    length = 0
    for p in paragraphs:
        p = p.strip()
        if not p:
            continue
        if length + len(p) > size and current:
            chunks.append("\n\n".join(current))
            current, length = [], 0
        current.append(p)
        length += len(p)
    if current:
        chunks.append("\n\n".join(current))
    return chunks


@mcp.tool()
def save_task_analysis(file_path: str, content: str = "") -> str:
    """Save or update a task analysis file. Embeds and stores in ReDo KB.
    
    Args:
        file_path: Path to the TASK_ANALYSIS_*.json file
        content: JSON content (if empty, reads from file_path)
    """
    if not content:
        try:
            with open(file_path) as f:
                content = f.read()
        except Exception as e:
            return f"error: cannot read {file_path}: {e}"

    # Write file if content provided
    if content:
        os.makedirs(os.path.dirname(file_path) or ".", exist_ok=True)
        with open(file_path, "w") as f:
            f.write(content)

    # Check if changed
    h = content_hash(content)
    db = get_db()
    existing = db.execute(
        "SELECT id FROM kb_chunks WHERE project=? AND source_file=? LIMIT 1",
        (PROJECT, file_path)
    ).fetchone()

    # Delete old chunks
    db.execute("DELETE FROM kb_fts WHERE rowid IN (SELECT id FROM kb_chunks WHERE project=? AND source_file=?)",
               (PROJECT, file_path))
    db.execute("DELETE FROM kb_chunks WHERE project=? AND source_file=?", (PROJECT, file_path))

    # Flatten JSON for better embedding
    try:
        data = json.loads(content)
        flat = flatten_task_analysis(data)
    except json.JSONDecodeError:
        flat = content

    # Chunk and embed
    chunks = chunk_text(flat)
    vecs = embed_texts(chunks)

    for i, (chunk, vec) in enumerate(zip(chunks, vecs)):
        cur = db.execute(
            "INSERT INTO kb_chunks (project, source_file, chunk_index, content, embedding) VALUES (?,?,?,?,?)",
            (PROJECT, file_path, i, chunk, encode_vec(vec))
        )
        db.execute("INSERT INTO kb_fts(rowid, content) VALUES (?,?)", (cur.lastrowid, chunk))

    db.commit()
    db.close()
    return f"ok: {len(chunks)} chunks indexed from {os.path.basename(file_path)}"


@mcp.tool()
def update_task_analysis(file_path: str, updates: str) -> str:
    """Update specific fields in an existing task analysis and re-index.
    
    Args:
        file_path: Path to the TASK_ANALYSIS_*.json file
        updates: JSON string with fields to update (merged into existing)
    """
    try:
        with open(file_path) as f:
            data = json.load(f)
    except Exception as e:
        return f"error: cannot read {file_path}: {e}"

    try:
        patch = json.loads(updates)
        deep_merge(data, patch)
    except json.JSONDecodeError as e:
        return f"error: invalid JSON updates: {e}"

    content = json.dumps(data, indent=2, ensure_ascii=False)
    return save_task_analysis(file_path, content)


@mcp.tool()
def search_knowledge(query: str, limit: int = 5) -> str:
    """Search ReDo's knowledge base for relevant context.
    
    Args:
        query: Search query
        limit: Max results (default 5)
    """
    db = get_db()
    
    # FTS search
    results = []
    try:
        rows = db.execute(
            """SELECT k.source_file, k.content, bm25(kb_fts) as score
               FROM kb_fts f JOIN kb_chunks k ON f.rowid = k.id
               WHERE k.project=? AND kb_fts MATCH ?
               ORDER BY score LIMIT ?""",
            (PROJECT, " OR ".join(f'"{w}"' for w in query.split() if len(w) >= 3), limit)
        ).fetchall()
        for source, content, score in rows:
            results.append({"source": os.path.basename(source), "content": content[:500], "score": round(-score, 2)})
    except Exception:
        pass

    # Embedding search if FTS returned few results
    if len(results) < limit:
        vecs = embed_texts([query])
        if vecs and vecs[0]:
            qvec = vecs[0]
            all_rows = db.execute(
                "SELECT source_file, content, embedding FROM kb_chunks WHERE project=?", (PROJECT,)
            ).fetchall()
            scored = []
            for source, content, emb_blob in all_rows:
                if not emb_blob:
                    continue
                emb = struct.unpack(f"{len(emb_blob)//4}f", emb_blob)
                cos = cosine_sim(qvec, emb)
                if cos > 0.3:
                    scored.append((source, content, cos))
            scored.sort(key=lambda x: -x[2])
            seen = {r["content"][:100] for r in results}
            for source, content, score in scored[:limit - len(results)]:
                if content[:100] not in seen:
                    results.append({"source": os.path.basename(source), "content": content[:500], "score": round(score, 2)})

    db.close()
    if not results:
        return "No results found."
    return json.dumps(results, indent=2, ensure_ascii=False)


@mcp.tool()
def list_task_analyses() -> str:
    """List all task analysis files indexed for this project."""
    db = get_db()
    rows = db.execute(
        "SELECT DISTINCT source_file FROM kb_chunks WHERE project=? AND source_file LIKE '%TASK_ANALYSIS%'",
        (PROJECT,)
    ).fetchall()
    db.close()
    if not rows:
        return "No task analyses found."
    return "\n".join(os.path.basename(r[0]) for r in rows)


def flatten_task_analysis(data, prefix=""):
    """Flatten a task analysis JSON into readable text for embedding."""
    lines = []
    if isinstance(data, dict):
        for k, v in data.items():
            if k == "subTarefas" and isinstance(v, list):
                for i, sub in enumerate(v):
                    lines.append(f"\n## Sub-task {i+1}: {sub.get('titulo', '')}")
                    lines.append(flatten_task_analysis(sub, prefix + "  "))
            elif isinstance(v, dict):
                lines.append(f"{prefix}{k}:")
                lines.append(flatten_task_analysis(v, prefix + "  "))
            elif isinstance(v, list):
                lines.append(f"{prefix}{k}: {', '.join(str(x) for x in v)}")
            else:
                lines.append(f"{prefix}{k}: {v}")
    return "\n".join(lines)


def deep_merge(base, patch):
    for k, v in patch.items():
        if k in base and isinstance(base[k], dict) and isinstance(v, dict):
            deep_merge(base[k], v)
        else:
            base[k] = v


def cosine_sim(a, b):
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    if na == 0 or nb == 0:
        return 0
    return dot / (na * nb)


if __name__ == "__main__":
    mcp.run(transport="stdio")
