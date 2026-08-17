import http from 'http';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import multer from 'multer';
import mime from 'mime-types';
import db, {
  getMessages, addMessage, searchMessages, setNodeOnline, getNodes,
  addTask, getTasks, updateTask, taskStats, addAttachment, systemStats,
} from './db.js';
import { Orchestrator, parseCommand } from './orchestrator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3777;
const UPLOAD_DIR = '/home/fabiorjvr/Compartilhado';
const SUBDIRS = { fotos: 'fotos', documentos: 'documentos', projetos: 'projetos', outros: 'outros' };
Object.values(SUBDIRS).forEach(d => fs.mkdirSync(path.join(UPLOAD_DIR, d), { recursive: true }));

function fileCategory(originalName) {
  const ext = path.extname(originalName).toLowerCase().replace('.', '');
  const fotos = ['jpg','jpeg','png','gif','webp','heic','bmp'];
  const docs = ['pdf','doc','docx','xls','xlsx','ppt','pptx','txt','md','csv'];
  const proj = ['zip','rar','7z','tar','gz','tgz','py','js','ts','html','css','json','sh','java','c','cpp','go','rs','sql'];
  if (fotos.includes(ext)) return SUBDIRS.fotos;
  if (docs.includes(ext)) return SUBDIRS.documentos;
  if (proj.includes(ext)) return SUBDIRS.projetos;
  return SUBDIRS.outros;
}

const server = http.createServer();
const wss = new WebSocketServer({ server, path: '/ws' });

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

wss.on('connection', (ws) => {
  clients.add(ws);
  let nodeName = 'unknown';
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    switch (msg.type) {
      case 'auth':
        nodeName = msg.node || 'unknown';
        setNodeOnline(nodeName, true);
        broadcast({ type: 'presence', nodes: getNodes() });
        break;
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
      case 'typing':
        broadcast({ type: 'typing', node: msg.node || nodeName, active: !!msg.active });
        break;
      case 'message': {
        const from = msg.from || nodeName;
        const saved = addMessage({ node: from, content: msg.text, type: msg.mtype || 'text' });
        broadcast({ type: 'message', message: saved });
        if (from === 'fabio') handleFabioInput(msg.text);
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

async function handleFabioInput(text) {
  const { target, prompt } = parseCommand(text);
  if (target === 'chat') return;
  if (prompt || target === 'status' || target === 'pause' || target === 'resume') {
    await orch.handleCommand({ target, prompt, from: 'fabio', recent: getMessages({ limit: 10 }) });
  }
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(UPLOAD_DIR, fileCategory(file.originalname))),
    filename: (req, file, cb) => cb(null, `${Date.now()}_${file.originalname.replace(/[^\w.\-]/g, '_')}`),
  }),
  limits: { fileSize: 100 * 1024 * 1024 },
});

const STATIC = path.join(__dirname, 'public');
const mimeByExt = ext => mime.lookup(ext) || 'application/octet-stream';

