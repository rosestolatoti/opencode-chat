import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { fileCategory, fileCategoryType, parseCookies, resolveInside, truncateText, parseJsonBody, extractMentions, stripMentions } from '../lib/util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('fileCategory: classifica extensões nas pastas certas', () => {
  assert.equal(fileCategory('foto.jpg'), 'fotos');
  assert.equal(fileCategory('planilha.xlsx'), 'documentos');
  assert.equal(fileCategory('projeto.zip'), 'projetos');
  assert.equal(fileCategory('script.sh'), 'projetos');
  assert.equal(fileCategory('coisa.desconhecida_xyz'), 'outros');
  assert.equal(fileCategory('SEMEXTENSAO'), 'outros');
});

test('fileCategoryType: categorias de exibição', () => {
  assert.equal(fileCategoryType('a.png'), 'image');
  assert.equal(fileCategoryType('a.mp4'), 'video');
  assert.equal(fileCategoryType('a.mp3'), 'audio');
  assert.equal(fileCategoryType('a.pdf'), 'pdf');
  assert.equal(fileCategoryType('a.zip'), 'archive');
  assert.equal(fileCategoryType('a.js'), 'code');
  assert.equal(fileCategoryType('a.xyz_estranho'), 'other');
});

test('parseCookies: parseia header de cookie', () => {
  assert.deepEqual(parseCookies('a=1; b=2'), { a: '1', b: '2' });
  assert.deepEqual(parseCookies(''), {});
  assert.equal(parseCookies('nexus_session=abc123').nexus_session, 'abc123');
});

test('resolveInside: bloqueia path traversal', () => {
  const base = path.join(os.tmpdir(), 'nexus-test-upload-' + Date.now());
  fs.mkdirSync(base, { recursive: true });
  assert.ok(resolveInside(base, 'fotos/gato.jpg') !== null);
  assert.equal(resolveInside(base, '../../etc/passwd'), null);
  assert.equal(resolveInside(base, 'fotos/../../../etc/passwd'), null);
  assert.equal(resolveInside('/caminho/que/nao/existe', 'x'), null);
  fs.rmSync(base, { recursive: true, force: true });
});

test('truncateText: limita e avisa quando corta', () => {
  assert.equal(truncateText('abc', 10), 'abc');
  const out = truncateText('x'.repeat(100), 20);
  assert.ok(out.length < 100);
  assert.ok(out.includes('truncado'));
});

test('parseJsonBody: aceita JSON válido e rejeita inválido/grande', () => {
  assert.deepEqual(parseJsonBody('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonBody(''), {});
  assert.throws(() => parseJsonBody('{quebrado'), /JSON inválido/);
  assert.throws(() => parseJsonBody(JSON.stringify({ big: 'x'.repeat(2000) }), 100), /corpo muito grande/);
});
test('extractMentions: detecta menções em QUALQUER posição e múltiplas', () => {
  assert.deepEqual(extractMentions('@linux analise o pdf'), ['linux']);
  assert.deepEqual(extractMentions('Confira as páginas 12-18. @linux analise'), ['linux'], 'menção no meio');
  assert.deepEqual(extractMentions('Veja isso @windows'), ['windows'], 'menção no fim');
  assert.deepEqual(extractMentions('PDF + @linux + @windows + @linux'), ['linux', 'windows'], 'múltiplas sem duplicar');
  assert.deepEqual(extractMentions('analise @Linux e @WINDOWS'), ['linux', 'windows'], 'case-insensitive');
  assert.deepEqual(extractMentions('texto sem menção'), []);
  assert.deepEqual(extractMentions(''), []);
  assert.deepEqual(extractMentions('email@linux.com'), [], 'não confunde email');
});

test('stripMentions: remove menções e normaliza espaços', () => {
  assert.equal(stripMentions('Confira as páginas 12-18. @linux analise'), 'Confira as páginas 12-18. analise');
  assert.equal(stripMentions('@linux @windows valide'), 'valide');
  assert.equal(stripMentions('sem menção aqui'), 'sem menção aqui');
});

test('fileCategoryType: banco de dados e demais extensões', () => {
  assert.equal(fileCategoryType('dados.db'), 'db');
  assert.equal(fileCategoryType('planilha.xlsx'), 'spreadsheet');
  assert.equal(fileCategoryType('dados.csv'), 'spreadsheet');
  assert.equal(fileCategoryType('documento.docx'), 'doc');
  assert.equal(fileCategoryType('notas.md'), 'code');
  assert.equal(fileCategoryType('site.html'), 'code');
});
