'use strict';

/* ============================================================
 * TCP 调试助手 · Pro —— 前端逻辑
 * 后端契约不变：SSE 接收推送，/api 下发指令。
 * UX：明暗主题、发送历史、方向筛选+搜索、复制、实时统计、HEX 校验、
 *     自动重连、时间戳开关。
 * 进阶：接收关键字高亮、报文模板、多连接分标签。
 * ============================================================ */

const $ = (id) => document.getElementById(id);

const state = {
  mode: 'client',
  serverRunning: false,
  clientConnected: false,
  entries: [],
  nextId: 1,
  recvBytes: 0,
  sentBytes: 0,
  rateSamples: [],          // { t, b }
  filter: 'all',            // all | recv | send
  search: '',
  highlight: '',            // 高亮关键字（text 模式）
  recvFormat: 'text',
  showTimestamp: true,
  autoScroll: true,
  autoReconnect: false,
  manualDisconnect: false,
  connecting: false,           // 正在发起客户端连接（用于抑制旧连接关闭的误报）
  lastConnect: null,
  wasConnected: false,
  reconnectTimer: null,
  // 多连接分标签
  clients: [],              // 服务端模式：[{ id, remote }]
  clientEndpoint: null,     // 客户端模式：host:port
  connFilter: 'all',        // 'all' 或某个客户端 id（数字）
};

/* ---------------- 工具 ---------------- */
function api(msg) {
  return fetch('/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(msg),
  }).then((r) => r.json());
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

function hexDump(hex) {
  const bytes = hex.match(/../g) || [];
  if (bytes.length === 0) return '(空)';
  let out = '';
  for (let i = 0; i < bytes.length; i += 16) {
    const slice = bytes.slice(i, i + 16);
    const offset = i.toString(16).padStart(8, '0');
    const hexPart = slice.join(' ');
    const ascii = slice.map((b) => {
      const c = parseInt(b, 16);
      return (c >= 32 && c < 127) ? String.fromCharCode(c) : '.';
    }).join('');
    out += `${offset}  ${hexPart.padEnd(47, ' ')}  ${ascii}\n`;
  }
  return out;
}

/* 输入防抖：搜索/高亮频繁触发时，避免大日志下每次按键都重建全部 DOM 而卡顿 */
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function getEncoding() {
  return document.querySelector('input[name="sendEncoding"]:checked').value;
}

/* HEX 合法性：去掉非十六进制字符后长度须为偶数 */
function hexValid(str) {
  const cleaned = (str || '').replace(/[^0-9a-fA-F]/g, '');
  return cleaned.length % 2 === 0;
}

/* 关键字高亮：按大小写不敏感切分原文本，匹配段包裹 <mark> */
function highlightText(text, kw) {
  if (!kw) return escapeHtml(text);
  const lower = text.toLowerCase();
  const k = kw.toLowerCase();
  let out = '';
  let i = 0;
  while (i < text.length) {
    const idx = lower.indexOf(k, i);
    if (idx === -1) { out += escapeHtml(text.slice(i)); break; }
    out += escapeHtml(text.slice(i, idx));
    out += '<mark>' + escapeHtml(text.slice(idx, idx + kw.length)) + '</mark>';
    i = idx + kw.length;
  }
  return out;
}

/* ---------------- Toast ---------------- */
let toastTimer = null;
function toast(text, isError = false) {
  const t = $('toast');
  t.textContent = text;
  t.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 2600);
}

/* ---------------- 主题 ---------------- */
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem('tcp-theme', theme); } catch (_) {}
}
function initTheme() {
  let theme = 'light';
  try { theme = localStorage.getItem('tcp-theme') || 'light'; } catch (_) {}
  applyTheme(theme);
  $('themeToggle').addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    applyTheme(cur === 'dark' ? 'light' : 'dark');
  });
}

