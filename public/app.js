const ICONS = {
  person:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.4"/><path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6"/></svg>',
  tower:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="3" width="9" height="14" rx="1"/><line x1="9" y1="6.5" x2="12" y2="6.5"/><line x1="9" y1="9.5" x2="12" y2="9.5"/><circle cx="10.5" cy="13" r="1"/><line x1="8" y1="20" x2="13" y2="20"/><line x1="10.5" y1="17" x2="10.5" y2="20"/></svg>',
  laptop:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="10" rx="1"/><path d="M2 18h20l-2-2H4z"/></svg>',
  phone:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2" width="10" height="20" rx="2"/><line x1="10" y1="19" x2="14" y2="19"/></svg>'
};

const TAG_OF = { fabio:'you', linux:'linux', windows:'windows', android:'android' };
const DISPLAY = { you:'Fabio Rosestolato', linux:'PC-Linux', windows:'Notebook-Windows', android:'Celular-Android' };

const MENTIONS = [
  { tag:'linux',   desc:'Deepseek V4 Flash · Subchief' },
  { tag:'windows', desc:'Big Pickle (fallback: Deepseek v4 Flash) · Agente' },
  { tag:'android', desc:'Claude Opus (futuro) · Reserva' },
  { tag:'todos',   desc:'Transmitir para toda a equipe' },
  { tag:'auto',    desc:'Executa rotina automática' },
  { tag:'pause',   desc:'Pausa o loop autônomo' },
  { tag:'resume',  desc:'Retoma o loop autônomo' },
  { tag:'status',  desc:'Mostra status de todos os nós' },
];

const NODE_POS = {
  you:{ x:44, y:61, color:'--blue' },
  linux:{ x:166, y:21, color:'--green' },
  windows:{ x:166, y:61, color:'--amber' },
  android:{ x:166, y:101, color:'--violet' },
};

const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';

const $ = s => document.querySelector(s);
const escapeHTML = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

function formatText(text){
  return escapeHTML(text).replace(/@([a-zA-Z0-9_]+)/g, '<span class="mention">@$1</span>');
}

const seen = new Set();
const streams = {};
const typingNodes = new Set();

function nowTime(){
  const d = new Date();
  return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
}

const isNearBottom = () => {
  const el = $('#transcript');
  return el.scrollHeight - el.scrollTop - el.clientHeight < 150;
};
const scrollIfNeeded = () => { if (isNearBottom()) $('#transcript').scrollTop = $('#transcript').scrollHeight; };

/* ---------- roster (dados reais do /api/status) ---------- */
function renderRoster(nodes){
  const el = $('#roster');
  const order = ['fabio','linux','windows','android'];
  const sorted = order.map(name => nodes.find(n => n.name === name)).filter(Boolean);
  el.innerHTML = sorted.map(n => {
    const tag = TAG_OF[n.name];
    const online = !!n.online;
    const working = activeAgent && activeAgent.node === n.name ? ' is-working' : '';
    return `
      <div class="member${working}" data-tag="${tag}">
        <div class="icon accent-${tag === 'you' ? 'human' : tag}">${iconFor(n.name)}</div>
        <div class="member-info">
          <div class="name">${escapeHTML(n.display_name)}</div>
          <div class="model">${escapeHTML(n.model || n.role || '')}</div>
        </div>
        <div class="status ${online ? 'online' : 'offline'}"><span class="led"></span>${online ? 'online' : 'offline'}</div>
      </div>`;
  }).join('');
  const total = sorted.length;
  const on = sorted.filter(n => n.online).length;
  $('#rosterCount').textContent = total + ' integrantes';
  lastHeaderMeta = total + ' integrantes · ' + on + ' online';
  if (!activeAgent) $('#headerMeta').textContent = lastHeaderMeta;
}

/* ---------- tarefas reais ---------- */
function renderTasks(tasks){
  const el = $('#taskList');
  if (!tasks.length){
    el.innerHTML = '<li class="task"><span style="color:var(--ink-dim)">Nenhuma tarefa pendente</span></li>';
    $('#taskCount').textContent = '0 pendentes';
    return;
  }
  el.innerHTML = tasks.map(t => `
    <li class="task" data-id="${t.id}">
      <div class="col">
        <div>${escapeHTML((t.payload && t.payload.task) || t.action || '')}</div>
        <span class="owner">@${escapeHTML(t.to_node)} · ${escapeHTML(t.from_node)}</span>
      </div>
      <span class="task-status ${t.status}">${t.status}</span>
    </li>`).join('');
  $('#taskCount').textContent = tasks.filter(t => t.status === 'pending').length + ' pendentes';
}

/* ---------- telemetria real ---------- */
function renderTelemetry(sys, totalMessages){
  $('#ramLabel').textContent = sys.memUsedGb + ' / ' + sys.memTotalGb + ' GB';
  $('#ramFill').style.width = (sys.memUsedGb / sys.memTotalGb * 100).toFixed(0) + '%';
  $('#statDisk').textContent = sys.diskFreeGb + ' GB';
  $('#statMessages').textContent = totalMessages;
  $('#load1').innerHTML = sys.loadAvg[0].toFixed(2) + '<small>1min</small>';
  $('#load5').innerHTML = sys.loadAvg[1].toFixed(2) + '<small>5min</small>';
  $('#load15').innerHTML = sys.loadAvg[2].toFixed(2) + '<small>15min</small>';
}

/* ---------- mensagens ---------- */
function fmtDuration(ms){
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const r = String(s % 60).padStart(2, '0');
  return m > 0 ? `${m}:${r}` : `0:${r}`;
}
const KIND_LABEL = { image:'Imagem', video:'Vídeo', audio:'Áudio', pdf:'PDF', archive:'Compactado', spreadsheet:'Planilha', code:'Código', doc:'Documento', db:'Banco de dados', other:'Arquivo' };

