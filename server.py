# /// script
# requires-python = ">=3.9"
# dependencies = [
#   "flask>=3.0",
# ]
# ///
"""
Danbooru Tag Explorer — local server
Serves static files + REST API for shared favorites/pins.

Usage:
  uv run server.py        (recommended — handles deps automatically)
  python server.py        (Flask must be installed manually)
"""

import json
import socket
import threading
import time
import webbrowser
from pathlib import Path

from flask import Flask, abort, jsonify, request, send_from_directory

# ── Config ───────────────────────────────────────────────────────────────────
BASE_DIR      = Path(__file__).parent
DATA_DIR      = BASE_DIR / "data"
SETTINGS_FILE = DATA_DIR / "settings.json"
PORT          = 8000
HOST          = "0.0.0.0"   # LAN アクセス可 (スマートフォン等から利用できます)

app = Flask(__name__, static_folder=str(BASE_DIR), static_url_path="")


# ── Utilities ─────────────────────────────────────────────────────────────────
def get_local_ip() -> str:
    """ルーティングテーブルを参照してLANのIPアドレスを取得する。"""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"


# ── Settings helpers ──────────────────────────────────────────────────────────
def load_settings() -> dict:
    if SETTINGS_FILE.exists():
        try:
            return json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"favTags": [], "pinnedCats": []}


def save_settings(data: dict):
    DATA_DIR.mkdir(exist_ok=True)
    SETTINGS_FILE.write_text(
        json.dumps(data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


# ── Static file serving ───────────────────────────────────────────────────────
@app.route("/")
def index():
    return send_from_directory(str(BASE_DIR), "index.html")


@app.route("/<path:path>")
def static_files(path):
    full = BASE_DIR / path
    if full.is_file():
        return send_from_directory(str(BASE_DIR), path)
    abort(404)


# ── API: GET /api/settings ────────────────────────────────────────────────────
@app.route("/api/settings", methods=["GET"])
def api_get_settings():
    return jsonify(load_settings())


# ── API: /api/favorites ───────────────────────────────────────────────────────
@app.route("/api/favorites", methods=["GET"])
def api_get_favorites():
    return jsonify(load_settings().get("favTags", []))


@app.route("/api/favorites", methods=["POST"])
def api_set_favorites():
    body = request.get_json(silent=True)
    if not isinstance(body, list):
        return jsonify({"error": "array expected"}), 400
    s = load_settings()
    s["favTags"] = body
    save_settings(s)
    return jsonify({"ok": True})


# ── API: /api/pins ────────────────────────────────────────────────────────────
@app.route("/api/pins", methods=["GET"])
def api_get_pins():
    return jsonify(load_settings().get("pinnedCats", []))


@app.route("/api/pins", methods=["POST"])
def api_set_pins():
    body = request.get_json(silent=True)
    if not isinstance(body, list):
        return jsonify({"error": "array expected"}), 400
    s = load_settings()
    s["pinnedCats"] = body
    save_settings(s)
    return jsonify({"ok": True})


# ── Main ──────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    local_ip = get_local_ip()
    local_url = f"http://localhost:{PORT}/"
    lan_url   = f"http://{local_ip}:{PORT}/"

    print()
    print("  Danbooru Tag Explorer")
    print(f"  このPC:           {local_url}")
    print(f"  スマートフォン等: {lan_url}")
    print("  停止: Ctrl+C")
    print()

    def _open():
        time.sleep(0.8)
        webbrowser.open(local_url)

    threading.Thread(target=_open, daemon=True).start()
    app.run(host=HOST, port=PORT, debug=False)
