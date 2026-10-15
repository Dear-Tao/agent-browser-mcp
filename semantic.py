"""Semantic page interaction for the agent-browser MCP server.

Ideas adapted from pi-control-chrome (@lyd123qw2008/dsh-tool-control-chrome),
rebuilt against this server's own bridge so the single browser channel is kept.

Why the fence is free here: the bridge injects code into the page's MAIN world
(chrome.scripting.executeScript with world:"MAIN"), so state parked on ``window``
survives between MCP calls and dies with the document. A ref minted in document
A is therefore genuinely absent in document B, and ``__ab_doc_id`` lets us prove
it instead of guessing from the URL.

Two ref namespaces, so a fresh observation never clobbers an earlier one:
  ``e<n>``  page_snapshot()  - registry reset on every call (fresh observation)
  ``f<n>``  find_element()   - appended, earlier snapshot refs stay usable
"""

from __future__ import annotations

import json
from typing import Any, Optional

# ---------------------------------------------------------------------------
# Page-side runtime: installed on first use, reused afterwards.
# NOTE: background.js only routes a request to the page when its `code` is NOT a
# JSON object with a `cmd` field. This snippet starts with `window.` so it always
# stays a plain string and is evaluated in the page's MAIN world.
# ---------------------------------------------------------------------------
_RUNTIME_JS = r"""
window.__abrt = (function () {
  var V = 1;
  if (window.__abrt && window.__abrt.v === V) return window.__abrt;

  var RE_INT = 'a[href],button,input,select,textarea,summary,[role],[onclick],' +
               '[tabindex],details,option,label,[contenteditable="true"],' +
               '[contenteditable=""]';

  function docId() {
    if (!window.__ab_doc_id) {
      window.__ab_doc_id = 'd' + Math.random().toString(36).slice(2, 10) +
        Date.now().toString(36);
    }
    return window.__ab_doc_id;
  }

  function isVisible(el) {
    try {
      var r = el.getBoundingClientRect();
      if (r.width <= 0 && r.height <= 0) return false;
      var st = window.getComputedStyle(el);
      return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
    } catch (e) { return false; }
  }

  function text(el) {
    var t = (el.innerText !== undefined ? el.innerText : el.textContent) || '';
    t = String(t).replace(/\s+/g, ' ').trim();
    return t.length > 180 ? t.slice(0, 180) + '...' : t;
  }

  function roleOf(el) {
    var explicit = (el.getAttribute('role') || '').trim().toLowerCase();
    if (explicit) return explicit;
    var tag = el.tagName.toLowerCase();
    switch (tag) {
      case 'a': return el.hasAttribute('href') ? 'link' : '';
      case 'button': return 'button';
      case 'summary': return 'button';
      case 'input':
        var t = (el.getAttribute('type') || 'text').toLowerCase();
        if (t === 'checkbox') return 'checkbox';
        if (t === 'radio') return 'radio';
        if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
        if (t === 'range') return 'slider';
        if (t === 'number') return 'spinbutton';
        if (t === 'search') return 'searchbox';
        if (t === 'hidden') return '';
        return 'textbox';
      case 'textarea': return 'textbox';
      case 'select': return (el.multiple || el.size > 1) ? 'listbox' : 'combobox';
      case 'img': return (el.getAttribute('alt') || '').trim() ? 'image' : '';
      case 'nav': return 'navigation';
      case 'main': return 'main';
      case 'form': return 'form';
      case 'table': return 'table';
      case 'ul': case 'ol': return 'list';
      case 'li': return 'listitem';
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading';
      case 'dialog': return 'dialog';
      case 'details': return 'group';
      case 'label': return '';
      default: return '';
    }
  }

  function nameOf(el) {
    var aria = (el.getAttribute('aria-label') || '').trim();
    if (aria) return aria;
    var by = el.getAttribute('aria-labelledby');
    if (by) {
      var parts = [], ids = by.split(/\s+/);
      for (var i = 0; i < ids.length; i++) {
        var n = document.getElementById(ids[i]);
        if (n) { var v = text(n); if (v) parts.push(v); }
      }
      if (parts.length) return parts.join(' ');
    }
    var tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      if (el.id) {
        var lab = null;
        try { lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); } catch (e) {}
        if (lab) { var lt = text(lab); if (lt) return lt; }
      }
      var wrap = el.closest ? el.closest('label') : null;
      if (wrap) { var wt = text(wrap); if (wt) return wt; }
      var ph = (el.getAttribute('placeholder') || '').trim();
      if (ph) return ph;
      var ti = (el.getAttribute('title') || '').trim();
      if (ti) return ti;
      return '';
    }
    if (tag === 'img') return (el.getAttribute('alt') || '').trim();
    var title = (el.getAttribute('title') || '').trim();
    if (title) return title;
    return text(el);
  }

  function metaOf(el) {
    var m = { tag: el.tagName.toLowerCase(), role: roleOf(el), name: nameOf(el) };
    var t = (el.getAttribute('type') || '').toLowerCase();
    if (t) m.type = t;
    var ph = el.getAttribute('placeholder');
    if (ph) m.placeholder = ph;
    var tid = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
    if (tid) m.testId = tid;
    var cls = (el.getAttribute('class') || '').trim();
    if (cls) m.class = cls.split(/\s+/).slice(0, 3).join(' ');
    return m;
  }

  function line(ref, el) {
    var m = metaOf(el);
    var o = { ref: ref, role: m.role, name: m.name, tag: m.tag };
    if (m.type) o.type = m.type;
    if (m.placeholder) o.placeholder = m.placeholder;
    if (m.testId) o.testId = m.testId;
    return o;
  }

  function collect(opts) {
    var o = opts || {};
    var root = document.body || document.documentElement;
    if (!root) return [];
    var list;
    try { list = Array.from(root.querySelectorAll(o.interactiveOnly === false ? '*' : RE_INT)); }
    catch (e) { return []; }
    var out = [], cap = o.scanLimit || 3000;
    for (var i = 0; i < list.length && out.length < cap; i++) {
      var el = list[i];
      var role = roleOf(el);
      if (o.interactiveOnly !== false && !role) continue;
      if (!isVisible(el)) continue;
      out.push({ el: el, role: role, name: nameOf(el) });
    }
    return out;
  }

  function reg() { if (!window.__ab_nodes) window.__ab_nodes = {}; return window.__ab_nodes; }

  function store(el, prefix) {
    window.__ab_fseq = (window.__ab_fseq || 0) + 1;
    var ref = (prefix || 'f') + window.__ab_fseq;
    reg()[ref] = el;
    return ref;
  }

  function snapshot(opts) {
    var o = opts || {};
    var limit = o.limit || 200, maxChars = o.maxChars || 20000;
    var found = collect({ interactiveOnly: o.interactiveOnly !== false, scanLimit: o.scanLimit });
    var r = reg();
    for (var k in r) { if (Object.prototype.hasOwnProperty.call(r, k)) delete r[k]; }
    var nodes = [], chars = 0, truncated = null;
    for (var i = 0; i < found.length; i++) {
      var el = found[i].el;
      if (nodes.length >= limit) { truncated = 'limit'; break; }
      var m = metaOf(el);
      var cost = (m.name ? m.name.length : 0) + m.role.length + m.tag.length + 14;
      if (chars + cost > maxChars) { truncated = 'max_chars'; break; }
      chars += cost;
      nodes.push(line(store(el, 'e'), el));
    }
    return {
      ok: true, docId: docId(), url: location.href, title: document.title,
      matched: found.length, returned: nodes.length, truncated: truncated, nodes: nodes
    };
  }

  function norm(s) { return s === null || s === undefined ? '' : String(s).trim().toLowerCase(); }

  function find(opts) {
    var o = opts || {};
    var found = collect({ interactiveOnly: o.interactiveOnly !== false, scanLimit: o.scanLimit || 6000 });
    var q = { role: norm(o.role), name: norm(o.name), label: norm(o.label),
              placeholder: norm(o.placeholder), text: norm(o.text), testid: norm(o.testid) };
    var base = found;
    if (o.selector) {
      var set = new Set();
      try {
        var sel = document.querySelectorAll(o.selector);
        for (var s = 0; s < sel.length; s++) set.add(sel[s]);
      } catch (e) { return { ok: false, error: 'BAD_SELECTOR: ' + e.message }; }
      base = found.filter(function (n) {
        return set.has(n.el) || (n.el.parentElement && set.has(n.el.parentElement));
      });
    }
    var hits = base.filter(function (n) {
      if (q.role && n.role !== q.role) return false;
      if (q.name && norm(n.name).indexOf(q.name) === -1) return false;
      if (q.label && norm(n.name) !== q.label) return false;
      if (q.placeholder && norm(n.el.getAttribute('placeholder')) !== q.placeholder) return false;
      if (q.testid) {
        var tid = norm(n.el.getAttribute('data-testid') || n.el.getAttribute('data-test-id') || n.el.id);
        if (tid !== q.testid) return false;
      }
      if (q.text && text(n.el).toLowerCase().indexOf(q.text) === -1) return false;
      return true;
    });
    var count = o.count || 10;
    var start = 0;
    if (o.nth !== null && o.nth !== undefined) start = o.nth < 0 ? hits.length + o.nth : o.nth;
    if (start < 0) start = 0;
    var chosen = hits.slice(start, start + count);
    var nodes = [];
    for (var i = 0; i < chosen.length; i++) nodes.push(line(store(chosen[i].el, 'f'), chosen[i].el));
    return {
      ok: true, docId: docId(), url: location.href, matched: hits.length,
      returned: nodes.length, ambiguous: hits.length > nodes.length, nodes: nodes
    };
  }

  function act(spec) {
    var s = spec || {};
    var ref = s.ref, action = s.action, value = s.value;
    var o = s.opts || {};
    var d = docId();
    if (o.expectDocId && o.expectDocId !== d) {
      return { ok: false, status: 'uncertain', reason: 'BROWSER_DOCUMENT_CHANGED',
               expectedDocId: o.expectDocId, currentDocId: d, ref: ref,
               note: 'Ref was minted in a previous document. Take a fresh page_snapshot; this action was NOT replayed.' };
    }
    var el = reg()[ref];
    if (!el) return { ok: false, status: 'missing', reason: 'UNKNOWN_REF', ref: ref, docId: d };
    if (!el.isConnected) return { ok: false, status: 'missing', reason: 'REF_DETACHED', ref: ref, docId: d };

    var tag = el.tagName.toLowerCase();
    function setVal(v) {
      var proto = tag === 'TEXTAREA' ? HTMLTextAreaElement.prototype
                : tag === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, 'value');
      if (setter && setter.set) setter.set.call(el, v); else el.value = v;
    }
    function fire() {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    }
    function scroll() { try { el.scrollIntoView({ block: 'center' }); } catch (e) {} }

    switch (action) {
      case 'exists':    return { ok: true, status: 'ok', docId: d, ref: ref, exists: true, visible: isVisible(el) };
      case 'text':      return { ok: true, status: 'ok', docId: d, ref: ref,
                                 text: (typeof el.value === 'string') ? el.value : text(el) };
      case 'isEnabled': return { ok: true, status: 'ok', docId: d, ref: ref,
                                 enabled: !el.disabled, visible: isVisible(el),
                                 checked: ('checked' in el) ? !!el.checked : undefined };
      case 'attrs':     return { ok: true, status: 'ok', docId: d, ref: ref, attrs: metaOf(el) };
      case 'scrollIntoView':
        scroll();
        return { ok: true, status: 'ok', docId: d, ref: ref };
      case 'click':
        scroll();
        el.click();
        break;
      case 'hover':
        scroll();
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        break;
      case 'focus':
        el.focus();
        break;
      case 'fill':
        setVal(value === null || value === undefined ? '' : String(value));
        fire();
        break;
      case 'clear':
        setVal('');
        fire();
        break;
      case 'select':
        setVal(value === null || value === undefined ? '' : String(value));
        fire();
        break;
      case 'check':
        if (!el.checked) { if (typeof el.click === 'function') el.click(); else el.checked = true; }
        break;
      case 'uncheck':
        if (el.checked) { if (typeof el.click === 'function') el.click(); else el.checked = false; }
        break;
      default:
        return { ok: false, status: 'error', reason: 'UNKNOWN_ACTION', action: action };
    }

    var after = docId();
    if (after !== d) {
      return { ok: false, status: 'uncertain', reason: 'BROWSER_DOCUMENT_CHANGED_DURING_ACTION',
               ref: ref, action: action,
               note: 'Action was dispatched but the document changed underneath it. Not replayed - re-observe and verify before retrying.' };
    }
    return { ok: true, status: 'ok', docId: after, ref: ref, action: action, confirmed: true };
  }

  function state() {
    var r = reg(), n = 0;
    for (var k in r) { if (Object.prototype.hasOwnProperty.call(r, k)) n++; }
    return { ok: true, docId: docId(), url: location.href, title: document.title,
             readyState: document.readyState, liveRefs: n };
  }

  return {
    v: V, docId: docId, state: state, snapshot: snapshot, find: find,
    act: act, store: store, meta: function (el) {
      var m = metaOf(el);
      m.visible = isVisible(el);
      return m;
    }
  };
})();
"""