function renderAttachment(div, m){
  if (!m.att_filename) return;
  const rel = m.att_url || '/uploads/' + m.att_filename;
  const kind = m.att_kind || 'other';
  const name = m.att_original_name || m.att_filename;
  const size = m.att_size ? fmtSize(m.att_size) : '';
  const parts = [];
  if (kind === 'image') parts.push((m.att_mime || '').startsWith('image/') ? (m.att_mime || '').split('/')[1].toUpperCase() : 'IMAGEM');
  else if (kind === 'pdf') parts.push('PDF');
  else if (kind === 'audio') parts.push((m.att_mime || '').split('/')[1]?.toUpperCase() || 'ÁUDIO');
  else if (kind === 'video') parts.push((m.att_mime || '').split('/')[1]?.toUpperCase() || 'VÍDEO');
  else parts.push((m.att_filename || '').split('.').pop()?.toUpperCase() || KIND_LABEL[kind].toUpperCase());
  if (size) parts.push(size);
  if (kind === 'pdf' && m.att_pages) parts.push(`${m.att_pages} página${m.att_pages > 1 ? 's' : ''}`);
  if ((kind === 'audio' || kind === 'video') && m.att_duration_ms) parts.push(fmtDuration(m.att_duration_ms));
  if (kind === 'image' && m.att_width && m.att_height) parts.push(`${m.att_width}×${m.att_height}`);

  const card = document.createElement('a');
  card.className = `att-card kind-${kind}`;
  card.href = rel;
  card.download = name;
  card.setAttribute('aria-label', `${KIND_LABEL[kind] || 'Arquivo'}: ${name}`);

  const preview = document.createElement('div');
  preview.className = 'att-preview';
  const ext = (m.att_filename || '').split('.').pop()?.toUpperCase() || KIND_LABEL[kind].toUpperCase();
  const thumbUrl = (kind === 'pdf' && m.att_thumb) ? m.att_thumb : null;
  if (kind === 'image' || thumbUrl) {
    // mídia real: foto/thumb com barra de extensão translúcida (nítida sobre qualquer fundo)
    const img = document.createElement('img');
    img.src = thumbUrl || rel;
    img.loading = 'lazy';
    img.alt = '';
    if (thumbUrl) img.className = 'att-thumb-pdf';
    img.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); openLightbox(img.src); });
    img.addEventListener('error', () => { preview.innerHTML = FM_ICONS.image; });
    preview.appendChild(img);
    const badge = document.createElement('span');
    badge.className = 'att-ext-media';
    badge.textContent = '.' + ext;
    preview.appendChild(badge);
  } else {
    // logo centralizada + extensão grande ao lado
    preview.innerHTML = FM_ICONS[kind] || FM_ICONS.doc;
    const badge = document.createElement('span');
    badge.className = 'att-ext-big';
    badge.textContent = '.' + ext;
    preview.appendChild(badge);
  }

  const body = document.createElement('div');
  body.className = 'att-body';
  body.innerHTML = `
    <div class="att-name" title="${escapeHTML(name)}">${escapeHTML(name)}</div>
    <div class="att-meta">${escapeHTML(parts.join(' · '))}</div>`;

  card.append(preview, body);
  div.appendChild(card);
}

function appendMessageDOM(msg){
  if (msg.id && seen.has(msg.id)) return;
  if (msg.id) seen.add(msg.id);
  const transcript = $('#transcript');
  const isSystem = msg.node === 'system';
  const tag = TAG_OF[msg.node] || 'linux';
  const cls = tag === 'you' ? 'from-you' : isSystem ? 'system' : 'from-' + tag;
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + cls;
  if (msg.id != null) wrap.dataset.messageId = String(msg.id);
  if (msg.content != null) wrap.dataset.messageContent = String(msg.content);
  if (msg.node != null) wrap.dataset.messageNode = String(msg.node);
  if (msg.att_filename) {
    wrap.dataset.attFilename = String(msg.att_filename);
    wrap.dataset.attUrl = msg.att_url || '/uploads/' + msg.att_filename;
  }
  const iconKey = tag === 'you' ? 'person' : tag;
  const avatarHTML = isSystem ? '' : `<div class="avatar accent-${tag === 'you' ? 'human' : tag}">${iconFor(msg.node)}</div>`;
  const model = (msg.node !== 'system' && msg.node !== 'fabio') ? `<span class="model accent-${tag === 'you' ? 'human' : tag}">${escapeHTML(modelFor(msg.node))}</span>` : '';
  // quote só quando a referência existe (nunca "↩ ?")
  const quote = (msg.reply_to && msg.reply_node)
    ? `<div class="msg-quote" data-reply-to="${Number(msg.reply_to)}">
        <span class="q-author">↩ ${escapeHTML(nameFor(msg.reply_node))}</span>
        <span class="q-text">${escapeHTML((msg.reply_preview || '').slice(0, 140))}</span>
      </div>`
    : '';
  // mensagem-anexo sem legenda: o cartão fala por si (não repete "📎 nome" como texto)
  const isPlainAtt = msg.att_filename && String(msg.content || '').startsWith('📎 ');
  const bodyText = isPlainAtt ? '' : formatText(msg.content || '');
  wrap.innerHTML = `
    ${avatarHTML}
    <div class="col">
      <div class="msg-meta"><span>${(msg.created_at || '').slice(11,16) || nowTime()}</span><span class="who accent-${tag === 'you' ? 'human' : tag}">${escapeHTML(nameFor(msg.node))}</span>${model}<button class="msg-menu-btn" aria-label="Opções da mensagem" title="Opções">⋮</button></div>
      ${quote}
      <div class="msg-bubble">${bodyText}</div>
    </div>`;
  const bubble = wrap.querySelector('.msg-bubble');
  renderAttachment(bubble, msg);
  transcript.appendChild(wrap);
  scrollIfNeeded();
}

const MODELS = {};
function loadMessages(){
  return fetch('/api/messages').then(r => r.json()).then(j => {
    $('#transcript').innerHTML = '';
    seen.clear();
    j.messages.forEach(appendMessageDOM);
    $('#transcript').scrollTop = $('#transcript').scrollHeight;
  }).catch(() => {
    console.warn('loadMessages falhou — tentando de novo em 3s');
    setTimeout(loadMessages, 3000);
  });
}

