// background.js - Cookie + CDP Bridge
try {
  importScripts('config.js');
} catch (e) {
  console.warn('[TMWD] config.js load failed, using 127.0.0.1:18865', e);
}
const TMWD_DEFAULT_HOST =
  typeof TMWD_HOST === 'string' && TMWD_HOST.trim() ? TMWD_HOST.trim() : '127.0.0.1';
const TMWD_DEFAULT_PORT =
  typeof TMWD_PORT === 'number' && TMWD_PORT > 0 && TMWD_PORT <= 65535
    ? TMWD_PORT
    : typeof TMWD_PORT === 'string' && /^\d+$/.test(TMWD_PORT)
      ? Math.max(1, Math.min(65535, parseInt(TMWD_PORT, 10)))
      : 18865;
const TMWD_DEFAULT_SECURE =
  typeof TMWD_SECURE === 'boolean' ? TMWD_SECURE : false;
const TMWD_DEFAULT_SKIP_HTTP =
  typeof TMWD_SKIP_HTTP_PROBE === 'boolean'
    ? TMWD_SKIP_HTTP_PROBE
    : TMWD_DEFAULT_SECURE;
const TMWD_DEFAULT_WS_URL =
  typeof TMWD_WS_URL === 'string' ? TMWD_WS_URL.trim() : '';
const TMWD_STORAGE_HOST = 'tmwd_bridge_host';
const TMWD_STORAGE_PORT = 'tmwd_bridge_port';
const TMWD_STORAGE_SECURE = 'tmwd_bridge_secure';

function tmwdParseWsUrl(input) {
  const raw = String(input || '').trim();
  if (!/^wss?:\/\//i.test(raw)) return null;
  try {
    const u = new URL(raw);
    if (!u.hostname) return null;
    const secure = u.protocol === 'wss:';
    const port = u.port
      ? parseInt(u.port, 10)
      : secure
        ? 443
        : 80;
    if (!Number.isFinite(port) || port < 1 || port > 65535) return null;
    return { host: u.hostname, port, secure, wsUrl: raw };
  } catch (_) {
    return null;
  }
}

function tmwdBracketHost(h) {
  if (!h || h.startsWith('[')) return h;
  return h.split(':').length > 2 ? `[${h}]` : h;
}

function tmwdBridgeWsUrl(ep) {
  if (ep.wsUrl) return ep.wsUrl;
  const scheme = ep.secure ? 'wss' : 'ws';
  return `${scheme}://${tmwdBracketHost(ep.host)}:${ep.port}`;
}

function tmwdBridgeHttpUrl(host, port) {
  return `http://${tmwdBracketHost(host)}:${port + 1}`;
}

async function loadBridgeEndpoint() {
  const stored = await chrome.storage.local.get([
    TMWD_STORAGE_HOST,
    TMWD_STORAGE_PORT,
    TMWD_STORAGE_SECURE,
  ]);
  let host =
    typeof stored[TMWD_STORAGE_HOST] === 'string'
      ? stored[TMWD_STORAGE_HOST].trim()
      : '';
  if (!host) host = TMWD_DEFAULT_HOST;

  let port = stored[TMWD_STORAGE_PORT];
  const hasStoredPort = port !== undefined && port !== null && port !== '';
  if (!hasStoredPort) {
    port = TMWD_DEFAULT_PORT;
  } else {
    const n = parseInt(String(port), 10);
    port = Number.isFinite(n) && n >= 1 && n <= 65535 ? n : TMWD_DEFAULT_PORT;
  }

  let secure = stored[TMWD_STORAGE_SECURE];
  if (secure === undefined || secure === null) secure = TMWD_DEFAULT_SECURE;
  else secure = !!secure;

  let wsUrl = TMWD_DEFAULT_WS_URL || null;
  const parsed = tmwdParseWsUrl(host);
  if (parsed) {
    host = parsed.host;
    if (!hasStoredPort) port = parsed.port;
    secure = parsed.secure;
    wsUrl = parsed.wsUrl;
  }

  const skipHttpProbe = TMWD_DEFAULT_SKIP_HTTP || secure;
  return { host, port, secure, skipHttpProbe, wsUrl };
}

let ws = null;
let tmwdCloseInfo = { code: 0, reason: '', wasClean: true };
let tmwdLastError = '';

async function tmwdReconnectBridge() {
  try {
    if (ws) {
      const old = ws;
      ws = null;
      old.onclose = null;
      old.close();
    }
  } catch (_) {}
  scheduleProbe();
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('CDP Bridge installed');
  // Strip CSP headers to allow eval/inline scripts
  chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [9999],
    addRules: [{
      id: 9999, priority: 1,
      action: { type: 'modifyHeaders', responseHeaders: [
        { header: 'content-security-policy', operation: 'remove' },
        { header: 'content-security-policy-report-only', operation: 'remove' }
      ]},
      condition: { urlFilter: '*', resourceTypes: ['main_frame', 'sub_frame'] }
    }]
  });
});

