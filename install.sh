#!/usr/bin/env bash
set -e

REDO_DIR="$HOME/.redo"
VENV_DIR="$REDO_DIR/embed-venv"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== ReDo! v2 — Install ==="

# 1. Create config dir
mkdir -p "$REDO_DIR"

# 2. Copy embed server script
cp "$SCRIPT_DIR/internal/infra/embedding/embed_server.py" "$REDO_DIR/embed_server.py"

# 3. Create venv + install deps
if [ ! -f "$VENV_DIR/bin/pip" ]; then
    echo "[1/3] Creating Python venv..."
    rm -rf "$VENV_DIR"
    python3 -m venv "$VENV_DIR"
    # Ensure pip exists
    if [ ! -f "$VENV_DIR/bin/pip" ]; then
        "$VENV_DIR/bin/python" -m ensurepip --upgrade
    fi
else
    echo "[1/3] Venv ready"
fi

echo "[2/3] Installing Python dependencies..."
"$VENV_DIR/bin/pip" install -q flask sentence-transformers einops pymupdf pillow google-generativeai tree-sitter==0.21.3 tree-sitter-languages

# 4. Pre-download the embedding model
echo "[3/3] Downloading embedding model (first time only)..."
"$VENV_DIR/bin/python" -c "
from sentence_transformers import SentenceTransformer
m = SentenceTransformer('nomic-ai/nomic-embed-text-v2-moe', trust_remote_code=True)
print('Model ready:', m.get_sentence_embedding_dimension(), 'dims')
"

echo ""
echo "=== Install complete ==="
echo "Configure MySQL DSN in $REDO_DIR/projects.json"
echo "Run 'wails dev' or the compiled binary to start"