/* ---------- streaming ---------- */
function streamStart(m){
  const tag = TAG_OF[m.from] || 'linux';
  const wrap = document.createElement('div');
  wrap.className = 'msg streaming from-' + tag;
  wrap.dataset.stream = m.stream_id;
  wrap.innerHTML = `
    <div class="avatar accent-${tag === 'you' ? 'human' : tag}">${ICONS[tag === 'you' ? 'person' : tag]}</div>
    <div class="col">
      <div class="msg-meta"><span>${nowTime()}</span><span class="who accent-${tag === 'you' ? 'human' : tag}">${escapeHTML(DISPLAY[tag] || m.from)}</span><span class="model">${escapeHTML(MODELS[m.from] || '')}</span></div>
      <div class="msg-bubble"></div>
    </div>`;
  $('#transcript').appendChild(wrap);
  scrollIfNeeded();
  streams[m.stream_id] = wrap.querySelector('.msg-bubble');
}
function streamChunk(m){
  const b = streams[m.stream_id];
  if (b){ b.textContent += m.chunk; scrollIfNeeded(); }
}
function streamEnd(m){
  const el = $('#transcript').querySelector(`[data-stream="${m.stream_id}"]`);
  if (el) { el.classList.remove('streaming'); el.classList.add('stream-final'); }
  delete streams[m.stream_id];
}

/* ---------- status de agente (fase: started/delegated/finished/error) ---------- */
let activeAgent = null;
let lastHeaderMeta = '';

function updateAgentStatus(m){
  activeAgent = (m.phase === 'started' || m.phase === 'delegated')
    ? { node: m.from, phase: m.phase, note: m.note }
    : null;
  if (activeAgent) {
    const label = m.phase === 'delegated' ? '→ delegando…' : 'trabalhando…';
    $('#headerMeta').textContent = `${nameFor(m.from)} ${label}`;
  } else if (lastHeaderMeta) {
    $('#headerMeta').textContent = lastHeaderMeta;
  }
  const roster = $('#roster');
  if (roster) {
    roster.querySelectorAll('.member').forEach(member => {
      const tag = member.dataset.tag;
      member.classList.toggle('is-working', !!activeAgent && TAG_OF[activeAgent.node] === tag);
    });
  }
}

/* ---------- conversão do balão de streaming na mensagem final (sem segundo bloco) ---------- */
function finalizeStreamAsMessage(m){
  const el = $('#transcript').querySelector(`[data-stream="${m.stream_id}"]`);
  if (!el) return false;
  const bubble = el.querySelector('.msg-bubble');
  if (!bubble) return false;
  bubble.innerHTML = formatText(m.content || '');
  renderAttachment(bubble, m);
  if (m.id != null) el.dataset.messageId = String(m.id);
  if (m.content != null) el.dataset.messageContent = String(m.content);
  if (m.node != null) el.dataset.messageNode = String(m.node);
  el.classList.remove('streaming', 'stream-final');
  delete streams[m.stream_id];
  if (m.id != null) seen.add(m.id);
  return true;
}

/* ---------- typing ---------- */
function updateTyping(){
  const old = $('#typing-el');
  if (old) old.remove();
  if (!typingNodes.size) return;
  const names = [...typingNodes].map(n => DISPLAY[TAG_OF[n]] || n).join(', ');
  const div = document.createElement('div');
  div.id = 'typing-el';
  div.className = 'msg';
  div.innerHTML = `<div class="typing-line"><span></span><span></span><span></span></div>
    <div class="msg-meta">${escapeHTML(names)} está digitando...</div>`;
  $('#transcript').appendChild(div);
  scrollIfNeeded();
}

/* ---------- presença / mesh ---------- */
function setActiveNode(tag){
  const pos = NODE_POS[tag];
  if (!pos) return;
  const pulse = $('#meshPulse');
  pulse.setAttribute('cx', pos.x);
  pulse.setAttribute('cy', pos.y);
  pulse.style.fill = 'var(' + pos.color + ')';
  document.querySelectorAll('.member').forEach(m => m.classList.toggle('is-active', m.dataset.tag === tag));
}

/* ---------- envio ---------- */
let pendingImage = null; // { file, previewUrl, caption }

function sendMessage(text){
  if (!text.trim() && !pendingImage) return;
  
  if (pendingImage) {
    // Envia imagem + texto juntos
    sendImageWithCaption(pendingImage.file, text);
    clearPendingImage();
  } else {
    // Texto normal
    const input = $('#messageInput');
    input.value = '';
    autoGrow();
    ws.send(JSON.stringify({ type:'message', text, replyTo: replyTarget ? replyTarget.id : undefined }));
    setActiveNode('you');
    if (replyTarget) cancelReply();
  }
}

function clearPendingImage() {
  if (pendingImage?.previewUrl) URL.revokeObjectURL(pendingImage.previewUrl);
  pendingImage = null;
  renderComposerPreview();
}

function renderComposerPreview() {
  const container = $('#composerPreview');
  if (!pendingImage) {
    container.hidden = true;
    container.innerHTML = '';
    return;
  }
  container.hidden = false;
  container.innerHTML = `
    <div class="composer-preview">
      <img src="${pendingImage.previewUrl}" alt="Preview" class="preview-img">
      <span class="preview-name">${escapeHTML(pendingImage.file.name)}</span>
      <button type="button" class="preview-remove" id="previewRemove" title="Remover imagem">✕</button>
    </div>
  `;
  $('#previewRemove')?.addEventListener('click', clearPendingImage);
}