async function debuggerAttachSafe(tabId) {
  try {
    await chrome.debugger.detach({ tabId });
  } catch (_) {}
  await chrome.debugger.attach({ tabId }, '1.3');
}

async function cdpFileChooserFill(msg) {
  const tabId = msg.tabId;
  if (!tabId) return { ok: false, error: 'no tabId' };
  const files = msg.files;
  if (!files || !files.length) return { ok: false, error: 'no files' };
  const clickExpression = String(msg.clickExpression || '').trim() || '(() => {})()';
  const timeoutMs = Number(msg.timeoutMs) || 15000;

  await debuggerAttachSafe(tabId);

  let opened = null;
  const onEv = (source, method, params) => {
    if (source.tabId === tabId && method === 'Page.fileChooserOpened') {
      opened = params;
    }
  };
  chrome.debugger.onEvent.addListener(onEv);

  const collectFrameIds = (node, out) => {
    if (!node || !node.frame || !node.frame.id) return;
    out.push(node.frame.id);
    for (const c of node.childFrames || []) collectFrameIds(c, out);
  };

  const evalClick = async (executionContextId) => {
    const params = {
      expression: clickExpression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    };
    if (executionContextId !== undefined && executionContextId !== null) {
      params.executionContextId = executionContextId;
    }
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', params);
  };

  try {
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable', {});
    await chrome.debugger.sendCommand({ tabId }, 'Page.enable', {});
    await chrome.debugger.sendCommand({ tabId }, 'DOM.enable', {});
    await chrome.debugger.sendCommand({ tabId }, 'Page.setInterceptFileChooserDialog', { enabled: true });

    const deadline = Date.now() + timeoutMs;

    await evalClick(undefined);

    const phase1End = Math.min(deadline, Date.now() + Math.min(2800, timeoutMs));
    while (!opened && Date.now() < phase1End) {
      await new Promise((r) => setTimeout(r, 40));
    }

    if (!opened && Date.now() < deadline) {
      let treeRes = null;
      try {
        treeRes = await chrome.debugger.sendCommand({ tabId }, 'Page.getFrameTree', {});
      } catch (e) {
        treeRes = null;
      }
      const frameIds = [];
      if (treeRes && treeRes.frameTree) collectFrameIds(treeRes.frameTree, frameIds);
      for (const frameId of frameIds) {
        if (opened || Date.now() >= deadline) break;
        try {
          const cw = await chrome.debugger.sendCommand({ tabId }, 'Page.createIsolatedWorld', {
            frameId,
            worldName: 'tmwd_fc_' + String(Math.random()).slice(2, 11),
            grantUniverseAccess: true,
          });
          await evalClick(cw.executionContextId);
        } catch (e) {}
        const sliceEnd = Math.min(deadline, Date.now() + 2200);
        while (!opened && Date.now() < sliceEnd) {
          await new Promise((r) => setTimeout(r, 40));
        }
      }
    }

    while (!opened && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 40));
    }
    if (!opened) {
      return { ok: false, error: 'fileChooserOpened timeout' };
    }
    const backendNodeId = opened.backendNodeId;
    if (backendNodeId === undefined || backendNodeId === null) {
      return { ok: false, error: 'fileChooserOpened without backendNodeId', opened };
    }

    await chrome.debugger.sendCommand({ tabId }, 'DOM.setFileInputFiles', {
      files,
      backendNodeId,
    });

    return { ok: true, data: { fileChooserFilled: true, opened } };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  } finally {
    chrome.debugger.onEvent.removeListener(onEv);
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Page.setInterceptFileChooserDialog', { enabled: false });
    } catch (_) {}
    try {
      await chrome.debugger.detach({ tabId });
    } catch (_) {}
  }
}

