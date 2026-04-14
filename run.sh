#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export PYTHONPATH="$SCRIPT_DIR"

case "${1:-web}" in
    web)  exec python3 -m app.main ;;
    tui)  exec python3 -m app.tui.app ;;
    run)  exec python3 -m app.services.orchestrator "${@:2}" ;;
    *)    echo "Usage: $0 [web|tui|run <dir> <question>]" ;;
esac
