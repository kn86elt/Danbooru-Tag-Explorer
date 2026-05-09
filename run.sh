#!/usr/bin/env bash
# Danbooru Tag Explorer - startup script for macOS / Linux
set -euo pipefail

DANBOORU_CSV_URL="https://raw.githubusercontent.com/DominikDoom/a1111-sd-webui-tagcomplete/main/tags/danbooru.csv"
PORT=8000

echo "=============================================="
echo " Danbooru Tag Explorer"
echo "=============================================="
echo

# -- Create data directory ---------------------------------------------------
mkdir -p data

# -- Check required tag_tree.json --------------------------------------------
if [[ ! -f data/tag_tree.json ]]; then
    echo "[ERROR] data/tag_tree.json not found."
    echo "        This file is bundled with the project."
    echo "        To regenerate manually:"
    echo "          python3 tools/build_tag_tree.py --out data/tag_tree.json"
    exit 1
fi

# -- Download danbooru.csv if missing ----------------------------------------
if [[ ! -f data/danbooru.csv ]]; then
    echo "Downloading danbooru.csv..."
    if command -v curl &>/dev/null; then
        curl -fsSL "$DANBOORU_CSV_URL" -o data/danbooru.csv
    elif command -v wget &>/dev/null; then
        wget -q "$DANBOORU_CSV_URL" -O data/danbooru.csv
    else
        echo "[ERROR] Neither curl nor wget found."
        echo "        Install one of them and try again."
        exit 1
    fi
    echo "danbooru.csv downloaded."
    echo
fi

# -- Generate ja.csv if missing ----------------------------------------------
if [[ ! -f data/ja.csv ]] && [[ -f generate_ja.py ]]; then
    echo "Generating ja.csv..."
    if command -v uv &>/dev/null; then
        uv run generate_ja.py || echo "[WARN] Failed to generate ja.csv. Continuing without translations."
    else
        python3 generate_ja.py || echo "[WARN] Failed to generate ja.csv. Continuing without translations."
    fi
fi

# -- Check if port is already in use ----------------------------------------
if command -v lsof &>/dev/null; then
    if lsof -iTCP:"$PORT" -sTCP:LISTEN -t &>/dev/null; then
        echo "[WARN] Port $PORT is already in use."
        echo "       Please close the other application and try again."
        exit 1
    fi
elif command -v ss &>/dev/null; then
    if ss -tlnp | grep -q ":${PORT} "; then
        echo "[WARN] Port $PORT is already in use."
        echo "       Please close the other application and try again."
        exit 1
    fi
fi

# -- Launch: prefer uv, fall back to python3 + pip --------------------------
echo "Starting server..."
echo "Press Ctrl+C to stop."
echo

if command -v uv &>/dev/null; then
    uv run server.py
else
    echo "[INFO] uv not found. Falling back to pip."
    echo "       Install uv for automatic dependency management:"
    echo "       https://docs.astral.sh/uv/getting-started/installation/"
    echo

    if ! command -v python3 &>/dev/null; then
        echo "[ERROR] python3 not found."
        echo "        Install Python 3.9+ from https://www.python.org/"
        exit 1
    fi

    if ! python3 -c "import flask" &>/dev/null; then
        echo "Installing Flask..."
        python3 -m pip install flask --user --quiet
        echo "Flask installed."
        echo
    fi

    python3 server.py
fi