/* ---------------- 连接状态徽章 ---------------- */
function renderConnStatus() {
  const el = $('connBadge');
  const dot = el.querySelector('.dot');
  const label = el.querySelector('.label');
  let cls = 'offline', text = '未连接', badgeCls = '';
  if (state.mode === 'client') {
    if (state.clientConnected) { cls = 'online'; text = '客户端已连接'; badgeCls = 'is-online'; }
    else { cls = 'offline'; text = '客户端未连接'; }
  } else {
    if (state.serverRunning) { cls = 'online'; text = '服务端监听中'; badgeCls = 'is-online'; }
    else { cls = 'offline'; text = '服务端未启动'; }
  }
  dot.className = 'dot ' + cls;
  label.textContent = text;
  el.className = 'conn-badge ' + badgeCls;
}

/* ---------------- 日志渲染 ---------------- */
function passesFilter(e) {
  if (state.filter !== 'all' && e.direction !== state.filter) return false;
  if (state.mode === 'server' && state.connFilter !== 'all') {
    if (e.clientId !== state.connFilter) return false;
  }
  if (state.search) {
    const q = state.search.toLowerCase();
    const hay = ((e.text || '') + ' ' + (e.hex || '') + ' ' + (e.endpoint || '') + ' ' + e.direction).toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

function entryBodyHtml(e) {
  if (state.recvFormat === 'hex') {
    return `<div class="body">${escapeHtml(e.hex || '(空)')}</div>`;
  }
  if (state.recvFormat === 'dump') {
    return `<div class="body dump">${escapeHtml(hexDump(e.hex || ''))}</div>`;
  }
  const txt = e.text && e.text.length ? e.text : (e.bytes ? '(不可打印数据)' : '(空)');
  return `<div class="body">${highlightText(txt, state.highlight)}</div>`;
}

function buildEntryEl(e) {
  const div = document.createElement('div');
  div.className = `entry ${e.direction}`;
  div.dataset.id = e.id;
  const ind = e.direction === 'recv' ? 'RECV' : 'SEND';
  const meta = (state.showTimestamp ? `[${fmtTime(e.ts)}] ` : '') +
    `<span class="endpoint">${escapeHtml(e.endpoint || '')}</span> · ${e.bytes} 字节`;
  div.innerHTML =
    `<span class="ind">${ind}</span>` +
    `<div class="main"><div class="meta">${meta}</div>${entryBodyHtml(e)}</div>` +
    `<button class="copy" data-id="${e.id}" title="复制">复制</button>`;
  return div;
}

/* 日志上限：防止长时间挂机内存与 DOM 无限增长（超出后丢弃最旧记录） */
const MAX_ENTRIES = 5000;

function appendEntry(e) {
  e.id = state.nextId++;          // 分配唯一 id（供单条复制 / 渲染使用）
  state.entries.push(e);
  if (state.entries.length > MAX_ENTRIES) {
    state.entries.splice(0, state.entries.length - MAX_ENTRIES);
  }
  if (e.direction === 'recv') state.recvBytes += e.bytes;
  else state.sentBytes += e.bytes;
  state.rateSamples.push({ t: Date.now(), b: e.bytes });
  updateStats();

  if (passesFilter(e)) {
    const logEl = $('log');
    const hint = logEl.querySelector('.empty-hint');
    if (hint) hint.remove();
    logEl.appendChild(buildEntryEl(e));
    while (logEl.children.length > MAX_ENTRIES) logEl.removeChild(logEl.firstChild);
    if (state.autoScroll) logEl.scrollTop = logEl.scrollHeight;
  }
}

function rerenderLog() {
  const logEl = $('log');
  const visible = state.entries.filter(passesFilter);
  if (visible.length === 0) {
    const hint = (state.search || state.filter !== 'all' || (state.mode === 'server' && state.connFilter !== 'all'))
      ? '无匹配的报文记录'
      : '暂无数据。连接后收发的内容会实时显示在这里。';
    logEl.innerHTML = `<div class="empty-hint">${hint}</div>`;
    return;
  }
  logEl.innerHTML = '';
  const frag = document.createDocumentFragment();
  visible.forEach((e) => frag.appendChild(buildEntryEl(e)));
  logEl.appendChild(frag);
  if (state.autoScroll) logEl.scrollTop = logEl.scrollHeight;
}

function updateStats() {
  $('statRecv').textContent = fmtBytes(state.recvBytes);
  $('statSent').textContent = fmtBytes(state.sentBytes);
  $('statCount').textContent = state.entries.length;
  updateRate();
}

function updateRate() {
  const now = Date.now();
  state.rateSamples = state.rateSamples.filter((s) => now - s.t <= 2000);
  const total = state.rateSamples.reduce((a, s) => a + s.b, 0);
  $('statRate').textContent = fmtBytes(total / 2) + '/s';
}

/* 复制 */
function entryContent(e) {
  if (state.recvFormat === 'hex') return e.hex || '';
  if (state.recvFormat === 'dump') return hexDump(e.hex || '');
  return e.text || '';
}
function copyText(text) {
  const done = () => toast('已复制到剪贴板');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); done(); } catch (_) { toast('复制失败', true); }
  document.body.removeChild(ta);
}

