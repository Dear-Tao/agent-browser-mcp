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
const TMWD_STORAGE_BROWSER_LABEL = 'tmwd_browser_label';
const TMWD_STORAGE_BROWSER_ID = 'tmwd_browser_id';

/** 生成一次、永不覆盖的浏览器指纹（绑定本 Chrome/Edge 配置的扩展本地存储）。 */
function generateBrowserId() {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = (Math.random() * 256) | 0;
  }
  return (
    'b_' +
    Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  );
}

function isStableBrowserId(id) {
  return typeof id === 'string' && /^b_[0-9a-f]{16,}$/i.test(id);
}

/**
 * 每个浏览器配置一份稳定 id + 用户可改的辨识名。
 * id 写入 chrome.storage.local：关浏览器 / 重启 / 重载扩展都保持不变；
 * 只有卸载扩展或清站点数据才会丢（会重新生成）。
 * @returns {Promise<{id: string, label: string, display: string, persisted: boolean}>}
 */
async function loadBrowserIdentity() {
  const stored = await chrome.storage.local.get([
    TMWD_STORAGE_BROWSER_LABEL,
    TMWD_STORAGE_BROWSER_ID,
  ]);
  let id = stored[TMWD_STORAGE_BROWSER_ID];
  let persisted = true;
  // 兼容旧版短 id（b + 8 位），继续沿用，绝不擅自换新
  const legacyOk = typeof id === 'string' && /^b[a-z0-9_]{6,}$/i.test(id);
  if (!isStableBrowserId(id) && !legacyOk) {
    id = generateBrowserId();
    await chrome.storage.local.set({ [TMWD_STORAGE_BROWSER_ID]: id });
    persisted = false;
  }
  const label =
    typeof stored[TMWD_STORAGE_BROWSER_LABEL] === 'string'
      ? stored[TMWD_STORAGE_BROWSER_LABEL].trim()
      : '';
  const display = label || `浏览器-${String(id).slice(-4)}`;
  return { id, label, display, persisted: persisted || legacyOk || isStableBrowserId(id) };
}

