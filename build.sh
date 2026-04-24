#!/usr/bin/env bash
# Build script that handles conda + WSL pkg-config issues
set -e

export PKG_CONFIG_PATH=/usr/lib/x86_64-linux-gnu/pkgconfig:/usr/share/pkgconfig
export CC=/usr/bin/gcc
export CGO_CFLAGS="-DSQLITE_ENABLE_FTS5"
export CGO_LDFLAGS="-lm"

# Remove conda from PATH to avoid header conflicts
CLEAN_PATH=$(echo "$PATH" | tr ':' '\n' | grep -v conda | grep -v miniconda | tr '\n' ':')
export PATH="$CLEAN_PATH"

mkdir -p build/bin
echo "Building ReDo! v2..."
go build -tags "production webkit2_41" -ldflags="-s -w" -o build/bin/redo .
echo "Built: build/bin/redo ($(du -h build/bin/redo | cut -f1))"