server.on('request', (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  const sendJson = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };

  const serveFile = (filePath, contentType) => {
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    });
  };

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    serveFile(path.join(STATIC, 'index.html'), 'text/html; charset=utf-8');
    return;
  }
  if (req.method === 'GET' && p.startsWith('/static/')) {
    const f = p.slice('/static/'.length).replace(/\.\./g, '');
    serveFile(path.join(STATIC, f), mimeByExt(path.extname(f)));
    return;
  }
  if (req.method === 'GET' && p.startsWith('/uploads/')) {
    const rel = p.slice('/uploads/'.length).replace(/\.\./g, '');
    const full = path.join(UPLOAD_DIR, rel);
    if (!full.startsWith(UPLOAD_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
    const contentType = mimeByExt(path.extname(full));
    res.setHeader('Content-Disposition', `inline; filename="${path.basename(full)}"`);
    serveFile(full, contentType);
    return;
  }

  if (req.method === 'GET' && p === '/api/files') {
    const CAT_BY_EXT = {
      image: ['.png','.jpg','.jpeg','.gif','.webp','.bmp','.svg','.ico','.avif','.heic'],
      video: ['.mp4','.mkv','.webm','.mov','.avi','.m4v'],
      audio: ['.mp3','.wav','.ogg','.flac','.m4a','.aac','.opus'],
      pdf: ['.pdf'],
      archive: ['.zip','.rar','.7z','.tar','.gz','.bz2','.xz','.tgz'],
      spreadsheet: ['.xls','.xlsx','.csv','.ods','.tsv'],
      code: ['.js','.ts','.py','.html','.css','.json','.md','.sh','.rb','.go','.rs','.java','.c','.cpp','.h','.sql','.yml','.yaml','.xml','.toml','.bat','.ps1','.php','.kt','.swift'],
      doc: ['.doc','.docx','.txt','.rtf','.odt','.pptx','.ppt'],
    };
    const categoryOf = f => {
      const ext = path.extname(f).toLowerCase();
      for (const [cat, exts] of Object.entries(CAT_BY_EXT)) if (exts.includes(ext)) return cat;
      return 'other';
    };
    const walk = (dirAbs, relPrefix) => {
      const items = [];
      for (const ent of fs.readdirSync(dirAbs, { withFileTypes: true })) {
        if (ent.name.startsWith('.')) continue;
        const rel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
        const full = path.join(dirAbs, ent.name);
        if (ent.isDirectory()) {
          items.push(...walk(full, rel));
        } else {
          const st = fs.statSync(full);
          items.push({
            name: ent.name,
            relPath: rel,
            subdir: relPrefix,
            size: st.size,
            mtime: st.mtime.toISOString(),
            mtimeMs: st.mtimeMs,
            ext: (path.extname(ent.name) || '').replace('.', '').toLowerCase(),
            category: categoryOf(ent.name),
            url: '/uploads/' + rel,
          });
        }
      }
      return items;
    };
    const files = [];
    for (const dir of Object.values(SUBDIRS)) files.push(...walk(path.join(UPLOAD_DIR, dir), dir));
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    sendJson(200, { base: UPLOAD_DIR, files });
    return;
  }

  if (req.method === 'GET' && p === '/api/download') {
    const rel = (url.searchParams.get('file') || '').replace(/\.\./g, '');
    const full = path.join(UPLOAD_DIR, rel);
    if (!full.startsWith(UPLOAD_DIR) || !fs.existsSync(full)) { sendJson(404, { error: 'arquivo não existe' }); return; }
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(full)}"`);
    serveFile(full, mimeByExt(path.extname(full)));
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
    sendJson(200, {
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
    sendJson(200, { messages: getMessages({ since, limit }) });
    return;
  }

  if (req.method === 'GET' && p === '/api/search') {
    const q = url.searchParams.get('q') || '';
    sendJson(200, { results: searchMessages(q, { node: url.searchParams.get('node') }) });
    return;
  }

  if (req.method === 'GET' && p === '/api/tasks') {
    sendJson(200, { tasks: getTasks(url.searchParams.get('status') || 'pending') });
    return;
  }

  if (req.method === 'POST' && p === '/api/message') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const j = JSON.parse(body);
        const saved = addMessage({ node: j.sender || 'linux', content: j.text, type: j.type || 'text' });
        broadcast({ type: 'message', message: saved });
        sendJson(200, saved);
      } catch (e) { sendJson(400, { error: e.message }); }
    });
    return;
  }

  if (req.method === 'POST' && p === '/api/command') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      const j = JSON.parse(body || '{}');
      handleFabioInput(j.text || '');
      sendJson(200, { ok: true, queued: true });
    });
    return;
  }

  if (req.method === 'POST' && p === '/api/upload') {
    upload.single('file')(req, res, (err) => {
      if (err) return sendJson(400, { error: err.message });
      const file = req.file;
      const sub = fileCategory(file.originalname);
      const relPath = `${sub}/${file.filename}`;
      const savedMsg = addMessage({ node: req.body?.sender || 'fabio', content: req.body?.caption || `📎 ${file.originalname}`, type: 'media' });
      addAttachment({ messageId: savedMsg.id, filename: relPath, originalName: file.originalname, mimeType: file.mimetype, sizeBytes: file.size });
      const att = { filename: relPath, original_name: file.originalname, mime_type: file.mimetype, size_bytes: file.size, url: `/uploads/${relPath}` };
      broadcast({ type: 'message', message: { ...savedMsg, ...att } });
      sendJson(200, { ok: true, message: savedMsg, attachment: att });
    });
    return;
  }

  sendJson(404, { error: 'rota não existe' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`⚡ NEXUS no ar: http://LINUX_TAILSCALE_IP:${PORT}`);
  console.log(`⚡ WebSocket: ws://LINUX_TAILSCALE_IP:${PORT}/ws`);
});

// Presença real dos dispositivos via tailscale ping (bolinha verde honesta)
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
  online.add('linux'); // server rodando = Linux online
  const win = await tailscalePing('WINDOWS_TAILSCALE_IP');
  const and = await tailscalePing('ANDROID_TAILSCALE_IP');
  if (win) online.add('windows');
  if (and) online.add('android');
  for (const n of getNodes()) setNodeOnline(n.name, online.has(n.name));
  const nodes = getNodes().map(n => ({ ...n, online: online.has(n.name) ? 1 : 0 }));
  broadcast({ type: 'presence', nodes });
}

checkPresence();
setInterval(checkPresence, 30000);