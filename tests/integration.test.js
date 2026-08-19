import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 3788;
const TOKEN = 'token-de-teste-123';
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-it-'));

let child;
let baseUrl;

function waitForServer(url, tries = 50) {
  return new Promise((resolve, reject) => {
    const t = n => {
      fetch(url).then(() => resolve()).catch(() => (n > 0 ? setTimeout(() => t(n - 1), 200) : reject(new Error('servidor não subiu'))));
    };
    t(tries);
  });
}

async function login(node) {
  const r = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: TOKEN, node }),
  });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  assert.equal(r.status, 200, `login ${node}`);
  return cookie;
}

before(async () => {
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NEXUS_PORT: String(PORT),
      NEXUS_TOKEN: TOKEN,
      NEXUS_DB: path.join(BASE, 'test.db'),
      NEXUS_UPLOAD_DIR: path.join(BASE, 'uploads'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  child.stderr.on('data', d => { err += d; });
  baseUrl = `http://127.0.0.1:${PORT}`;
  await waitForServer(`${baseUrl}/api/session`);
});

after(() => {
  child.kill('SIGKILL');
  fs.rmSync(BASE, { recursive: true, force: true });
});

test('sem sessão: todas as APIs recusadas com 401', async () => {
  for (const [m, p] of [['GET', '/api/messages'], ['GET', '/api/status'], ['GET', '/api/files'], ['GET', '/uploads/x.png'], ['POST', '/api/message'], ['POST', '/api/command'], ['POST', '/api/upload']]) {
    const r = await fetch(`${baseUrl}${p}`, { method: m });
    assert.equal(r.status, 401, `${m} ${p}`);
  }
});

test('login com token errado/vazio → 401', async () => {
  for (const token of ['errado', '']) {
    const r = await fetch(`${baseUrl}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, node: 'fabio' }) });
    assert.equal(r.status, 401);
  }
});

test('os 3 dispositivos confiáveis têm FULL POWER (comando aceito)', async () => {
  for (const node of ['android', 'linux', 'windows']) {
    const cookie = await login(node);
    const r = await fetch(`${baseUrl}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ text: '@status' }),
    });
    assert.equal(r.status, 200, `${node} @status`);
    const j = await r.json();
    assert.equal(j.ok, true, `${node} recebeu ok:true`);
  }
});

test('identidade vem da sessão: payload forjado é ignorado', async () => {
  const cookie = await login('linux');
  const r = await fetch(`${baseUrl}/api/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ text: 'teste_identidade', from: 'fabio', role: 'leader', node: 'windows' }),
  });
  assert.equal(r.status, 200);
  const saved = await r.json();
  assert.equal(saved.node, 'linux', 'gravada como linux, não como fabio/windows');
});

test('mensagem vazia → 400, nada salvo', async () => {
  const cookie = await login('fabio');
  for (const text of ['', '   ', '\n\t']) {
    const r = await fetch(`${baseUrl}/api/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ text }),
    });
    assert.equal(r.status, 400, `texto ${JSON.stringify(text)}`);
  }
  const msgs = await (await fetch(`${baseUrl}/api/messages`, { headers: { Cookie: cookie } })).json();
  assert.ok(!msgs.messages.some(m => m.content === ''), 'nenhuma mensagem vazia no banco');
});

test('mensagem > 64KB → 413', async () => {
  const cookie = await login('fabio');
  const r = await fetch(`${baseUrl}/api/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ text: 'x'.repeat(70000) }),
  });
  assert.equal(r.status, 413);
});

test('body > 1MB → 413 com resposta HTTP limpa (não derruba)', async () => {
  const cookie = await login('fabio');
  const r = await fetch(`${baseUrl}/api/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ text: 'x'.repeat(1200000) }),
  });
  assert.equal(r.status, 413);
  const j = await r.json();
  assert.ok(j.error, 'resposta JSON limpa');
  // servidor continua vivo
  const ok = await fetch(`${baseUrl}/api/session`, { headers: { Cookie: cookie } });
  assert.equal(ok.status, 200);
});