async function sendImageWithCaption(file, caption) {
  let uploadFile = file;
  if (file.type.startsWith('image/')) {
    try {
      const compressed = await compressImage(file);
      uploadFile = new File([compressed], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' });
      console.log(`[Upload] Comprimido: ${(file.size/1024).toFixed(0)}KB → ${(uploadFile.size/1024).toFixed(0)}KB`);
    } catch (e) { console.warn('[Upload] Falha ao comprimir, enviando original:', e.message); }
  }
  const fd = new FormData();
  fd.append('file', uploadFile);
  fd.append('sender', 'fabio');
  if (caption && caption.trim()) fd.append('caption', caption.trim());
  try {
    const r = await fetch('/api/upload', { method:'POST', body:fd });
    const j = await r.json();
    if (!j.ok) alert('Erro no upload: ' + (j.error || 'desconhecido'));
  } catch (e) { alert('Falha ao enviar: ' + e.message); }
}

function autoGrow(){
  const t = $('#messageInput');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 160) + 'px';
}

/* ---------- mention autocomplete ---------- */
const input = $('#messageInput');
const menu = $('#mentionMenu');
let matches = [];
let selected = 0;

function updateMentionMenu(){
  const caret = input.selectionStart;
  const before = input.value.slice(0, caret);
  const m = before.match(/(?:^|\s)@([a-zA-Z0-9_]*)$/);
  if (!m){ closeMentionMenu(); return; }
  const q = m[1].toLowerCase();
  matches = MENTIONS.filter(x => x.tag.startsWith(q));
  if (!matches.length){ closeMentionMenu(); return; }
  selected = 0;
  renderMentionMenu();
}
function renderMentionMenu(){
  menu.innerHTML = matches.map((m, i) => `
    <div class="mention-item ${i === selected ? 'is-selected' : ''}" data-index="${i}">
      <span class="tag">@${m.tag}</span><span class="desc">${m.desc}</span>
    </div>`).join('');
  menu.classList.add('is-open');
}
function closeMentionMenu(){ menu.classList.remove('is-open'); menu.innerHTML = ''; matches = []; }
function acceptMention(m){
  const caret = input.selectionStart;
  const before = input.value.slice(0, caret);
  const after = input.value.slice(caret);
  const newBefore = before.replace(/(?:^|\s)@([a-zA-Z0-9_]*)$/, match => (match.startsWith(' ') ? ' ' : '') + '@' + m.tag + ' ');
  input.value = newBefore + after;
  const pos = newBefore.length;
  input.setSelectionRange(pos, pos);
  closeMentionMenu();
  input.focus();
}

input.addEventListener('input', () => { autoGrow(); updateMentionMenu(); });
input.addEventListener('keydown', e => {
  if (!menu.classList.contains('is-open')){
    if (e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); sendMessage(input.value); }
    return;
  }
  if (e.key === 'ArrowDown'){ e.preventDefault(); selected = (selected + 1) % matches.length; renderMentionMenu(); }
  else if (e.key === 'ArrowUp'){ e.preventDefault(); selected = (selected - 1 + matches.length) % matches.length; renderMentionMenu(); }
  else if (e.key === 'Enter' || e.key === 'Tab'){ e.preventDefault(); acceptMention(matches[selected]); }
  else if (e.key === 'Escape'){ closeMentionMenu(); }
});
menu.addEventListener('mousedown', e => {
  const item = e.target.closest('.mention-item');
  if (!item) return;
  e.preventDefault();
  acceptMention(matches[+item.dataset.index]);
});
document.addEventListener('click', e => {
  if (!e.target.closest('.composer')) closeMentionMenu();
});

$('#composer').addEventListener('submit', e => { e.preventDefault(); sendMessage(input.value); });

/* ---------- mensagens interativas: menu, reply, copiar, selecionar ---------- */
let replyTarget = null;
let ctxMsg = null;

function setReplyTarget(msg){
  replyTarget = msg;
  $('#replyAuthor').textContent = nameFor(msg.node);
  $('#replyText').textContent = (msg.content || '').slice(0, 140);
  $('#replyBar').hidden = false;
  $('#messageInput').focus();
}
function cancelReply(){
  replyTarget = null;
  $('#replyBar').hidden = true;
}
function openCtxMenu(msg, x, y){
  ctxMsg = msg;
  const menu = $('#ctxMenu');
  menu.hidden = false;
  const hasAtt = !!msg.attFilename;
  $('#ctxCopyName').hidden = !hasAtt;
  $('#ctxCopyPath').hidden = !hasAtt;
  $('#ctxCopyMsg').textContent = hasAtt ? 'Copiar mensagem' : 'Copiar';
  const pad = 8;
  menu.style.left = Math.max(pad, Math.min(x, window.innerWidth - menu.offsetWidth - pad)) + 'px';
  menu.style.top = Math.max(pad, Math.min(y, window.innerHeight - menu.offsetHeight - pad)) + 'px';
  menu.querySelector('button:not([hidden])')?.focus();
}
function closeCtxMenu(){
  $('#ctxMenu').hidden = true;
  ctxMsg = null;
  document.body.classList.remove('no-select');
}

function readMsgFromDom(wrap){
  if (!wrap) return null;
  return {
    id: parseInt(wrap.dataset.messageId, 10) || null,
    node: wrap.dataset.messageNode || null,
    content: wrap.dataset.messageContent !== undefined ? wrap.dataset.messageContent : '',
    attFilename: wrap.dataset.attFilename || null,
    attUrl: wrap.dataset.attUrl || null,
  };
}

/* ---------- identidade visual central (nunca undefined/null/? para o usuário) ---------- */
function nameFor(node){
  const tag = TAG_OF[node] || 'linux';
  return DISPLAY[tag] || node || 'desconhecido';
}
function iconFor(node){
  const tag = TAG_OF[node] || 'linux';
  return ICONS[tag === 'you' ? 'person' : tag] || ICONS.person || '👤';
}
function modelFor(node){
  return MODELS[node] || '';
}

