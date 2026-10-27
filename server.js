'use strict';

/**
 * TCP 调试助手 —— 后端桥接服务
 *
 * 设计要点：
 *  - 零第三方依赖，仅使用 Node.js 内置模块（http / net / fs / path）。
 *  - 浏览器 → 后端：通过普通 HTTP POST 下发指令（连接 / 发送 / 启停服务端 / 自动发送等）。
 *  - 后端 → 浏览器：通过 SSE（Server-Sent Events）实时推送收到的 TCP 数据、状态变化与日志。
 *  - 这样既避免了 WebSocket 握手/掩码实现的复杂度，又保证了实时性。
 */

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = parseInt(process.env.PORT, 10) || 8080;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');

/* ------------------------------------------------------------------ *
 * SSE 客户端管理
 * ------------------------------------------------------------------ */
const sseClients = new Set();
const MAX_SSE_CLIENTS = 100;         // SSE 连接上限：防多标签页无限累积持久连接

function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch (_) {
      sseClients.delete(res);
    }
  }
}

/* ------------------------------------------------------------------ *
 * TCP 状态
 * ------------------------------------------------------------------ */
let clientSocket = null;            // 客户端模式：当前活动的连接
let clientConnected = false;        // 客户端是否已连接
let serverInstance = null;          // 服务端模式：net.Server 实例
let serverPort = null;              // 服务端模式：监听端口（用于状态快照）
const serverClients = new Map();    // 服务端模式：id -> socket
let nextClientId = 1;
let autosendTimer = null;           // 自动发送定时器

/**
 * 向单个 SSE 客户端推送当前状态快照。
 * 页面首次加载 / 断线重连时调用，保证界面徽章与后端真实状态一致，
 * 避免「界面显示未启动、实际已在监听」导致启动按钮报"已在运行"的错位。
 */
function sendStateSnapshot(res) {
  const send = (event) => {
    try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch (_) {}
  };
  // snapshot: true 标记供前端识别——快照只用于同步状态，不触发提示 toast
  send({ type: 'server_status', running: !!serverInstance, port: serverPort, snapshot: true });
  send({ type: 'client_status', connected: clientConnected, snapshot: true });
  send({ type: 'autosend_status', running: !!autosendTimer, snapshot: true });
}

/* ------------------------------------------------------------------ *
 * 编解码工具
 * ------------------------------------------------------------------ */
function parseHex(str) {
  const cleaned = (str || '').replace(/[^0-9a-fA-F]/g, '');
  if (cleaned.length % 2 !== 0) {
    throw new Error('HEX 字符串长度必须为偶数（每字节两个字符）');
  }
  const buf = Buffer.alloc(cleaned.length / 2);
  for (let i = 0; i < cleaned.length; i += 2) {
    buf[i / 2] = parseInt(cleaned.substring(i, i + 2), 16);
  }
  return buf;
}

function encodeSend(data, encoding) {
  if (encoding === 'hex') {
    return parseHex(data);
  }
  return Buffer.from(String(data == null ? '' : data), 'utf-8');
}

function logData(direction, endpoint, buf, clientId = null) {
  broadcast({
    type: 'data',
    direction,                       // 'recv' | 'send'
    endpoint,                        // 数据来源 / 去向描述
    clientId,                        // 服务端模式下为连接 id，客户端模式为 null
    ts: Date.now(),
    hex: buf.toString('hex').toUpperCase(),
    text: buf.toString('utf-8'),
    bytes: buf.length,
  });
}

/* ------------------------------------------------------------------ *
 * 发送
 * ------------------------------------------------------------------ */
function doSend(opts) {
  const { data, encoding = 'text', clientId = null, appendCRLF = false } = opts;
  let payload = encodeSend(data, encoding);
  if (appendCRLF) {
    payload = Buffer.concat([payload, Buffer.from('\r\n', 'utf-8')]);
  }

  if (clientId != null) {
    // 服务端模式：定向到某个客户端或广播给全部
    if (clientId === 'all') {
      if (serverClients.size === 0) {
        throw new Error('当前没有已连接的客户端');
      }
      for (const [id, sock] of serverClients) {
        sock.write(payload);
        logData('send', `→ client#${id}`, payload, id);
      }
    } else {
      const cid = Number(clientId);
      const sock = serverClients.get(cid);
      if (!sock) {
        throw new Error(`客户端 #${clientId} 不存在或已断开`);
      }
      sock.write(payload);
      logData('send', `→ client#${cid}`, payload, cid);
    }
  } else {
    // 客户端模式
    if (!clientSocket || !clientConnected) {
      throw new Error('尚未建立连接');
    }
    clientSocket.write(payload);
    logData('send', '→ server', payload, null);
  }
  return { bytes: payload.length };
}

