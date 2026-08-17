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