/** 工具栏图标不挂辨识名；悬停标题仍带名字，方便多开时区分。 */
async function refreshBrowserBadge() {
  try {
    const ident = await loadBrowserIdentity();
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({
      title: `Agent Browser Bridge｜${ident.display}`,
    });
  } catch (_) {}
}

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
  // 录制中的标签页已由录制器持有 debugger attach：直接复用，不要 detach（会杀死录制会话）
  if (recCdpAttached && recCdpAttached.has(tabId)) return;
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
  if (msg.cmd === 'tmwd_browser_get') {
    const ident = await loadBrowserIdentity();
    return { ok: true, ...ident };
  }
  if (msg.cmd === 'tmwd_browser_set') {
    const label = msg.label !== undefined && msg.label !== null ? String(msg.label).trim() : '';
    if (!label) {
      await chrome.storage.local.remove([TMWD_STORAGE_BROWSER_LABEL]);
    } else {
      await chrome.storage.local.set({ [TMWD_STORAGE_BROWSER_LABEL]: label.slice(0, 32) });
    }
    await refreshBrowserBadge();
    await sendTabsUpdate();
    const ident = await loadBrowserIdentity();
    return { ok: true, ...ident };
  }
  if (msg.cmd === 'tmwd_bridge_get') {
    const stored = await chrome.storage.local.get([
      TMWD_STORAGE_HOST,
      TMWD_STORAGE_PORT,
      TMWD_STORAGE_SECURE,
    ]);
    const effective = await loadBridgeEndpoint();
    const browser = await loadBrowserIdentity();
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
      browser,
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
    const browser = await loadBrowserIdentity();
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
      browser,
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
        // 扩展侧开页可绕过 popup blocker：页面注入脚本没有用户手势，
        // window.open / 锚点点击在多数站点会被拦，chrome.tabs.create 不受影响。
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
  if (msg.cmd === 'downloads') {
    try {
      const q = { limit: Number(msg.limit) || 20, orderBy: ['-startTime'] };
      if (msg.state) q.state = msg.state;
      const items = await chrome.downloads.search(q);
      return { ok: true, data: items.map(d => ({
        id: d.id, filename: d.filename, url: d.url, state: d.state, mime: d.mime,
        bytes: d.bytesReceived, total: d.totalBytes, started: d.startTime,
        ended: d.endTime || undefined, error: d.error || undefined,
      })) };
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
  if (msg.cmd === 'recorder') return await handleRecorder(msg);
  if (msg.cmd === 'rec_event') return await handleRecEvent(msg);
  return { ok: false, error: 'Unknown cmd: ' + msg.cmd };
}

// --- 操作录制器（一期：录制 + 缓冲 + 导出数据源）---
// 状态/缓冲都放 chrome.storage.local（每个浏览器 Profile 独立），SW 休眠不丢事件。
// rid 为单调递增 id，服务端按 rid 去重（缓冲分片推送会重叠）。
const TMWD_STORAGE_REC_STATE = 'tmwd_rec_state';
const TMWD_STORAGE_REC_BUFFER = 'tmwd_rec_buffer';
const TMWD_STORAGE_REC_SEQ = 'tmwd_rec_seq';
const REC_BUFFER_CAP = 10000;
const REC_BODY_CAP = 8192;      // 响应体截断（商品列表等大 JSON 需要）
const REC_PUSH_BATCH_BYTES = 256 * 1024; // 单条 WS 消息按字节分批（服务端 MAXPAYLOAD 32MB）
let recState = null;        // 缓存的录制开关状态
let recStateLoaded = false; // SW 冷启动后是否已从 storage 恢复
let recBuffer = [];
let recBufferLoaded = false;
let recSeq = 0;
let recPushedSeq = 0;       // 已推送到服务端的最大 rid（防缓冲滚动后旧事件丢失）
let recFlushTimer = null;

function recLocalStamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function recGetState() {
  if (!recStateLoaded) {
    const s = await chrome.storage.local.get(TMWD_STORAGE_REC_STATE);
    recState = s[TMWD_STORAGE_REC_STATE] || null;
    recStateLoaded = true;
  }
  return recState;
}

let recLoadPromise = null;  // 并发加载记忆化：避免双调用方互相覆盖刚追加的事件

async function recLoadBuffer() {
  if (recBufferLoaded) return recBuffer;
  if (!recLoadPromise) {
    recLoadPromise = (async () => {
      const s = await chrome.storage.local.get([
        TMWD_STORAGE_REC_BUFFER,
        TMWD_STORAGE_REC_SEQ,
        'tmwd_rec_pushed',
      ]);
      recBuffer = Array.isArray(s[TMWD_STORAGE_REC_BUFFER]) ? s[TMWD_STORAGE_REC_BUFFER] : [];
      recSeq = Number(s[TMWD_STORAGE_REC_SEQ]) || 0;
      recPushedSeq = Number(s.tmwd_rec_pushed) || 0;
      if (recBuffer.length) {
        // 历史事件 24 小时自动过期：隔天再录不会带着陈旧时间线
        const cutoff = Date.now() - 24 * 3600 * 1000;
        const fresh = recBuffer.filter((e) => (Number(e.ts) || 0) >= cutoff);
        if (fresh.length !== recBuffer.length) {
          recBuffer = fresh;
          void chrome.storage.local.set({ [TMWD_STORAGE_REC_BUFFER]: fresh });
        }
      }
      if (recBuffer.length) {
        const maxRid = Math.max(...recBuffer.map((e) => Number(e.rid) || 0));
        if (maxRid > recSeq) recSeq = maxRid;
        // SW 冷启动后与可能已重启的服务端之间留 200 条重叠窗口，靠服务端 rid 去重兜底
        if (recPushedSeq < maxRid - 200) recPushedSeq = maxRid - 200;
      }
      recBufferLoaded = true;
      return recBuffer;
    })();
  }
  await recLoadPromise;
  return recBuffer;
}

async function recPersist() {
  try {
    // 持久化瘦身：body 只保留最近 500 条（storage 配额保护：最坏 500×8KB≈4MB < 10MB 配额），
    // 更早的事件只留元数据；正常流程无影响（body 已实时推送至服务端），
    // 仅影响"服务端丢失后靠扩展缓冲 repush 恢复"场景的早期事件保真度
    const buf = recBuffer.slice(-REC_BUFFER_CAP);
    const keepBodies = 500;
    const slim = buf.map((e, idx) => (
      idx < buf.length - keepBodies && e.body !== undefined ? { ...e, body: undefined } : e
    ));
    await chrome.storage.local.set({
      [TMWD_STORAGE_REC_BUFFER]: slim,
      [TMWD_STORAGE_REC_SEQ]: recSeq,
      tmwd_rec_pushed: recPushedSeq,
    });
  } catch (_) {}
}

function recScheduleFlush() {
  if (recFlushTimer) return;
  recFlushTimer = setTimeout(() => {
    recFlushTimer = null;
    void recPersist().then(() => recPushToServer());
  }, 800);
}

async function recPushToServer() {
  try {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    await recLoadBuffer();
    if (!recBuffer.length) return;
    // 只推未推送过的 rid（缓冲滚动后旧事件不丢）；按字节分批（胖事件友好）
    const pending = recBuffer.filter((e) => (Number(e.rid) || 0) > recPushedSeq);
    if (!pending.length) return;
    const ident = await loadBrowserIdentity();
    let bytes = 0;
    let batch = [];
    for (const ev of pending) {
      const size = JSON.stringify(ev).length;
      if (batch.length && bytes + size > REC_PUSH_BATCH_BYTES) {
        ws.send(JSON.stringify({
          type: 'rec_events',
          browser: { id: ident.id, label: ident.display },
          events: batch,
        }));
        recPushedSeq = Math.max(recPushedSeq, Number(batch[batch.length - 1].rid) || recPushedSeq);
        batch = [];
        bytes = 0;
      }
      batch.push(ev);
      bytes += size;
    }
    if (batch.length) {
      ws.send(JSON.stringify({
        type: 'rec_events',
        browser: { id: ident.id, label: ident.display },
        events: batch,
      }));
      recPushedSeq = Math.max(recPushedSeq, Number(batch[batch.length - 1].rid) || recPushedSeq);
    }
  } catch (_) {}
}

async function handleRecorder(msg) {
  const method = msg.method || 'status';
  const state = await recGetState();
    if (method === 'start') {
    if (state && state.active) {
      await recLoadBuffer();
      return { ok: true, already: true, browser_id: state.browser_id,
               browser_label: state.browser_label, started_at: state.started_at,
               events: recBuffer.length };
    }
    const ident = await loadBrowserIdentity();
    const st = {
      active: true,
      session_id: 'rec_' + recLocalStamp(),
      browser_id: ident.id,
      browser_label: ident.display,
      started_at: new Date().toISOString(),
    };
    recState = st;
    recStateLoaded = true;
    recBuffer = [];
    recBufferLoaded = true;
    recPushedSeq = recSeq; // recSeq 不归零（rid 全局单调），游标直接对齐
    await chrome.storage.local.set({
      [TMWD_STORAGE_REC_STATE]: st,
      [TMWD_STORAGE_REC_BUFFER]: [],
    });
    // 关键：向所有已存在的标签页（含 iframe）主动注入采集代码——
    // 扩展更新后旧页面跑的是旧采集脚本，仅靠 manifest 声明永远覆盖不到
    const injectResults = [];
    try {
      const tabs = await chrome.tabs.query({});
      const jobs = tabs.filter((t) => isScriptable(t.url)).map(async (t) => {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: t.id, allFrames: true },
            files: ['recorder_capture.js'],
          });
          return { tabId: t.id, url: String(t.url || '').slice(0, 60), ok: true };
        } catch (e) {
          return { tabId: t.id, url: String(t.url || '').slice(0, 60), ok: false,
                   error: String((e && e.message) || e).slice(0, 100) };
        }
      });
      injectResults.push(...await Promise.allSettled(jobs).then((rs) => rs.map((r) => r.value || { ok: false, error: 'unsettled' })));
    } catch (e) {
      injectResults.push({ ok: false, error: 'query: ' + String((e && e.message) || e).slice(0, 100) });
    }
    void recCdpAttachAll(); // CDP 响应体捕获（横幅 = 录制中提示）
    const injectedOk = injectResults.filter((r) => r.ok).length;
    return { ok: true, ...st, injected_tabs: injectedOk, inject_results: injectResults };
  }
  if (method === 'stop') {
    await recLoadBuffer();
    if (recFlushTimer) { clearTimeout(recFlushTimer); recFlushTimer = null; }
    await recPersist();
    const stoppedAt = new Date().toISOString();
    if (state && state.active) {
      const stopped = { ...state, active: false, stopped_at: stoppedAt };
      recState = stopped;
      await chrome.storage.local.set({ [TMWD_STORAGE_REC_STATE]: stopped });
      await recPushToServer();
      // 通知服务端该会话已结束（服务端自动把该次会话落盘为 recordings/<session_id>.*）
      try {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'rec_stopped',
            session_id: state.session_id,
            browser: { id: state.browser_id, label: state.browser_label },
            events: recBuffer.length,
          }));
        }
      } catch (_) {}
      void recCdpDetachAll(); // 释放 debugger attach（横幅消失）
      return { ok: true, stopped: true, session_id: state.session_id,
               browser_id: state.browser_id,
               browser_label: state.browser_label, events: recBuffer.length,
               started_at: state.started_at, stopped_at: stoppedAt };
    }
    return { ok: true, stopped: false, note: 'not recording', events: recBuffer.length };
  }
  if (method === 'dump') {
    await recLoadBuffer();
    return { ok: true, state, events: recBuffer };
  }
  if (method === 'repush') {
    // 恢复路径：重置推送游标，把整个缓冲重新推给服务端（rid 去重由服务端负责）
    await recLoadBuffer();
    recPushedSeq = 0;
    await recPersist();
    await recPushToServer();
    return { ok: true, repushed: recBuffer.length };
  }
  // status
  await recLoadBuffer();
  return {
    ok: true,
    recording: !!(state && state.active),
    session_id: state ? state.session_id : null,
    browser_id: state ? state.browser_id : null,
    browser_label: state ? state.browser_label : null,
    started_at: state ? state.started_at : null,
    events: recBuffer.length,
  };
}

