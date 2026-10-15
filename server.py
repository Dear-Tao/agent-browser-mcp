from __future__ import annotations

import base64
import json
import os
import random
import re
import socket
import sys
import time
from pathlib import Path
from typing import Any, Optional

os.environ.setdefault("PYAUTO_GUI_NO_FAILSAFE", "1")

from mcp.server.mcpserver import MCPServer

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tmwebdriver import TMWebDriver  # noqa: E402
import simphtml  # noqa: E402
import semantic  # noqa: E402

mcp = MCPServer(
    name="agent-browser",
    instructions=(
        "Browser automation tools for the user's real Chrome session via TMWebDriver/CDP bridge. "
        "Supports page scanning, JS execution, CDP commands, screenshots, cookies, and desktop physical input.\n\n"
        "Preferred flow for interacting with a page (avoids inventing CSS selectors each time):\n"
        "  1. page_snapshot()  -> interactive elements as {ref, role, name, tag}, plus a docId.\n"
        "  2. element_action(ref='e7', action='click') to act on one.\n"
        "  Use find_element(role='button', name='Save') when you know the semantics but not the layout.\n"
        "  Pass the docId you acted on back as expect_doc_id: if the page navigated underneath you the\n"
        "  call returns status='uncertain' instead of guessing, and nothing is replayed.\n"
        "  scan_page stays available for reading raw rendered content; desktop_* tools drive the OS itself."
    ),
)

_driver: Optional[TMWebDriver] = None
_DRIVER_PORT = int(os.environ.get("AGENT_BROWSER_TMWD_PORT", "18865"))
_DRIVER_BIND = (os.environ.get("AGENT_BROWSER_TMWD_BIND") or "0.0.0.0").strip() or "0.0.0.0"
_DRIVER_HOST = (os.environ.get("AGENT_BROWSER_TMWD_HOST") or "127.0.0.1").strip() or "127.0.0.1"

# Tabs the agent opened. Cleanup closes only what it created and never the user's
# own tabs. Modes: agent (reclaimable) | handoff / deliverable (kept) | release
# (hand control back; the tab is never closed).
_TAB_OWNERS: dict[str, dict[str, Any]] = {}


def _security_note() -> dict[str, Any]:
    """Surface LAN exposure explicitly: the bridge has no pairing token."""
    exposed = _DRIVER_BIND not in ("127.0.0.1", "localhost", "::1")
    return {
        "bind_host": _DRIVER_BIND,
        "lan_exposed": exposed,
        "pairing_token": False,
        "note": (
            "Bridge listens on all interfaces with no pairing token: anything on the same "
            "network can drive this browser. Set AGENT_BROWSER_TMWD_BIND=127.0.0.1 unless you "
            "genuinely need another device on the LAN."
        ) if exposed else "Bridge is loopback-only.",
    }


def detect_lan_ip() -> str:
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.connect(("8.8.8.8", 80))
        ip = sock.getsockname()[0]
        sock.close()
        return ip
    except Exception:
        return "127.0.0.1"

_CONFIG_JS_DEFAULTS = (
    'const TID = \'{tid}\';\n'
    'var TMWD_HOST = "127.0.0.1";\n'
    'var TMWD_PORT = 18865;\n'
    'var TMWD_SECURE = false;\n'
)


def chrome_extension_dir() -> Path:
    return ROOT / "chrome_extension"


def ensure_config_js() -> Path:
    path = chrome_extension_dir() / "config.js"
    if not path.exists():
        tid = f"__ljq_{hex(random.randint(0, 99999999))[2:8]}"
        path.write_text(_CONFIG_JS_DEFAULTS.format(tid=tid), encoding="utf-8")
        return path
    prev = path.read_text(encoding="utf-8")
    if re.search(r"const\s+TID\s*=", prev):
        return path
    tid = f"__ljq_{hex(random.randint(0, 99999999))[2:8]}"
    path.write_text(_CONFIG_JS_DEFAULTS.format(tid=tid), encoding="utf-8")
    return path


