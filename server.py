from __future__ import annotations

import base64
import json
import os
import socket
import sys
import time
import urllib.parse
from pathlib import Path
from typing import Any, Optional

os.environ.setdefault("PYAUTO_GUI_NO_FAILSAFE", "1")

try:
    # mcp 1.x
    from mcp.server.fastmcp import FastMCP as MCPServer
except ImportError:
    # mcp 2.x: FastMCP was renamed to MCPServer
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
        "Multi-browser: the user names each browser in the extension popup (browser_label). "
        "When they say which browser to use, call switch_browser(browser_label=...). "
        "You pick any live tab inside that browser yourself — do not ask the user for tab ids.\n\n"
        "User's current tab: get_active_tab() returns the tab the user is actually looking at "
        "(active tab of the last focused window). list_tabs() also marks each tab with "
        "is_active_tab. When the user says '当前页面/现在打开的' — use get_active_tab(), "
        "do NOT guess from default_session_id (which is just the first connected tab).\n\n"
        "Tab reuse: open_url(reuse='auto', default) reuses an already-open matching tab "
        "(switches to it and focuses the browser window) instead of creating duplicates; "
        "use reuse='new' to force a new tab or reuse='current' to force in-place navigation.\n\n"
        "Efficiency: element_action_batch(actions_json) runs several actions in one call and "
        "stops at the first failure. wait_for(kind, value) polls in-page (selector/ref/"
        "url_contains/title_contains/text/idle) — prefer it over blind sleeps after clicks. "
        "page_snapshot/find_element cover same-origin iframes too (iframe:true marks those "
        "elements). file_upload(click_selector, files_csv) fills file-chooser dialogs via CDP. "
        "console_log / network_log read captured console output and fetch/XHR traffic "
        "(hooks install on first call; network_log returns JSON bodies up to 2KB — prefer it "
        "over DOM parsing for API-driven pages). downloads_list lists browser downloads.\n\n"
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
    'var TMWD_HOST = "127.0.0.1";\n'
    'var TMWD_PORT = 18865;\n'
    'var TMWD_SECURE = false;\n'
)


def chrome_extension_dir() -> Path:
    return ROOT / "chrome_extension"


def ensure_config_js() -> Path:
    path = chrome_extension_dir() / "config.js"
    if not path.exists():
        path.write_text(_CONFIG_JS_DEFAULTS, encoding="utf-8")
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
        "extension_name": "Agent Browser Bridge",
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


def _match_browser_sessions(browser_label: str) -> list[dict[str, Any]]:
    needle = str(browser_label or "").strip()
    if not needle:
        return []
    return [
        s
        for s in active_sessions()
        if needle in str(s.get("browser_label") or "")
        or needle == str(s.get("browser_id") or "")
    ]


def _pick_session_in_browser(
    matches: list[dict[str, Any]],
    url_hint: str = "",
) -> dict[str, Any]:
    """Agent 自选标签：优先 url_hint，再 http(s)，否则第一个。"""
    hint = str(url_hint or "").strip()
    if hint:
        for s in matches:
            if hint in str(s.get("url") or ""):
                return s
    for s in matches:
        if str(s.get("url") or "").startswith("http"):
            return s
    return matches[0]


@mcp.tool(description=(
    "List connected browsers (primary) and their tabs. Prefer the browsers[] summary: "
    "each has a stable browser_id and user-facing browser_label from the extension popup. "
    "When the user names a browser, use switch_browser — do not ask them for tab ids."
))
def list_tabs() -> dict[str, Any]:
    sessions = compact_tabs()
    browsers: dict[str, dict[str, Any]] = {}
    for t in sessions:
        label = str(t.get("browser_label") or t.get("browser_id") or "未命名")
        bid = str(t.get("browser_id") or "")
        entry = browsers.setdefault(
            label,
            {
                "browser_label": label,
                "browser_id": bid,
                "tab_count": 0,
                "sample_urls": [],
            },
        )
        entry["tab_count"] += 1
        if bid and not entry.get("browser_id"):
            entry["browser_id"] = bid
        url = str(t.get("url") or "")
        if url and url not in entry["sample_urls"] and len(entry["sample_urls"]) < 3:
            entry["sample_urls"].append(url)
    return {
        "default_session_id": require_driver().default_session_id,
        "user_active_session_id": _user_active_session_id(),
        "browsers": list(browsers.values()),
        "tabs": sessions,
    }