async function handleRecEvent(msg) {
  const state = await recGetState();
  if (!state || !state.active) return { ok: false, note: 'not recording' };
  const ev = msg.event;
  if (!ev || typeof ev !== 'object') return { ok: false, error: 'no event' };
  await recLoadBuffer();
  // 双保险去重：多监听器场景（旧世界残留）下，同一元素 100ms 内的重复 click 折叠
  const prev = recBuffer[recBuffer.length - 1];
  if (ev.type === 'click' && prev && prev.type === 'click'
    && prev.css === ev.css && (prev.id || '') === (ev.id || '')
    && Math.abs((ev.ts || 0) - (prev.ts || 0)) < 100) {
    return { ok: true, dedup: true };
  }
  recSeq += 1;
  recBuffer.push({ ...ev, rid: recSeq, session: state.session_id, browser_id: state.browser_id, ts: ev.ts || Date.now() });
  if (recBuffer.length > REC_BUFFER_CAP) {
    recBuffer.splice(0, recBuffer.length - REC_BUFFER_CAP);
  }
  recScheduleFlush();
  return { ok: true };
}

// --- 录制响应体（CDP Network 域：录制期间持有 debugger attach，横幅即"录制中"提示）---
const recCdpAttached = new Set(); // tabId 集合：录制器持有的 debugger attach
const recCdpPending = new Map();  // cdpRequestId -> { url, status }