def get_driver() -> TMWebDriver:
    global _driver
    ensure_config_js()
    if _driver is None:
        _driver = TMWebDriver(host=_DRIVER_HOST, port=_DRIVER_PORT, bind_host=_DRIVER_BIND)
    return _driver


def require_driver() -> TMWebDriver:
    driver = get_driver()
    return driver


def active_sessions() -> list[dict[str, Any]]:
    return require_driver().get_all_sessions()


def ensure_sessions() -> list[dict[str, Any]]:
    sessions = active_sessions()
    if not sessions:
        raise RuntimeError(
            "No connected browser tabs. Load the unpacked extension from the reported extension path, "
            "keep this MCP server running via Hermes, and open a normal http/https page in Chrome."
        )
    return sessions


def normalize_session_id(session_id: Optional[str]) -> Optional[str]:
    if session_id is None:
        return None
    return str(session_id)


def switch_session(session_id: Optional[str] = None, url_pattern: Optional[str] = None) -> str:
    driver = require_driver()
    if session_id is not None:
        sid = str(session_id)
        found = next((s for s in active_sessions() if str(s.get("id")) == sid), None)
        if not found:
            raise RuntimeError(f"Session {sid} not found")
        driver.default_session_id = sid
        return sid
    if url_pattern:
        sid = driver.set_session(url_pattern)
        if not sid:
            raise RuntimeError(f"No session matching url pattern: {url_pattern}")
        return str(sid)
    if driver.default_session_id:
        return str(driver.default_session_id)
    sessions = ensure_sessions()
    driver.default_session_id = str(sessions[0]["id"])
    return str(driver.default_session_id)


def exec_js(script: str, session_id: Optional[str] = None, timeout: float = 15.0) -> dict[str, Any]:
    driver = require_driver()
    if session_id is not None:
        driver.default_session_id = str(session_id)
    return driver.execute_js(script, timeout=timeout)


def compact_tabs() -> list[dict[str, Any]]:
    tabs = []
    for sess in active_sessions():
        item = dict(sess)
        item.pop("connected_at", None)
        item.pop("type", None)
        tabs.append(item)
    return tabs


@mcp.tool(description="Return extension path, bridge ports, and connection status for setup/diagnostics.")
def get_setup_status() -> dict[str, Any]:
    driver = get_driver()
    sessions = compact_tabs()
    lan_ip = detect_lan_ip()
    return {
        "extension_name": "Auto Publisher Bridge",
        "extension_path": str(chrome_extension_dir()),
        "config_js": str(ensure_config_js()),
        "tmwebdriver_bind_host": _DRIVER_BIND,
        "tmwebdriver_listen_port": _DRIVER_PORT,
        "tmwebdriver_http_port": _DRIVER_PORT + 1,
        "lan_ip": lan_ip,
        "listen_ws_urls": [
            f"ws://127.0.0.1:{_DRIVER_PORT}",
            f"ws://{lan_ip}:{_DRIVER_PORT}",
        ],
        "remote_mode": driver.is_remote,
        "connected_tabs": len(sessions),
        "default_session_id": driver.default_session_id,
        "tabs": sessions,
        "security": _security_note(),
        "notes": [
            "Load the unpacked extension from extension_path in chrome://extensions with Developer Mode enabled.",
            "Keep a normal http/https page open in Chrome; about:blank is not enough.",
            "Server listens on 0.0.0.0 (all interfaces). Extension address is configured in popup, not overwritten by MCP.",
            f"LAN extension example: host={lan_ip}, port={_DRIVER_PORT}, WSS unchecked.",
            f"Local extension example: host=127.0.0.1, port={_DRIVER_PORT}, WSS unchecked.",
            f"WSS reverse-proxy example: host=wss://your-domain:port in popup, WSS checked.",
        ],
    }


@mcp.tool(description="List currently connected browser tabs/sessions.")
def list_tabs() -> dict[str, Any]:
    sessions = compact_tabs()
    return {
        "default_session_id": require_driver().default_session_id,
        "tabs": sessions,
    }


@mcp.tool(description="Set the active browser tab by session id or URL substring.")
def switch_tab(session_id: Optional[str] = None, url_pattern: Optional[str] = None) -> dict[str, Any]:
    sid = switch_session(session_id=session_id, url_pattern=url_pattern)
    return {"active_session_id": sid, "tabs": compact_tabs()}