def _snippet(call: str, config: Optional[dict] = None) -> str:
    """Page code that installs the runtime if needed, then makes one call."""
    cfg = json.dumps(config or {}, ensure_ascii=False)
    return _RUNTIME_JS + "\nreturn window.__abrt." + call + "(" + cfg + ");\n"


_SECRET_HINTS = ("password", "passwd", "token", "secret", "otp", "cvv", "card", "authorization")


def _unwrap(driver, code: str, timeout: float = 20.0) -> dict[str, Any]:
    """Send a page snippet and normalise the bridge response.

    A navigation during the call makes the bridge answer with {closed: 1}; that is
    an *unknown outcome*, not a failure, so it is surfaced as 'uncertain' rather
    than being reported as an error the caller would retry.
    """
    try:
        raw = driver.execute_js(code, timeout=timeout)
    except Exception as exc:
        detail = exc.args[0] if exc.args else str(exc)
        if isinstance(detail, dict):
            detail = detail.get("message") or str(detail)
        return {
            "ok": False,
            "status": "unavailable",
            "reason": "BRIDGE_REJECTED",
            "note": str(detail)[:400],
            "hint": (
                "The page rejected the injected script and the extension's CDP fallback did "
                "not complete. This affects every page-script tool on this tab (scan_page, "
                "execute_js and these alike) - try cdp_command, or another tab."
            ),
        }
    if isinstance(raw, dict) and raw.get("closed"):
        return {
            "ok": False,
            "status": "uncertain",
            "reason": "TAB_RELOADED_DURING_CALL",
            "note": str(raw.get("result", "")),
        }
    # The bridge answers with a prose string when the injected script never came
    # back. That happens on CSP-strict sites: the page blocks eval, and the
    # extension's CDP fallback does not settle. Pre-existing, not per-tool.
    if isinstance(raw, dict) and isinstance(raw.get("result"), str):
        detail = raw["result"]
        if "No response data" in detail:
            return {
                "ok": False,
                "status": "unavailable",
                "reason": "PAGE_SCRIPT_NOT_EXECUTED",
                "note": detail,
                "hint": (
                    "This page blocked the injected script (strict Content-Security-Policy), "
                    "and the extension's CDP fallback did not respond. Try open_new_tab to a "
                    "less restricted surface, or use cdp_command for raw CDP."
                ),
            }
        return {"ok": False, "status": "error", "note": detail}
    data = raw.get("data") if isinstance(raw, dict) else raw
    if isinstance(data, str):
        try:
            data = json.loads(data)
        except Exception:
            return {"ok": False, "error": "unparsable page payload", "raw": data[:500]}
    if not isinstance(data, dict):
        return {"ok": False, "error": "unexpected page payload", "raw": repr(data)[:500]}
    return data