function recIsNoiseUrl(url) {
  // 静态资源 / 桥接自探针 / Cloudflare 挑战 / 统计埋点不进时间线
  try {
    if (/\.(js|mjs|css|png|jpe?g|gif|webp|svg|woff2?|ico|mp4|mp3)(\?|$)/i.test(url)) return true;
    if (/^https?:\/\/(127\.0\.0\.1|localhost):(18865|18866)\//i.test(url)) return true;
    if (/\/cdn-cgi\//i.test(url)) return true;
    if (/(google-analytics\.com|googletagmanager\.com|doubleclick\.net|\/g\/collect|_private\/browser\/rum)/i.test(url)) return true;
    return false;
  } catch (_) {
    return false;
  }
}

async function recCdpAttachTab(tabId) {
  if (recCdpAttached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {});
    recCdpAttached.add(tabId);
  } catch (e) {
    // SW 重启后旧 attach 仍有效（同一扩展身份）：attach 报 already attached 时
    // 尝试直接用 Network.enable 验证客户端身份，成功则视为已持有
    const msg = String((e && e.message) || e);
    if (/already attached/i.test(msg)) {
      try {
        await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {});
        recCdpAttached.add(tabId);
      } catch (_) {}
    }
  }
}

async function recCdpAttachAll() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (isScriptable(t.url)) await recCdpAttachTab(t.id);
    }
  } catch (_) {}
}