@mcp.tool(description="Navigate the current tab to a URL using real-browser JS navigation.")
def open_url(url: str, session_id: Optional[str] = None, timeout: float = 15.0) -> dict[str, Any]:
    if session_id is not None:
        switch_session(session_id=session_id)
    driver = require_driver()
    driver.jump(url, timeout=timeout)
    return {
        "status": "ok",
        "active_session_id": driver.default_session_id,
        "url": url,
    }


@mcp.tool(description=(
    "Open a new browser tab with the given URL. Pass track=True to record it as an "
    "agent-created tab, so close_agent_tabs can reclaim it later without ever touching "
    "the user's own tabs."
))
def open_new_tab(url: str, track: bool = False) -> dict[str, Any]:
    driver = require_driver()
    before = {str(s.get("id")) for s in active_sessions()}
    result = driver.newtab(url)
    # The extension reports new tabs on its next push, which can lag the page's
    # window.open by a beat. Poll briefly so track=True actually records it.
    claimed: list[str] = []
    for _ in range(15):
        time.sleep(0.2)
        for sess in active_sessions():
            sid = str(sess.get("id"))
            if sid not in before and sid not in claimed:
                claimed.append(sid)
        if claimed:
            break
    if claimed:
        for sess in active_sessions():
            sid = str(sess.get("id"))
            if sid in claimed:
                _TAB_OWNERS[sid] = {
                    "url": sess.get("url"),
                    "title": sess.get("title"),
                    "mode": "agent",
                }
    return {
        "status": "ok" if claimed else "unavailable",
        "result": result,
        "tracked": claimed if track else [],
        "new_tabs_seen": claimed,
        "note": None if claimed else (
            "The page blocked window.open and the anchor fallback, so no new tab appeared. "
            "Switch to a page that allows new tabs, or navigate an existing tab with open_url."
        ),
        "tabs": compact_tabs(),
        "owned_tabs": dict(_TAB_OWNERS),
    }


@mcp.tool(description=(
    "Set the lifecycle mode of a tab this agent opened: 'agent' (reclaimable, default), "
    "'handoff' or 'deliverable' (keep it past cleanup), or 'release' (give control back to the "
    "user; the tab is never closed). Never closes anything by itself."
))
def mark_tab(mode: str, session_id: Optional[str] = None) -> dict[str, Any]:
    if mode not in ("agent", "handoff", "deliverable", "release"):
        raise RuntimeError("mode must be one of: agent, handoff, deliverable, release")
    sid = str(session_id) if session_id is not None else str(require_driver().default_session_id)
    entry = _TAB_OWNERS.get(sid)
    if entry is None:
        live = next((s for s in active_sessions() if str(s.get("id")) == sid), None)
        if live is None:
            raise RuntimeError(f"Tab {sid} is not connected and was never tracked by the agent")
        _TAB_OWNERS[sid] = {"url": live.get("url"), "title": live.get("title"), "mode": mode}
    else:
        entry["mode"] = mode
    return {"session_id": sid, "mode": mode, "owned_tabs": dict(_TAB_OWNERS)}


def _tab_still_open(driver: TMWebDriver, sid: str) -> bool:
    return any(str(s.get("id")) == sid for s in active_sessions())


def _try_close_tab(driver: TMWebDriver, sid: str, previous: Optional[str]) -> str:
    """Close one agent-owned tab and verify it actually went away.

    Two paths on purpose: the extension's tabs/close is the clean one, but it only
    exists once the unpacked extension has been reloaded, and an older service
    worker answers a close request with a tab list instead of closing anything.
    So every attempt is verified, and the fallback is page-side window.close() -
    legal precisely because the agent opened these tabs itself via open_new_tab.
    """
    for path in ("extension", "window"):
        try:
            driver.default_session_id = sid
            if path == "extension":
                driver.execute_js(
                    json.dumps({"cmd": "tabs", "method": "close", "tabIds": [int(sid)]}),
                    timeout=10,
                )
            else:
                driver.execute_js("window.close(); return true;", timeout=8)
        except Exception:
            continue
        time.sleep(0.5)
        if not _tab_still_open(driver, sid):
            driver.default_session_id = previous
            return path
    driver.default_session_id = previous
    return "failed"


