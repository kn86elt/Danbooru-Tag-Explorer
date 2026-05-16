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
import urllib.request
import urllib.error
import webbrowser
from pathlib import Path

from flask import Flask, abort, jsonify, request, send_from_directory

# ── LLM プリセット ────────────────────────────────────────────────────────────
LLM_PRESETS = [
    {"id": "ollama",         "label": "Ollama",                "port": 11434, "path": "/v1", "key": "",          "supportsUnload": True},
    {"id": "lm-studio",      "label": "LM Studio",             "port": 1234,  "path": "/v1", "key": "lm-studio", "supportsUnload": True},
    {"id": "text-gen-webui", "label": "text-generation-webui", "port": 5000,  "path": "/v1", "key": "",          "supportsUnload": True},
    {"id": "koboldcpp",      "label": "KoboldCpp",             "port": 5001,  "path": "/v1", "key": "",          "supportsUnload": False},
    {"id": "llama-server",   "label": "llama.cpp server",      "port": 8080,  "path": "/v1", "key": "none",      "supportsUnload": False},
    {"id": "custom",         "label": "カスタム",              "port": None,  "path": "/v1", "key": "",          "supportsUnload": False},
]

def _http_get(url, timeout=5):
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))

def _http_post(url, body=None, timeout=10, extra_headers=None):
    data = json.dumps(body or {}).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if extra_headers:
        headers.update(extra_headers)
    req = urllib.request.Request(
        url, data=data, headers=headers, method="POST"
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))

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

# Default values injected into every settings response.
# _notes is always overwritten with canonical text (never user-edited).
_DEFAULTS: dict = {
    "favTags":    [],
    "pinnedCats": [],
    "tagCsv":     "data/danbooru.csv",
    "jaCsv":      "data/ja.csv",
    "llm": {
        "preset":  "ollama",
        "host":    "localhost",
        "port":    11434,
        "path":    "/v1",
        "apiKey":  "",
        "model":   "",
        "timeout": 30,
    },
    "_notes": {
        "tagCsv": "タグメタデータCSV (デフォルト: data/danbooru.csv)",
        "jaCsv":  "日本語訳CSV  (デフォルト: data/ja.csv)",
    },
}


def load_settings() -> dict:
    result = {k: v for k, v in _DEFAULTS.items()}  # shallow copy of defaults
    if SETTINGS_FILE.exists():
        try:
            saved = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
            # Merge saved values; _notes is always reset to canonical defaults
            result.update({k: v for k, v in saved.items() if k != "_notes"})
        except Exception:
            pass
    return result


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


@app.route("/api/settings", methods=["POST"])
def api_post_settings():
    body = request.get_json(silent=True) or {}
    s = load_settings()
    if isinstance(body.get("llm"), dict):
        llm = s.setdefault("llm", {})
        for k in ("preset", "host", "port", "path", "apiKey", "model", "timeout"):
            if k in body["llm"]:
                llm[k] = body["llm"][k]
    if isinstance(body.get("tagCsv"), str):
        s["tagCsv"] = body["tagCsv"]
    if isinstance(body.get("jaCsv"), str):
        s["jaCsv"] = body["jaCsv"]
    save_settings(s)
    return jsonify({"ok": True})


# ── API: /api/llm ─────────────────────────────────────────────────────────────
@app.route("/api/llm/models", methods=["GET"])
def api_llm_models():
    llm  = load_settings().get("llm", {})
    # クエリパラメータが渡された場合はそちらを優先（保存前のテスト用）
    host = (request.args.get("host") or llm.get("host") or "localhost").strip()
    port = int(request.args.get("port") or llm.get("port") or 11434)
    path = (request.args.get("path") or llm.get("path") or "/v1").rstrip("/")
    url  = f"http://{host}:{port}{path}/models"
    try:
        data   = _http_get(url, timeout=5)
        models = [m["id"] for m in data.get("data", []) if isinstance(m, dict) and "id" in m]
        return jsonify({"models": models, "error": None})
    except Exception as e:
        return jsonify({"models": [], "error": str(e)})


@app.route("/api/llm/unload", methods=["POST"])
def api_llm_unload():
    llm    = load_settings().get("llm", {})
    preset = llm.get("preset", "ollama")
    host   = (llm.get("host") or "localhost").strip()
    port   = llm.get("port") or 11434
    model  = (llm.get("model") or "").strip()
    base   = f"http://{host}:{port}"
    try:
        if preset == "ollama":
            if not model:
                return jsonify({"ok": False, "message": "モデル名が設定されていません"})
            _http_post(f"{base}/api/generate", {"model": model, "keep_alive": 0})
        elif preset == "lm-studio":
            data    = _http_get(f"{base}/api/v0/models", timeout=5)
            entries = data.get("data", data) if isinstance(data, dict) else data
            loaded  = [m for m in entries if isinstance(m, dict) and m.get("state") == "loaded"]
            if not loaded:
                return jsonify({"ok": False, "message": "ロード済みモデルが見つかりません"})
            iid = loaded[0].get("instance_id") or loaded[0].get("id") or ""
            _http_post(f"{base}/api/v1/models/unload", {"instance_id": iid})
        elif preset == "text-gen-webui":
            _http_post(f"{base}/v1/internal/model/unload")
        else:
            return jsonify({"ok": False, "message": f"プリセット '{preset}' はアンロードに対応していません"})
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "message": str(e)})


# ── API: /api/ai-translate ────────────────────────────────────────────────────
@app.route("/api/ai-translate", methods=["POST"])
def api_ai_translate():
    body    = request.get_json(silent=True) or {}
    text    = (body.get("text") or "").strip()
    if not text:
        return jsonify({"error": "text is required"}), 400
    llm     = load_settings().get("llm", {})
    host    = (llm.get("host")    or "localhost").strip()
    port    = int(llm.get("port") or 11434)
    path    = (llm.get("path")    or "/v1").rstrip("/")
    api_key = (llm.get("apiKey")  or "").strip()
    model   = (llm.get("model")   or "").strip()
    timeout = int(llm.get("timeout") or 30)
    if not model:
        return jsonify({"error": "モデルが設定されていません"}), 400
    url = f"http://{host}:{port}{path}/chat/completions"
    extra_headers = {}
    if api_key and api_key.lower() != "none":
        extra_headers["Authorization"] = f"Bearer {api_key}"
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": (
                "Convert Japanese text to English keywords for Danbooru image tags.\n"
                "For each concept output exactly one line: japanese_word: candidate1 | candidate2 | candidate3\n"
                "Provide up to 3 alternative English keywords separated by ' | '.\n"
                "IMPORTANT: Use the exact Japanese characters from the input. Do NOT convert to hiragana or katakana.\n"
                "Use plain English words (no underscores). No explanation."
            )},
            {"role": "user",   "content": text},
        ],
        "temperature": 0.3,
        "max_tokens":  300,
        "stream":      False,
    }
    try:
        result = _http_post(url, payload, timeout=timeout, extra_headers=extra_headers)
        tags = result["choices"][0]["message"]["content"].strip()
        return jsonify({"tags": tags})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


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
    # Migrate settings.json: inject new keys (tagCsv, jaCsv, _notes) if missing.
    save_settings(load_settings())
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

    
