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