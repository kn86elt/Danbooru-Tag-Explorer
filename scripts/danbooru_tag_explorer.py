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
import re
import traceback
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
ROUTE_PREFIX  = "/danbooru_tag_explorer"

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


# ---- Settings helpers -------------------------------------------------------
_DEFAULTS = {
    "favTags":    [],
    "pinnedCats": [],
    "tagCsv":     "data/danbooru.csv",
    "jaCsv":      "data/ja.csv",
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