async function handleExtMessage(msg, sender) {
  if (msg.cmd === 'tmwd_bridge_get') {
    const stored = await chrome.storage.local.get([
      TMWD_STORAGE_HOST,
      TMWD_STORAGE_PORT,
      TMWD_STORAGE_SECURE,
    ]);
    const effective = await loadBridgeEndpoint();
    return {
      ok: true,
      defaults: {
        host: TMWD_DEFAULT_HOST,
        port: TMWD_DEFAULT_PORT,
        secure: TMWD_DEFAULT_SECURE,
        wsUrl: TMWD_DEFAULT_WS_URL || null,
      },
      stored: {
        host: typeof stored[TMWD_STORAGE_HOST] === 'string' ? stored[TMWD_STORAGE_HOST] : null,
        port: stored[TMWD_STORAGE_PORT] ?? null,
        secure: stored[TMWD_STORAGE_SECURE] ?? null,
      },
      effective,
    };
  }
  if (msg.cmd === 'tmwd_bridge_set') {
    const rawHost = msg.host !== undefined && msg.host !== null ? String(msg.host).trim() : '';
    if (!rawHost) {
      await chrome.storage.local.remove([
        TMWD_STORAGE_HOST,
        TMWD_STORAGE_PORT,
        TMWD_STORAGE_SECURE,
      ]);
      await tmwdReconnectBridge();
      const effective = await loadBridgeEndpoint();
      return { ok: true, effective, cleared: true };
    }
    const parsed = tmwdParseWsUrl(rawHost);
    let host = rawHost;
    let port = parseInt(String(msg.port ?? ''), 10);
    let secure = !!msg.secure;
    if (parsed) {
      host = parsed.host;
      if (!Number.isFinite(port)) port = parsed.port;
      secure = parsed.secure;
    }
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      return { ok: false, error: '端口须为 1–65535 的整数' };
    }
    await chrome.storage.local.set({
      [TMWD_STORAGE_HOST]: host,
      [TMWD_STORAGE_PORT]: port,
      [TMWD_STORAGE_SECURE]: secure,
    });
    await tmwdReconnectBridge();
    const effective = await loadBridgeEndpoint();
    return { ok: true, effective };
  }
  if (msg.cmd === 'tmwd_bridge_status') {
    const ep = await loadBridgeEndpoint();
    const wsUrl = tmwdBridgeWsUrl(ep);
    let httpReachable = false;
    if (!ep.skipHttpProbe) {
      try {
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 1200);
        await fetch(tmwdBridgeHttpUrl(ep.host, ep.port), { signal: ctrl.signal });
        httpReachable = true;
      } catch (_) {}
    }
    const rs = ws ? ws.readyState : null;
    let phase = 'disconnected';
    if (rs === WebSocket.OPEN) phase = 'connected';
    else if (rs === WebSocket.CONNECTING) phase = 'connecting';
    else if (rs === WebSocket.CLOSING) phase = 'closing';
    return {
      ok: true,
      effective: ep,
      wsUrl,
      wsReadyState: rs,
      phase,
      httpReachable: ep.skipHttpProbe ? null : httpReachable,
      skipHttpProbe: ep.skipHttpProbe,
      lastClose: { ...tmwdCloseInfo },
      lastError: tmwdLastError || '',
    };
  }
  if (msg.cmd === 'cookies') return await handleCookies(msg, sender);
  if (msg.cmd === 'cdp_file_chooser_fill') return await cdpFileChooserFill(msg);
  if (msg.cmd === 'cdp') return await handleCDP(msg, sender);
  if (msg.cmd === 'batch') return await handleBatch(msg, sender);
  if (msg.cmd === 'tabs') {
    try {
      if (msg.method === 'switch') {
        const tab = await chrome.tabs.update(msg.tabId, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        return { ok: true };
      } else if (msg.method === 'create') {
        // Opening from the extension side sidesteps Chrome's popup blocker: an
        // injected page script carries no user gesture, so window.open() and the
        // anchor fallback are both suppressed on most sites.
        const tab = await chrome.tabs.create({ url: msg.url, active: msg.active !== false });
        return { ok: true, data: { id: tab.id, url: tab.url, title: tab.title } };
      } else if (msg.method === 'close') {
        const ids = (Array.isArray(msg.tabIds) ? msg.tabIds : [msg.tabId])
          .filter((id) => typeof id === 'number');
        if (!ids.length) return { ok: false, error: 'no tab ids to close' };
        await chrome.tabs.remove(ids);
        return { ok: true, closed: ids };
      } else {
        const tabs = (await chrome.tabs.query({})).filter(t => isScriptable(t.url));
        const data = tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId }));
        return { ok: true, data };
      }
    } catch (e) { return { ok: false, error: e.message }; }
  }
  if (msg.cmd === 'management') {
    try {
      if (msg.method === 'list') {
        const all = await chrome.management.getAll();
        return { ok: true, data: all.map(e => ({ id: e.id, name: e.name, enabled: e.enabled, type: e.type, version: e.version })) };
      }
      if (msg.method === 'reload') {
        chrome.alarms.create('tmwd-self-reload', { when: Date.now() + 200 });
        return { ok: true };
      }
      if (msg.method === 'disable') {
        await chrome.management.setEnabled(msg.extId, false);
        return { ok: true };
      }
      if (msg.method === 'enable') {
        await chrome.management.setEnabled(msg.extId, true);
        return { ok: true };
      }
      return { ok: false, error: 'Unknown method: ' + msg.method };
    } catch (e) { return { ok: false, error: e.message }; }
  }
  return { ok: false, error: 'Unknown cmd: ' + msg.cmd };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleExtMessage(msg, sender).then(sendResponse);
  return true;
});