async function recCdpDetachAll() {
  for (const tabId of Array.from(recCdpAttached)) {
    try { await chrome.debugger.detach({ tabId }); } catch (_) {}
    recCdpAttached.delete(tabId);
  }
}

async function recCdpHandleEvent(source, method, params) {
  if (!method || !method.startsWith('Network.')) return;
  const st = await recGetState();
  if (!st || !st.active) return;
  const tabId = source && source.tabId;
  if (!tabId) return;
  // 只对"值得录的请求"做自愈挂载，静态资源事件不触发（避免 attach 风暴）
  const isRecordableRequest = method === 'Network.requestWillBeSent'
    && ((params.type || '') === 'XHR' || (params.type || '') === 'Fetch');
  if (!recCdpAttached.has(tabId)) {
    if (!isRecordableRequest) return;
    await recCdpAttachTab(tabId);
    if (!recCdpAttached.has(tabId)) return;
  }
  if (method === 'Network.requestWillBeSent') {
    // 只录 API 类请求；Script/样式/图片等静态资源与主文档导航不进时间线
    if (!isRecordableRequest) return;
    const req = params.request || {};
    const url = String(req.url || '');
    if (!/^https?:/i.test(url)) return;
    if (recIsNoiseUrl(url)) return;
    await recLoadBuffer();
    recSeq += 1;
    const rid = recSeq;
    const ev = {
      type: 'request', method: req.method, url: url.slice(0, 500),
      rid, session: st.session_id, browser_id: st.browser_id, ts: Date.now(), via: 'cdp', tabId,
    };
    if (req.postData) ev.postData = String(req.postData).slice(0, REC_BODY_CAP);
    recBuffer.push(ev);
    if (recBuffer.length > REC_BUFFER_CAP) recBuffer.splice(0, recBuffer.length - REC_BUFFER_CAP);
    recScheduleFlush();
    recCdpPending.set(params.requestId, { rid });
  } else if (method === 'Network.responseReceived') {
    const pend = recCdpPending.get(params.requestId);
    if (!pend) return; // 请求本身已被过滤（noise/非 API），响应同样不记
    const resp = params.response || {};
    const mime = String(resp.mimeType || '').toLowerCase();
    // CSS/JS chunk/图片等非 API 响应：连带移除其请求事件（XHR 加载的样式/模块无扩展名，URL 过滤拦不住）
    if (mime.includes('css') || mime.includes('javascript') || mime.startsWith('image/')
      || mime.startsWith('font/') || mime.startsWith('video/') || mime.startsWith('audio/')
      || mime === 'application/octet-stream') {
      recCdpPending.delete(params.requestId);
      if (pend.rid) {
        const idx = recBuffer.findIndex((e) => e.rid === pend.rid);
        if (idx !== -1) recBuffer.splice(idx, 1);
      }
      return;
    }
    recCdpPending.set(params.requestId, {
      rid: pend.rid,
      url: String(resp.url || '').slice(0, 500),
      status: resp.status,
      mime,
    });
    if (recCdpPending.size > 500) {
      const oldest = recCdpPending.keys().next().value;
      recCdpPending.delete(oldest);
    }
  } else if (method === 'Network.loadingFinished') {
    const meta = recCdpPending.get(params.requestId);
    recCdpPending.delete(params.requestId);
    if (!meta) return;
    // 只抓文本类响应体；图片/二进制（无扩展名的头像、像素 GIF 等）只记状态
    const mime = (meta.mime || '').toLowerCase();
    const isText = mime.startsWith('text/') || mime.includes('json')
      || mime.includes('javascript') || mime.includes('xml') || mime.includes('x-www-form-urlencoded')
      || mime === '';
    let body = '';
    try {
      if (isText) {
        const r = await chrome.debugger.sendCommand({ tabId }, 'Network.getResponseBody', { requestId: params.requestId });
        body = String(r.body || '');
      if (r.base64Encoded) body = atob(body);
      body = body.slice(0, REC_BODY_CAP);
      }
    } catch (_) {}
    await recLoadBuffer();
    recSeq += 1;
    recBuffer.push({
      type: 'response', url: meta.url, status: meta.status, body,
      rid: recSeq, session: st.session_id, browser_id: st.browser_id, ts: Date.now(),
    });
    if (recBuffer.length > REC_BUFFER_CAP) recBuffer.splice(0, recBuffer.length - REC_BUFFER_CAP);
    recScheduleFlush();
  } else if (method === 'Network.loadingFailed') {
    const meta = recCdpPending.get(params.requestId);
    recCdpPending.delete(params.requestId);
    if (!meta) return;
    await recLoadBuffer();
    recSeq += 1;
    recBuffer.push({
      type: 'response', url: meta.url, status: 'failed', errorText: String(params.errorText || '').slice(0, 100),
      rid: recSeq, session: st.session_id, browser_id: st.browser_id, ts: Date.now(),
    });
    recScheduleFlush();
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  void recCdpHandleEvent(source, method, params).catch(() => {});
});
chrome.debugger.onDetach.addListener((source) => {
  if (source && source.tabId) recCdpAttached.delete(source.tabId);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[TMWD_STORAGE_REC_STATE]) {
    recState = changes[TMWD_STORAGE_REC_STATE].newValue || null;
    recStateLoaded = true;
  }
});