function getVisibleEntries() {
  return state.entries.filter(passesFilter);
}

/* ---------------- 发送历史 ---------------- */
const HISTORY_KEY = 'tcp-history';
function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch (_) { return []; }
}
function saveHistory(list) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 20))); } catch (_) {}
}
function pushHistory(data, encoding) {
  if (!data && encoding !== 'hex') return;
  let list = loadHistory().filter((h) => !(h.data === data && h.encoding === encoding));
  list.unshift({ data, encoding });
  saveHistory(list);
  renderHistory();
}
function renderHistory() {
  const list = loadHistory();
  const ul = $('historyList');
  if (list.length === 0) {
    ul.innerHTML = '<div class="history-empty">暂无发送历史</div>';
    return;
  }
  ul.innerHTML = list.map((h, i) =>
    `<li data-i="${i}">
       <span class="tag">${h.encoding === 'hex' ? 'HEX' : 'TXT'}</span>
       <span class="txt">${escapeHtml(h.data)}</span>
       <button class="del" data-del="${i}" title="删除">✕</button>
     </li>`).join('');
}

/* ---------------- 报文模板 ---------------- */
const TEMPLATE_KEY = 'tcp-templates';
function loadTemplates() {
  try { return JSON.parse(localStorage.getItem(TEMPLATE_KEY) || '[]'); } catch (_) { return []; }
}
function saveTemplates(list) {
  try { localStorage.setItem(TEMPLATE_KEY, JSON.stringify(list.slice(0, 30))); } catch (_) {}
}
function renderTemplates() {
  const list = loadTemplates();
  const ul = $('templateList');
  if (list.length === 0) {
    ul.innerHTML = '<div class="history-empty">暂无模板，点上方按钮保存当前内容</div>';
    return;
  }
  ul.innerHTML = list.map((t, i) =>
    `<li data-i="${i}">
       <span class="tag">${t.encoding === 'hex' ? 'HEX' : 'TXT'}</span>
       <span class="txt">${escapeHtml(t.data)}</span>
       <button class="del" data-del="${i}" title="删除">✕</button>
     </li>`).join('');
}
function saveCurrentAsTemplate() {
  const data = $('sendData').value;
  const encoding = getEncoding();
  if (!data) { toast('发送内容为空，无法保存', true); return; }
  const list = loadTemplates().filter((t) => !(t.data === data && t.encoding === encoding));
  list.unshift({ data, encoding });
  saveTemplates(list);
  renderTemplates();
  toast('已保存为模板');
}

/* ---------------- SSE 事件 ---------------- */
function connectSSE() {
  const es = new EventSource('/events');
  es.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch (_) { return; }
    handleServerEvent(msg);
  };
  es.onerror = () => { /* 浏览器自动重连 */ };
}