def _user_active_session_id() -> Optional[str]:
    """用户当前正在看的标签（最后聚焦窗口的激活标签），找不到返回 None。"""
    for s in active_sessions():
        if s.get("is_active_tab"):
            return str(s.get("id"))
    return None


@mcp.tool(description=(
    "Get the tab the user is currently looking at (the active tab of the last focused "
    "browser window). Returns {session_id, url, title, browser_label} or {active: False} "
    "if Chrome has no focused window or the active tab is not scriptable/connected."
))
def get_active_tab() -> dict[str, Any]:
    sessions = active_sessions()
    pick = next((s for s in sessions if s.get("is_active_tab")), None)
    if not pick:
        return {"active": False, "note": "Chrome 无聚焦窗口或激活标签页不可注入（如 chrome:// 页）"}
    return {
        "active": True,
        "session_id": str(pick.get("id")),
        "url": pick.get("url"),
        "title": pick.get("title"),
        "browser_label": pick.get("browser_label"),
        "browser_id": pick.get("browser_id"),
    }


@mcp.tool(description=(
    "Switch to a named browser (browser_label from the extension popup, e.g. '卖家Chrome'). "
    "Picks any live tab inside that browser for you. Optional url_hint prefers a matching tab "
    "(e.g. 'seller.ozon.ru'). This is the main way to follow the user's '用哪个浏览器' instruction."
))
def switch_browser(browser_label: str, url_hint: str = "") -> dict[str, Any]:
    matches = _match_browser_sessions(browser_label)
    if not matches:
        known = sorted(
            {
                str(s.get("browser_label") or s.get("browser_id") or "未命名")
                for s in active_sessions()
            }
        )
        raise RuntimeError(
            f"No browser matching {browser_label!r}. Connected labels: {known}"
        )
    pick = _pick_session_in_browser(matches, url_hint=url_hint)
    sid = switch_session(session_id=str(pick.get("id")))
    return {
        "status": "ok",
        "active_session_id": sid,
        "browser_label": pick.get("browser_label"),
        "browser_id": pick.get("browser_id"),
        "active_url": pick.get("url"),
        "tabs_in_browser": len(matches),
    }


@mcp.tool(description=(
    "Set the active tab by session id or URL substring. Prefer switch_browser when the user "
    "names a browser; use this only when you already know a specific session/url."
))
def switch_tab(
    session_id: Optional[str] = None,
    url_pattern: Optional[str] = None,
    browser_label: Optional[str] = None,
) -> dict[str, Any]:
    if browser_label:
        return switch_browser(browser_label=browser_label)
    sid = switch_session(session_id=session_id, url_pattern=url_pattern)
    return {"active_session_id": sid, "tabs": compact_tabs()}


def _url_matches(a: str, b: str) -> bool:
    """同一个页面才复用：同源 + 路径完全一致 + query 一致（忽略 fragment 和尾部 /）。

    故意不做路径前缀匹配：开着 /orders/123 时请求 /orders 应该导航到列表页，
    而不是被误判为"已打开"后切到详情页。
    """
    try:
        pa, pb = urllib.parse.urlsplit(a), urllib.parse.urlsplit(b)
    except ValueError:
        return False
    if (pa.scheme, pa.netloc) != (pb.scheme, pb.netloc) or not pa.netloc:
        return False
    ta = (pa.path or "/").rstrip("/") or "/"
    tb = (pb.path or "/").rstrip("/") or "/"
    if ta != tb:
        return False
    qa = sorted(urllib.parse.parse_qsl(pa.query))
    qb = sorted(urllib.parse.parse_qsl(pb.query))
    return qa == qb