async function handleCookies(msg, sender) {
  try {
    let url = msg.url || sender.tab?.url;
    if (!url && msg.tabId) {
      const tab = await chrome.tabs.get(msg.tabId);
      url = tab.url;
    }
    const origin = url.match(/^https?:\/\/[^\/]+/)[0];
    const all = await chrome.cookies.getAll({ url });
    const part = await chrome.cookies.getAll({ url, partitionKey: { topLevelSite: origin } }).catch(() => []);
    const merged = [...all];
    for (const c of part) {
      if (!merged.some(x => x.name === c.name && x.domain === c.domain)) merged.push(c);
    }
    return { ok: true, data: merged };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function handleBatch(msg, sender) {
  const R = [];
  let attached = null;
  const resolve$N = (params) => JSON.parse(JSON.stringify(params || {}).replace(/"\$(\d+)\.([^"]+)"/g,
    (_, i, path) => { let v = R[+i]; for (const k of path.split('.')) v = v[k]; return JSON.stringify(v); }));
  try {
    for (const c of msg.commands) {
      if (c.tabId === undefined && msg.tabId !== undefined) c.tabId = msg.tabId;
      if (c.cmd === 'cookies') {
        R.push(await handleCookies(c, sender));
      } else if (c.cmd === 'tabs') {
        const tabs = (await chrome.tabs.query({})).filter(t => isScriptable(t.url));
        R.push({ ok: true, data: tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId })) });
      } else if (c.cmd === 'cdp') {
        const tabId = c.tabId || msg.tabId || sender.tab?.id;
        if (attached !== tabId) {
          if (attached) { await chrome.debugger.detach({ tabId: attached }); attached = null; }
          await debuggerAttachSafe(tabId);
          attached = tabId;
        }
        R.push(await chrome.debugger.sendCommand({ tabId }, c.method, resolve$N(c.params)));
      } else {
        R.push({ ok: false, error: 'unknown cmd: ' + c.cmd });
      }
    }
    if (attached) await chrome.debugger.detach({ tabId: attached });
    return { ok: true, results: R };
  } catch (e) {
    if (attached) try { await chrome.debugger.detach({ tabId: attached }); } catch (_) {}
    return { ok: false, error: e.message, results: R };
  }
}

async function handleCDP(msg, sender) {
  const tabId = msg.tabId || sender.tab?.id;
  if (!tabId) return { ok: false, error: 'no tabId' };
  try {
    await debuggerAttachSafe(tabId);
    const result = await chrome.debugger.sendCommand({ tabId }, msg.method, msg.params || {});
    await chrome.debugger.detach({ tabId });
    return { ok: true, data: result };
  } catch (e) {
    try { await chrome.debugger.detach({ tabId }); } catch (_) {}
    return { ok: false, error: e.message };
  }
}
// Filter out chrome:// and other internal tabs that can't be scripted
const isScriptable = url => url && /^https?:/.test(url);