@mcp.tool(description=(
    "Close tabs this agent opened that are still marked 'agent'. Tabs marked handoff, "
    "deliverable or release, and every tab the user opened, are left untouched. Each close is "
    "verified, so this reports exactly what went away, what it used, and what it could not close."
))
def close_agent_tabs(mode: str = "agent") -> dict[str, Any]:
    driver = require_driver()
    live = {str(s.get("id")) for s in active_sessions()}
    targets, keep, gone = [], {}, []
    for sid, entry in list(_TAB_OWNERS.items()):
        if sid not in live:
            gone.append(sid)
            _TAB_OWNERS.pop(sid, None)
        elif entry.get("mode") == mode:
            targets.append(sid)
        else:
            keep[sid] = entry.get("mode")

    previous = driver.default_session_id
    closed: dict[str, str] = {}
    failed: list[str] = []
    for sid in targets:
        how = _try_close_tab(driver, sid, previous)
        if how == "failed":
            failed.append(sid)
        else:
            closed[sid] = how
            _TAB_OWNERS.pop(sid, None)

    return {
        "status": "ok" if not failed else "partial",
        "requested_mode": mode,
        "closed": closed,
        "closed_via": sorted(set(closed.values())),
        "failed": failed,
        "already_gone": gone,
        "kept": keep,
        "user_tabs_untouched": sorted(live - set(targets)),
    }


@mcp.tool(description="Get absolute path to the unpacked Chrome extension directory for manual installation.")
def extension_path() -> dict[str, Any]:
    return {
        "extension_path": str(chrome_extension_dir()),
        "config_js": str(ensure_config_js()),
    }


@mcp.tool(description="List Chrome extensions visible to the CDP bridge extension itself.")
def list_extensions(session_id: Optional[str] = None) -> dict[str, Any]:
    if session_id is not None:
        switch_session(session_id=session_id)
    return exec_js(json.dumps({"cmd": "management", "method": "list"}), timeout=20.0)


@mcp.tool(description="Read the current page as simplified HTML/text, preserving login state from the real browser.")
def scan_page(
    session_id: Optional[str] = None,
    text_only: bool = False,
    cutlist: bool = True,
    maxchars: int = 35000,
    instruction: str = "",
    extra_js: str = "",
) -> dict[str, Any]:
    driver = require_driver()
    if session_id is not None:
        switch_session(session_id=session_id)
    ensure_sessions()
    content = simphtml.get_html(
        driver,
        cutlist=cutlist,
        maxchars=maxchars,
        instruction=instruction,
        extra_js=extra_js,
        text_only=text_only,
    )
    return {
        "status": "success",
        "active_session_id": driver.default_session_id,
        "tabs": compact_tabs(),
        "content": content,
    }


@mcp.tool(description=(
    "Cheap identity probe for the current document: docId, url, title, readiness and how many "
    "element refs are still live. Call this after an action that reported status='uncertain' to "
    "see whether the page really moved on."
))
def page_state(session_id: Optional[str] = None) -> dict[str, Any]:
    if session_id is not None:
        switch_session(session_id=session_id)
    return semantic.page_state(require_driver())


@mcp.tool(description=(
    "Bounded interactive-element snapshot of the current page. Returns {ref, role, name, tag} "
    "for visible actionable nodes plus the document's docId, so you can act on them later with "
    "element_action(ref=...) instead of writing a CSS selector each time. e-refs are reset by this "
    "call; budget-bounded by limit/max_chars, and credential-shaped entries are flagged 'redacted'."
))
def page_snapshot(
    session_id: Optional[str] = None,
    interactive_only: bool = True,
    limit: int = 200,
    max_chars: int = 20000,
) -> dict[str, Any]:
    if session_id is not None:
        switch_session(session_id=session_id)
    return semantic.page_snapshot(
        require_driver(), interactive_only=interactive_only, limit=limit, max_chars=max_chars
    )