/* ------------------------------------------------------------------ *
 * 客户端模式
 * ------------------------------------------------------------------ */
function clientConnect({ host, port }) {
  return new Promise((resolve, reject) => {
    if (clientSocket) {
      try { clientSocket.destroy(); } catch (_) {}
      clientSocket = null;
      clientConnected = false;
    }
    let settled = false;
    const sock = net.createConnection({ host, port }, () => {
      clientConnected = true;
      clientSocket = sock;
      broadcast({ type: 'client_status', connected: true, host, port });
      if (!settled) { settled = true; resolve({ connected: true, host, port }); }
    });
    sock.on('data', (buf) => logData('recv', `${host}:${port}`, buf, null));
    sock.on('error', (err) => {
      broadcast({ type: 'error', scope: 'client', message: err.message });
      if (!settled) { settled = true; reject(new Error(err.message)); }
    });
    sock.on('close', () => {
      // 关键：仅当此 socket 仍是当前活动连接时才视为"客户端断开"并广播。
      // 否则重连时销毁旧 socket 触发的 close 会错误地清掉新连接的状态，
      // 导致刚连上的连接被误判为断开，甚至触发虚假自动重连。
      if (sock !== clientSocket) return;
      clientConnected = false;
      clientSocket = null;
      broadcast({ type: 'client_status', connected: false });
      if (!settled) { settled = true; } // 连接失败（未触发 'connect'），由 'error' 负责 reject
    });
  });
}

function clientDisconnect() {
  if (clientSocket) {
    try { clientSocket.destroy(); } catch (_) {}
  }
  clientSocket = null;
  clientConnected = false;
  broadcast({ type: 'client_status', connected: false });
}

/* ------------------------------------------------------------------ *
 * 服务端模式
 * ------------------------------------------------------------------ */
function broadcastClientList() {
  const list = [];
  for (const [id, sock] of serverClients) {
    list.push({ id, remote: `${sock.remoteAddress}:${sock.remotePort}` });
  }
  broadcast({ type: 'client_list', clients: list });
}

function serverStart({ port }) {
  return new Promise((resolve, reject) => {
    if (serverInstance) {
      return reject(new Error('服务端已在运行'));
    }
    let settled = false;
    const srv = net.createServer((sock) => {
      const id = nextClientId++;
      serverClients.set(id, sock);
      broadcast({
        type: 'server_client',
        action: 'connect',
        id,
        remote: `${sock.remoteAddress}:${sock.remotePort}`,
      });
      broadcastClientList();
      sock.on('data', (buf) => logData('recv', `client#${id}`, buf, id));
      sock.on('error', (err) => {
        broadcast({ type: 'error', scope: 'server-client', id, message: err.message });
      });
      sock.on('close', () => {
        serverClients.delete(id);
        broadcast({ type: 'server_client', action: 'disconnect', id });
        broadcastClientList();
      });
    });
    srv.on('error', (err) => {
      broadcast({ type: 'error', scope: 'server', message: err.message });
      if (!settled) { settled = true; reject(new Error(err.message)); }
    });
    srv.listen(port, () => {
      serverInstance = srv;
      serverPort = port;
      broadcast({ type: 'server_status', running: true, port });
      broadcastClientList();
      if (!settled) { settled = true; resolve({ running: true, port }); }
    });
  });
}

function serverStop() {
  autosendStop();
  for (const [, sock] of serverClients) {
    try { sock.destroy(); } catch (_) {}
  }
  serverClients.clear();
  if (serverInstance) {
    // 强制断开所有已接受的连接，确保监听端口被立即释放（close() 会等待连接结束）
    try {
      if (typeof serverInstance.closeAllConnections === 'function') {
        serverInstance.closeAllConnections();
      }
    } catch (_) {}
    try { serverInstance.close(); } catch (_) {}
    serverInstance = null;
    serverPort = null;
  }
  broadcast({ type: 'server_status', running: false });
  broadcast({ type: 'client_list', clients: [] });
}

function serverDisconnectClient(id) {
  const sock = serverClients.get(Number(id));
  if (sock) {
    try { sock.destroy(); } catch (_) {}
    serverClients.delete(Number(id));
    broadcastClientList();
  }
}