// --- 录制网络请求（webRequest 后台级：不依赖页面存活，跨导航稳定）---
// 只录 xmlhttprequest（fetch/XHR API 调用）；main_frame 导航由 tabs.onUpdated 记录。
// 状态码由 onCompleted 回填；已推送游标之后才回填的状态会丢失（大多数 API <800ms 内完成）。
const recReqStatusMap = new Map(); // requestId -> rid
const REC_REQ_MAP_CAP = 500;

chrome.webRequest.onBeforeRequest.addListener((details) => {
  void (async () => {
    try {
      if (recCdpAttached.has(details.tabId)) return; // CDP 已在录该 tab，避免重复
      const st = await recGetState();
      if (!st || !st.active) return;
      if (details.type !== 'xmlhttprequest') return;
      const url = String(details.url || '');
      if (!/^https?:/i.test(url)) return;
      if (recIsNoiseUrl(url)) return;
      if (/\.(js|mjs|css|png|jpe?g|gif|webp|svg|woff2?|ico|mp4|mp3)(\?|$)/i.test(url)) return;
      await recLoadBuffer();
      recSeq += 1;
      const rid = recSeq;
      recBuffer.push({
        type: 'request', method: details.method, url: url.slice(0, 500),
        tabId: details.tabId, requestId: details.requestId,
        rid, session: st.session_id, browser_id: st.browser_id, ts: Date.now(),
      });
      if (recBuffer.length > REC_BUFFER_CAP) {
        recBuffer.splice(0, recBuffer.length - REC_BUFFER_CAP);
      }
      recReqStatusMap.set(details.requestId, rid);
      if (recReqStatusMap.size > REC_REQ_MAP_CAP) {
        const oldest = recReqStatusMap.keys().next().value;
        recReqStatusMap.delete(oldest);
      }
      recScheduleFlush();
    } catch (_) {}
  })();
}, { urls: ['http://*/*', 'https://*/*'] });

