import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { addMessage } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const NODES = {
  linux: {
    display: 'Linux PC',
    role: 'subchief',
    model: 'opencode/deepseek-v4-flash-free',
    fallback: null,
    workdir: path.join(__dirname, 'work', 'linux'),
  },
  windows: {
    display: 'Notebook Windows',
    role: 'agent',
    model: 'opencode/big-pickle',
    fallback: 'opencode/deepseek-v4-flash-free',
    workdir: 'C:\\Users\\wilgo\\.opencode\\nexus_work',
  },
};

const OPENCODE_BIN = '/home/fabiorjvr/.opencode/bin/opencode';
const WINDOWS_SSH = 'wilgo@WINDOWS_TAILSCALE_IP';

function makeContext(node, task, recent) {
  const cfg = NODES[node];
  return [
    `[NEXUS CONTEXT]`,
    `Você é o agente ${node.toUpperCase()} (${cfg.display}) da equipe NEXUS.`,
    `Hierarquia: Fabio (líder humano) → Linux (sub-chefe) → Windows (agente).`,
    `Seu role: ${cfg.role}. Você é um dos agentes que conversam num chat de equipe.`,
    `Tarefa atual: ${task}`,
    `Histórico recente do chat (últimas 10 mensagens):`,
    recent.length ? recent.map(m => `${m.node}: ${m.content.slice(0, 400)}`).join('\n') : '(nenhuma)',
    `Responda de forma direta, objetiva e útil. Se precisar que o outro agente faça algo, diga "DELEGAR:windows" ou "DELEGAR:linux" seguido do motivo, e o NEXUS encaminha.`,
    `[/NEXUS CONTEXT]`,
  ].join('\n');
}

function runLocal(node, model, prompt, onChunk, onDone) {
  const cfg = NODES[node];
  const args = ['run', '--pure', '-m', model, '--format', 'json', prompt];
  const child = spawn(OPENCODE_BIN, args, {
    cwd: cfg.workdir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  return wireStream(child, onChunk, onDone);
}

function runRemote(node, model, prompt, onChunk, onDone) {
  const cfg = NODES[node];
  const b64 = Buffer.from(prompt, 'utf8').toString('base64');
  const ps = `powershell -NoProfile -Command "$b='${b64}'; $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b)); cd ${cfg.workdir} 2>$null; opencode run --pure -m ${model} --format json $p"`;
  const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', WINDOWS_SSH, ps], { stdio: ['ignore', 'pipe', 'pipe'] });
  return wireStream(child, onChunk, onDone);
}

function wireStream(child, onChunk, onDone) {
  let jsonBuf = '';
  let textOut = '';
  let errBuf = '';
  const flush = line => {
    if (!line) return;
    try {
      const ev = JSON.parse(line);
      if (ev.type === 'text' && ev.part?.type === 'text' && ev.part.text) {
        textOut += ev.part.text;
        onChunk(ev.part.text);
      }
    } catch { /* linha não-JSON (warnings etc) — ignora */ }
  };
  child.stdout.on('data', d => {
    jsonBuf += d.toString();
    let i;
    while ((i = jsonBuf.indexOf('\n')) >= 0) {
      const line = jsonBuf.slice(0, i);
      jsonBuf = jsonBuf.slice(i + 1);
      flush(line);
    }
  });
  child.stderr.on('data', d => { errBuf += d.toString(); });
  child.on('error', err => onDone(textOut, err));
  child.on('close', code => {
    flush(jsonBuf);
    if (code === 0) return onDone(textOut, null);
    const detail = errBuf.trim().slice(-500);
    onDone(textOut, new Error(`exit ${code}${detail ? ' — ' + detail : ''}`));
  });
  return child;
}

/**
 * Executa o agente com fallback automático:
 * tenta o modelo principal; se falhar (erro ou saída quase vazia),
 * tenta o modelo reserva (cfg.fallback) e avisa via onRetry.
 */
export function runAgent(node, { task, recent = [] }, { onChunk, onDone, onRetry }) {
  const cfg = NODES[node];
  const prompt = makeContext(node, task, recent);
  const run = (model, cb) =>
    node === 'linux' ? runLocal(node, model, prompt, onChunk, cb) : runRemote(node, model, prompt, onChunk, cb);

  run(cfg.model, (text, err) => {
    if (!cfg.fallback) return onDone(text, err);
    const failed = err || text.trim().length < 3;
    if (!failed) return onDone(text, err);
    if (onRetry) onRetry(cfg.model, cfg.fallback, err);
    run(cfg.fallback, (text2, err2) => onDone(text2, err2));
  });
}

export function testWindows() {
  return new Promise(resolve => {
    const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', WINDOWS_SSH, 'opencode --version']);
    let out = '';
    child.stdout.on('data', d => out += d.toString());
    child.stderr.on('data', d => out += d.toString());
    child.on('close', code => resolve({ ok: code === 0 && out.includes('1.'), version: out.trim(), code }));
  });
}