# -*- coding: utf-8 -*-
"""
Danbooru Tag Explorer -- A1111 / reForge extension entry point

Place the entire danbooru_tag_explorer/ folder inside A1111's extensions/ folder
and restart the WebUI. A "Tag Explorer" tab will appear.

Standalone operation (server.py / run.bat) is not affected.

[danbooru.csv resolution order]
  1. A1111 Settings (Settings > Danbooru Tag Explorer) で指定されたパス
  2. data/danbooru.csv inside this extension folder -> use it
  3. a1111-sd-webui-tagcomplete installed and has CSV -> borrow it
  4. Neither found -> 404 (run standalone once, or install tagcomplete)

[ja.csv resolution order]
  1. A1111 Settings (Settings > Danbooru Tag Explorer) で指定されたパス
  2. data/ja.csv inside this extension folder -> use it
  3. Neither found -> 日本語訳なしで起動

A1111モードでは CSV は専用エンドポイント (/api/csv/danbooru, /api/csv/ja) 経由で
配信する。settings.json の tagCsv / jaCsv フィールドはフロントエンドから無視される。
"""

import json
import random
import re
import traceback
import urllib.request
import urllib.error
from pathlib import Path

# FastAPI is imported at module level so that Request (and other types) are in
# the global namespace when FastAPI inspects route handler signatures.
# Wrapped in try/except so the module can be imported outside A1111 without crashing.
try:
    from fastapi import Request
    from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
    _FASTAPI_OK = True
except Exception:
    _FASTAPI_OK = False

# ---- Path definitions -------------------------------------------------------
BASE_DIR      = Path(__file__).parent.parent.resolve()
DATA_DIR      = BASE_DIR / "data"
SETTINGS_FILE = DATA_DIR / "settings.json"
SKILLS_FILE       = DATA_DIR / "skills.json"
LLM_HISTORY_FILE  = DATA_DIR / "llm_history.json"
ROUTE_PREFIX  = "/danbooru_tag_explorer"

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


_TAGCOMPLETE_CSV_CANDIDATES = [
    "a1111-sd-webui-tagcomplete/tags/danbooru.csv",
    "sd-webui-tagcomplete/tags/danbooru.csv",
]


# ---- tagcomplete CSV detection ----------------------------------------------
def find_tagcomplete_csv():
    extensions_dir = BASE_DIR.parent
    for rel in _TAGCOMPLETE_CSV_CANDIDATES:
        candidate = extensions_dir / rel
        if candidate.is_file():
            return candidate.resolve()
    return None


def _get_shared_opt(name: str) -> str:
    """A1111 の shared.opts から設定値を取得する。利用不可の場合は空文字を返す。"""
    try:
        from modules import shared  # type: ignore
        return (getattr(shared.opts, name, None) or "").strip()
    except Exception:
        return ""


def resolve_danbooru_csv():
    """danbooru.csv のパスを解決する。shared.opts -> ローカル -> tagcomplete の順で探す。"""
    custom = _get_shared_opt("dte_tag_csv")
    if custom:
        p = Path(custom)
        if not p.is_absolute():
            p = BASE_DIR / p
        if p.is_file():
            return p.resolve()
    local = DATA_DIR / "danbooru.csv"
    if local.is_file():
        return local
    return find_tagcomplete_csv()


def resolve_ja_csv():
    """ja.csv のパスを解決する。shared.opts -> ローカルの順で探す。"""
    custom = _get_shared_opt("dte_ja_csv")
    if custom:
        p = Path(custom)
        if not p.is_absolute():
            p = BASE_DIR / p
        if p.is_file():
            return p.resolve()
    local = DATA_DIR / "ja.csv"
    if local.is_file():
        return local
    return None


