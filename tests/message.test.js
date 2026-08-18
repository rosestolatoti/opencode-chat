import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMessage, MAX_MESSAGE_CHARS } from '../lib/util.js';

test('normalizeMessage: rejeita vazia, espaços e acima do limite', () => {
  assert.throws(() => normalizeMessage(''), /vazia/);
  assert.throws(() => normalizeMessage('   \n\t  '), /vazia/);
  assert.throws(() => normalizeMessage(undefined), /vazia/);
  assert.throws(() => normalizeMessage(null), /vazia/);
  assert.equal(normalizeMessage('  olá mundo  '), 'olá mundo');
  assert.equal(normalizeMessage('x'.repeat(MAX_MESSAGE_CHARS)), 'x'.repeat(MAX_MESSAGE_CHARS));
  assert.throws(() => normalizeMessage('x'.repeat(MAX_MESSAGE_CHARS + 1)), /muito longa/);
});

test('MAX_MESSAGE_CHARS é 64KB', () => {
  assert.equal(MAX_MESSAGE_CHARS, 65536);
});

test('normalizeMessage: remove null bytes e controles (não quebram spawn)', () => {
  assert.equal(normalizeMessage('a\u0000b'), 'ab');
  assert.equal(normalizeMessage('\u0001\u0002x\u007F'), 'x');
  assert.equal(normalizeMessage('linha1\nlinha2\ttab\r'), 'linha1\nlinha2\ttab');
  assert.equal(normalizeMessage('\u0000\u0000só espaços depois\u0000'), 'só espaços depois');
  assert.throws(() => normalizeMessage('\u0000\u0000'), /vazia/);
});