chrome.webRequest.onCompleted.addListener((details) => {
  void (async () => {
    try {
      const st = await recGetState();
      const rid = recReqStatusMap.get(details.requestId);
      recReqStatusMap.delete(details.requestId);
      if (!st || !st.active || rid === undefined) return;
      await recLoadBuffer();
      const ev = recBuffer.find((e) => e.rid === rid);
      if (ev) ev.status = details.statusCode;
    } catch (_) {}
  })();
}, { urls: ['http://*/*', 'https://*/*'] });


chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleExtMessage(msg, sender).then(sendResponse);
  return true;
});

async function handleCookies(msg, sender) {
  try {
    // method: get(default) | set | clear
    const method = msg.method || 'get';
    if (method === 'set') {
      const list = Array.isArray(msg.cookies) ? msg.cookies : [];
      const results = [];
      for (const c of list) {
        if (!c || !c.name) {
          results.push({ ok: false, error: 'missing name' });
          continue;
        }
        const domain = c.domain || '';
        const host = domain.replace(/^\./, '') || 'ozon.ru';
        const url =
          c.url ||
          (c.secure === false ? `http://${host}/` : `https://${host}/`);
        const details = {
          url,
          name: c.name,
          value: c.value == null ? '' : String(c.value),
          path: c.path || '/',
          secure: !!c.secure,
          httpOnly: !!c.httpOnly,
        };
        if (domain) details.domain = domain;
        if (c.expirationDate != null && Number.isFinite(Number(c.expirationDate))) {
          details.expirationDate = Number(c.expirationDate);
        }
        const ss = c.sameSite;
        if (ss && ss !== 'unspecified') details.sameSite = ss;
        if (c.partitionKey && typeof c.partitionKey === 'object') {
          details.partitionKey = c.partitionKey;
        }
        try {
          const saved = await chrome.cookies.set(details);
          results.push({
            ok: !!saved,
            name: c.name,
            domain: domain || null,
            error: saved ? null : 'chrome.cookies.set returned null',
          });
        } catch (e) {
          results.push({
            ok: false,
            name: c.name,
            domain: domain || null,
            error: e.message || String(e),
          });
        }
      }
      const okCount = results.filter((r) => r.ok).length;
      return { ok: true, data: { set: okCount, total: list.length, results } };
    }

    let url = msg.url || sender.tab?.url;
    if (!url && msg.tabId) {
      const tab = await chrome.tabs.get(msg.tabId);
      url = tab.url;
    }
    if (!url) return { ok: false, error: 'no url for cookies' };
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
    await refreshBrowserBadge();
    await sendTabsUpdate('ext_ready');
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
    await refreshBrowserBadge();
    await connectWS();
  } catch (e) {
    console.error('[TMWD-WS] initial connect', e);
    scheduleProbe();
  }
})();
chrome.runtime.onStartup.addListener(() => {
  void refreshBrowserBadge();
  void connectWS().catch(() => scheduleProbe());
});
chrome.runtime.onInstalled.addListener(() => {
  void refreshBrowserBadge();
  void connectWS().catch(() => scheduleProbe());
});

