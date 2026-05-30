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
import random
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
SKILLS_FILE       = DATA_DIR / "skills.json"
LLM_HISTORY_FILE  = DATA_DIR / "llm_history.json"
PORT          = 8000
HOST          = "0.0.0.0"   # LAN アクセス可 (スマートフォン等から利用できます)

app = Flask(__name__, static_folder=str(BASE_DIR), static_url_path="")

SYSTEM_PROMPT_FREE_DEFAULT = (
    "You are a helpful assistant. Keep your response concise and brief, within a few lines."
    "\nタグやプロンプトを列挙する場合は、コードブロック形式で出力してください。"
)

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
        "timeout": 120,
    },
    "_notes": {
        "tagCsv": "タグメタデータCSV (デフォルト: data/danbooru.csv)",
        "jaCsv":  "日本語訳CSV  (デフォルト: data/ja.csv)",
    },
    "systemPromptSlots":    [],
    "activeSystemPromptSlot": None,
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
    result["_systemPromptDefault"] = SYSTEM_PROMPT_FREE_DEFAULT
    return result


def save_settings(data: dict):
    DATA_DIR.mkdir(exist_ok=True)
    SETTINGS_FILE.write_text(
        json.dumps(data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


# ── Skills helpers ────────────────────────────────────────────────────────────

_DEFAULT_SKILLS = [
    {
        "id": "settings",
        "label": "設定",
        "description": "設定モーダルを開く",
        "content": None,
        "temperature": None,
        "type": "system",
        "specialType": "settings",
    },
    {
        "id": "history",
        "label": "履歴",
        "description": "過去に送信した指示を呼び出す",
        "content": None,
        "temperature": None,
        "type": "system",
        "specialType": "history",
    },
    {
        "id": "tag-classify",
        "label": "分類",
        "description": "",
        "content": "以下のタグを意味ごとに分類して、意味ごとに別々のコードブロックで出力して。\n単語の区切りのアンダーバー_はスペースに置換、タグとタグの間はカンマで区切って。",
        "temperature": None,
        "type": "system",
    },
    {
        "id": "motif",
        "label": "モチーフ",
        "description": "",
        "content": "女の子をモチーフにイラストのシチュエーションをいくつか考えて、その絵を再現するための要素をdanbooruタグで列挙しそれぞれ別のコードブロックで出力。解説は不要。服、物体など構成要素すべてdanbooru tagに分解して列挙する。女の子のポーズも考える（手、姿勢、表情など）。",
        "temperature": None,
        "type": "system",
    },
    {
        "id": "fashion",
        "label": "ファッション",
        "description": "",
        "content": "流行の夏向けファッションのStable Diffusion用プロンプトを数パターン考えて、利用しやすいようパターンごとに別々のcodeblockとして出力。プロンプトにはdanbooruタグ使用しカンマ区切りで列挙、単語区切りはアンダーバーではなくスペース、服装と無関係な要素（人物、背景、環境）は出力しない。曖昧な装飾語(cute、beautiful等)を使用しない。",
        "temperature": None,
        "type": "system",
    },
    {
        "id": "danbooru",
        "label": "Danbooruタグ選択",
        "description": "日本語テキストからDanbooruタグを検索・選択します（ツール呼び出し）",
        "content": None,
        "temperature": None,
        "type": "system",
        "toolCalling": True,
    },
]


def load_skills() -> list:
    if SKILLS_FILE.exists():
        try:
            return json.loads(SKILLS_FILE.read_text(encoding="utf-8")).get("skills", [])
        except Exception:
            pass
    return [dict(s) for s in _DEFAULT_SKILLS]


def save_skills(skills: list):
    DATA_DIR.mkdir(exist_ok=True)
    SKILLS_FILE.write_text(
        json.dumps({"skills": skills}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def ensure_skills():
    current = load_skills()
    current_ids = {s.get("id") for s in current}
    missing = [s for s in _DEFAULT_SKILLS if s["id"] not in current_ids]
    if not SKILLS_FILE.exists() or missing:
        user_skills   = [s for s in current if s.get("type") != "system"]
        existing_sys  = {s["id"]: s for s in current if s.get("type") == "system"}
        merged_sys    = [existing_sys.get(d["id"], dict(d)) for d in _DEFAULT_SKILLS]
        save_skills(merged_sys + user_skills)


# ── LLM 履歴 helpers ─────────────────────────────────────────────────────────

def load_llm_history() -> list:
    if LLM_HISTORY_FILE.exists():
        try:
            return json.loads(LLM_HISTORY_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return []


def save_llm_history(history: list):
    DATA_DIR.mkdir(exist_ok=True)
    LLM_HISTORY_FILE.write_text(
        json.dumps(history, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


# ── Danbooru CSV index（遅延ロード）──────────────────────────────────────────

_tag_index: list | None = None


def _load_tag_index() -> list:
    global _tag_index
    if _tag_index is not None:
        return _tag_index
    cfg_path = load_settings().get("tagCsv", "data/danbooru.csv")
    csv_path = BASE_DIR / cfg_path
    rows = []
    if csv_path.is_file():
        import csv as _csv
        with open(csv_path, encoding="utf-8", newline="") as f:
            for row in _csv.reader(f):
                if len(row) >= 3:
                    name = row[0].strip()
                    cnt  = int(row[2]) if row[2].strip().isdigit() else 0
                    rows.append((name, cnt))
    _tag_index = rows
    return _tag_index


def _search_tags(query: str, limit: int = 15) -> list:
    q = query.lower().replace(" ", "_")
    hits = [(name, cnt) for name, cnt in _load_tag_index() if q in name.lower()]
    hits.sort(key=lambda x: x[1], reverse=True)
    return [{"tag": name, "post_count": cnt} for name, cnt in hits[:limit]]


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
    if isinstance(body.get("systemPromptSlots"), list):
        s["systemPromptSlots"] = body["systemPromptSlots"]
    if "activeSystemPromptSlot" in body:
        s["activeSystemPromptSlot"] = body["activeSystemPromptSlot"] or None
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
    free_mode = "systemPrompt" in body
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
    if free_mode:
        sp = (body.get("systemPrompt") or "").strip()
        if sp:
            system_content = sp + "\nタグやプロンプトを列挙する場合は、コードブロック形式で出力してください。"
        else:
            cfg = load_settings()
            active_id = cfg.get("activeSystemPromptSlot")
            if active_id:
                slot = next((x for x in cfg.get("systemPromptSlots", []) if x.get("id") == active_id), None)
                system_content = slot["content"] if slot and slot.get("content") else SYSTEM_PROMPT_FREE_DEFAULT
            else:
                system_content = SYSTEM_PROMPT_FREE_DEFAULT
        temperature = 0.9
        max_tokens  = 800
        custom_temp = body.get("temperature")
        if isinstance(custom_temp, (int, float)) and 0.0 <= custom_temp <= 2.0:
            temperature = float(custom_temp)
    else:
        count = max(1, min(int(body.get("count") or 3), 10))
        cand_ex = " | ".join(f"candidate{i+1}" for i in range(count))
        system_content = (
            "Convert Japanese text to English keywords for Danbooru image tags.\n"
            f"For each concept output exactly one line: japanese_word: {cand_ex}\n"
            f"Provide up to {count} alternative English keywords separated by ' | '.\n"
            "IMPORTANT: Use the exact Japanese characters from the input. Do NOT convert to hiragana or katakana.\n"
            "Use plain English words (no underscores). No explanation."
        )
        temperature = 0.6
        max_tokens  = 150 + count * 30
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_content},
            {"role": "user",   "content": text},
        ],
        "temperature": temperature,
        "max_tokens":  max_tokens,
        "seed":        random.randint(0, 2**31 - 1) if free_mode else None,
        "stream":      False,
    }
    if payload["seed"] is None:
        del payload["seed"]
    try:
        result = _http_post(url, payload, timeout=timeout, extra_headers=extra_headers)
        content = result["choices"][0]["message"]["content"].strip()
        if free_mode:
            return jsonify({"reply": content})
        return jsonify({"tags": content})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── API: /api/llm-history ────────────────────────────────────────────────────
@app.route("/api/llm-history", methods=["GET"])
def api_get_llm_history():
    return jsonify(load_llm_history())


@app.route("/api/llm-history", methods=["POST"])
def api_post_llm_history():
    body    = request.get_json(silent=True) or {}
    content = (body.get("content") or "").strip()
    if not content:
        return jsonify({"error": "content required"}), 400
    history = load_llm_history()
    history = [h for h in history if h != content]
    history.insert(0, content)
    history = history[:10]
    save_llm_history(history)
    return jsonify({"ok": True})


# ── API: /api/skills ─────────────────────────────────────────────────────────
@app.route("/api/skills", methods=["GET"])
def api_get_skills():
    return jsonify(load_skills())


@app.route("/api/skills", methods=["POST"])
def api_post_skills():
    body = request.get_json(silent=True) or {}
    user_skills = body.get("skills")
    if not isinstance(user_skills, list):
        return jsonify({"error": "skills array required"}), 400
    current = load_skills()
    system_skills = [s for s in current if s.get("type") == "system"]
    for s in user_skills:
        if not isinstance(s.get("id"), str) or not s["id"].strip():
            return jsonify({"error": "各スキルに id が必要です"}), 400
        if not isinstance(s.get("label"), str) or not s["label"].strip():
            return jsonify({"error": "各スキルに label が必要です"}), 400
        s["type"] = "user"
    save_skills(system_skills + user_skills)
    return jsonify({"ok": True})


# ── API: /api/ai-tag-select ───────────────────────────────────────────────────
@app.route("/api/ai-tag-select", methods=["POST"])
def api_ai_tag_select():
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
    timeout = int(llm.get("timeout") or 60)
    if not model:
        return jsonify({"error": "モデルが設定されていません"}), 400
    url = f"http://{host}:{port}{path}/chat/completions"
    extra_headers = {}
    if api_key and api_key.lower() != "none":
        extra_headers["Authorization"] = f"Bearer {api_key}"
    tools = [
        {
            "type": "function",
            "function": {
                "name": "search_tags",
                "description": "Search Danbooru tags by English keyword. Call for each concept. Returns matching tags sorted by post count.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "English keyword (e.g. 'cat ears', 'long hair')"}
                    },
                    "required": ["query"],
                },
            },
        }
    ]
    system_prompt = (
        "You are a Danbooru tag expert. Given Japanese text, identify each visual concept "
        "and call search_tags for each one to find the best matching Danbooru tag. "
        "After searching, output only the selected tags as a comma-separated list. No explanation."
    )
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user",   "content": text},
    ]
    try:
        for _ in range(8):
            payload = {
                "model":       model,
                "messages":    messages,
                "tools":       tools,
                "tool_choice": "auto",
                "temperature": 0.1,
                "max_tokens":  400,
                "stream":      False,
            }
            result     = _http_post(url, payload, timeout=timeout, extra_headers=extra_headers)
            message    = result["choices"][0]["message"]
            tool_calls = message.get("tool_calls") or []
            if not tool_calls:
                content = (message.get("content") or "").strip()
                return jsonify({"reply": content})
            messages.append({
                "role":       "assistant",
                "content":    message.get("content") or "",
                "tool_calls": tool_calls,
            })
            for tc in tool_calls:
                fn   = tc.get("function", {})
                args = json.loads(fn.get("arguments", "{}"))
                hits = _search_tags(args.get("query", ""))
                result_text = "\n".join(
                    f"{h['tag']} ({h['post_count']} posts)" for h in hits
                ) or "No results found."
                messages.append({
                    "role":         "tool",
                    "tool_call_id": tc.get("id", ""),
                    "content":      result_text,
                })
        return jsonify({"error": "ツール呼び出しループが上限に達しました"}), 500
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
    ensure_skills()
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

    