# ---- Skills helpers ---------------------------------------------------------
_DEFAULT_SKILLS = [
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


def load_skills():
    if SKILLS_FILE.exists():
        try:
            return json.loads(SKILLS_FILE.read_text(encoding="utf-8")).get("skills", [])
        except Exception:
            pass
    return [dict(s) for s in _DEFAULT_SKILLS]


def save_skills(skills):
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
        user_skills  = [s for s in current if s.get("type") != "system"]
        existing_sys = {s["id"]: s for s in current if s.get("type") == "system"}
        merged_sys   = [existing_sys.get(d["id"], dict(d)) for d in _DEFAULT_SKILLS]
        save_skills(merged_sys + user_skills)


# ---- LLM 履歴 helpers -------------------------------------------------------

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


# ---- Danbooru CSV index（遅延ロード）----------------------------------------
_tag_index = None


def _load_tag_index():
    global _tag_index
    if _tag_index is not None:
        return _tag_index
    csv_path = resolve_danbooru_csv()
    rows = []
    if csv_path is not None and csv_path.is_file():
        import csv as _csv
        with open(csv_path, encoding="utf-8", newline="") as f:
            for row in _csv.reader(f):
                if len(row) >= 3:
                    name = row[0].strip()
                    cnt  = int(row[2]) if row[2].strip().isdigit() else 0
                    rows.append((name, cnt))
    _tag_index = rows
    return _tag_index


def _search_tags(query, limit=15):
    q = query.lower().replace(" ", "_")
    hits = [(name, cnt) for name, cnt in _load_tag_index() if q in name.lower()]
    hits.sort(key=lambda x: x[1], reverse=True)
    return [{"tag": name, "post_count": cnt} for name, cnt in hits[:limit]]


# ---- Settings helpers -------------------------------------------------------
_DEFAULTS = {
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
        "tagCsv": "Tag metadata CSV (default: data/danbooru.csv) -- A1111モードでは無視される",
        "jaCsv":  "Japanese translation CSV (default: data/ja.csv) -- A1111モードでは無視される",
    },
}


def load_settings():
    result = {k: v for k, v in _DEFAULTS.items()}
    if SETTINGS_FILE.exists():
        try:
            saved = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
            result.update({k: v for k, v in saved.items() if k != "_notes"})
        except Exception:
            pass
    return result