function handleServerEvent(msg) {
  switch (msg.type) {
    case 'data':
      appendEntry(msg);
      break;
    case 'client_status': {
      const nowConnected = !!msg.connected;
      const wasBefore = state.clientConnected;
      state.clientConnected = nowConnected;
      if (nowConnected) {
        state.wasConnected = true;
        state.connecting = false;     // 连接成功，清除"正在连接"标记
        state.clientEndpoint = `${msg.host}:${msg.port}`;
        clearTimeout(state.reconnectTimer);
        if (!msg.snapshot) toast(`已连接到 ${msg.host}:${msg.port}`);
      } else {
        state.clientEndpoint = null;
        if (state.connecting) {
          // 正在发起连接（重连或首次）：旧 socket 的关闭属于预期——不提示、不重连、复位标记
          state.connecting = false;
        } else if (wasBefore && !msg.snapshot) {
          toast('客户端已断开');
          // 实时读取复选框；仅"真的连上过又掉线"才重连
          if ($('autoReconnect').checked && !state.manualDisconnect && state.mode === 'client') {
            scheduleReconnect();
          }
        }
      }
      $('btnClientConnect').disabled = state.clientConnected;
      $('btnClientDisconnect').disabled = !state.clientConnected;
      renderConnTabs();
      renderConnStatus();
      break;
    }
    case 'server_status':
      state.serverRunning = !!msg.running;
      $('btnServerStart').disabled = state.serverRunning;
      $('btnServerStop').disabled = !state.serverRunning;
      $('sendTargetWrap').classList.toggle('hidden', !(state.mode === 'server' && state.serverRunning));
      if (!msg.running) { state.clients = []; }
      renderConnTabs();
      renderConnStatus();
      if (!msg.snapshot) toast(msg.running ? `服务端已在端口 ${msg.port} 监听` : '服务端已停止');
      break;
    case 'server_client':
      if (msg.action === 'connect') toast(`客户端 #${msg.id} (${msg.remote}) 已连接`);
      else toast(`客户端 #${msg.id} 已断开`);
      break;
    case 'client_list':
      renderClientList(msg.clients || []);
      break;
    case 'autosend_status':
      $('btnAutosendStart').disabled = msg.running;
      $('btnAutosendStop').disabled = !msg.running;
      if (!msg.snapshot) toast(msg.running ? `自动发送已启动，间隔 ${msg.intervalMs} ms` : '自动发送已停止');
      break;
    case 'clear':
      state.entries = [];
      state.recvBytes = 0;
      state.sentBytes = 0;
      state.rateSamples = [];
      $('log').innerHTML = '<div class="empty-hint">暂无数据。连接后收发的内容会实时显示在这里。</div>';
      updateStats();
      break;
    case 'error':
      toast(`错误[${msg.scope}]：${msg.message}`, true);
      break;
  }
}

function scheduleReconnect() {
  clearTimeout(state.reconnectTimer);
  if (!state.lastConnect) return;
  toast('连接已断开，3 秒后尝试重连…', false);
  state.reconnectTimer = setTimeout(() => {
    if (state.clientConnected || state.manualDisconnect) return;
    api({ action: 'client_connect', ...state.lastConnect }).then((r) => {
      if (!r.ok) scheduleReconnect();
    });
  }, 3000);
}

/* ---------------- 客户端列表 + 连接标签 ---------------- */
function renderClientList(clients) {
  const ul = $('clientList');
  $('clientCount').textContent = clients.length;
  if (clients.length === 0) {
    ul.innerHTML = '<li class="empty">暂无连接</li>';
  } else {
    ul.innerHTML = clients.map((c) =>
      `<li><span>#${c.id} — ${escapeHtml(c.remote)}</span>` +
      `<button class="kick" data-id="${c.id}">断开</button></li>`).join('');
  }
  const sel = $('sendTarget');
  const current = sel.value;
  sel.innerHTML = '<option value="all">全部客户端</option>' +
    clients.map((c) => `<option value="${c.id}">#${c.id} — ${escapeHtml(c.remote)}</option>`).join('');
  if ([...sel.options].some((o) => o.value === current)) sel.value = current;
  ul.querySelectorAll('.kick').forEach((b) => {
    b.addEventListener('click', () => api({ action: 'server_disconnect_client', clientId: Number(b.dataset.id) }));
  });
  // 同步分标签数据
  state.clients = clients.map((c) => ({ id: c.id, remote: c.remote }));
  renderConnTabs();
}