// --- Shared page/CDP script builder core ---
function buildExecScript(code, errorHandler) {
  return `(async () => {
    function smartProcessResult(result) {
      if (result === null || result === undefined || typeof result !== 'object') return result;
      try { if (result.window === result && result.document) return '[Window: ' + (result.location?.href || 'about:blank') + ']'; } catch(_){}
      if (typeof jQuery !== 'undefined' && result instanceof jQuery) {
        const elements = []; for (let i = 0; i < result.length; i++) { if (result[i] && result[i].nodeType === 1) elements.push(result[i].outerHTML); } return elements;
      }
      if (result instanceof NodeList || result instanceof HTMLCollection) {
        const elements = []; for (let i = 0; i < result.length; i++) { if (result[i] && result[i].nodeType === 1) elements.push(result[i].outerHTML); } return elements;
      }
      if (result.nodeType === 1) return result.outerHTML;
      if (!Array.isArray(result) && typeof result === 'object' && 'length' in result && typeof result.length === 'number') {
        const firstElement = result[0];
        if (firstElement && firstElement.nodeType === 1) {
          const elements = []; const length = Math.min(result.length, 100);
          for (let i = 0; i < length; i++) { const elem = result[i]; if (elem && elem.nodeType === 1) elements.push(elem.outerHTML); } return elements;
        }
      }
      try { return JSON.parse(JSON.stringify(result, function(key, value) { if (typeof value === 'object' && value !== null) { if (value.nodeType === 1) return value.outerHTML; if (value === window || value === document) return '[Object]'; try { if (value.window === value && value.document) return '[Window]'; } catch(_){} } return value; })); } catch (e) { return '[无法序列化: ' + e.message + ']'; }
    }
    try {
      const jsCode = ${JSON.stringify(code)}.trim();
      const lines = jsCode.split(/\\r?\\n/).filter(l => l.trim());
      const lastLine = lines.length > 0 ? lines[lines.length - 1].trim() : '';
      const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
      let r;
      function _air(c) { const ls = c.split(/\\r?\\n/); let i = ls.length - 1; while (i >= 0 && !ls[i].trim()) i--; if (i < 0) return c; const t = ls[i].trim(); if (/^(return |return;|return$|let |const |var |if |if\\(|for |for\\(|while |while\\(|switch|try |throw |class |function |async |import |export |\\/\\/|})/.test(t)) return c; ls[i] = ls[i].match(/^(\\s*)/)[1] + 'return ' + t; return ls.join('\\n'); }
      if (lastLine.startsWith('return')) {
        r = await (new AsyncFunction(jsCode))();
      } else {
        try { r = eval(jsCode); if (r instanceof Promise) r = await r; } catch (e) {
          if (e instanceof SyntaxError && (/return/i.test(e.message) || /await/i.test(e.message))) { r = await (new AsyncFunction(_air(jsCode)))(); } else throw e;
        }
      }
      return { ok: true, data: smartProcessResult(r) };
    } catch (e) {
      ${errorHandler}
    }
  })()`;
}

function buildPageScript(code) {
  return buildExecScript(code, `
      const errMsg = e.message || String(e);
      return { ok: false, error: { name: e.name || 'Error', message: errMsg, stack: e.stack || '' },
        csp: errMsg.includes('Refused to evaluate') || errMsg.includes('unsafe-eval') || errMsg.includes('Content Security Policy') };
  `);
}

function buildCdpScript(code) {
  return buildExecScript(code, `
      return { ok: false, error: { name: e.name || 'Error', message: e.message || String(e), stack: e.stack || '' } };
  `);
}

// --- WebSocket Client for TMWebDriver ---

function scheduleProbe() {
  // Use chrome.alarms to survive MV3 service worker suspension
  chrome.alarms.create('tmwd-ws-probe', { delayInMinutes: 0.083 }); // ~5s
}

function scheduleKeepalive() {
  // Keep SW alive while WS is connected (~25s, under 30s SW timeout)
  chrome.alarms.create('tmwd-ws-keepalive', { delayInMinutes: 0.4 }); // ~24s
}

