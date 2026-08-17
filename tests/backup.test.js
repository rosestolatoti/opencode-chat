import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function runBackup(base) {
  return execFileSync('bash', [path.join(ROOT, 'scripts', 'backup.sh')], {
    env: { ...process.env, NEXUS_BASE_DIR: base },
    encoding: 'utf8',
  });
}

test('backup duplo consecutivo funciona e retenção mantém 7', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-bak-'));
  try {
    // banco fake
    execFileSync('sqlite3', [path.join(base, 'nexus.db'), 'CREATE TABLE t(x); INSERT INTO t VALUES (1),(2);']);
    const out1 = runBackup(base);
    const out2 = runBackup(base);
    assert.ok(out1.includes('backup ok'), '1º backup');
    assert.ok(out2.includes('backup ok'), '2º backup consecutivo (sem colisão de timestamp)');
    const backups = fs.readdirSync(path.join(base, 'backups')).filter(f => f.endsWith('.db'));
    assert.equal(backups.length, 2, 'dois arquivos distintos');

    // 9 backups antigos falsos + rodar → retenção de 7
    for (let i = 0; i < 9; i++) {
      fs.writeFileSync(path.join(base, 'backups', `nexus_2026080${i}_000000_000000000.db`), 'falso');
    }
    runBackup(base);
    const after = fs.readdirSync(path.join(base, 'backups')).filter(f => f.endsWith('.db'));
    assert.ok(after.length <= 7, `retenção: ${after.length} <= 7`);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('restore do backup em banco separado (produção intocada)', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-rst-'));
  try {
    execFileSync('sqlite3', [path.join(base, 'nexus.db'), 'CREATE TABLE messages(id INTEGER PRIMARY KEY, content TEXT); INSERT INTO messages VALUES (1,"a"),(2,"b"),(3,"c");']);
    runBackup(base);
    const backup = fs.readdirSync(path.join(base, 'backups')).find(f => f.endsWith('.db'));
    const restore = path.join(base, 'restored.db');
    execFileSync('sqlite3', [backup && path.join(base, 'backups', backup), `.backup '${restore}'`]);
    const count = execFileSync('sqlite3', [restore, 'SELECT COUNT(*) FROM messages;'], { encoding: 'utf8' }).trim();
    assert.equal(count, '3', 'restore completo em banco separado');
    const prodCount = execFileSync('sqlite3', [path.join(base, 'nexus.db'), 'SELECT COUNT(*) FROM messages;'], { encoding: 'utf8' }).trim();
    assert.equal(prodCount, '3', 'produção intacta');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});