def save_settings(data):
    DATA_DIR.mkdir(exist_ok=True)
    SETTINGS_FILE.write_text(
        json.dumps(data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


# ---- index.html with A1111 patches -----------------------------------------
def _file_version(filename: str) -> str:
    """ファイルの mtime を整数文字列で返す。ファイルが存在しない場合は '0'。"""
    p = BASE_DIR / filename
    return str(int(p.stat().st_mtime)) if p.is_file() else "0"


def build_index_html():
    html = (BASE_DIR / "index.html").read_text(encoding="utf-8")

    # CSS / JS の URL にファイル mtime をクエリとして付加する（キャッシュバスティング）。
    # ファイルが更新されると URL が変わり、ブラウザは必ず新しいファイルを取得する。
    def versioned(match: re.Match) -> str:
        attr, filename = match.group(1), match.group(2)
        ver = _file_version(filename)
        return f'{attr}="{filename}?v={ver}"'

    html = re.sub(r'(href)="([\w./][\w./]*\.css)"',  versioned, html)
    html = re.sub(r'(src)="([\w./][\w./]*\.js)"',    versioned, html)

    injection = (
        '  <base href="' + ROUTE_PREFIX + '/">\n'
        "  <script>\n"
        "    window.__DTE_MODE__ = 'a1111';\n"
        "    // A1111 extension: default to light theme on first visit\n"
        "    if (!localStorage.getItem('theme')) {\n"
        "      localStorage.setItem('theme', 'light');\n"
        "    }\n"
        "  </script>"
    )
    return html.replace("<head>", "<head>\n" + injection, 1)


# ---- FastAPI route registration ---------------------------------------------
def on_app_started(demo, app):
    if not _FASTAPI_OK:
        print("[Danbooru Tag Explorer] FastAPI not available -- extension disabled.")
        return

    try:
        ensure_skills()

        csv_path = resolve_danbooru_csv()
        if csv_path is None:
            print(
                "[Danbooru Tag Explorer] danbooru.csv not found. "
                "Run standalone (run.bat) once to download it, or install tagcomplete."
            )
        elif _get_shared_opt("dte_tag_csv"):
            print("[Danbooru Tag Explorer] danbooru.csv: A1111 Settings で指定 (" + str(csv_path) + ")")
        elif (DATA_DIR / "danbooru.csv").is_file():
            print("[Danbooru Tag Explorer] danbooru.csv: local copy (" + str(csv_path) + ")")
        else:
            print("[Danbooru Tag Explorer] danbooru.csv: from tagcomplete (" + str(csv_path) + ")")

        ja_path = resolve_ja_csv()
        if ja_path is None:
            print("[Danbooru Tag Explorer] ja.csv not found (日本語訳なしで起動します)")
        elif _get_shared_opt("dte_ja_csv"):
            print("[Danbooru Tag Explorer] ja.csv: A1111 Settings で指定 (" + str(ja_path) + ")")
        else:
            print("[Danbooru Tag Explorer] ja.csv: " + str(ja_path))

        @app.get(ROUTE_PREFIX + "/")
        def dte_index():
            try:
                return HTMLResponse(build_index_html())
            except Exception as exc:
                return HTMLResponse(
                    "<pre>Danbooru Tag Explorer error: " + str(exc) + "</pre>",
                    status_code=500,
                )

        @app.get(ROUTE_PREFIX + "/api/settings")
        def dte_get_settings():
            s = load_settings()
            # A1111モードではCSVは専用エンドポイント(/api/csv/*)で配信するため
            # settings.json の tagCsv / jaCsv はフロントエンドから無視される。
            s["_mode"] = "a1111"
            actual = resolve_danbooru_csv()
            if actual is None:
                s["_info"] = {"csvSource": "missing"}
            elif _get_shared_opt("dte_tag_csv"):
                s["_info"] = {"csvSource": "custom", "csvPath": str(actual)}
            elif (DATA_DIR / "danbooru.csv").is_file():
                s["_info"] = {"csvSource": "local"}
            else:
                s["_info"] = {"csvSource": "tagcomplete", "csvPath": str(actual)}
            return JSONResponse(s)

        @app.get(ROUTE_PREFIX + "/api/csv/danbooru")
        def dte_csv_danbooru():
            """danbooru.csv を配信する。shared.opts -> ローカル -> tagcomplete の順で解決。"""
            path = resolve_danbooru_csv()
            if path is None:
                return JSONResponse({"error": "danbooru.csv not found"}, status_code=404)
            return FileResponse(str(path), media_type="text/plain; charset=utf-8")

        @app.get(ROUTE_PREFIX + "/api/csv/ja")
        def dte_csv_ja():
            """ja.csv を配信する。shared.opts -> ローカルの順で解決。"""
            path = resolve_ja_csv()
            if path is None:
                return JSONResponse({"error": "ja.csv not found"}, status_code=404)
            return FileResponse(str(path), media_type="text/plain; charset=utf-8")

        @app.get(ROUTE_PREFIX + "/api/favorites")
        def dte_get_favorites():
            return JSONResponse(load_settings().get("favTags", []))

        @app.post(ROUTE_PREFIX + "/api/favorites")
        async def dte_set_favorites(request: Request):
            try:
                body = await request.json()
            except Exception:
                return JSONResponse({"error": "invalid JSON"}, status_code=400)
            if not isinstance(body, list):
                return JSONResponse({"error": "array expected"}, status_code=400)
            s = load_settings()
            s["favTags"] = body
            save_settings(s)
            return JSONResponse({"ok": True})

        @app.get(ROUTE_PREFIX + "/api/pins")
        def dte_get_pins():
            return JSONResponse(load_settings().get("pinnedCats", []))

        @app.post(ROUTE_PREFIX + "/api/pins")
        async def dte_set_pins(request: Request):
            try:
                body = await request.json()
            except Exception:
                return JSONResponse({"error": "invalid JSON"}, status_code=400)
            if not isinstance(body, list):
                return JSONResponse({"error": "array expected"}, status_code=400)
            s = load_settings()
            s["pinnedCats"] = body
            save_settings(s)
            return JSONResponse({"ok": True})

        @app.post(ROUTE_PREFIX + "/api/settings")
        async def dte_post_settings(request: Request):
            try:
                body = await request.json()
            except Exception:
                return JSONResponse({"error": "invalid JSON"}, status_code=400)
            s = load_settings()
            if isinstance(body.get("llm"), dict):
                llm = s.setdefault("llm", {})
                for k in ("preset", "host", "port", "path", "apiKey", "model", "timeout"):
                    if k in body["llm"]:
                        llm[k] = body["llm"][k]
            # A1111モードでは tagCsv/jaCsv は A1111 Settings が管理するため保存しない
            save_settings(s)
            return JSONResponse({"ok": True})

        @app.get(ROUTE_PREFIX + "/api/llm/models")
        def dte_llm_models(request: Request):
            llm  = load_settings().get("llm", {})
            host = (request.query_params.get("host") or llm.get("host") or "localhost").strip()
            port = int(request.query_params.get("port") or llm.get("port") or 11434)
            path = (request.query_params.get("path") or llm.get("path") or "/v1").rstrip("/")
            url  = f"http://{host}:{port}{path}/models"
            try:
                data   = _http_get(url, timeout=5)
                models = [m["id"] for m in data.get("data", []) if isinstance(m, dict) and "id" in m]
                return JSONResponse({"models": models, "error": None})
            except Exception as e:
                return JSONResponse({"models": [], "error": str(e)})

        @app.post(ROUTE_PREFIX + "/api/llm/unload")
        def dte_llm_unload():
            llm    = load_settings().get("llm", {})
            preset = llm.get("preset", "ollama")
            host   = (llm.get("host") or "localhost").strip()
            port   = llm.get("port") or 11434
            model  = (llm.get("model") or "").strip()
            base   = f"http://{host}:{port}"
            try:
                if preset == "ollama":
                    if not model:
                        return JSONResponse({"ok": False, "message": "モデル名が設定されていません"})
                    _http_post(f"{base}/api/generate", {"model": model, "keep_alive": 0})
                elif preset == "lm-studio":
                    data    = _http_get(f"{base}/api/v0/models", timeout=5)
                    entries = data.get("data", data) if isinstance(data, dict) else data
                    loaded  = [m for m in entries if isinstance(m, dict) and m.get("state") == "loaded"]
                    if not loaded:
                        return JSONResponse({"ok": False, "message": "ロード済みモデルが見つかりません"})
                    iid = loaded[0].get("instance_id") or loaded[0].get("id") or ""
                    _http_post(f"{base}/api/v1/models/unload", {"instance_id": iid})
                elif preset == "text-gen-webui":
                    _http_post(f"{base}/v1/internal/model/unload")
                else:
                    return JSONResponse({"ok": False, "message": f"プリセット '{preset}' はアンロードに対応していません"})
                return JSONResponse({"ok": True})
            except Exception as e:
                return JSONResponse({"ok": False, "message": str(e)})

        @app.post(ROUTE_PREFIX + "/api/ai-translate")
        async def dte_ai_translate(request: Request):
            body    = await request.json()
            text    = (body.get("text") or "").strip()
            if not text:
                return JSONResponse({"error": "text is required"}, status_code=400)
            free_mode = "systemPrompt" in body
            llm     = load_settings().get("llm", {})
            host    = (llm.get("host")    or "localhost").strip()
            port    = int(llm.get("port") or 11434)
            path    = (llm.get("path")    or "/v1").rstrip("/")
            api_key = (llm.get("apiKey")  or "").strip()
            model   = (llm.get("model")   or "").strip()
            timeout = int(llm.get("timeout") or 30)
            if not model:
                return JSONResponse({"error": "モデルが設定されていません"}, status_code=400)
            url = f"http://{host}:{port}{path}/chat/completions"
            extra_headers = {}
            if api_key and api_key.lower() != "none":
                extra_headers["Authorization"] = f"Bearer {api_key}"
            if free_mode:
                sp = (body.get("systemPrompt") or "").strip()
                system_content = sp if sp else "You are a helpful assistant. Keep your response concise and brief, within a few lines."
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
                    return JSONResponse({"reply": content})
                return JSONResponse({"tags": content})
            except Exception as e:
                return JSONResponse({"error": str(e)}, status_code=500)

        @app.get(ROUTE_PREFIX + "/api/llm-history")
        def dte_get_llm_history():
            return JSONResponse(load_llm_history())

        @app.post(ROUTE_PREFIX + "/api/llm-history")
        async def dte_post_llm_history(request: Request):
            try:
                body = await request.json()
            except Exception:
                return JSONResponse({"error": "invalid JSON"}, status_code=400)
            content = (body.get("content") or "").strip()
            if not content:
                return JSONResponse({"error": "content required"}, status_code=400)
            history = load_llm_history()
            history = [h for h in history if h != content]
            history.insert(0, content)
            history = history[:10]
            save_llm_history(history)
            return JSONResponse({"ok": True})

        @app.get(ROUTE_PREFIX + "/api/skills")
        def dte_get_skills():
            return JSONResponse(load_skills())

        @app.post(ROUTE_PREFIX + "/api/skills")
        async def dte_post_skills(request: Request):
            try:
                body = await request.json()
            except Exception:
                return JSONResponse({"error": "invalid JSON"}, status_code=400)
            user_skills = body.get("skills")
            if not isinstance(user_skills, list):
                return JSONResponse({"error": "skills array required"}, status_code=400)
            current = load_skills()
            system_skills = [s for s in current if s.get("type") == "system"]
            for s in user_skills:
                if not isinstance(s.get("id"), str) or not s["id"].strip():
                    return JSONResponse({"error": "各スキルに id が必要です"}, status_code=400)
                if not isinstance(s.get("label"), str) or not s["label"].strip():
                    return JSONResponse({"error": "各スキルに label が必要です"}, status_code=400)
                s["type"] = "user"
            save_skills(system_skills + user_skills)
            return JSONResponse({"ok": True})

        @app.post(ROUTE_PREFIX + "/api/ai-tag-select")
        async def dte_ai_tag_select(request: Request):
            body    = await request.json()
            text    = (body.get("text") or "").strip()
            if not text:
                return JSONResponse({"error": "text is required"}, status_code=400)
            llm     = load_settings().get("llm", {})
            host    = (llm.get("host")    or "localhost").strip()
            port    = int(llm.get("port") or 11434)
            path    = (llm.get("path")    or "/v1").rstrip("/")
            api_key = (llm.get("apiKey")  or "").strip()
            model   = (llm.get("model")   or "").strip()
            timeout = int(llm.get("timeout") or 60)
            if not model:
                return JSONResponse({"error": "モデルが設定されていません"}, status_code=400)
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
                        return JSONResponse({"reply": content})
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
                return JSONResponse({"error": "ツール呼び出しループが上限に達しました"}, status_code=500)
            except Exception as e:
                return JSONResponse({"error": str(e)}, status_code=500)

        @app.get(ROUTE_PREFIX + "/{path:path}")
        def dte_static(path: str):
            target = (BASE_DIR / path).resolve()
            if not target.is_relative_to(BASE_DIR):
                return JSONResponse({"error": "not found"}, status_code=404)
            if target.is_file():
                resp = FileResponse(str(target))
                # JS/CSS はブラウザにキャッシュさせない。
                # これにより A1111 再起動後に必ず最新ファイルが読み込まれる。
                if path.endswith((".js", ".css")):
                    resp.headers["Cache-Control"] = "no-cache, must-revalidate"
                return resp
            return JSONResponse({"error": "not found"}, status_code=404)

    except Exception:
        print("[Danbooru Tag Explorer] on_app_started error:")
        traceback.print_exc()


# ---- Gradio tab HTML --------------------------------------------------------
def _build_ui_html():
    # iframe height: use calc(100vh - OFFSET) to fill the visible tab area.
    # Gradio tab panels use height:auto so measurement-based approaches fail.
    # OFFSET covers browser chrome + A1111 top bar + tab row (~220px total).
    #
    # Scroll focus: listen for mouseleave on the wrapper div to release scroll
    # focus from the iframe contentWindow back to the parent window.
    prefix = ROUTE_PREFIX
    IFRAME_OFFSET = 220  # px; tune if the iframe is too tall or too short

    return (
        "<style>\n"
        "  #dte-wrap  { width:100%; height:calc(100vh - " + str(IFRAME_OFFSET) + "px);"
        " min-height:400px; overflow:hidden; }\n"
        "  #dte-frame { width:100%; height:100%; border:none; display:block; }\n"
        "</style>\n"
        '<div id="dte-wrap">\n'
        '  <iframe id="dte-frame"\n'
        '          src="' + prefix + '/"\n'
        '          allow="clipboard-write">\n'
        "  </iframe>\n"
        "</div>\n"
        "<script>\n"
        "(function () {\n"
        "  var wrap  = document.getElementById('dte-wrap');\n"
        "  var frame = document.getElementById('dte-frame');\n"
        "  if (!wrap || !frame) return;\n"
        "  wrap.addEventListener('mouseleave', function () {\n"
        "    try { frame.contentWindow.blur(); } catch (e) {}\n"
        "    try { window.focus(); } catch (e) {}\n"
        "  });\n"
        "})();\n"
        "</script>\n"
    )


# ---- Gradio tab registration ------------------------------------------------
def on_ui_tabs():
    try:
        import gradio as gr
        with gr.Blocks() as ui:
            gr.HTML(_build_ui_html())
        return [(ui, "DanbooruTagExplorer", "danbooru_tag_explorer_tab")]
    except Exception:
        print("[Danbooru Tag Explorer] on_ui_tabs error:")
        traceback.print_exc()
        return []


# ---- A1111 Settings ---------------------------------------------------------
def on_ui_settings():
    try:
        from modules import shared  # type: ignore
        section = ("danbooru_tag_explorer", "Danbooru Tag Explorer")
        shared.opts.add_option(
            "dte_tag_csv",
            shared.OptionInfo(
                "",
                "タグCSVファイルパス（絶対パスまたは相対パス。空欄 = 自動検出: data/danbooru.csv -> tagcomplete）",
                section=section,
            ),
        )
        shared.opts.add_option(
            "dte_ja_csv",
            shared.OptionInfo(
                "",
                "日本語訳CSVファイルパス（絶対パスまたは相対パス。空欄 = data/ja.csv）",
                section=section,
            ),
        )
    except Exception:
        print("[Danbooru Tag Explorer] on_ui_settings error:")
        traceback.print_exc()


# ---- Register callbacks -----------------------------------------------------
try:
    from modules import script_callbacks  # type: ignore
    script_callbacks.on_app_started(on_app_started)
    script_callbacks.on_ui_tabs(on_ui_tabs)
    script_callbacks.on_ui_settings(on_ui_settings)
except ImportError:
    pass  # Outside A1111 -- silently skip
except Exception:
    print("[Danbooru Tag Explorer] Failed to register callbacks:")
    traceback.print_exc()
