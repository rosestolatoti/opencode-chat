import { runAgent, testWindows } from './bridge.js';
import { addMessage, getMessages, getNodes, getTasks, taskStats, addTask, updateTask } from './db.js';
import { truncateText } from './lib/util.js';

const MENTION_RE = /^@(linux|windows|todos|auto|pause|resume|status)\s*/i;

/* Política central do orquestrador — limites previsíveis */
const POLICY = {
  MAX_QUEUE: 50,
  MAX_OPS_PER_MIN: 10,
  MIN_FREE_MEM_GB: 2,
  MAX_TASK_MS: 10 * 60 * 1000,
  MAX_DELEGATIONS: 5,
  MAX_CHARS_TRANSFER: 4000,
};

function parseCommand(text) {
  const match = text.match(MENTION_RE);
  if (!match) return { target: 'chat', prompt: text.trim() };
  return { target: match[1].toLowerCase(), prompt: text.replace(MENTION_RE, '').trim() };
}

class Orchestrator {
  constructor({ broadcast, broadcastStream }) {
    this.broadcast = broadcast; // (event: object) => void
    this.broadcastStream = broadcastStream;
    this.queue = [];       // fila serial (um spawn de opencode por vez no Linux)
    this.running = false;
    this.paused = false;
    this.opTimestamps = []; // rate limit
    this.maxDelegations = POLICY.MAX_DELEGATIONS;
    this.timeoutMs = POLICY.MAX_TASK_MS;
    this.activeTasks = new Map();
  }

  isRateLimited() {
    const now = Date.now();
    this.opTimestamps = this.opTimestamps.filter(t => now - t < 60000);
    return this.opTimestamps.length >= POLICY.MAX_OPS_PER_MIN;
  }

  async freeMemGb() {
    const { execFile } = await import('child_process');
    return new Promise(resolve => {
      execFile('free', ['-b'], (err, stdout) => {
        // fail-closed: se não sabemos a memória, NÃO executamos
        if (err) return resolve(0);
        const line = stdout.split('\n')[1].split(/\s+/);
        const avail = parseInt(line[6], 10) || 0; // MemAvailable
        resolve(avail / 1024 ** 3);
      });
    });
  }

  async handleCommand({ target, prompt, from = 'fabio', recent }) {
    switch (target) {
      case 'chat':
        this.broadcast({ type: 'system', text: `(chat) ${from}: ${prompt}` });
        return { ok: true, note: 'mensagem de chat normal' };
      case 'status':
        return this.reportStatus();
      case 'pause':
        this.paused = true;
        this.broadcast({ type: 'system', text: '⏸️ Loop autônomo PAUSADO pelo líder.' });
        return { ok: true };
      case 'resume':
        this.paused = false;
        this.broadcast({ type: 'system', text: '▶️ Loop autônomo RETOMADO.' });
        return { ok: true };
      case 'todos':
        return this.enqueue('linux', prompt, { from, sequential: ['linux', 'windows'] });
      case 'auto':
        return this.enqueue('linux', prompt, { from, autonomous: true });
      default:
        return this.enqueue(target, prompt, { from });
    }
  }

  enqueue(node, task, opts = {}) {
    if (this.queue.length >= POLICY.MAX_QUEUE) {
      this.broadcast({ type: 'system', text: `⛔ Fila cheia (${POLICY.MAX_QUEUE} tarefas). Tarefa recusada.` });
      return { ok: false, error: 'fila cheia' };
    }
    if (this.isRateLimited()) {
      this.broadcast({ type: 'system', text: `⏳ Limite de ${POLICY.MAX_OPS_PER_MIN} comandos/minuto atingido. Aguarde.` });
      return { ok: false, error: 'rate limit' };
    }
    this.opTimestamps.push(Date.now());
    const job = { node, task, opts, id: Date.now() };
    this.queue.push(job);
    this.broadcast({ type: 'system', text: `📥 ${node} enfileirado: "${task.slice(0, 80)}${task.length > 80 ? '…' : ''}"` });
    this.pump();
    return { ok: true, queue: this.queue.length };
  }

  async pump() {
    if (this.running) return;
    if (this.paused) return;
    const job = this.queue.shift();
    if (!job) return;
    this.running = true;
    try {
      const mem = await this.freeMemGb();
      if (mem < POLICY.MIN_FREE_MEM_GB) {
        this.broadcast({ type: 'system', text: `⚠️ Memória baixa (${mem.toFixed(1)}GB livres). Tarefa "${job.task.slice(0, 40)}…" adiada até liberar RAM.` });
        this.queue.unshift(job);
        setTimeout(() => { this.running = false; this.pump(); }, 30000);
        return;
      }
      await this.runJob(job, 0);
    } catch (e) {
      this.broadcast({ type: 'system', text: `❌ Erro na tarefa: ${e.message}` });
    } finally {
      this.running = false;
      this.pump();
    }
  }