/* 多连接分标签：服务端模式下按连接展示/筛选 */
function renderConnTabs() {
  const tabs = $('connTabs');
  if (state.mode !== 'server' || state.clients.length === 0) {
    const changed = state.connFilter !== 'all';
    tabs.classList.add('hidden');
    tabs.innerHTML = '';
    state.connFilter = 'all';
    // 原筛选的连接已不存在时，日志视图需要同步回到"全部"
    if (changed) rerenderLog();
    return;
  }
  if (state.connFilter !== 'all' && !state.clients.some((c) => c.id === state.connFilter)) {
    state.connFilter = 'all';
    rerenderLog();
  }
  tabs.classList.remove('hidden');
  const parts = [`<button class="conn-tab${state.connFilter === 'all' ? ' active' : ''}" data-conn="all">全部</button>`];
  state.clients.forEach((c) => {
    parts.push(`<button class="conn-tab${state.connFilter === c.id ? ' active' : ''}" data-conn="${c.id}">#${c.id}</button>`);
  });
  tabs.innerHTML = parts.join('');
}

/* ---------------- 模式 ---------------- */
function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('clientCard').classList.toggle('hidden', mode !== 'client');
  $('serverCard').classList.toggle('hidden', mode !== 'server');
  $('sendTargetWrap').classList.toggle('hidden', !(mode === 'server' && state.serverRunning));
  renderConnTabs();
  renderConnStatus();
}

/* ---------------- 发送区：计数 + HEX 校验 ---------------- */
function refreshSendMeta() {
  const enc = getEncoding();
  const data = $('sendData').value;
  const counter = $('sendCounter');
  const warn = $('hexWarn');
  const ta = $('sendData');
  if (enc === 'hex') {
    const cleaned = data.replace(/[^0-9a-fA-F]/g, '');
    if (cleaned.length % 2 !== 0) {
      counter.textContent = `${data.length} 字符 · HEX 错误`;
      warn.classList.remove('hidden');
      ta.classList.add('invalid');
      return;
    }
    warn.classList.add('hidden');
    ta.classList.remove('invalid');
    counter.textContent = `${data.length} 字符 · ${cleaned.length / 2} 字节 (HEX)`;
  } else {
    warn.classList.add('hidden');
    ta.classList.remove('invalid');
    const bytes = new TextEncoder().encode(data).length;
    counter.textContent = `${data.length} 字符 · ${bytes} 字节`;
  }
}