def redact(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Flag credential-shaped elements before their detail reaches the model."""
    out = []
    for node in nodes:
        clean = dict(node)
        blob = " ".join(
            str(clean.get(k, "")) for k in ("name", "placeholder", "class", "testId", "type")
        ).lower()
        if any(hint in blob for hint in _SECRET_HINTS):
            clean["redacted"] = True
            clean.pop("value", None)
        out.append(clean)
    return out


def page_state(driver) -> dict[str, Any]:
    return _unwrap(driver, _snippet("state"))


def page_snapshot(
    driver,
    interactive_only: bool = True,
    limit: int = 200,
    max_chars: int = 20000,
    scan_limit: int = 3000,
) -> dict[str, Any]:
    payload = _unwrap(
        driver,
        _snippet(
            "snapshot",
            {
                "interactiveOnly": interactive_only,
                "limit": limit,
                "maxChars": max_chars,
                "scanLimit": scan_limit,
            },
        ),
    )
    if payload.get("ok") and isinstance(payload.get("nodes"), list):
        payload["nodes"] = redact(payload["nodes"])
    return payload


def find_element(
    driver,
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
    scan_limit: int = 6000,
) -> dict[str, Any]:
    payload = _unwrap(
        driver,
        _snippet(
            "find",
            {
                "role": role, "name": name, "label": label, "placeholder": placeholder,
                "text": text, "testid": testid, "selector": selector, "nth": nth,
                "count": count, "interactiveOnly": interactive_only, "scanLimit": scan_limit,
            },
        ),
    )
    if payload.get("ok") and isinstance(payload.get("nodes"), list):
        payload["nodes"] = redact(payload["nodes"])
    return payload


def element_action(
    driver,
    ref: str,
    action: str = "click",
    value: Optional[str] = None,
    expect_doc_id: str = "",
) -> dict[str, Any]:
    return _unwrap(
        driver,
        _snippet(
            "act",
            {"ref": ref, "action": action, "value": value, "opts": {"expectDocId": expect_doc_id}},
        ),
    )