  async runJob(job, depth) {
    if (depth >= this.maxDelegations) {
      this.broadcast({ type: 'system', text: '⛔ Limite de delegações atingido. Chamando o líder.' });
      return;
    }
    const recent = getMessages({ limit: 10 });
    const streamId = `s${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    this.broadcast({ type: 'stream_start', stream_id: streamId, from: job.node });
    this.broadcast({ type: 'typing', node: job.node, active: true });

    const taskId = addTask({ from: job.opts.from || 'fabio', to: job.node, action: 'execute', payload: { task: job.task, depth } }).id;

    await new Promise(resolve => {
      let buffer = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        this.broadcast({ type: 'system', text: `⏱️ Timeout de ${this.timeoutMs / 60000}min na tarefa de ${job.node}.` });
        resolve();
      }, this.timeoutMs);

      let child;
      try {
        child = runAgent(job.node, { task: job.task, recent }, {
          onChunk: chunk => {
            buffer += chunk;
            const clean = stripAnsi(buffer);
            buffer = clean;
            if (clean.length >= 80 || clean.includes('\n')) {
              this.broadcastStream(streamId, job.node, clean);
              buffer = '';
            }
          },
          onRetry: (from, to, err) => {
            this.broadcast({ type: 'system', text: `🔁 ${job.node}: modelo ${from} falhou (${err?.message || 'saída vazia'}) → usando ${to}` });
          },
          onDone: (full, err) => {
            clearTimeout(timer);
            this.broadcast({ type: 'typing', node: job.node, active: false });
            const leftover = stripAnsi(buffer).trim();
            if (leftover) this.broadcastStream(streamId, job.node, leftover);
            this.broadcast({ type: 'stream_end', stream_id: streamId, from: job.node });
            const final = stripAnsi(full).trim();
            const msg = addMessage({ node: job.node, content: final || `(sem resposta${err ? ` — erro: ${err.message}` : ''})`, type: 'text' });
            updateTask(taskId, { status: err ? 'failed' : 'done', result: final || err?.message });
            this.broadcast({ type: 'message', message: msg });
            this.resolve(job, final, err, depth);
            resolve();
          },
        });
      } catch (e) {
        clearTimeout(timer);
        this.broadcast({ type: 'typing', node: job.node, active: false });
        this.broadcast({ type: 'stream_end', stream_id: streamId, from: job.node });
        addMessage({ node: job.node, content: `❌ Falha ao iniciar: ${e.message}`, type: 'text' });
        resolve();
      }
    });
  }

  async resolve(job, result, err, depth) {
    if (err) {
      this.broadcast({ type: 'system', text: `⚠️ ${job.node} falhou (${err.message}).` });
      return;
    }
    const text = result || '';

    if (job.opts.sequential?.length) {
      const idx = job.opts.sequential.indexOf(job.node);
      const next = job.opts.sequential[idx + 1];
      if (next) {
        this.broadcast({ type: 'system', text: `🔄 ${job.node} concluiu → passando para ${next}…` });
        this.enqueue(next, truncateText(text || job.task, POLICY.MAX_CHARS_TRANSFER), { from: job.node, sequential: job.opts.sequential });
        return;
      }
      this.broadcast({ type: 'system', text: `✅ Sequência completa (${job.opts.sequential.join(' → ')}) para o líder.` });
      return;
    }

    const deleg = /DELEGAR:\s*(linux|windows)/i.exec(text);
    if (deleg && (job.opts.autonomous || job.opts.sequential)) {
      const to = deleg[1].toLowerCase();
      const reason = truncateText(text.replace(/DELEGAR:\s*(linux|windows)/i, '').trim() || 'continue a tarefa', POLICY.MAX_CHARS_TRANSFER);
      this.broadcast({ type: 'system', text: `🔄 ${job.node} delegou para ${to}: ${reason.slice(0, 100)}` });
      this.enqueue(to, reason, { from: job.node, autonomous: job.opts.autonomous, sequential: job.opts.sequential });
      return;
    }
    if (job.opts.autonomous && text.includes('TAREFA_COMPLETA') === false && depth < 2) {
      const next = truncateText(text.split('\n').pop()?.trim() || '', POLICY.MAX_CHARS_TRANSFER);
      if (next && next.length > 10 && !next.startsWith('[')) {
        this.broadcast({ type: 'system', text: `🔄 ${job.node} continuando autonomamente…` });
        this.enqueue(job.node, next, { from: job.node, autonomous: true });
      }
    }
  }

  async reportStatus() {
    const nodes = getNodes().map(n => `${n.name}: ${n.online ? '🟢 online' : '⚪ offline'} (${n.role})`);
    const tasks = taskStats().map(t => `${t.status}: ${t.n}`).join(', ') || 'sem tarefas';
    const text = `📊 STATUS\n${nodes.join('\n')}\nTarefas: ${tasks}\nFila: ${this.queue.length}`;
    const msg = addMessage({ node: 'system', role: 'system', content: text, type: 'system' });
    this.broadcast({ type: 'message', message: msg });
    return { ok: true };
  }

  async testAgents() {
    const win = await testWindows();
    this.broadcast({ type: 'system', text: `🧪 Windows: ${win.ok ? `✅ opencode ${win.version}` : `❌ ${win.version || 'inacessível'}`}` });
    return win;
  }
}

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\r/g, '');
}

export { Orchestrator, parseCommand, POLICY };