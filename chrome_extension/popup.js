document.addEventListener('DOMContentLoaded', () => {
  const out = document.getElementById('out');
  const btn = document.getElementById('refresh');
  btn.addEventListener('click', fetchCookies);
  fetchCookies();

  const hostEl = document.getElementById('tmwdHost');
  const portEl = document.getElementById('tmwdPort');
  const secureEl = document.getElementById('tmwdSecure');
  const saveBtn = document.getElementById('tmwdSave');
  const resetBtn = document.getElementById('tmwdReset');
  const refreshConnBtn = document.getElementById('tmwdRefreshConn');
  const cfgHintEl = document.getElementById('tmwdCfgHint');
  const connEl = document.getElementById('tmwdConnStatus');

  async function refreshConnStatus() {
    if (!connEl) return;
    try {
      const r = await chrome.runtime.sendMessage({ cmd: 'tmwd_bridge_status' });
      if (!r?.ok) {
        connEl.textContent = '状态获取失败';
        connEl.className = 'conn-line conn-bad';
        return;
      }
      const url = r.wsUrl || '';
      const httpOk = r.httpReachable;
      const phase = r.phase;
      if (phase === 'connected') {
        connEl.textContent = `WebSocket 已连接\n${url}`;
        connEl.className = 'conn-line conn-ok';
        return;
      }
      if (phase === 'connecting' || phase === 'closing') {
        connEl.textContent = `${phase === 'connecting' ? '正在连接' : '正在关闭'}…\n${url}`;
        connEl.className = 'conn-line conn-warn';
        return;
      }
      let hint = '';
      if (r.skipHttpProbe) {
        hint = 'WSS 反代模式：已跳过 HTTP 探测，仅尝试 WebSocket 连接。';
      } else if (!httpOk) {
        hint = '该地址 HTTP 探测无响应：请确认已启动 MCP/TMWebDriver，且主机端口与 Python 一致。';
      } else {
        hint = '端口可达但未建立 WebSocket，可稍候或点「保存并重连」。';
      }
      if (r.lastError) {
        hint += ` ${r.lastError}`;
      }
      if (r.lastClose && r.lastClose.code) {
        hint += ` 上次关闭 code=${r.lastClose.code}${r.lastClose.reason ? ' ' + r.lastClose.reason : ''}`;
      }
      connEl.textContent = `未连接\n${url}\n${hint}`;
      connEl.className = 'conn-line conn-bad';
    } catch (e) {
      connEl.textContent = '状态获取失败: ' + e.message;
      connEl.className = 'conn-line conn-bad';
    }
  }

  async function loadBridgeUi() {
    cfgHintEl.textContent = '';
    try {
      const r = await chrome.runtime.sendMessage({ cmd: 'tmwd_bridge_get' });
      if (!r?.ok) {
        cfgHintEl.textContent = '读取失败: ' + (r?.error || 'unknown');
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
      cfgHintEl.textContent = usingFile
        ? `配置来源：config.js 默认（${scheme}://${d.host}:${d.port}）`
        : `配置来源：已用弹窗覆盖；文件默认仍为 ${d.secure ? 'wss' : 'ws'}://${d.host}:${d.port}`;
    } catch (e) {
      cfgHintEl.textContent = '读取失败: ' + e.message;
    }
    await refreshConnStatus();
  }

  saveBtn.addEventListener('click', async () => {
    cfgHintEl.textContent = '';
    const host = hostEl.value.trim();
    const portStr = portEl.value.trim();
    try {
      if (!host) {
        const r = await chrome.runtime.sendMessage({ cmd: 'tmwd_bridge_set', host: '', port: 0 });
        if (!r?.ok) {
          cfgHintEl.textContent = r?.error || '保存失败';
          await refreshConnStatus();
          return;
        }
        await loadBridgeUi();
        cfgHintEl.textContent = '已恢复为 config.js / 环境变量默认并重连';
        return;
      }
      const port = parseInt(portStr, 10);
      if (!Number.isFinite(port)) {
        cfgHintEl.textContent = '请填写有效端口';
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
        cfgHintEl.textContent = r?.error || '保存失败';
        await refreshConnStatus();
        return;
      }
      await loadBridgeUi();
      cfgHintEl.textContent = '已保存并重连';
    } catch (e) {
      cfgHintEl.textContent = '错误: ' + e.message;
      await refreshConnStatus();
    }
  });

  resetBtn.addEventListener('click', async () => {
    cfgHintEl.textContent = '';
    try {
      const r = await chrome.runtime.sendMessage({ cmd: 'tmwd_bridge_set', host: '', port: 0 });
      if (!r?.ok) {
        cfgHintEl.textContent = r?.error || '失败';
        await refreshConnStatus();
        return;
      }
      await loadBridgeUi();
      cfgHintEl.textContent = '已清除覆盖并重连';
    } catch (e) {
      cfgHintEl.textContent = '错误: ' + e.message;
      await refreshConnStatus();
    }
  });

  refreshConnBtn.addEventListener('click', () => void refreshConnStatus());

  void loadBridgeUi();
  const connTimer = setInterval(() => void refreshConnStatus(), 2000);
  window.addEventListener('beforeunload', () => clearInterval(connTimer));
});

async function fetchCookies() {
  const out = document.getElementById('out');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) { out.textContent = 'No active tab'; return; }
    const resp = await chrome.runtime.sendMessage({ cmd: 'cookies', url: tab.url });
    if (!resp?.ok) { out.textContent = 'Error: ' + (resp?.error || 'unknown'); return; }
    if (!resp.data.length) { out.textContent = '(no cookies)'; return; }
    out.textContent = resp.data.map(c =>
      `${c.name}=${c.value}` + (c.httpOnly ? ' [H]' : '') + (c.secure ? ' [S]' : '') + (c.partitionKey ? ' [P]' : '')
    ).join('\n');
    const str = resp.data.map(c => `${c.name}=${c.value}`).join('; ');
    await navigator.clipboard.writeText(str);
  } catch (e) { out.textContent = 'Error: ' + e.message; }
}