@mcp.tool(description=(
    "Find elements by meaning rather than by selector: role ('button'/'link'/'textbox'/'checkbox'), "
    "name (substring of the accessible name), label, placeholder, text, testid, or an explicit CSS "
    "selector. Returns f-refs usable with element_action, and reports how many matched in total so "
    "you can tell an ambiguous hit from a unique one (use nth to disambiguate). Does not disturb "
    "the page; it only reads."
))
def find_element(
    role: str = "",
    name: str = "",
    label: str = "",
    placeholder: str = "",
    text: str = "",
    testid: str = "",
    selector: str = "",
    nth: Optional[int] = None,
    count: int = 10,
    interactive_only: bool = True,
    session_id: Optional[str] = None,
) -> dict[str, Any]:
    if session_id is not None:
        switch_session(session_id=session_id)
    return semantic.find_element(
        require_driver(),
        role=role, name=name, label=label, placeholder=placeholder,
        text=text, testid=testid, selector=selector, nth=nth, count=count,
        interactive_only=interactive_only,
    )


@mcp.tool(description=(
    "Act on an element ref from page_snapshot (e1, e2...) or find_element (f1, f2...). Actions: "
    "click, fill (value), clear, select (value), check, uncheck, hover, focus, scrollIntoView, and "
    "read-only exists / text / isEnabled / attrs. Always pass the docId you observed as "
    "expect_doc_id: if the document changed underneath the ref, the call returns "
    "status='uncertain' and does NOT replay the action, so a timed-out click can never silently "
    "become a duplicate order."
))
def element_action(
    ref: str,
    action: str = "click",
    value: Optional[str] = None,
    expect_doc_id: str = "",
    session_id: Optional[str] = None,
) -> dict[str, Any]:
    if session_id is not None:
        switch_session(session_id=session_id)
    return semantic.element_action(
        require_driver(), ref=ref, action=action, value=value, expect_doc_id=expect_doc_id
    )


@mcp.tool(description="Execute arbitrary JS in the current page context or send JSON CDP bridge commands through the page bridge.")
def execute_js(
    script: str,
    session_id: Optional[str] = None,
    no_monitor: bool = False,
    timeout: float = 15.0,
) -> dict[str, Any]:
    driver = require_driver()
    if session_id is not None:
        switch_session(session_id=session_id)
    ensure_sessions()
    return simphtml.execute_js_rich(script, driver, no_monitor=no_monitor, timeout=timeout)


@mcp.tool(description="Call a single Chrome DevTools Protocol command on the current or specified tab.")
def cdp_command(
    method: str,
    params_json: str = "{}",
    session_id: Optional[str] = None,
    tab_id: Optional[int] = None,
) -> dict[str, Any]:
    if session_id is not None:
        switch_session(session_id=session_id)
    params = json.loads(params_json or "{}")
    payload: dict[str, Any] = {"cmd": "cdp", "method": method, "params": params}
    if tab_id is not None:
        payload["tabId"] = tab_id
    return exec_js(json.dumps(payload), timeout=20.0)


@mcp.tool(description="Run a CDP bridge batch command; pass the full JSON command object as text.")
def cdp_batch(batch_json: str, session_id: Optional[str] = None) -> dict[str, Any]:
    if session_id is not None:
        switch_session(session_id=session_id)
    payload = json.loads(batch_json)
    if payload.get("cmd") != "batch":
        raise RuntimeError("batch_json must be a JSON object with cmd='batch'")
    return exec_js(json.dumps(payload), timeout=30.0)


@mcp.tool(description="Get cookies for the current page or specified tab via the Chrome extension bridge.")
def get_cookies(session_id: Optional[str] = None, tab_id: Optional[int] = None) -> dict[str, Any]:
    if session_id is not None:
        switch_session(session_id=session_id)
    payload: dict[str, Any] = {"cmd": "cookies"}
    if tab_id is not None:
        payload["tabId"] = tab_id
    return exec_js(json.dumps(payload), timeout=15.0)