async function isServerAlive() {
  try {
    const ep = await loadBridgeEndpoint();
    if (ep.skipHttpProbe) return true;
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 2000);
    await fetch(tmwdBridgeHttpUrl(ep.host, ep.port), { signal: ctrl.signal });
    return true;
  } catch (e) {
    return false;
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'tmwd-self-reload') {
    chrome.runtime.reload();
    return;
  }
  if (alarm.name === 'tmwd-ws-keepalive') {
    // Keepalive: ping to keep SW alive + detect dead connections
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send('{"type":"ping"}'); } catch (_) {}
      scheduleKeepalive();
    } else {
      // Connection lost, switch to probe mode
      ws = null;
      scheduleProbe();
    }
  }
  if (alarm.name === 'tmwd-ws-probe') {
    if (ws && ws.readyState <= 1) return; // Already connected/connecting
    if (await isServerAlive()) {
      console.log('[TMWD-WS] Server detected, connecting...');
      await connectWS();
    } else {
      scheduleProbe(); // Server not up, keep probing
    }
  }
});

async function handleWsExec(data) {
  const tabId = data.tabId;
  console.log('[TMWD-WS] Exec request', data.id, 'on tab', tabId);
  ws.send(JSON.stringify({ type: 'ack', id: data.id }));
  if (!tabId) {
    ws.send(JSON.stringify({ type: 'error', id: data.id, error: 'No tabId provided' }));
    return;
  }
  // Use onCreated listener to reliably capture new tabs (avoids race condition with query-diff)
  const newTabIds = new Set();
  const onCreated = (tab) => { newTabIds.add(tab.id); };
  chrome.tabs.onCreated.addListener(onCreated);
  try {
    let res;
    try {
      const result = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: async (s) => await eval(s),
        args: [buildPageScript(data.code)]
      });
      res = result[0]?.result;
      if (res === null || res === undefined) {
        console.log('[TMWD-WS] executeScript returned null/undefined, treating as CSP issue');
        res = { ok: false, error: { name: 'Error', message: 'executeScript returned null (possible CSP or context issue)', stack: '' }, csp: true };
      }
    } catch (e) {
      console.log('[TMWD-WS] scripting.executeScript failed:', e.message);
      res = { ok: false, error: { name: e.name || 'Error', message: e.message || String(e), stack: e.stack || '' }, csp: true };
    }
    // CDP fallback for CSP-restricted pages
    if (res && !res.ok && res.csp) {
      console.log('[TMWD-WS] CDP fallback for tab', tabId);
      const wrappedCode = buildCdpScript(data.code);
      try {
        await debuggerAttachSafe(tabId);
        const cdpRes = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
          expression: wrappedCode, awaitPromise: true, returnByValue: true
        });
        await chrome.debugger.detach({ tabId });
        if (cdpRes.exceptionDetails) {
          const desc = cdpRes.exceptionDetails.exception?.description || 'CDP Error';
          res = { ok: false, error: { name: 'Error', message: desc, stack: desc } };
        } else {
          res = cdpRes.result.value;
        }
      } catch (cdpErr) {
        try { await chrome.debugger.detach({ tabId }); } catch (_) {}
        res = { ok: false, error: { name: 'Error', message: 'CDP fallback failed: ' + cdpErr.message, stack: '' } };
      }
    }
    // Grace period for async tab creation (e.g. link click with target=_blank)
    if (newTabIds.size === 0) await new Promise(r => setTimeout(r, 200));
    chrome.tabs.onCreated.removeListener(onCreated);
    // Get full info for captured new tabs
    const newTabs = [];
    for (const id of newTabIds) {
      try { const t = await chrome.tabs.get(id); newTabs.push({id: t.id, url: t.url, title: t.title}); } catch (_) {}
    }
    if (res?.ok) {
      ws.send(JSON.stringify({ type: 'result', id: data.id, result: res.data, newTabs }));
    } else {
      console.log(res);
      ws.send(JSON.stringify({ type: 'error', id: data.id, error: res?.error || 'Unknown error', newTabs }));
    }
  } catch (e) {
    ws.send(JSON.stringify({ type: 'error', id: data.id, error: { name: e.name || 'Error', message: e.message || String(e), stack: e.stack || '' } }));
  } finally {
    chrome.tabs.onCreated.removeListener(onCreated);
  }
}

