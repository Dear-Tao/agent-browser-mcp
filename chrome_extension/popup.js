document.addEventListener('DOMContentLoaded', () => {
  const cookiePanel = document.getElementById('cookiePanel');
  const cookieReload = document.getElementById('cookieReload');
  const btn = document.getElementById('refresh');
  if (cookiePanel) {
    cookiePanel.addEventListener('toggle', () => {
      if (cookiePanel.open) void loadCookies({ copy: false });
    });
  }
  if (cookieReload) {
    cookieReload.addEventListener('click', () => void loadCookies({ copy: false }));
  }
  if (btn) {
    btn.addEventListener('click', () => void loadCookies({ copy: true }));
  }

  const hostEl = document.getElementById('tmwdHost');
  const portEl = document.getElementById('tmwdPort');
  const secureEl = document.getElementById('tmwdSecure');
  const saveBtn = document.getElementById('tmwdSave');
  const resetBtn = document.getElementById('tmwdReset');
  const refreshConnBtn = document.getElementById('tmwdRefreshConn');
  const cfgHintEl = document.getElementById('tmwdCfgHint');
  const connChip = document.getElementById('connChip');
  const connChipText = document.getElementById('connChipText');
  const connUrl = document.getElementById('connUrl');
  const connDetail = document.getElementById('connDetail');
  const browserLabelEl = document.getElementById('tmwdBrowserLabel');
  const identId = document.getElementById('identId');
  const identIdText = document.getElementById('identIdText');
  const identIdHint = document.getElementById('identIdHint');
  const browserSaveBtn = document.getElementById('tmwdBrowserSave');

  function setChip(kind, text) {
    if (!connChip || !connChipText) return;
    connChip.className = 'chip ' + kind;
    connChipText.textContent = text;
    document.body.dataset.conn = kind || 'wait';
  }

  function setHint(el, text, kind) {
    if (!el) return;
    el.textContent = text || '';
    el.className = 'hint' + (kind ? ' ' + kind : '');
  }

  async function loadBrowserUi() {
    if (!browserLabelEl || !identIdText) return;
    try {
      const r = await chrome.runtime.sendMessage({ cmd: 'tmwd_browser_get' });
      if (!r?.ok) {
        identIdText.textContent = r?.error || '读取失败';
        if (identId) identId.dataset.id = '';
        return;
      }
      browserLabelEl.value = r.label || '';
      identIdText.textContent = r.id || '—';
      if (identId) identId.dataset.id = r.id || '';
    } catch (e) {
      identIdText.textContent = e.message || String(e);
      if (identId) identId.dataset.id = '';
    }
  }

  if (identId) {
    identId.addEventListener('click', async () => {
      const id = identId.dataset.id || '';
      if (!id) return;
      try {
        await navigator.clipboard.writeText(id);
        if (identIdHint) identIdHint.textContent = '已复制';
        identId.classList.add('copied');
        setTimeout(() => {
          if (identIdHint) identIdHint.textContent = '复制';
          identId.classList.remove('copied');
        }, 1200);
      } catch (e) {
        if (identIdHint) identIdHint.textContent = '失败';
      }
    });
  }

  if (browserSaveBtn) {
    browserSaveBtn.addEventListener('click', async () => {
      setHint(cfgHintEl, '');
      try {
        const r = await chrome.runtime.sendMessage({
          cmd: 'tmwd_browser_set',
          label: browserLabelEl ? browserLabelEl.value : '',
        });
        if (!r?.ok) {
          setHint(cfgHintEl, r?.error || '保存失败', 'bad');
          return;
        }
        await loadBrowserUi();
        setHint(cfgHintEl, `已保存「${r.display}」`, 'ok');
      } catch (e) {
        setHint(cfgHintEl, '错误: ' + e.message, 'bad');
      }
    });
  }

  async function refreshConnStatus() {
    try {
      const r = await chrome.runtime.sendMessage({ cmd: 'tmwd_bridge_status' });
      if (!r?.ok) {
        setChip('bad', '状态失败');
        if (connUrl) connUrl.textContent = '—';
        if (connDetail) connDetail.textContent = '无法读取桥接状态';
        return;
      }
      const url = r.wsUrl || '';
      const httpOk = r.httpReachable;
      const phase = r.phase;
      if (connUrl) connUrl.textContent = url || '—';

      if (phase === 'connected') {
        setChip('ok', '已连接');
        if (connDetail) {
          connDetail.textContent = r.browser?.display
            ? `当前浏览器：${r.browser.display}`
            : 'WebSocket 正常';
        }
        return;
      }
      if (phase === 'connecting' || phase === 'closing') {
        setChip('warn', phase === 'connecting' ? '连接中' : '关闭中');
        if (connDetail) connDetail.textContent = '请稍候…';
        return;
      }

      setChip('bad', '未连接');
      let hint = '';
      if (r.skipHttpProbe) {
        hint = 'WSS 反代模式：已跳过 HTTP 探测，仅尝试 WebSocket。';
      } else if (!httpOk) {
        hint = 'HTTP 探测无响应：确认 MCP / TMWebDriver 已启动，主机端口一致。';
      } else {
        hint = '端口可达但未建立 WebSocket，可点「保存并重连」。';
      }
      if (r.lastError) hint += ` · ${r.lastError}`;
      if (r.lastClose && r.lastClose.code) {
        hint += ` · 上次关闭 code=${r.lastClose.code}${r.lastClose.reason ? ' ' + r.lastClose.reason : ''}`;
      }
      if (connDetail) connDetail.textContent = hint;
    } catch (e) {
      setChip('bad', '状态失败');
      if (connDetail) connDetail.textContent = e.message || String(e);
    }
  }

  async function loadBridgeUi() {
    setHint(cfgHintEl, '');
    try {
      const r = await chrome.runtime.sendMessage({ cmd: 'tmwd_bridge_get' });
      if (!r?.ok) {
        setHint(cfgHintEl, '读取失败: ' + (r?.error || 'unknown'), 'bad');
        return;
      }
      const eff = r.effective || {};
      hostEl.value = eff.host || '';
      portEl.value = eff.port != null ? String(eff.port) : '';
      if (secureEl) secureEl.checked = !!eff.secure;
      const d = r.defaults || {};
      const st = r.stored || {};
      const usingFile = st.host == null && st.port == null && st.secure == null;
      const scheme = eff.secure ? 'wss' : 'ws';
      setHint(
        cfgHintEl,
        usingFile
          ? `来源：config.js 默认（${scheme}://${d.host}:${d.port}）`
          : `来源：弹窗覆盖；文件默认 ${d.secure ? 'wss' : 'ws'}://${d.host}:${d.port}`
      );
    } catch (e) {
      setHint(cfgHintEl, '读取失败: ' + e.message, 'bad');
    }
    await refreshConnStatus();
  }

  saveBtn.addEventListener('click', async () => {
    setHint(cfgHintEl, '');
    const host = hostEl.value.trim();
    const portStr = portEl.value.trim();
    try {
      if (!host) {
        const r = await chrome.runtime.sendMessage({ cmd: 'tmwd_bridge_set', host: '', port: 0 });
        if (!r?.ok) {
          setHint(cfgHintEl, r?.error || '保存失败', 'bad');
          await refreshConnStatus();
          return;
        }
        await loadBridgeUi();
        setHint(cfgHintEl, '已恢复默认并重连', 'ok');
        return;
      }
      const port = parseInt(portStr, 10);
      if (!Number.isFinite(port)) {
        setHint(cfgHintEl, '请填写有效端口', 'bad');
        await refreshConnStatus();
        return;
      }
      const r = await chrome.runtime.sendMessage({
        cmd: 'tmwd_bridge_set',
        host,
        port,
        secure: secureEl ? secureEl.checked : false,
      });
      if (!r?.ok) {
        setHint(cfgHintEl, r?.error || '保存失败', 'bad');
        await refreshConnStatus();
        return;
      }
      await loadBridgeUi();
      setHint(cfgHintEl, '已保存并重连', 'ok');
    } catch (e) {
      setHint(cfgHintEl, '错误: ' + e.message, 'bad');
      await refreshConnStatus();
    }
  });

  resetBtn.addEventListener('click', async () => {
    setHint(cfgHintEl, '');
    try {
      const r = await chrome.runtime.sendMessage({ cmd: 'tmwd_bridge_set', host: '', port: 0 });
      if (!r?.ok) {
        setHint(cfgHintEl, r?.error || '失败', 'bad');
        await refreshConnStatus();
        return;
      }
      await loadBridgeUi();
      setHint(cfgHintEl, '已清除覆盖并重连', 'ok');
    } catch (e) {
      setHint(cfgHintEl, '错误: ' + e.message, 'bad');
    }
  });

  refreshConnBtn.addEventListener('click', () => void refreshConnStatus());

  void loadBrowserUi();
  void loadBridgeUi();
  const connTimer = setInterval(() => void refreshConnStatus(), 2000);
  window.addEventListener('beforeunload', () => clearInterval(connTimer));
});

