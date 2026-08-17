import http from 'http';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import multer from 'multer';
import mime from 'mime-types';
import db, {
  getMessages, addMessage, searchMessages, setNodeOnline, getNodes,
  addTask, getTasks, updateTask, taskStats, addAttachment, systemStats,
} from './db.js';
import { Orchestrator, parseCommand } from './orchestrator.js';
import { PORT, BOOTSTRAP_TOKEN, UPLOAD_DIR, LINUX_IP, WINDOWS_IP, ANDROID_IP, SESSION_TTL_MS } from './config.js';
import { SUBDIRS, fileCategory, fileCategoryType, parseCookies, resolveInside, parseJsonBody, normalizeMessage } from './lib/util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC = path.join(__dirname, 'public');
try {
  Object.values(SUBDIRS).forEach(d => fs.mkdirSync(path.join(UPLOAD_DIR, d), { recursive: true }));
} catch (e) {
  console.error('Falha ao criar pastas de upload:', e.message);
}

/* ================== identidade / sessões ================== */

const ROLE_BY_NODE = { fabio: 'leader', linux: 'subchief', windows: 'agent', android: 'viewer' };
const COOKIE_NAME = 'nexus_session';
const sessions = new Map(); // id -> { node, role, expires }

function getSession(req) {
  const sid = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s || s.expires < Date.now()) { sessions.delete(sid); return null; }
  return s;
}

function issueSession(res, node) {
  const id = crypto.randomBytes(24).toString('hex');
  const role = ROLE_BY_NODE[node] || 'viewer';
  sessions.set(id, { node, role, expires: Date.now() + SESSION_TTL_MS });
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${id}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; SameSite=Lax`);
  return { node, role };
}

function destroySession(req, res) {
  const sid = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (sid) sessions.delete(sid);
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

/* ================== helpers HTTP ================== */

function baseHeaders(res, extra = {}) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
}

function sendJson(res, code, obj) {
  baseHeaders(res, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.writeHead(code);
  res.end(JSON.stringify(obj));
}

function serveFile(res, filePath, contentType, { download = false } = {}) {
  fs.stat(filePath, (err, st) => {
    if (err) { sendJson(res, 404, { error: 'arquivo não existe' }); return; }
    baseHeaders(res, {
      'Content-Type': contentType,
      'Content-Length': st.size,
      'Cache-Control': 'no-store',
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${path.basename(filePath)}"`,
    });
    res.writeHead(200);
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
}

function readJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    let aborted = false;
    req.on('data', d => {
      if (aborted) return;
      size += d.length;
      if (size > maxBytes) {
        aborted = true;
        req.removeAllListeners('data'); // drena o restante sem acumular
        req.on('data', () => {});
        const e = new Error('corpo muito grande');
        e.status = 413;
        reject(e);
        return;
      }
      body += d;
    });
    req.on('end', () => {
      if (aborted) return;
      try { resolve(parseJsonBody(body, maxBytes)); }
      catch (e) { reject(e); }
    });
    req.on('error', e => reject(Object.assign(e, { status: 400 })));
  });
}

function requireAuth(req, res) {
  const s = getSession(req);
  if (!s) sendJson(res, 401, { error: 'não autenticado' });
  return s;
}

/* ================== WebSocket ================== */

const server = http.createServer();
const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

// rejeita handshake sem sessão antes de aceitar o upgrade
server.on('upgrade', (req, socket, head) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws') { socket.destroy(); return; }
    if (!getSession(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  } catch {
    socket.destroy();
  }
});

const clients = new Set();
function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(data);
}

const orch = new Orchestrator({
  broadcast,
  broadcastStream: (streamId, node, text) => {
    broadcast({ type: 'stream_chunk', stream_id: streamId, from: node, chunk: text });
  },
});

wss.on('connection', (ws, req) => {
  const session = getSession(req);
  if (!session) { ws.close(4001, 'não autenticado'); return; }
  const nodeName = session.node;
  clients.add(ws);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  setNodeOnline(nodeName, true);
  broadcast({ type: 'presence', nodes: getNodes() });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    switch (msg.type) {
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
      case 'typing':
        broadcast({ type: 'typing', node: nodeName, active: !!msg.active });
        break;
      case 'message': {
        let text;
        try { text = normalizeMessage(msg.text); }
        catch (e) { ws.send(JSON.stringify({ type: 'error', error: e.message })); return; }
        const saved = addMessage({ node: nodeName, content: text, type: msg.mtype || 'text' });
        broadcast({ type: 'message', message: saved });
        if (nodeName !== 'unknown') handleFabioInput(text, nodeName);
        break;
      }
      case 'task':
        addTask({ from: nodeName, to: msg.to || 'linux', action: msg.action || 'execute', payload: msg.payload });
        broadcast({ type: 'task', task: { from: nodeName, to: msg.to, action: msg.action } });
        break;
    }
  });
  ws.on('close', () => {
    clients.delete(ws);
    setNodeOnline(nodeName, false);
    broadcast({ type: 'presence', nodes: getNodes() });
  });
  ws.on('error', () => {});
});

