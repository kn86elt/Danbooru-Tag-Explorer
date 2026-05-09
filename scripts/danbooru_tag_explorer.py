# -*- coding: utf-8 -*-
"""
Danbooru Tag Explorer -- A1111 / reForge extension entry point

Place the entire danbooru_tag_explorer/ folder inside A1111's extensions/ folder
and restart the WebUI. A "Tag Explorer" tab will appear.

Standalone operation (server.py / run.bat) is not affected.

[danbooru.csv resolution order]
  1. data/danbooru.csv inside this extension folder -> use it
  2. a1111-sd-webui-tagcomplete installed and has CSV -> borrow it
  3. Neither found -> 404 (run standalone once, or install tagcomplete)
"""

import json
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


def resolve_danbooru_csv():
    local = DATA_DIR / "danbooru.csv"
    if local.is_file():
        return local
    return find_tagcomplete_csv()


# ---- Settings helpers -------------------------------------------------------
_DEFAULTS = {
    "favTags":    [],
    "pinnedCats": [],
    "tagCsv":     "data/danbooru.csv",
    "jaCsv":      "data/ja.csv",
    "_notes": {
        "tagCsv": "Tag metadata CSV (default: data/danbooru.csv)",
        "jaCsv":  "Japanese translation CSV (default: data/ja.csv)",
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
def build_index_html():
    html = (BASE_DIR / "index.html").read_text(encoding="utf-8")
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
        elif (DATA_DIR / "danbooru.csv").is_file():
            print("[Danbooru Tag Explorer] danbooru.csv: local copy (" + str(csv_path) + ")")
        else:
            print("[Danbooru Tag Explorer] danbooru.csv: from tagcomplete (" + str(csv_path) + ")")

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
            s["tagCsv"] = "data/danbooru.csv"
            actual = resolve_danbooru_csv()
            if actual is None:
                s["_info"] = {"csvSource": "missing"}
            elif (DATA_DIR / "danbooru.csv").is_file():
                s["_info"] = {"csvSource": "local"}
            else:
                s["_info"] = {"csvSource": "tagcomplete", "csvPath": str(actual)}
            return JSONResponse(s)

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
                return FileResponse(str(target))
            if path == "data/danbooru.csv":
                tc_csv = find_tagcomplete_csv()
                if tc_csv is not None:
                    return FileResponse(str(tc_csv))
            return JSONResponse({"error": "not found"}, status_code=404)

    except Exception:
        print("[Danbooru Tag Explorer] on_app_started error:")
        traceback.print_exc()


# ---- Gradio tab HTML --------------------------------------------------------
def _build_ui_html():
    # Height strategy
    # -----------------------------------------------------------------------
    # Gradio tab panels use height:auto, so any child measurement-based approach
    # creates a circular dependency (panel height = iframe height = 0).
    # getBoundingClientRect() on #dte-wrap consistently returns all-zeros.
    #
    # Fix: use calc(100vh - OFFSET) in CSS. Viewport units are independent of
    # the parent chain, so this always fills the visible tab area correctly.
    # OFFSET covers browser chrome (~60px) + A1111 top bar + tab row (~160px).
    #
    # Scroll focus strategy
    # -----------------------------------------------------------------------
    # Once an iframe receives a wheel event, its contentWindow holds scroll focus
    # until explicitly released. Tab-switch detection via MutationObserver proved
    # unreliable (Gradio's panel attributes may not change in an observable way).
    #
    # Fix: listen for mouseleave on #dte-wrap. The moment the cursor moves to
    # another tab or elsewhere on the page, blur the iframe's contentWindow and
    # focus the parent window. Simple and reliable.

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
        "\n"
        "  // Release scroll focus the moment the cursor leaves the iframe area\n"
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


# ---- Register callbacks -----------------------------------------------------
try:
    from modules import script_callbacks  # type: ignore
    script_callbacks.on_app_started(on_app_started)
    script_callbacks.on_ui_tabs(on_ui_tabs)
except ImportError:
    pass  # Outside A1111 -- silently skip
except Exception:
    print("[Danbooru Tag Explorer] Failed to register callbacks:")
    traceback.print_exc()