let lastCookieClipboard = '';

function formatCookieLines(data) {
  return data
    .map(
      (c) =>
        `${c.name}=${c.value}` +
        (c.httpOnly ? ' [H]' : '') +
        (c.secure ? ' [S]' : '') +
        (c.partitionKey ? ' [P]' : '')
    )
    .join('\n');
}

async function loadCookies({ copy = false } = {}) {
  const hint = document.getElementById('cookieHint');
  const out = document.getElementById('out');
  const summary = document.getElementById('cookieSummary');
  const setHint = (text) => {
    if (hint) hint.textContent = text;
  };
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) {
      if (out) out.textContent = '';
      lastCookieClipboard = '';
      if (summary) summary.textContent = '无页面';
      setHint('当前没有可读取的页面');
      return;
    }
    const resp = await chrome.runtime.sendMessage({ cmd: 'cookies', url: tab.url });
    if (!resp?.ok) {
      if (out) out.textContent = '';
      lastCookieClipboard = '';
      if (summary) summary.textContent = '读取失败';
      setHint('读取失败：' + (resp?.error || 'unknown'));
      return;
    }
    if (!resp.data.length) {
      if (out) out.textContent = '';
      lastCookieClipboard = '';
      if (summary) summary.textContent = '0 条';
      setHint('当前页没有 Cookies');
      return;
    }
    lastCookieClipboard = resp.data.map((c) => `${c.name}=${c.value}`).join('; ');
    if (out) out.textContent = formatCookieLines(resp.data);
    if (summary) summary.textContent = `${resp.data.length} 条`;
    if (copy) {
      await navigator.clipboard.writeText(lastCookieClipboard);
      setHint(`已复制 ${resp.data.length} 条到剪贴板`);
    } else {
      setHint(`已加载 ${resp.data.length} 条，点「复制」才写入剪贴板`);
    }
  } catch (e) {
    if (summary) summary.textContent = '失败';
    setHint(copy ? '复制失败：' + e.message : '读取失败：' + e.message);
  }
}