test('WS: handshake sem sessão → 401; com sessão → conecta', async () => {
  const WebSocket = (await import('ws')).default;
  const bad = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const status = await new Promise(res => {
    bad.on('unexpected-response', (q, r) => res(r.statusCode));
    bad.on('error', () => {});
    setTimeout(() => res(null), 3000);
  });
  assert.equal(status, 401);

  const cookie = await login('fabio');
  const ok = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Cookie: cookie } });
  const opened = await new Promise(res => {
    ok.on('open', () => res(true));
    ok.on('error', () => res(false));
    setTimeout(() => res(false), 3000);
  });
  assert.equal(opened, true);
  ok.close();
});

test('WS: mensagem vazia → erro, não salva', async () => {
  const WebSocket = (await import('ws')).default;
  const cookie = await login('fabio');
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Cookie: cookie } });
  const got = await new Promise(res => {
    ws.on('open', () => ws.send(JSON.stringify({ type: 'message', text: '   ' })));
    ws.on('message', d => { const m = JSON.parse(d); if (m.type === 'error') res(m.error); });
    setTimeout(() => res(null), 3000);
  });
  assert.ok(got && got.includes('vazia'), `erro recebido: ${got}`);
  ws.close();
});

test('reply: regras de validação (válido, negativo, zero, string, inexistente, existente)', async () => {
  const cookie = await login('fabio');
  const post = body => fetch(`${baseUrl}/api/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  });

  // original (referência válida)
  const orig = await (await post({ text: 'mensagem original para reply' })).json();

  // 1) replyTo válido/existente → salva com relação
  const ok = await (await post({ text: 'reply ok', replyTo: orig.id })).json();
  assert.equal(ok.reply_to, orig.id);
  assert.equal(ok.reply_node, 'fabio');
  assert.equal(ok.reply_preview, 'mensagem original para reply');

  // 2) negativo → null (salva sem relação)
  const neg = await (await post({ text: 'reply neg', replyTo: -5 })).json();
  assert.equal(neg.reply_to, null);

  // 3) zero → null
  const zero = await (await post({ text: 'reply zero', replyTo: 0 })).json();
  assert.equal(zero.reply_to, null);

  // 4) string (mesmo numérica) → null
  const str = await (await post({ text: 'reply string', replyTo: '5' })).json();
  assert.equal(str.reply_to, null);

  // 5) inexistente → 400 com mensagem clara (nada salvo)
  const missing = await post({ text: 'reply fantasma', replyTo: 999999 });
  assert.equal(missing.status, 400);
  const missingBody = await missing.json();
  assert.equal(missingBody.error, 'mensagem de referência não encontrada');
  const msgs = await (await fetch(`${baseUrl}/api/messages`, { headers: { Cookie: cookie } })).json();
  assert.ok(!msgs.messages.some(m => m.content === 'reply fantasma'), 'mensagem fantasma NÃO foi salva');

  // 6) existente após reload (relação persiste no histórico)
  const hist = await (await fetch(`${baseUrl}/api/messages`, { headers: { Cookie: cookie } })).json();
  const persisted = hist.messages.find(m => m.id === ok.id);
  assert.equal(persisted.reply_to, orig.id);
  assert.equal(persisted.reply_node, 'fabio');
});

test('upload: mensagem-anexo com metadados por tipo (png/pdf/mp3)', async () => {
  const cookie = await login('fabio');

  // PNG real 1x1 (gerado com zlib)
  const zlib = await import('node:zlib');
  const crc32 = await import('node:zlib');
  function pngBytes() {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const chunk = (type, data) => {
      const t = Buffer.from(type);
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
      const body = Buffer.concat([t, data]);
      const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
      return Buffer.concat([len, body, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
    const idat = zlib.deflateSync(Buffer.from([0, 255, 0, 0, 255, 0]));
    return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
  }
  // PDF fake com 3 páginas
  const pdfBuf = Buffer.from('%PDF-1.4\n/Type /Catalog\n/Pages << /Count 3 >>\n/Type /Page\n/Type /Page\n/Type /Page\n%%EOF');

  const up = async (name, buf, caption, mime) => {
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: mime }), name);
    if (caption) fd.append('caption', caption);
    return fetch(`${baseUrl}/api/upload`, { method: 'POST', headers: { Cookie: cookie }, body: fd });
  };

  const png = await (await up('minha_foto.png', pngBytes(), '', 'image/png')).json();
  assert.equal(png.attachment.kind, 'image', 'png → image');
  assert.equal(png.attachment.width, 1, 'width detectado');
  assert.equal(png.attachment.height, 1, 'height detectado');
  assert.equal(png.attachment.mime_type, 'image/png');

  const pdfRes = await (await up('relatorio.pdf', pdfBuf, 'Confira as páginas 12-18.', 'application/pdf')).json();
  assert.equal(pdfRes.attachment.kind, 'pdf', 'pdf → pdf');
  assert.equal(pdfRes.attachment.pages, 3, 'páginas detectadas');

  const mp3 = await (await up('audio_teste.mp3', Buffer.from('ID3 fake mp3 bytes que o ffprobe rejeita'), '', 'audio/mpeg')).json();
  assert.equal(mp3.attachment.kind, 'audio', 'mp3 → audio');
  assert.equal(mp3.attachment.duration_ms, null, 'duração desconhecida → null (fallback seguro)');

  // mensagem-anexo aparece no histórico com att_kind
  const msgs = await (await fetch(`${baseUrl}/api/messages`, { headers: { Cookie: cookie } })).json();
  const found = msgs.messages.find(m => m.id === pdfRes.message.id);
  assert.equal(found.att_kind, 'pdf');
  assert.equal(found.att_pages, 3);
  assert.equal(found.content, 'Confira as páginas 12-18.', 'legenda preservada');
});

test('upload pdf REAL gera thumbnail da 1ª página', async () => {
  const cookie = await login('fabio');
  const { execFileSync } = await import('child_process');
  const pdfPath = path.join(BASE, 'real.pdf');
  execFileSync('gs', ['-q', '-sDEVICE=pdfwrite', '-dNOPAUSE', '-dBATCH', '-sOutputFile=' + pdfPath,
    '-c', '/Helvetica findfont 20 scalefont setfont 72 700 moveto (NEXUS) show showpage']);
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(pdfPath)], { type: 'application/pdf' }), 'relatorio_real.pdf');
  const j = await (await fetch(`${baseUrl}/api/upload`, { method: 'POST', headers: { Cookie: cookie }, body: fd })).json();
  assert.equal(j.attachment.kind, 'pdf');
  assert.ok(j.attachment.thumb, 'thumbnail gerada: ' + j.attachment.thumb);
  assert.ok(j.attachment.thumb.startsWith('/uploads/.thumbs/'), 'thumb dentro de .thumbs');
  // arquivo físico existe
  const thumbAbs = path.join(BASE, 'uploads', j.attachment.thumb.replace('/uploads/', ''));
  assert.ok(fs.existsSync(thumbAbs), 'arquivo do thumb no disco');
});

test('reply via WebSocket: broadcast com relação correta + persiste no histórico', async () => {
  const WebSocket = (await import('ws')).default;
  const cookie = await login('linux');
  const post = body => fetch(`${baseUrl}/api/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  });
  const orig = await (await post({ text: 'WS_ORIGINAL_123' })).json();

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Cookie: cookie } });
  const received = await new Promise(res => {
    ws.on('open', () => ws.send(JSON.stringify({ type: 'message', text: 'WS_REPLY_123', replyTo: orig.id })));
    ws.on('message', d => {
      const m = JSON.parse(d);
      if (m.type === 'message' && m.message && m.message.content === 'WS_REPLY_123') res(m.message);
    });
    setTimeout(() => res(null), 5000);
  });
  assert.ok(received, 'broadcast recebido');
  assert.equal(received.reply_to, orig.id, 'reply_to no broadcast');
  assert.equal(received.reply_node, 'linux', 'reply_node no broadcast');
  assert.equal(received.reply_preview, 'WS_ORIGINAL_123', 'reply_preview no broadcast');
  assert.ok(Number.isInteger(received.id), 'message_id presente');

  // reload via HTTP: relação preservada
  const hist = await (await fetch(`${baseUrl}/api/messages`, { headers: { Cookie: cookie } })).json();
  const persisted = hist.messages.find(m => m.id === received.id);
  assert.equal(persisted.reply_to, orig.id);
  assert.equal(persisted.reply_preview, 'WS_ORIGINAL_123');
  ws.close();
});