/* ---------------- 事件绑定 ---------------- */
function bindEvents() {
  document.querySelectorAll('.mode-btn').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

  // 客户端
  $('btnClientConnect').addEventListener('click', () => {
    const host = $('clientHost').value.trim();
    const port = parseInt($('clientPort').value, 10);
    if (!host || !port) { toast('请填写主机和端口', true); return; }
    state.manualDisconnect = false;
    state.connecting = true;       // 标记正在(重)连接，旧连接关闭时不误报
    state.lastConnect = { host, port };
    state.autoReconnect = $('autoReconnect').checked;
    api({ action: 'client_connect', host, port }).then((r) => { if (!r.ok) toast(r.error || '连接失败', true); });
  });
  $('btnClientDisconnect').addEventListener('click', () => {
    state.manualDisconnect = true;
    clearTimeout(state.reconnectTimer);
    api({ action: 'client_disconnect' });
  });

  // 服务端
  $('btnServerStart').addEventListener('click', () => {
    const port = parseInt($('serverPort').value, 10);
    if (!port) { toast('请填写监听端口', true); return; }
    api({ action: 'server_start', port }).then((r) => {
      if (r.ok) return;
      // 后端提示"已在运行"说明状态短暂错位（如页面重连期间他处已启动），
      // 此时按成功处理，让界面与后端状态对齐，而不是报错阻断操作。
      if (r.error && r.error.includes('已在运行')) {
        state.serverRunning = true;
        $('btnServerStart').disabled = true;
        $('btnServerStop').disabled = false;
        $('sendTargetWrap').classList.toggle('hidden', !(state.mode === 'server' && state.serverRunning));
        renderConnStatus();
        toast(`服务端已在端口 ${port} 监听（已同步状态）`);
        return;
      }
      toast(r.error || '启动失败', true);
    });
  });
  $('btnServerStop').addEventListener('click', () => api({ action: 'server_stop' }));

  // 发送
  $('btnSend').addEventListener('click', sendOnce);
  $('btnClearSend').addEventListener('click', () => { $('sendData').value = ''; refreshSendMeta(); });
  $('sendData').addEventListener('input', refreshSendMeta);
  document.querySelectorAll('input[name="sendEncoding"]').forEach((r) => r.addEventListener('change', refreshSendMeta));
  // 发送快捷键：Ctrl/Cmd + Enter（全局生效，不限于文本框；避开搜索/高亮框，兼容 IME 输入中）
  document.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    const isEnter = e.key === 'Enter' || e.code === 'Enter';
    if ((e.ctrlKey || e.metaKey) && isEnter) {
      const ae = document.activeElement;
      if (ae && (ae.id === 'searchInput' || ae.id === 'highlightInput')) return;
      e.preventDefault();
      sendOnce();
    }
  });

  // 历史
  $('sendHistoryBtn').addEventListener('click', () => {
    const p = $('historyPanel');
    const hidden = p.classList.toggle('hidden');
    if (!hidden) { $('templatePanel').classList.add('hidden'); renderHistory(); }
  });
  $('historyList').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      const i = Number(del.dataset.del);
      const list = loadHistory(); list.splice(i, 1); saveHistory(list); renderHistory();
      return;
    }
    const li = e.target.closest('li[data-i]');
    if (li) {
      const item = loadHistory()[Number(li.dataset.i)];
      if (item) {
        $('sendData').value = item.data;
        document.querySelector(`input[name="sendEncoding"][value="${item.encoding}"]`).checked = true;
        refreshSendMeta();
        $('historyPanel').classList.add('hidden');
        $('sendData').focus();
      }
    }
  });

  // 模板
  $('templateBtn').addEventListener('click', () => {
    const p = $('templatePanel');
    const hidden = p.classList.toggle('hidden');
    if (!hidden) { $('historyPanel').classList.add('hidden'); renderTemplates(); }
  });
  $('saveTemplateBtn').addEventListener('click', saveCurrentAsTemplate);
  $('templateList').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      const i = Number(del.dataset.del);
      const list = loadTemplates(); list.splice(i, 1); saveTemplates(list); renderTemplates();
      return;
    }
    const li = e.target.closest('li[data-i]');
    if (li) {
      const item = loadTemplates()[Number(li.dataset.i)];
      if (item) {
        $('sendData').value = item.data;
        document.querySelector(`input[name="sendEncoding"][value="${item.encoding}"]`).checked = true;
        refreshSendMeta();
        $('templatePanel').classList.add('hidden');
        $('sendData').focus();
      }
    }
  });

  // 自动发送
  $('btnAutosendStart').addEventListener('click', () => {
    const encoding = getEncoding();
    const data = $('sendData').value;
    if (encoding === 'hex' && !hexValid(data)) { toast('HEX 格式错误：长度必须为偶数', true); return; }
    const intervalMs = parseInt($('autosendInterval').value, 10) || 1000;
    const appendCRLF = $('appendCRLF').checked;
    const clientId = state.mode === 'server' ? $('sendTarget').value : null;
    if (!data && !$('appendCRLF').checked) { toast('请输入发送内容', true); return; }
    api({ action: 'autosend_start', data, encoding, intervalMs, appendCRLF, clientId })
      .then((r) => { if (!r.ok) toast(r.error || '启动失败', true); });
  });
  $('btnAutosendStop').addEventListener('click', () => api({ action: 'autosend_stop' }));

  // 日志工具条
  document.querySelectorAll('.filter-btn').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach((x) => x.classList.toggle('active', x === b));
      state.filter = b.dataset.filter;
      rerenderLog();
    }));
  const onLogQuery = debounce((kind, value) => {
    if (kind === 'search') state.search = value;
    else state.highlight = value;
    rerenderLog();
  }, 160);
  $('searchInput').addEventListener('input', (e) => onLogQuery('search', e.target.value.trim()));
  $('highlightInput').addEventListener('input', (e) => onLogQuery('highlight', e.target.value.trim()));
  $('recvFormat').addEventListener('change', (e) => { state.recvFormat = e.target.value; rerenderLog(); });
  $('showTimestamp').addEventListener('change', (e) => { state.showTimestamp = e.target.checked; rerenderLog(); });
  $('autoScroll').addEventListener('change', (e) => {
    state.autoScroll = e.target.checked;
    if (state.autoScroll) $('log').scrollTop = $('log').scrollHeight;
  });
  $('btnClearLog').addEventListener('click', () => api({ action: 'clear' }));
  $('btnExportText').addEventListener('click', () => exportLog('text'));
  $('btnExportHex').addEventListener('click', () => exportLog('hex'));
  $('btnCopyAll').addEventListener('click', () => {
    const visible = getVisibleEntries();
    if (visible.length === 0) { toast('没有可复制的记录', true); return; }
    copyText(visible.map(entryContent).join('\n'));
  });

  // 连接标签切换（事件委托）
  $('connTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.conn-tab');
    if (!btn) return;
    state.connFilter = btn.dataset.conn === 'all' ? 'all' : Number(btn.dataset.conn);
    renderConnTabs();
    rerenderLog();
  });

  // 日志内单条复制（事件委托）
  $('log').addEventListener('click', (e) => {
    const btn = e.target.closest('.copy');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const entry = state.entries.find((x) => x.id === id);
    if (entry) copyText(entryContent(entry));
  });
}

