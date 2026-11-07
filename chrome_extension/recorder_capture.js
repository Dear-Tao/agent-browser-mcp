// recorder_capture.js — 操作录制采集端（隔离世界）
// 双入口：① manifest content_scripts（新页面自动挂载）② 开始录制时由 background
// 对所有已存在标签页 executeScript 注入（解决"扩展更新后旧页面无采集代码"问题）。
// 幂等守卫：同一文档重复注入只生效一次。
;(function () {
  // 守卫锚在 DOM（跨世界、跨扩展重载存活）；window 全局会随扩展重载的隔离世界重建而丢失，
  // 导致每次重载重复挂监听器（一次点击记录 N 条）。
  if (document.documentElement.dataset.abRecInstalled) return;
  document.documentElement.dataset.abRecInstalled = '1';

  if (/streamlit/i.test(document.title)) return;

  let recOn = false;

  function recSel(el) {
    try {
      if (el.id) return '#' + CSS.escape(el.id);
      const parts = [];
      let node = el;
      let depth = 0;
      while (node && node.nodeType === 1 && depth < 4) {
        if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
        let seg = node.tagName.toLowerCase();
        const parent = node.parentElement;
        if (parent) {
          const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
          if (same.length > 1) seg += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
        }
        parts.unshift(seg);
        node = parent;
        depth++;
      }
      return parts.join(' > ');
    } catch (e) { return ''; }
  }

  function recText(el) {
    try {
      // 表单控件的 value 不作为 text（避免与 input 事件重复），只取可见文本
      const tag = el.tagName ? el.tagName.toLowerCase() : '';
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return '';
      const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
      return t.slice(0, 60);
    } catch (e) { return ''; }
  }

  function recBase(el) {
    return {
      css: recSel(el),
      tag: el.tagName ? el.tagName.toLowerCase() : '',
      id: el.id || '',
      name: (el.getAttribute && (el.getAttribute('name') || el.getAttribute('aria-label') || el.getAttribute('placeholder'))) || '',
      role: (el.getAttribute && el.getAttribute('role')) || '',
      frame: window === window.top ? 'main' : 'iframe',
    };
  }

  function recSend(ev) {
    if (!recOn) return;
    ev.url = location.href;
    try {
      chrome.runtime.sendMessage({ cmd: 'rec_event', event: ev }, () => void chrome.runtime.lastError);
    } catch (e) {}
  }

  function recAttach() {
    if (recOn) return;
    recOn = true;
    // 记录所有点击：Ozon 等后台大量使用无 role/a/button 的 div 型按钮，
    // 白名单过滤会漏掉关键操作；时间线场景宁多勿漏
    document.addEventListener('click', (e) => {
      const el = e.target;
      if (!el || !el.tagName || el.nodeType !== 1) return;
      recSend({ type: 'click', ...recBase(el), text: recText(el) });
    }, true);
    document.addEventListener('change', (e) => {
      const el = e.target;
      if (!el || !el.tagName) return;
      const tag = el.tagName.toLowerCase();
      if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return;
      const value = el.value;
      if (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) {
        recSend({ type: 'check', ...recBase(el), checked: !!el.checked, text: recText(el) });
        return;
      }
      recSend({ type: 'input', ...recBase(el), value: String(value == null ? '' : value).slice(0, 200) });
    }, true);
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const el = e.target;
      if (!el || !el.tagName) return;
      const tag = el.tagName.toLowerCase();
      if (tag !== 'input' && tag !== 'textarea') return;
      recSend({ type: 'enter', ...recBase(el) });
    }, true);
  }

  function recDetach() {
    if (!recOn) return;
    recOn = false;
    // 监听器随文档生命周期存在，置标志位即可停止发送
  }

  async function recSyncState() {
    try {
      const s = await chrome.storage.local.get('tmwd_rec_state');
      const st = s.tmwd_rec_state;
      const want = !!(st && st.active);
      if (want) recAttach(); else recDetach();
    } catch (e) {}
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.tmwd_rec_state) void recSyncState();
  });
  void recSyncState();
})();