@mcp.tool(description="Capture a screenshot of the current page/tab via CDP and optionally save it to a file path.")
def capture_page_screenshot(
    session_id: Optional[str] = None,
    tab_id: Optional[int] = None,
    format: str = "png",
    save_path: str = "",
) -> dict[str, Any]:
    if session_id is not None:
        switch_session(session_id=session_id)
    payload: dict[str, Any] = {
        "cmd": "cdp",
        "method": "Page.captureScreenshot",
        "params": {"format": format},
    }
    if tab_id is not None:
        payload["tabId"] = tab_id
    result = exec_js(json.dumps(payload), timeout=20.0)
    data = result.get("data")
    if isinstance(data, dict) and "data" in data:
        b64 = data["data"]
    else:
        b64 = data
    out: dict[str, Any] = {"format": format, "base64": b64}
    if save_path:
        path = Path(save_path).expanduser().resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(base64.b64decode(b64))
        out["saved_to"] = str(path)
    return out


@mcp.tool(description="Take a desktop screenshot of the whole screen using mss; useful for physical-input verification.")
def capture_desktop_screenshot(save_path: str = "") -> dict[str, Any]:
    import mss
    from PIL import Image

    path = Path(save_path).expanduser().resolve() if save_path else (ROOT / "temp_desktop.png")
    path.parent.mkdir(parents=True, exist_ok=True)
    with mss.mss() as sct:
        monitor = sct.monitors[1]
        shot = sct.grab(monitor)
        img = Image.frombytes("RGB", shot.size, shot.rgb)
        img.save(path)
    return {"saved_to": str(path), "size": path.stat().st_size}


@mcp.tool(description="Move the real mouse cursor to screen coordinates.")
def mouse_move(x: int, y: int, duration: float = 0.0) -> dict[str, Any]:
    import pyautogui

    pyautogui.moveTo(x, y, duration=duration)
    return {"status": "ok", "x": x, "y": y}


@mcp.tool(description="Click on the real desktop at screen coordinates.")
def mouse_click(
    x: Optional[int] = None,
    y: Optional[int] = None,
    button: str = "left",
    clicks: int = 1,
    interval: float = 0.1,
) -> dict[str, Any]:
    import pyautogui

    if x is not None and y is not None:
        pyautogui.click(x=x, y=y, clicks=clicks, interval=interval, button=button)
    else:
        pyautogui.click(clicks=clicks, interval=interval, button=button)
    return {"status": "ok", "x": x, "y": y, "button": button, "clicks": clicks}


@mcp.tool(description="Drag the real mouse from one point to another.")
def mouse_drag(x1: int, y1: int, x2: int, y2: int, duration: float = 0.3, button: str = "left") -> dict[str, Any]:
    import pyautogui

    pyautogui.moveTo(x1, y1)
    pyautogui.dragTo(x2, y2, duration=duration, button=button)
    return {"status": "ok", "from": [x1, y1], "to": [x2, y2], "button": button}


@mcp.tool(description="Type text via the real keyboard, optionally after clicking a field.")
def type_text(text: str, interval: float = 0.01, click_x: Optional[int] = None, click_y: Optional[int] = None) -> dict[str, Any]:
    import pyautogui

    if click_x is not None and click_y is not None:
        pyautogui.click(click_x, click_y)
        time.sleep(0.1)
    pyautogui.write(text, interval=interval)
    return {"status": "ok", "typed_chars": len(text)}


@mcp.tool(description="Send a hotkey chord like 'command,l' or 'ctrl,shift,p' via the real keyboard.")
def hotkey(keys_csv: str) -> dict[str, Any]:
    import pyautogui

    keys = [k.strip() for k in keys_csv.split(",") if k.strip()]
    if not keys:
        raise RuntimeError("keys_csv must contain at least one key")
    pyautogui.hotkey(*keys)
    return {"status": "ok", "keys": keys}


@mcp.tool(description="Report the current desktop mouse position and primary screen size.")
def pointer_info() -> dict[str, Any]:
    import pyautogui

    x, y = pyautogui.position()
    w, h = pyautogui.size()
    return {"x": x, "y": y, "screen_width": w, "screen_height": h}


if __name__ == "__main__":
    ensure_config_js()
    get_driver()
    mcp.run(transport="stdio")