/* ---------- toast ---------- */
let toastTimer = null;
function showToast(text, isError = false){
  const t = $('#toast');
  t.textContent = text;
  t.classList.toggle('is-error', isError);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

$('#transcript').addEventListener('click', e => {
  // clique simples no corpo da mensagem → marca (seleciona) e abre o menu
  const wrap = e.target.closest('.msg');
  if (wrap && !e.target.closest('.msg-menu-btn') && !e.target.closest('.msg-quote') && !e.target.closest('a')) {
    e.stopPropagation();
    wrap.classList.toggle('selected');
    const msg = readMsgFromDom(wrap);
    if (msg) {
      const r = wrap.getBoundingClientRect();
      openCtxMenu(msg, e.clientX, r.top + r.height / 2);
    }
    return;
  }
  const btn = e.target.closest('.msg-menu-btn');
  if (btn) {
    e.stopPropagation();
    const msg = readMsgFromDom(btn.closest('.msg'));
    if (msg) {
      const r = btn.getBoundingClientRect();
      openCtxMenu(msg, r.right, r.bottom + 4);
    }
    return;
  }
  const quote = e.target.closest('.msg-quote');
  if (quote) {
    e.stopPropagation();
    const target = document.querySelector(`.msg[data-message-id="${quote.dataset.replyTo}"]`);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.classList.add('flash');
      setTimeout(() => target.classList.remove('flash'), 1600);
    }
  }
});

$('#transcript').addEventListener('contextmenu', e => {
  const wrap = e.target.closest('.msg');
  if (!wrap) return;
  e.preventDefault();
  const msg = readMsgFromDom(wrap);
  if (msg) openCtxMenu(msg, e.clientX, e.clientY);
});

let lpTimer = null;
let lpStart = null;
let suppressClick = false;
$('#transcript').addEventListener('touchstart', e => {
  const wrap = e.target.closest('.msg');
  if (!wrap) return;
  lpStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  // bloqueia seleção nativa DESDE o início do toque (não só após 500ms)
  document.body.classList.add('no-select');
  lpTimer = setTimeout(() => {
    clearTimeout(lpTimer);
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 1200);
    navigator.vibrate && navigator.vibrate(40);
    const msg = readMsgFromDom(wrap);
    if (msg) {
      const r = wrap.getBoundingClientRect();
      openCtxMenu(msg, e.touches[0].clientX, r.top + r.height / 2);
    }
  }, 500);
}, { passive: true });
$('#transcript').addEventListener('touchmove', e => {
  // micro-movimento (<10px) NÃO cancela o long-press; scroll real (>10px) cancela
  if (lpStart) {
    const dx = Math.abs(e.touches[0].clientX - lpStart.x);
    const dy = Math.abs(e.touches[0].clientY - lpStart.y);
    if (Math.hypot(dx, dy) > 10) { clearTimeout(lpTimer); lpStart = null; }
  }
}, { passive: true });
['touchend','touchcancel'].forEach(ev =>
  $('#transcript').addEventListener(ev, () => {
    clearTimeout(lpTimer);
    lpStart = null;
    document.body.classList.remove('no-select');
  }, { passive: true })
);