// heartbeat: detecta clientes mortos sem fechar a conexão
setInterval(() => {
  for (const c of clients) {
    if (!c.isAlive) { c.terminate(); continue; }
    c.isAlive = false;
    c.ping();
  }
}, 30000);

async function handleFabioInput(text, from = 'fabio') {
  const { target, prompt } = parseCommand(text);
  if (target === 'chat') return { ok: true, note: 'chat' };
  if (prompt || target === 'status' || target === 'pause' || target === 'resume') {
    return await orch.handleCommand({ target, prompt, from, recent: getMessages({ limit: 10 }) });
  }
  return { ok: true };
}

/* ================== uploads ================== */

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(UPLOAD_DIR, fileCategory(file.originalname))),
    filename: (req, file, cb) => cb(null, `${Date.now()}_${file.originalname.replace(/[^\w.\-]/g, '_')}`),
  }),
  limits: { fileSize: 100 * 1024 * 1024 },
});

async function listUploads() {
  const items = [];
  const walk = async (dirAbs, relPrefix) => {
    let entries;
    try { entries = await fs.promises.readdir(dirAbs, { withFileTypes: true }); }
    catch { return; }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const rel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
      const full = path.join(dirAbs, ent.name);
      if (ent.isDirectory()) {
        await walk(full, rel);
      } else {
        let st;
        try { st = await fs.promises.stat(full); } catch { continue; }
        items.push({
          name: ent.name,
          relPath: rel,
          subdir: relPrefix,
          size: st.size,
          mtime: st.mtime.toISOString(),
          mtimeMs: st.mtimeMs,
          ext: (path.extname(ent.name) || '').replace('.', '').toLowerCase(),
          category: fileCategoryType(ent.name),
          url: '/uploads/' + rel,
        });
      }
    }
  };
  for (const dir of Object.values(SUBDIRS)) await walk(path.join(UPLOAD_DIR, dir), dir);
  items.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return items;
}

const mimeByExt = ext => mime.lookup(ext) || 'application/octet-stream';

/* ================== rotas ================== */