async function connectWS() {
  if (ws && ws.readyState <= 1) return;
  ws = null;
  let ep;
  try {
    ep = await loadBridgeEndpoint();
  } catch (e) {
    console.error('[TMWD-WS] loadBridgeEndpoint', e);
    ep = { host: TMWD_DEFAULT_HOST, port: TMWD_DEFAULT_PORT };
  }
  const wsUrl = tmwdBridgeWsUrl(ep);
  console.log('[TMWD-WS] Connecting to', wsUrl);
  try {
    ws = new WebSocket(wsUrl);
  } catch (e) {
    console.error('[TMWD-WS] Constructor error:', e);
    tmwdLastError = e && e.message ? String(e.message) : String(e);
    ws = null;
    scheduleProbe();
    return;
  }
  ws.onopen = async () => {
    tmwdLastError = '';
    tmwdCloseInfo = { code: 0, reason: '', wasClean: true };
    console.log('[TMWD-WS] Connected!');
    scheduleKeepalive(); // Keep SW alive while connected
    const tabs = (await chrome.tabs.query({})).filter(t => isScriptable(t.url));
    ws.send(JSON.stringify({
      type: 'ext_ready',
      tabs: tabs.map(t => ({ id: t.id, url: t.url, title: t.title }))
    }));
    console.log('[TMWD-WS] Sent ext_ready with', tabs.length, 'tabs');
  };
  ws.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.id && data.code) {
        let code = data.code;
        // If code is a JSON string representing an object, parse it
        if (typeof code === 'string') {
          try { const p = JSON.parse(code); if (p && typeof p === 'object') code = p; } catch (_) {}
        }
        if (typeof code === 'object' && code !== null && code.cmd) {
          // Custom protocol message → route to handleExtMessage
          if (code.tabId === undefined && data.tabId !== undefined) code.tabId = data.tabId;
          const res = await handleExtMessage(code, {});
          ws.send(JSON.stringify({ type: res.ok ? 'result' : 'error', id: data.id, result: res.data ?? res.results ?? res, error: res.error }));
        } else if (typeof code === 'string') {
          // Plain JS code
          await handleWsExec(data);
        } else if (typeof code === 'object' && code !== null) {
          // Object without cmd → legacy extension message
          const msg = code.tabId === undefined && data.tabId !== undefined ? { ...code, tabId: data.tabId } : code;
          const res = await handleExtMessage(msg, {});
          ws.send(JSON.stringify({ type: res.ok ? 'result' : 'error', id: data.id, result: res.data ?? res.results ?? res, error: res.error }));
        }
      }
    } catch (e) {
      console.error('[TMWD-WS] message parse error', e);
    }
  };
  ws.onclose = (ev) => {
    tmwdCloseInfo = {
      code: ev.code,
      reason: String(ev.reason || ''),
      wasClean: !!ev.wasClean,
    };
    console.log('[TMWD-WS] Disconnected', tmwdCloseInfo);
    ws = null;
    scheduleProbe();
  };
  ws.onerror = () => {
    tmwdLastError = 'WebSocket 错误';
    console.error('[TMWD-WS] Error');
  };
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (!changes[TMWD_STORAGE_HOST] && !changes[TMWD_STORAGE_PORT]) return;
  void tmwdReconnectBridge();
});

void (async () => {
  try {
    await connectWS();
  } catch (e) {
    console.error('[TMWD-WS] initial connect', e);
    scheduleProbe();
  }
})();
chrome.runtime.onStartup.addListener(() => {
  void connectWS().catch(() => scheduleProbe());
});
chrome.runtime.onInstalled.addListener(() => {
  void connectWS().catch(() => scheduleProbe());
});

// Sync tab list on changes
async function sendTabsUpdate() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const tabs = (await chrome.tabs.query({})).filter(t => isScriptable(t.url) && !/streamlit/i.test(t.title));
  ws.send(JSON.stringify({
    type: 'tabs_update',
    tabs: tabs.map(t => ({ id: t.id, url: t.url, title: t.title }))
  }));
}
chrome.tabs.onUpdated.addListener((_, changeInfo) => {
  if (changeInfo.status === 'complete') sendTabsUpdate();
});
chrome.tabs.onRemoved.addListener(() => sendTabsUpdate());
chrome.tabs.onCreated.addListener(() => sendTabsUpdate());