function copyToClipboard(text){
  return new Promise(resolve => {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => resolve(true)).catch(() => resolve(fallbackCopy(text)));
    } else {
      resolve(fallbackCopy(text));
    }
  });
}
function fallbackCopy(text){
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

$('#ctxMenu').addEventListener('click', e => {
  const act = e.target.closest('button')?.dataset.action;
  if (!act || !ctxMsg) return;
  if (act === 'reply') setReplyTarget(ctxMsg);
  else if (act === 'mention') {
    const input = $('#messageInput');
    input.value += (input.value && !input.value.endsWith(' ') ? ' ' : '') + '@' + ctxMsg.node + ' ';
    input.focus();
  } else if (act === 'copy' || act === 'copy-name' || act === 'copy-path') {
    const text = act === 'copy-name' ? ctxMsg.attFilename
      : act === 'copy-path' ? ctxMsg.attUrl
      : ctxMsg.content;
    copyToClipboard(text).then(ok => showToast(ok ? 'Copiado ✓' : 'Falha ao copiar', !ok));
  } else if (act === 'select') {
    const el = document.querySelector(`.msg[data-message-id="${ctxMsg.id}"]`);
    if (el) el.classList.toggle('selected');
  }
  closeCtxMenu();
});
document.addEventListener('click', e => {
  if (suppressClick) { suppressClick = false; return; } // click sintético pós-long-press
  if (!e.target.closest('#ctxMenu')) closeCtxMenu();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeCtxMenu(); });
$('#replyCancel').addEventListener('click', cancelReply);

/* ---------- busca (filtra mensagens na tela) ---------- */
$('#searchInput').addEventListener('input', e => {
  const q = e.target.value.toLowerCase();
  document.querySelectorAll('.msg').forEach(m => {
    m.style.display = m.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
});

/* ---------- pasta compartilhada ---------- */
const fmModal = $('#fileModal');
const CAT_LABEL = { image:'Imagem', video:'Vídeo', audio:'Áudio', pdf:'PDF', archive:'Compactado', spreadsheet:'Planilha', code:'Código', doc:'Documento', db:'Banco de dados', other:'Arquivo' };

const FM_ICONS = {
  image: '<svg viewBox="0 0 24 24"><defs><linearGradient id="gImg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4FC3F7"/><stop offset="1" stop-color="#1B7F4B"/></linearGradient></defs><rect x="2.5" y="3.5" width="19" height="17" rx="3" fill="url(#gImg)" opacity=".96"/><circle cx="8.6" cy="9" r="1.9" fill="#fff"/><path d="M3.5 18.5l4.6-4.6 3.4 3.4 3-3 5.5 5.5" stroke="#fff" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  video: '<svg viewBox="0 0 24 24"><defs><linearGradient id="gVid" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#B388FF"/><stop offset="1" stop-color="#6A3FB5"/></linearGradient></defs><rect x="2.5" y="4.5" width="15" height="15" rx="3" fill="url(#gVid)"/><path d="M17.5 10.2l4-2.4v8.4l-4-2.4" fill="#fff" opacity=".95"/><rect x="5" y="9.5" width="8" height="5" rx="1.2" fill="#fff" opacity=".35"/><circle cx="9" cy="12" r="1.1" fill="#fff"/></svg>',
  audio: '<svg viewBox="0 0 24 24"><defs><linearGradient id="gAud" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFD166"/><stop offset="1" stop-color="#E89A0C"/></linearGradient></defs><circle cx="12" cy="12" r="10.2" fill="url(#gAud)"/><path d="M9.6 16.6V8.6l6-1.1v7.4" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="8.1" cy="17" r="1.7" fill="#fff"/><circle cx="14.3" cy="15.2" r="1.7" fill="#fff"/><path d="M5.2 9.6c-.7 1.4-.7 3.4 0 4.8M18.8 9.6c.7 1.4.7 3.4 0 4.8" stroke="#fff" stroke-width="1.2" stroke-linecap="round" opacity=".65"/></svg>',
  pdf: '<svg viewBox="0 0 24 24"><defs><linearGradient id="gPdf" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FF7A7A"/><stop offset="1" stop-color="#C62A24"/></linearGradient></defs><path d="M5.5 2.8h8.2l4.8 4.8v12.6a1.6 1.6 0 0 1-1.6 1.6H5.5a1.6 1.6 0 0 1-1.6-1.6V4.4a1.6 1.6 0 0 1 1.6-1.6z" fill="url(#gPdf)"/><path d="M13.7 2.8v4.8h4.8" stroke="#fff" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/><rect x="7.4" y="11.2" width="8" height="1.35" rx=".67" fill="#fff" opacity=".92"/><rect x="7.4" y="14.4" width="6.2" height="1.35" rx=".67" fill="#fff" opacity=".7"/><rect x="7.4" y="17.4" width="4.4" height="1.35" rx=".67" fill="#fff" opacity=".5"/><circle cx="16.4" cy="16" r="3.2" fill="#fff"/><text x="13.1" y="17.9" font-size="3.6" font-family="Arial, sans-serif" font-weight="800" fill="#C62A24">PDF</text></svg>',
  archive: '<svg viewBox="0 0 24 24"><defs><linearGradient id="gZip" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7AA2FF"/><stop offset="1" stop-color="#2247C4"/></linearGradient></defs><rect x="3" y="7.5" width="18" height="13" rx="2.5" fill="url(#gZip)"/><path d="M6.5 7.5V5.8a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v1.7" stroke="#fff" stroke-width="1.5" fill="none" stroke-linecap="round"/><path d="M3 13h18" stroke="#fff" stroke-width="1.3" opacity=".55"/><path d="M10 13v-3h4v3M10 15.4v3h4v-3" stroke="#fff" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity=".9"/></svg>',
  spreadsheet: '<svg viewBox="0 0 24 24"><defs><linearGradient id="gSht" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4BD37B"/><stop offset="1" stop-color="#1E7B4F"/></linearGradient></defs><rect x="3.5" y="3" width="17" height="18" rx="2.5" fill="url(#gSht)"/><rect x="3.5" y="3" width="17" height="5.2" rx="2.5" fill="#fff" opacity=".25"/><path d="M3.5 8.2h17" stroke="#fff" stroke-width="1.2" opacity=".5"/><path d="M8.8 8.2v12.8M13.5 8.2v12.8M18 8.2v12.8M3.5 13h17M3.5 17.5h17" stroke="#fff" stroke-width="1.1" opacity=".75"/></svg>',
  code: '<svg viewBox="0 0 24 24"><defs><linearGradient id="gCode" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4DD8E6"/><stop offset="1" stop-color="#16707D"/></linearGradient></defs><rect x="2.5" y="4" width="19" height="16" rx="3" fill="url(#gCode)"/><path d="M9 8.5L5.5 12 9 15.5M15 8.5L18.5 12 15 15.5M13.2 7l-2.4 10" stroke="#fff" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  doc: '<svg viewBox="0 0 24 24"><defs><linearGradient id="gDoc" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#93A4B5"/><stop offset="1" stop-color="#4B5C6D"/></linearGradient></defs><path d="M5.5 2.8h8.2l4.8 4.8v12.6a1.6 1.6 0 0 1-1.6 1.6H5.5a1.6 1.6 0 0 1-1.6-1.6V4.4a1.6 1.6 0 0 1 1.6-1.6z" fill="url(#gDoc)"/><path d="M13.7 2.8v4.8h4.8" stroke="#fff" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/><rect x="7.4" y="11.6" width="8.6" height="1.35" rx=".67" fill="#fff" opacity=".92"/><rect x="7.4" y="14.8" width="6.6" height="1.35" rx=".67" fill="#fff" opacity=".7"/><rect x="7.4" y="17.8" width="4.8" height="1.35" rx=".67" fill="#fff" opacity=".5"/></svg>',
  other: '<svg viewBox="0 0 24 24"><defs><linearGradient id="gOth" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#AAB4C0"/><stop offset="1" stop-color="#5C6670"/></linearGradient></defs><path d="M5.5 2.8h8.2l4.8 4.8v12.6a1.6 1.6 0 0 1-1.6 1.6H5.5a1.6 1.6 0 0 1-1.6-1.6V4.4a1.6 1.6 0 0 1 1.6-1.6z" fill="url(#gOth)"/><path d="M13.7 2.8v4.8h4.8" stroke="#fff" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="9.3" cy="13" r="1.1" fill="#fff" opacity=".8"/><circle cx="12.4" cy="13" r="1.1" fill="#fff" opacity=".55"/><circle cx="15.5" cy="13" r="1.1" fill="#fff" opacity=".35"/></svg>',
  db: '<svg viewBox="0 0 24 24"><defs><linearGradient id="gDb" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#B79CFF"/><stop offset="1" stop-color="#7C4DDB"/></linearGradient></defs><ellipse cx="12" cy="5.6" rx="8.2" ry="3.3" fill="url(#gDb)"/><path d="M3.8 5.6v12.8c0 1.8 3.7 3.3 8.2 3.3s8.2-1.5 8.2-3.3V5.6" fill="url(#gDb)"/><path d="M3.8 12c0 1.8 3.7 3.3 8.2 3.3s8.2-1.5 8.2-3.3" fill="none" stroke="#fff" stroke-width="1.2" opacity=".8"/><ellipse cx="12" cy="5.6" rx="8.2" ry="3.3" fill="none" stroke="#fff" stroke-width="1" opacity=".45"/></svg>',
};

let fmFiles = [];
let fmBase = '';
let fmQuery = '';
let fmSort = 'date';
let fmDir = -1;

function fmtSize(b){
  if (b >= 1048576) return (b/1048576).toFixed(1).replace('.',',') + ' MB';
  if (b >= 1024) return (b/1024).toFixed(0) + ' KB';
  return b + ' B';
}
function fmtDate(ms){
  const d = new Date(ms);
  const dd = String(d.getDate()).padStart(2,'0');
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const hh = String(d.getHours()).padStart(2,'0');
  const mi = String(d.getMinutes()).padStart(2,'0');
  return `${dd}/${mm}/${d.getFullYear()} ${hh}:${mi}`;
}

function renderFiles(){
  const body = $('#fmBody');
  const q = fmQuery.toLowerCase();
  let list = fmFiles.filter(f =>
    f.name.toLowerCase().includes(q) ||
    (f.ext && f.ext.includes(q)) ||
    (CAT_LABEL[f.category] || '').toLowerCase().includes(q)
  );
  const dir = fmDir;
  list.sort((a, b) => {
    if (fmSort === 'name') return dir * a.name.localeCompare(b.name);
    if (fmSort === 'size') return dir * (a.size - b.size);
    if (fmSort === 'type') return dir * (CAT_LABEL[a.category].localeCompare(CAT_LABEL[b.category]) || a.name.localeCompare(b.name));
    return dir * (a.mtimeMs - b.mtimeMs);
  });
  $('#fmCount').textContent = list.length + (list.length === 1 ? ' arquivo' : ' arquivos');
  if (!list.length){
    body.innerHTML = '<div class="fm-empty">' + (q ? 'Nada encontrado para “' + escapeHTML(q) + '”' : 'Pasta vazia — envie algo com 📎 ou ⬆️') + '</div>';
    return;
  }
  body.innerHTML = `<div class="fm-dir">${escapeHTML(fmBase)}</div><div class="fm-grid">` +
    list.map(f => {
      const img = f.category === 'image'
        ? `<img class="fm-thumb" src="${f.url}" loading="lazy" alt="" onerror="this.remove()">`
        : '';
      const icon = img ? '' : `<div class="fm-ic">${FM_ICONS[f.category] || FM_ICONS.other}</div>`;
      const tag = (f.ext ? f.ext.toUpperCase() + ' · ' : '') + (CAT_LABEL[f.category] || 'Arquivo');
      return `
      <a class="fm-card cat-${f.category}" href="${f.url}" download target="_blank" title="${escapeHTML(f.name)}">
        <div class="fm-prev">${img}${icon}</div>
        <div class="fm-info">
          <div class="fm-name">${escapeHTML(f.name)}</div>
          <div class="fm-meta"><span>${fmtSize(f.size)}</span><span>${fmtDate(f.mtimeMs)}</span></div>
          <div class="fm-tag">${escapeHTML(tag)}</div>
        </div>
      </a>`;
    }).join('') + '</div>';
}

async function openFiles(){
  fmModal.classList.add('is-open');
  const body = $('#fmBody');
  body.innerHTML = '<div class="fm-empty">Carregando…</div>';
  try{
    const j = await fetch('/api/files').then(r => r.json());
    fmFiles = j.files || [];
    fmBase = j.base || '';
    renderFiles();
  }catch(e){
    body.innerHTML = '<div class="fm-empty">Erro ao listar: ' + escapeHTML(e.message) + '</div>';
  }
}

$('#btnFiles').addEventListener('click', openFiles);
$('#fmClose').addEventListener('click', () => fmModal.classList.remove('is-open'));
fmModal.addEventListener('click', e => { if (e.target === fmModal) fmModal.classList.remove('is-open'); });
$('#fmSearch').addEventListener('input', e => { fmQuery = e.target.value; renderFiles(); });
document.querySelectorAll('.fm-sort').forEach(btn => {
  btn.addEventListener('click', () => {
    const key = btn.dataset.sort;
    if (fmSort === key) fmDir = -fmDir;
    else { fmSort = key; fmDir = (key === 'name' || key === 'type') ? 1 : -1; }
    document.querySelectorAll('.fm-sort').forEach(b => { b.classList.toggle('is-on', b === btn); b.removeAttribute('data-arrow'); });
    btn.dataset.arrow = fmDir === 1 ? '↑' : '↓';
    renderFiles();
  });
});

async function compressImage(file, maxDim = 1280, quality = 0.7) {
  // Cria bitmap já redimensionado — evita alocar canvas gigante (limite de RAM do Chrome Android)
  if ('createImageBitmap' in window) {
    try {
      const bmp = await createImageBitmap(file, { resizeWidth: maxDim, resizeHeight: maxDim, resizeQuality: 'high' });
      const canvas = document.createElement('canvas');
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      canvas.getContext('2d').drawImage(bmp, 0, 0);
      bmp.close();
      return await new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
    } catch (e) { console.warn('createImageBitmap falhou, fallback canvas direto:', e.message); }
  }
  // Fallback: canvas direto (pode estourar RAM em fotos grandes)
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(img.src);
      const canvas = document.createElement('canvas');
      let { width, height } = img;
      if (width > height) { if (width > maxDim) { height *= maxDim/width; width = maxDim; } }
      else { if (height > maxDim) { width *= maxDim/height; height = maxDim; } }
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      canvas.toBlob(b => resolve(b), 'image/jpeg', quality);
    };
    img.onerror = () => reject(new Error('Falha ao carregar imagem'));
    img.src = URL.createObjectURL(file);
  });
}