server.on('request', (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let p;
    try { p = decodeURIComponent(url.pathname); } catch { p = url.pathname; }
    const rawP = url.pathname;

    // bootstrap: primeiro acesso com o segredo -> sessão (nunca fica na URL)
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      const bt = url.searchParams.get('bootstrap');
      if (bt && BOOTSTRAP_TOKEN && bt === BOOTSTRAP_TOKEN) {
        const node = ROLE_BY_NODE[url.searchParams.get('node')] ? url.searchParams.get('node') : 'fabio';
        issueSession(res, node);
        res.setHeader('Location', '/');
        baseHeaders(res);
        res.writeHead(302);
        res.end();
        return;
      }
      serveFile(res, path.join(STATIC, 'index.html'), 'text/html; charset=utf-8');
      return;
    }
    if (req.method === 'GET' && p.startsWith('/static/')) {
      const full = resolveInside(STATIC, p.slice('/static/'.length));
      if (!full) { sendJson(res, 403, { error: 'forbidden' }); return; }
      serveFile(res, full, mimeByExt(path.extname(full)));
      return;
    }

    // login/logout/sessão (únicos endpoints públicos de API)
    if (req.method === 'POST' && p === '/api/login') {
      readJsonBody(req).then(j => {
        if (!BOOTSTRAP_TOKEN || j.token !== BOOTSTRAP_TOKEN) { sendJson(res, 401, { error: 'token inválido' }); return; }
        const node = ROLE_BY_NODE[j.node] ? j.node : 'fabio';
        sendJson(res, 200, issueSession(res, node));
      }).catch(e => sendJson(res, e.status || 400, { error: e.message }));
      return;
    }
    if (req.method === 'POST' && p === '/api/logout') {
      destroySession(req, res);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET' && p === '/api/session') {
      const s = getSession(req);
      if (!s) { sendJson(res, 401, { error: 'não autenticado' }); return; }
      sendJson(res, 200, s);
      return;
    }

    // daqui para baixo: tudo exige sessão
    const session = requireAuth(req, res);
    if (!session) return;

    if (req.method === 'GET' && p.startsWith('/uploads/')) {
      const full = resolveInside(UPLOAD_DIR, p.slice('/uploads/'.length));
      if (!full) { sendJson(res, 403, { error: 'forbidden' }); return; }
      serveFile(res, full, mimeByExt(path.extname(full)));
      return;
    }

    if (req.method === 'GET' && p === '/api/files') {
      listUploads()
        .then(files => sendJson(res, 200, { base: UPLOAD_DIR, files }))
        .catch(e => sendJson(res, 500, { error: e.message }));
      return;
    }

    if (req.method === 'GET' && p === '/api/download') {
      const full = resolveInside(UPLOAD_DIR, url.searchParams.get('file') || '');
      if (!full || !fs.existsSync(full)) { sendJson(res, 404, { error: 'arquivo não existe' }); return; }
      serveFile(res, full, mimeByExt(path.extname(full)), { download: true });
      return;
    }

    if (req.method === 'GET' && p === '/api/status') {
      let memAvailable = os.freemem();
      try {
        const mi = fs.readFileSync('/proc/meminfo', 'utf8');
        const m = mi.match(/MemAvailable:\s+(\d+)/);
        if (m) memAvailable = parseInt(m[1], 10) * 1024;
      } catch { /* fallback freemem */ }
      const memUsed = os.totalmem() - memAvailable;
      sendJson(res, 200, {
        ...systemStats(),
        system: {
          uptimeSec: Math.floor(os.uptime()),
          memTotalGb: +(os.totalmem() / 1024 ** 3).toFixed(1),
          memUsedGb: +(memUsed / 1024 ** 3).toFixed(1),
          memFreeGb: +(memAvailable / 1024 ** 3).toFixed(1),
          diskFreeGb: +(fs.statfsSync(__dirname).bavail * fs.statfsSync(__dirname).bsize / 1024 ** 3).toFixed(1),
          loadAvg: os.loadavg().map(x => +x.toFixed(2)),
        },
        tasks: taskStats(),
      });
      return;
    }

    if (req.method === 'GET' && p === '/api/messages') {
      const since = parseInt(url.searchParams.get('since') || '0', 10);
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500);
      sendJson(res, 200, { messages: getMessages({ since, limit }) });
      return;
    }

    if (req.method === 'GET' && p === '/api/search') {
      const q = url.searchParams.get('q') || '';
      sendJson(res, 200, { results: searchMessages(q, { node: url.searchParams.get('node') }) });
      return;
    }

    if (req.method === 'GET' && p === '/api/tasks') {
      sendJson(res, 200, { tasks: getTasks(url.searchParams.get('status') || 'pending') });
      return;
    }

    if (req.method === 'POST' && p === '/api/message') {
      readJsonBody(req).then(j => {
        const text = normalizeMessage(j.text);
        const saved = addMessage({ node: session.node, content: text, type: j.type || 'text' });
        broadcast({ type: 'message', message: saved });
        sendJson(res, 200, saved);
      }).catch(e => sendJson(res, e.status || 400, { error: e.message }));
      return;
    }

    if (req.method === 'POST' && p === '/api/command') {
      readJsonBody(req).then(async j => {
        const r = await handleFabioInput(String(j.text || ''), session.node);
        if (r && r.ok === false) {
          sendJson(res, 429, { ok: false, error: r.error });
          return;
        }
        sendJson(res, 200, { ok: true, queued: true });
      }).catch(e => sendJson(res, e.status || 400, { error: e.message }));
      return;
    }

    if (req.method === 'POST' && p === '/api/upload') {
      upload.single('file')(req, res, (err) => {
        if (err) { sendJson(res, 400, { error: err.message }); return; }
        if (!req.file) { sendJson(res, 400, { error: 'nenhum arquivo enviado' }); return; }
        try {
          const file = req.file;
          const sub = fileCategory(file.originalname);
          const relPath = `${sub}/${file.filename}`;
          const savedMsg = addMessage({ node: session.node, content: req.body?.caption || `📎 ${file.originalname}`, type: 'media' });
          addAttachment({ messageId: savedMsg.id, filename: relPath, originalName: file.originalname, mimeType: file.mimetype, sizeBytes: file.size });
          const att = { filename: relPath, original_name: file.originalname, mime_type: file.mimetype, size_bytes: file.size, url: `/uploads/${relPath}` };
          broadcast({ type: 'message', message: { ...savedMsg, ...att } });
          sendJson(res, 200, { ok: true, message: savedMsg, attachment: att });
        } catch (e) {
          sendJson(res, 500, { error: e.message });
        }
      });
      return;
    }

    sendJson(res, 404, { error: 'rota não existe' });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`⚡ NEXUS no ar: http://${LINUX_IP}:${PORT}`);
  console.log(`⚡ WebSocket: ws://${LINUX_IP}:${PORT}/ws`);
});

/* ================== presença real via Tailscale ================== */
import { execFile } from 'child_process';

function tailscalePing(ip) {
  return new Promise(resolve => {
    execFile('tailscale', ['ping', '--c', '1', '--timeout', '3s', ip], { timeout: 8000 }, (err) => {
      resolve(!err);
    });
  });
}

async function checkPresence() {
  const online = new Set();
  for (const c of clients) online.add('fabio');
  online.add('linux');
  try {
    const win = await tailscalePing(WINDOWS_IP);
    const and = await tailscalePing(ANDROID_IP);
    if (win) online.add('windows');
    if (and) online.add('android');
  } catch { /* mantém o estado atual */ }
  for (const n of getNodes()) setNodeOnline(n.name, online.has(n.name));
  const nodes = getNodes().map(n => ({ ...n, online: online.has(n.name) ? 1 : 0 }));
  broadcast({ type: 'presence', nodes });
}

checkPresence();
setInterval(checkPresence, 30000);