@mcp.tool(description=(
    "Navigate to a URL. reuse='auto' (default): if a connected tab already shows the exact "
    "same page (same origin, path and query), switch to it and focus it in the browser "
    "instead of navigating — avoids duplicate tabs; falls back to navigating the "
    "current/default tab when no match exists (an explicit session_id skips reuse and "
    "navigates that session). reuse='current': always navigate the current/default tab "
    "(use to force reload a reused page). reuse='new': always open a brand-new tab."
))
def open_url(
    url: str,
    session_id: Optional[str] = None,
    timeout: float = 15.0,
    reuse: str = "auto",
) -> dict[str, Any]:
    url = str(url or "").strip()
    mode = (str(reuse or "auto") or "auto").strip().lower()
    if mode not in ("auto", "new", "current"):
        raise RuntimeError("reuse must be one of: auto, new, current")
    # 显式指定 session_id = agent 明确知道要操作哪个标签，跳过复用逻辑
    if session_id is not None and mode == "auto":
        mode = "current"
    driver = require_driver()
    if mode == "new":
        result = driver.newtab(url)
        via = result.get("via") if isinstance(result, dict) else None
        return {"status": "opened_new_tab", "url": url, "via": via}
    if mode == "auto":
        candidates = [
            s for s in active_sessions()
            if s.get("url") and _url_matches(str(s.get("url")), url)
        ]
        if candidates:
            # 优先用户正在看的标签，其次最近连接的
            candidates.sort(key=lambda s: (
                not s.get("is_active_tab"),
                -float(s.get("connected_at") or 0),
            ))
            pick = candidates[0]
            sid = str(pick.get("id"))
            driver.default_session_id = sid
            # 把浏览器窗口真正聚焦到该标签（经由同一浏览器的会话发命令）
            tid = pick.get("tab_id")
            focused = False
            if tid is not None:
                same_browser = next(
                    (
                        s for s in active_sessions()
                        if s.get("browser_id") == pick.get("browser_id")
                    ),
                    None,
                )
                if same_browser is not None:
                    resp = driver.focus_tab(tid, session_id=str(same_browser.get("id")))
                    focused = bool(resp and resp.get("ok"))
            return {
                "status": "reused_existing_tab",
                "session_id": sid,
                "url": pick.get("url"),
                "title": pick.get("title"),
                "browser_label": pick.get("browser_label"),
                "browser_focused": focused,
            }
    if session_id is not None:
        switch_session(session_id=session_id)
    driver.jump(url, timeout=timeout)
    return {
        "status": "navigated_current_tab",
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
    # Extension reports new tabs on its next push, which can lag slightly.
    claimed: list[str] = []
    for _ in range(15):
        time.sleep(0.2)
        for sess in active_sessions():
            sid = str(sess.get("id"))
            if sid not in before and sid not in claimed:
                claimed.append(sid)
        if claimed:
            break
    if track and claimed:
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
            "No new tab appeared. Switch to a page that allows new tabs, "
            "or navigate an existing tab with open_url."
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


def _tab_still_open(sid: str) -> bool:
    return any(str(s.get("id")) == sid for s in active_sessions())


def _try_close_tab(driver: TMWebDriver, sid: str, previous: Optional[str]) -> str:
    """Close one agent-owned tab and verify it went away.

    Prefer extension tabs/close; fall back to window.close() for older service workers.
    """
    from tmwebdriver import chrome_tab_id_of

    sess = driver.sessions.get(str(sid))
    chrome_tid = None
    if sess is not None:
        try:
            chrome_tid = chrome_tab_id_of(sess)
        except Exception:
            chrome_tid = None
    for path in ("extension", "window"):
        try:
            driver.default_session_id = sid
            if path == "extension":
                if chrome_tid is None:
                    continue
                driver.execute_js(
                    json.dumps({"cmd": "tabs", "method": "close", "tabIds": [int(chrome_tid)]}),
                    timeout=10,
                )
            else:
                driver.execute_js("window.close(); return true;", timeout=8)
        except Exception:
            continue
        time.sleep(0.5)
        if not _tab_still_open(sid):
            driver.default_session_id = previous
            return path
    driver.default_session_id = previous
    return "failed"


@mcp.tool(description=(
    "Close tabs this agent opened that are still marked 'agent'. Tabs marked handoff, "
    "deliverable or release, and every tab the user opened, are left untouched."
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
    "selector. Returns f-refs usable with element_action. Use nth to disambiguate."
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
    "status='uncertain' and does NOT replay the action."
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


@mcp.tool(description=(
    "Execute a sequence of element actions in one call (same actions as element_action: "
    "click/fill/clear/select/check/uncheck/hover/focus/scrollIntoView). actions_json: JSON "
    "array of {ref, action, value}. Stops at the first failure or document change and "
    "reports exactly what executed; pass expect_doc_id from your snapshot."
))
def element_action_batch(
    actions_json: str,
    expect_doc_id: str = "",
    session_id: Optional[str] = None,
) -> dict[str, Any]:
    if session_id is not None:
        switch_session(session_id=session_id)
    try:
        actions = json.loads(actions_json or "[]")
    except json.JSONDecodeError as e:
        raise RuntimeError(f"actions_json is not valid JSON: {e}")
    if not isinstance(actions, list) or not actions:
        raise RuntimeError("actions_json must be a non-empty JSON array of {ref, action, value} objects")
    return semantic.element_action_batch(require_driver(), actions, expect_doc_id=expect_doc_id)


@mcp.tool(description=(
    "Wait until a condition is met (polls inside the page every 250ms — use instead of "
    "blind sleeps). kind: 'selector' (visible element match), 'selector_exists', 'ref' "
    "(a snapshot ref is still connected), 'url_contains', 'title_contains', 'text' "
    "(visible text contains value), 'idle' (document readyState complete). Returns "
    "met=true/false with waited_ms; page-side timeout capped at 60s."
))
def wait_for(
    kind: str,
    value: str = "",
    timeout: float = 10.0,
    session_id: Optional[str] = None,
) -> dict[str, Any]:
    if session_id is not None:
        switch_session(session_id=session_id)
    return semantic.wait_for(require_driver(), kind=kind, value=value, timeout=timeout)


@mcp.tool(description=(
    "Upload local file(s) through the page's file-chooser dialog via CDP. click_selector: "
    "CSS selector of the control that opens the chooser (e.g. 'input[type=file]' or the "
    "upload button). files_csv: comma-separated absolute local file paths."
))
def file_upload(
    click_selector: str,
    files_csv: str,
    timeout: float = 15.0,
    session_id: Optional[str] = None,
) -> dict[str, Any]:
    selector = str(click_selector or "").strip()
    if not selector:
        raise RuntimeError("click_selector is required")
    files = [f.strip() for f in str(files_csv or "").split(",") if f.strip()]
    if not files:
        raise RuntimeError("files_csv must contain at least one absolute file path")
    for f in files:
        if not Path(f).expanduser().exists():
            raise RuntimeError(f"file not found: {f}")
    if session_id is not None:
        switch_session(session_id=session_id)
    ensure_sessions()
    click_expr = f"document.querySelector({json.dumps(selector)}).click()"
    payload = {
        "cmd": "cdp_file_chooser_fill",
        "files": files,
        "clickExpression": click_expr,
        "timeoutMs": int(timeout * 1000),
    }
    return exec_js(json.dumps(payload), timeout=timeout + 10.0)


@mcp.tool(description=(
    "Read captured page console output (console.log/info/warn/error/debug, window.onerror, "
    "unhandledrejection). Capture hooks install on first use for the current document and "
    "persist until navigation; buffer keeps the last 100 entries. level filters "
    "(e.g. 'error'); since_seq returns only entries newer than that seq."
))
def console_log(
    level: str = "",
    since_seq: int = 0,
    session_id: Optional[str] = None,
) -> dict[str, Any]:
    if session_id is not None:
        switch_session(session_id=session_id)
    return semantic.console_log(require_driver(), level=level, since_seq=since_seq)


@mcp.tool(description=(
    "Read captured page network activity (fetch/XHR: method, url, status, ok and the first "
    "2KB of the response body). Hooks install on first use for the current document; buffer "
    "keeps the last 80 requests. url_filter is a case-insensitive substring match; "
    "since_seq returns only newer entries. Ideal for reading JSON APIs directly."
))
def network_log(
    url_filter: str = "",
    since_seq: int = 0,
    session_id: Optional[str] = None,
) -> dict[str, Any]:
    if session_id is not None:
        switch_session(session_id=session_id)
    return semantic.network_log(require_driver(), url_filter=url_filter, since_seq=since_seq)


@mcp.tool(description=(
    "List recent browser downloads via the extension bridge, most recent first. "
    "state filter: '' (all) | in_progress | complete | interrupted."
))
def downloads_list(
    state: str = "",
    limit: int = 20,
    session_id: Optional[str] = None,
) -> dict[str, Any]:
    if session_id is not None:
        switch_session(session_id=session_id)
    payload = {"cmd": "downloads", "state": str(state or ""), "limit": int(limit)}
    return exec_js(json.dumps(payload), timeout=15.0)


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
