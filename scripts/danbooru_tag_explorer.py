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
    # Scroll problem root cause
    # -----------------------------------------------------------------------
    # When an iframe loads a document, the browser gives it implicit scroll
    # focus. Even when the iframe is hidden (display:none or visibility:hidden
    # on a parent), Chrome retains scroll focus in the iframe's contentWindow,
    # causing wheel events to be swallowed by the hidden iframe rather than
    # reaching Gradio's scroll containers in other tabs.
    #
    # Additionally, if the Gradio tab panel does NOT use display:none to hide
    # inactive tabs (e.g. uses height:0 / overflow:hidden / CSS transforms),
    # a tall #dte-wrap (height:calc(100vh - X)) in the hidden panel still
    # participates in layout, inflating the page scroll area and breaking
    # Gradio's scroll behaviour in other tabs.
    #
    # Fix strategy:
    #   1. Start #dte-wrap with height:0 / min-height:0 so it never inflates
    #      the page, regardless of how Gradio hides the panel.
    #   2. tabindex="-1" prevents the iframe from receiving keyboard focus.
    #   3. blur() + window.focus() immediately after the iframe document loads
    #      releases scroll focus before the user sees anything.
    #   4. pointer-events:none (CSS default) prevents mouse/wheel events from
    #      being dispatched to the iframe element in the parent document.
    #   5. onActivate() restores height and pointer-events when the Tag
    #      Explorer tab is clicked; onDeactivate() resets them.
    #
    # White-screen fix
    # -----------------------------------------------------------------------
    # Lazy loading (data-src) requires detecting the tab click before setting
    # src. If Gradio's tab buttons are not found in time, src is never set.
    # Fix: use eager loading (src set immediately) -- the document loads but
    # cannot steal focus thanks to (2)+(3)+(4). Height starts at 0 so the
    # invisible iframe has no rendered scroll area to capture.

    prefix = ROUTE_PREFIX
    IFRAME_OFFSET = 220  # px; tune if iframe is too tall/short after activation

    js = (
        "(function () {\n"
        "  var wrap  = document.getElementById('dte-wrap');\n"
        "  var frame = document.getElementById('dte-frame');\n"
        "  if (!wrap || !frame) return;\n"
        "\n"
        "  // Release scroll focus immediately after the iframe's doc loads\n"
        "  frame.addEventListener('load', function () {\n"
        "    try { frame.contentWindow.blur(); } catch (e) {}\n"
        "    window.focus();\n"
        "  });\n"
        "\n"
        "  function onActivate() {\n"
        "    wrap.style.height    = 'calc(100vh - " + str(IFRAME_OFFSET) + "px)';\n"
        "    wrap.style.minHeight = '400px';\n"
        "    frame.style.pointerEvents = 'auto';\n"
        "  }\n"
        "\n"
        "  function onDeactivate() {\n"
        "    wrap.style.height    = '0';\n"
        "    wrap.style.minHeight = '0';\n"
        "    frame.style.pointerEvents = 'none';\n"
        "    try { frame.contentWindow.blur(); } catch (e) {}\n"
        "    window.focus();\n"
        "  }\n"
        "\n"
        "  // Backup: release on mouseleave\n"
        "  wrap.addEventListener('mouseleave', function () {\n"
        "    try { frame.contentWindow.blur(); } catch (e) {}\n"
        "    window.focus();\n"
        "  });\n"
        "\n"
        "  // Primary: intercept Gradio tab button clicks\n"
        "  function attachTabListeners() {\n"
        "    var tabs = document.querySelectorAll('.tab-nav button, [role=\"tab\"]');\n"
        "    if (!tabs.length) { setTimeout(attachTabListeners, 200); return; }\n"
        "    var ourBtn = null;\n"
        "    tabs.forEach(function (btn) {\n"
        "      var t = (btn.textContent || btn.innerText || '').replace(/\\s+/g, ' ').trim();\n"
        "      if (t.indexOf('Tag Explorer') >= 0) ourBtn = btn;\n"
        "    });\n"
        "    if (!ourBtn) { setTimeout(attachTabListeners, 200); return; }\n"
        "    ourBtn.addEventListener('click', onActivate);\n"
        "    tabs.forEach(function (btn) {\n"
        "      if (btn !== ourBtn) btn.addEventListener('click', onDeactivate);\n"
        "    });\n"
        "    // If Tag Explorer is already the active tab on load\n"
        "    var sel = ourBtn.getAttribute('aria-selected');\n"
        "    var cls = (ourBtn.className || '').toString();\n"
        "    if (sel === 'true' || cls.indexOf('selected') >= 0) onActivate();\n"
        "    console.log('[DTE] tab listeners attached');\n"
        "  }\n"
        "  attachTabListeners();\n"
        "})();\n"
    )

    return (
        "<style>\n"
        "  #dte-wrap  { width:100%; height:0; min-height:0; overflow:hidden; }\n"
        "  #dte-frame { width:100%; height:100%; border:none; display:block; pointer-events:none; }\n"
        "</style>\n"
        '<div id="dte-wrap">\n'
        '  <iframe id="dte-frame"\n'
        '          src="' + prefix + '/"\n'
        '          allow="clipboard-write"\n'
        '          tabindex="-1">\n'
        "  </iframe>\n"
        "</div>\n"
        "<script>\n" + js + "</script>\n"
    )


# ---- Gradio tab registration ------------------------------------------------
def on_ui_tabs():
    try:
        import gradio as gr
        with gr.Blocks() as ui:
            gr.HTML(_build_ui_html())
        return [(ui, "Tag Explorer", "danbooru_tag_explorer_tab")]
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