/* ------------------------------------------------------------------ *
 * 自动定时发送
 * ------------------------------------------------------------------ */
function autosendStart(opts) {
  if (autosendTimer) clearInterval(autosendTimer);
  const intervalMs = Math.max(100, parseInt(opts.intervalMs, 10) || 1000);
  const run = () => {
    try {
      doSend(opts);
      return true;
    } catch (e) {
      // 单次发送失败（如客户端已断开 / 服务端无客户端）：停止自动发送并只提示一次，
      // 避免每隔一个间隔就 broadcast 一次错误，导致前端持续弹 toast 刷屏。
      autosendStop();
      broadcast({ type: 'error', scope: 'autosend', message: e.message });
      return false;
    }
  };
  if (!run()) return;           // 首次发送失败则整体不启动，避免"假启动"反复刷屏
  autosendTimer = setInterval(run, intervalMs);
  broadcast({ type: 'autosend_status', running: true, intervalMs });
}

function autosendStop() {
  if (autosendTimer) {
    clearInterval(autosendTimer);
    autosendTimer = null;
  }
  broadcast({ type: 'autosend_status', running: false });
}

/* ------------------------------------------------------------------ *
 * 指令路由
 * ------------------------------------------------------------------ */
async function handleAction(msg) {
  try {
    switch (msg.action) {
      case 'client_connect':
        return { ok: true, ...(await clientConnect(msg)) };
      case 'client_disconnect':
        clientDisconnect();
        return { ok: true };
      case 'server_start':
        return { ok: true, ...(await serverStart(msg)) };
      case 'server_stop':
        serverStop();
        return { ok: true };
      case 'server_disconnect_client':
        serverDisconnectClient(msg.clientId);
        return { ok: true };
      case 'send':
        return { ok: true, ...doSend(msg) };
      case 'autosend_start':
        autosendStart(msg);
        return { ok: true };
      case 'autosend_stop':
        autosendStop();
        return { ok: true };
      case 'clear':
        broadcast({ type: 'clear' });
        return { ok: true };
      default:
        return { ok: false, error: '未知指令: ' + msg.action };
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ------------------------------------------------------------------ *
 * HTTP 服务（静态文件 + SSE + API）
 * ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const server = http.createServer((req, res) => {
  const url = req.url || '/';

  // SSE 事件流
  if (url === '/events') {
    if (sseClients.size >= MAX_SSE_CLIENTS) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('SSE 连接数已达上限');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('retry: 3000\n\n');
    sseClients.add(res);
    // 新连接时同步当前状态快照（服务端/客户端/自动发送），再同步客户端列表
    sendStateSnapshot(res);
    broadcastClientList();
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // 指令接口
  if (url.split('?')[0] === '/api' && req.method === 'POST') {
    let body = '';
    const MAX_BODY = 10 * 1024 * 1024;   // 10MB：防超大/畸形请求体无界占内存
    req.on('data', (chunk) => {
      if (body.length > MAX_BODY) {
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', async () => {
      let result;
      try {
        const msg = body ? JSON.parse(body) : {};
        result = await handleAction(msg);
      } catch (e) {
        result = { ok: false, error: e.message };
      }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify(result));
    });
    return;
  }

  // 静态文件
  let rel = url === '/' ? '/index.html' : url.split('?')[0];
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, HOST, () => {
  // 列出本机可访问的网址（0.0.0.0 时同时给出回环与各网卡 IPv4）
  const urls = new Set([`http://127.0.0.1:${PORT}`]);
  if (HOST === '0.0.0.0' || HOST === '::') {
    const ifaces = os.networkInterfaces();
    for (const list of Object.values(ifaces)) {
      for (const info of list || []) {
        if (info.family === 'IPv4' && !info.internal) urls.add(`http://${info.address}:${PORT}`);
      }
    }
  }
  console.log(`\n[TCP 调试助手] 已启动`);
  console.log(`  监听地址 : ${HOST}:${PORT}`);
  console.log(`  访问网址 : ${[...urls].join('   ')}`);
  console.log(`  配置说明 : 默认仅本机(127.0.0.1)。如需局域网其他设备访问，启动时用 HOST 覆盖：`);
  console.log(`            开放全部网卡  ->  HOST=0.0.0.0 npm start`);
  console.log(`            指定局域网IP  ->  HOST=192.168.1.125 npm start`);
  console.log(`            更换端口      ->  PORT=9000 npm start\n`);
});

// 进程退出时清理资源
function shutdown() {
  autosendStop();
  clientDisconnect();
  serverStop();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