function sendOnce() {
  const encoding = getEncoding();
  const data = $('sendData').value;
  if (encoding === 'hex' && !hexValid(data)) { toast('HEX 格式错误：长度必须为偶数', true); return; }
  if (!data && !$('appendCRLF').checked) { toast('请输入发送内容', true); return; }
  const appendCRLF = $('appendCRLF').checked;
  const clientId = state.mode === 'server' ? $('sendTarget').value : null;
  api({ action: 'send', data, encoding, appendCRLF, clientId }).then((r) => {
    if (!r.ok) { toast(r.error || '发送失败', true); return; }
    pushHistory(data, encoding);
  });
}

/* ---------------- 导出 ---------------- */
function exportLog(format) {
  // 与「复制全部」保持一致：导出当前可见（已筛选 / 搜索 / 分标签）的记录
  const entries = getVisibleEntries();
  if (entries.length === 0) { toast('没有可导出的记录', true); return; }
  const lines = entries.map((e) => {
    const dir = e.direction === 'recv' ? 'RECV' : 'SEND';
    const content = format === 'hex' ? (e.hex || '') : (e.text || '');
    return `[${fmtTime(e.ts)}] ${dir} ${e.endpoint || ''} (${e.bytes}B): ${content}`;
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.href = URL.createObjectURL(blob);
  a.download = `tcp-log-${format}-${stamp}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------------- 启动 ---------------- */
function init() {
  initTheme();
  bindEvents();
  setMode('client');
  renderConnStatus();
  renderHistory();
  renderTemplates();
  refreshSendMeta();
  updateStats();
  connectSSE();
  setInterval(updateRate, 1000); // 速率随时间衰减
}

document.addEventListener('DOMContentLoaded', init);