async function doUpload(file){
  if (!file) return;
  let uploadFile = file;
  if (file.type.startsWith('image/')) {
    try {
      const compressed = await compressImage(file);
      uploadFile = new File([compressed], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' });
      console.log(`[Upload] Comprimido: ${(file.size/1024).toFixed(0)}KB → ${(uploadFile.size/1024).toFixed(0)}KB`);
    } catch (e) { console.warn('[Upload] Falha ao comprimir, enviando original:', e.message); }
  }
  const fd = new FormData();
  fd.append('file', uploadFile);
  fd.append('sender', 'fabio');
  const r = await fetch('/api/upload', { method:'POST', body:fd });
  const j = await r.json();
  if (j.ok){
    appendMessageDOM({ ...j.message, att_filename: j.attachment.filename, att_original_name: j.attachment.original_name, att_mime: j.attachment.mime_type, att_size: j.attachment.size_bytes });
    openFiles();
  } else {
    alert('Erro no upload: ' + (j.error || 'desconhecido'));
  }
}

$('#fileInput').addEventListener('change', e => { 
  const file = e.target.files[0]; 
  e.target.value = ''; 
  if (file && file.type.startsWith('image/')) {
    pendingImage = { file, previewUrl: URL.createObjectURL(file) };
    renderComposerPreview();
    $('#messageInput').focus();
  } else if (file) {
    // Não-imagem: envia direto
    doUpload(file);
  }
});
$('#fileInput2').addEventListener('change', e => { 
  const file = e.target.files[0]; 
  e.target.value = ''; 
  if (file && file.type.startsWith('image/')) {
    pendingImage = { file, previewUrl: URL.createObjectURL(file) };
    renderComposerPreview();
    $('#messageInput').focus();
  } else if (file) {
    doUpload(file);
  }
});
$('#fileInput3').addEventListener('change', e => { 
  const file = e.target.files[0]; 
  e.target.value = ''; 
  if (file && file.type.startsWith('image/')) {
    pendingImage = { file, previewUrl: URL.createObjectURL(file) };
    renderComposerPreview();
    $('#messageInput').focus();
  } else if (file) {
    doUpload(file);
  }
});

/* ---------- websocket com reconexão automática ---------- */
let ws = null;
let wsRetry = 0;
let currentSession = null;

function handleWsMessage(ev) {
  const m = JSON.parse(ev.data);
  switch (m.type){
    case 'presence':
      renderRoster(m.nodes);
      m.nodes.forEach(n => { MODELS[n.name] = n.model; });
      break;
    case 'message':
      // mensagem final do streaming: converte o balão existente (nunca duplica)
      if (m.message && m.message.stream_id && finalizeStreamAsMessage(m.message)) {
        setActiveNode(TAG_OF[m.message.node] || 'linux');
      } else {
        appendMessageDOM(m.message);
        setActiveNode(TAG_OF[m.message.node] || 'linux');
      }
      break;
    case 'system':
      appendMessageDOM({ node:'system', content:m.text, type:'system' });
      break;
    case 'agent_status':
      updateAgentStatus(m);
      break;
    case 'error':
      showToast(m.error || 'erro', true);
      break;
    case 'typing':
      if (m.active) typingNodes.add(m.node); else typingNodes.delete(m.node);
      updateTyping();
      break;
    case 'stream_start': streamStart(m); break;
    case 'stream_chunk': streamChunk(m); break;
    case 'stream_end': streamEnd(m); break;
  }
}

function connectWs(){
  ws = new WebSocket(wsUrl);
  ws.onopen = () => {
    wsRetry = 0;
    loadMessages();
    refresh();
  };
  ws.onmessage = handleWsMessage;
  ws.onclose = async () => {
    // sessão morreu? (ex: servidor reiniciou) → mostra login e PARA o loop
    const r = await fetch('/api/session').catch(() => null);
    if (!r || r.status === 401) { showLogin(); return; }
    wsRetry++;
    const delay = Math.min(1000 * Math.pow(2, wsRetry), 30000);
    setTimeout(connectWs, delay);
  };
  ws.onerror = () => ws.close();
}

function showLogin(){
  $('#loginOverlay').hidden = false;
  if (ws) { try { ws.close(); } catch {} }
}

/* ---------- sessão / login ---------- */
async function ensureSession(){
  try {
    const r = await fetch('/api/session');
    if (r.ok){ currentSession = await r.json(); return true; }
  } catch {}
  return false;
}

async function doLogin(){
  const token = $('#loginToken').value.trim();
  const node = $('#loginNode').value;
  const err = $('#loginErr');
  err.hidden = true;
  if (!token){ err.textContent = 'Digite o token.'; err.hidden = false; return; }
  try {
    const r = await fetch('/api/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ token, node }) });
    if (r.ok){ location.reload(); return; }
    const j = await r.json().catch(() => ({}));
    err.textContent = j.error || 'Token inválido.';
    err.hidden = false;
  } catch {
    err.textContent = 'Falha ao conectar com o servidor.';
    err.hidden = false;
  }
}
$('#loginBtn').addEventListener('click', doLogin);
$('#loginToken').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

/* ---------- boot: autentica primeiro, depois conecta ---------- */
async function boot(){
  const ok = await ensureSession();
  if (!ok){ showLogin(); return; }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  connectWs();
  loadMessages();
  refresh();
}
boot();

/* ---------- refresh periódico (só sidebar/telemetria — NÃO mexe nas mensagens) ---------- */
async function refresh(){
  try{
    const st = await fetch('/api/status').then(r => r.json());
    renderRoster(st.nodes);
    st.nodes.forEach(n => { MODELS[n.name] = n.model; });
    renderTasks(st.tasks || []);
    renderTelemetry(st.system, st.totalMessages);
  }catch(e){ console.error('refresh', e); }
}

/* ---------- lightbox ---------- */
function openLightbox(src){
  const lb = $('#lightbox');
  const img = $('#lightbox-img');
  img.src = src;
  img.onload = () => { lb.hidden = false; };
  img.onerror = () => { lb.hidden = true; };
}
$('#lb-close').addEventListener('click', () => $('#lightbox').hidden = true);

setInterval(refresh, 15000);
refresh();