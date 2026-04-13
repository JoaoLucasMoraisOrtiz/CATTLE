#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

case "${1:-web}" in
    web)  exec python3 "$SCRIPT_DIR/server.py" ;;
    tui)  exec python3 "$SCRIPT_DIR/app.py" ;;
    run)  exec python3 "$SCRIPT_DIR/orchestrator.py" "${@:2}" ;;
    *)    echo "Usage: $0 [web|tui|run <dir> <question>]" ;;
esac