// Sync tab list on changes（附带浏览器辨识，供 Agent 区分多浏览器）
async function sendTabsUpdate(type = 'tabs_update') {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const browser = await loadBrowserIdentity();
  const tabs = (await chrome.tabs.query({})).filter(
    (t) => isScriptable(t.url) && !/streamlit/i.test(t.title || '')
  );
  // 用户"正在看"的标签 = 最后聚焦窗口里的激活标签
  let activeTabId = null;
  let windowFocused = false;
  try {
    const [focused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (focused) activeTabId = focused.id;
    // 该浏览器是否真正持有系统焦点（多 Profile 时只有真正聚焦的那个可信）
    const fw = await chrome.windows.getLastFocused();
    windowFocused = !!fw.focused;
  } catch (e) { /* 无聚焦窗口（如 Chrome 最小化）时保持默认值 */ }
  ws.send(
    JSON.stringify({
      type,
      browser: { id: browser.id, label: browser.display },
      active_tab_id: activeTabId,
      focused: windowFocused,
      tabs: tabs.map((t) => ({
        id: t.id,
        url: t.url,
        title: t.title,
        active: !!t.active,
        windowId: t.windowId,
        browser_id: browser.id,
        browser_label: browser.display,
      })),
    })
  );
  console.log('[TMWD-WS] Sent', type, 'browser=', browser.display, 'tabs=', tabs.length, 'active=', activeTabId);
}
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') sendTabsUpdate();
  // 录制中：记录本浏览器内的页面导航（含 SPA history 变化）
  if (changeInfo.status === 'complete' || changeInfo.url) {
    void (async () => {
      try {
        const st = await recGetState();
        if (!st || !st.active) return;
        if (changeInfo.status === 'complete') {
          // 新加载的页面补挂 CDP（SW 冷启动/新标签页场景）
          if (tab && isScriptable(tab.url)) void recCdpAttachTab(tabId);
        }
        const url = changeInfo.url || tab.url || '';
        if (!/^https?:/i.test(url)) return;
        if (recIsNoiseUrl(url)) return;
        // 去重改为比对缓冲末尾（持久状态）：SW 重启不丢失去重上下文
        await recLoadBuffer();
        const lastEv = recBuffer[recBuffer.length - 1];
        const title = tab.title || '';
        if (lastEv && lastEv.type === 'nav' && lastEv.url === url && lastEv.title === title) return;
        await handleRecEvent({ event: { type: 'nav', url, title } });
      } catch (_) {}
    })();
  }
});
chrome.tabs.onRemoved.addListener(() => sendTabsUpdate());
chrome.tabs.onCreated.addListener((tab) => {
  sendTabsUpdate();
  void (async () => {
    try {
      const st = await recGetState();
      if (st && st.active) {
        if (!tab.url || isScriptable(tab.url)) await recCdpAttachTab(tab.id);
      }
    } catch (_) {}
  })();
});
// 用户切换标签页/窗口时立即推送，服务端才能实时跟踪"当前打开的是哪个标签"
chrome.tabs.onActivated.addListener(() => sendTabsUpdate());
chrome.windows.onFocusChanged.addListener((windowId) => {
  // windowId === -1 表示焦点离开所有 Chrome 窗口，此时不用推送
  if (windowId !== chrome.windows.WINDOW_ID_NONE) sendTabsUpdate();
});

// SW 冷启动恢复：若录制仍在进行，重新挂 CDP（事件监听必须顶层注册，attach 需补）
void (async () => {
  try {
    const st = await recGetState();
    if (st && st.active) await recCdpAttachAll();
  } catch (_) {}
})();
