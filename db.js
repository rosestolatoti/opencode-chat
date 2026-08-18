import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { DB_PATH, LINUX_IP, WINDOWS_IP, ANDROID_IP } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node TEXT NOT NULL,
    role TEXT DEFAULT 'agent',
    content TEXT NOT NULL,
    type TEXT DEFAULT 'text',
    stream_complete INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS nodes (
    name TEXT PRIMARY KEY,
    display_name TEXT,
    role TEXT,
    os TEXT,
    tailscale_ip TEXT,
    last_seen DATETIME,
    online INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_node TEXT NOT NULL,
    to_node TEXT NOT NULL,
    action TEXT NOT NULL,
    payload TEXT,
    status TEXT DEFAULT 'pending',
    result TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME
);
CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER REFERENCES messages(id),
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type TEXT,
    size_bytes INTEGER,
    width INTEGER,
    height INTEGER,
    pages INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, content='messages', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
END;
`);

try { db.exec('ALTER TABLE nodes ADD COLUMN model TEXT'); } catch { /* já existe */ }
try { db.exec('ALTER TABLE messages ADD COLUMN reply_to INTEGER'); } catch { /* já existe */ }

const nodes = [
  ['linux', 'PC-LINUX', 'subchief', 'linux', LINUX_IP, 'Deepseek v4 Flash'],
  ['windows', 'NOTEBOOK-WINDOWS', 'agent', 'windows', WINDOWS_IP, 'Big Pickle (fallback: Deepseek v4 Flash)'],
  ['android', 'CELULAR-ANDROID', 'viewer', 'android', ANDROID_IP, 'Claude Opus (futuro)'],
  ['fabio', 'FABIO ROSESTOLATO', 'leader', 'human', '', 'Líder humano'],
];

const upsertNode = db.prepare(`
  INSERT INTO nodes (name, display_name, role, os, tailscale_ip, model)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(name) DO UPDATE SET
    display_name=excluded.display_name, role=excluded.role,
    os=excluded.os, tailscale_ip=excluded.tailscale_ip, model=excluded.model
`);
for (const n of nodes) upsertNode.run(...n);

const MSG_SELECT = `
  SELECT m.*, a.filename AS att_filename, a.original_name AS att_original_name,
         a.mime_type AS att_mime, a.size_bytes AS att_size,
         ('/uploads/' || a.filename) AS att_url,
         r.node AS reply_node, substr(r.content, 1, 140) AS reply_preview
  FROM messages m
  LEFT JOIN attachments a ON a.message_id = m.id
  LEFT JOIN messages r ON r.id = m.reply_to`;

export function getMessageById(id) {
  return db.prepare(`${MSG_SELECT} WHERE m.id = ?`).get(id);
}

export function getMessages({ since = 0, limit = 100 } = {}) {
  return db.prepare(
    `${MSG_SELECT} WHERE m.id > ? ORDER BY m.id DESC LIMIT ?`
  ).all(since, limit).reverse();
}

export function addMessage({ node, role = 'agent', content, type = 'text', streamComplete = 1, replyTo = null }) {
  const info = db.prepare(
    'INSERT INTO messages (node, role, content, type, stream_complete, reply_to) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(node, role, content, type, streamComplete ? 1 : 0, Number.isInteger(replyTo) && replyTo > 0 ? replyTo : null);
  return getMessageById(info.lastInsertRowid);
}

export function searchMessages(term, { node, type, limit = 50 } = {}) {
  let sql = `SELECT m.*, a.filename AS att_filename, a.original_name AS att_original_name,
                    a.mime_type AS att_mime, a.size_bytes AS att_size,
                    r.node AS reply_node, substr(r.content, 1, 140) AS reply_preview,
                    bm25(messages_fts) AS rank
             FROM messages_fts
             JOIN messages m ON m.id = messages_fts.rowid
             LEFT JOIN attachments a ON a.message_id = m.id
             LEFT JOIN messages r ON r.id = m.reply_to
             WHERE messages_fts MATCH ?`;
  const params = [];
  const esc = term.replace(/["*]/g, ' ').trim().split(/\s+/).map(w => `"${w}"`).join(' AND ');
  params.push(esc || `"${term}"`);
  if (node) { sql += ' AND m.node = ?'; params.push(node); }
  if (type) { sql += ' AND m.type = ?'; params.push(type); }
  sql += ' ORDER BY rank LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params);
}

export function setNodeOnline(name, online) {
  db.prepare('UPDATE nodes SET online = ?, last_seen = CURRENT_TIMESTAMP WHERE name = ?')
    .run(online ? 1 : 0, name);
}

export function getNodes() {
  return db.prepare('SELECT * FROM nodes ORDER BY name').all();
}

export function addTask({ from, to, action, payload }) {
  const info = db.prepare(
    'INSERT INTO tasks (from_node, to_node, action, payload) VALUES (?, ?, ?, ?)'
  ).run(from, to, action, JSON.stringify(payload ?? {}));
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(info.lastInsertRowid);
}

export function getTasks(status) {
  const rows = db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY id').all(status);
  return rows.map(r => ({ ...r, payload: JSON.parse(r.payload || '{}') }));
}

export function updateTask(id, { status, result }) {
  db.prepare(
    `UPDATE tasks SET status = ?, result = ?, completed_at = CASE WHEN ? = 'done' OR ? = 'failed' THEN CURRENT_TIMESTAMP ELSE completed_at END WHERE id = ?`
  ).run(status, result ?? '', status, status, id);
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

export function taskStats() {
  return db.prepare(
    "SELECT status, COUNT(*) AS n FROM tasks GROUP BY status"
  ).all();
}

export function addAttachment({ messageId, filename, originalName, mimeType, sizeBytes }) {
  const info = db.prepare(
    'INSERT INTO attachments (message_id, filename, original_name, mime_type, size_bytes) VALUES (?, ?, ?, ?, ?)'
  ).run(messageId, filename, originalName, mimeType, sizeBytes);
  return db.prepare('SELECT * FROM attachments WHERE id = ?').get(info.lastInsertRowid);
}

export function systemStats() {
  const total = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
  const nodesStats = getNodes().map(n => ({ ...n }));
  return { totalMessages: total, nodes: nodesStats };
}

export default db;