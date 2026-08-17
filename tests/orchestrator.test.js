import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../orchestrator.js';
import { POLICY } from '../orchestrator.js';

test('parseCommand: @linux direciona para linux', () => {
  const r = parseCommand('@linux faça X');
  assert.equal(r.target, 'linux');
  assert.equal(r.prompt, 'faça X');
});

test('parseCommand: @auto direciona para auto', () => {
  const r = parseCommand('@auto analise os logs');
  assert.equal(r.target, 'auto');
  assert.equal(r.prompt, 'analise os logs');
});

test('parseCommand: case-insensitive', () => {
  assert.equal(parseCommand('@WINDOWS teste').target, 'windows');
  assert.equal(parseCommand('@Todos teste').target, 'todos');
});

test('parseCommand: sem menção vira conversa normal', () => {
  const r = parseCommand('olá pessoal');
  assert.equal(r.target, 'chat');
  assert.equal(r.prompt, 'olá pessoal');
});

test('parseCommand: @status sem prompt', () => {
  const r = parseCommand('@status');
  assert.equal(r.target, 'status');
  assert.equal(r.prompt, '');
});

test('política: limites definidos e coerentes', () => {
  assert.equal(POLICY.MAX_QUEUE, 50);
  assert.equal(POLICY.MAX_OPS_PER_MIN, 10);
  assert.equal(POLICY.MAX_TASK_MS, 10 * 60 * 1000);
  assert.equal(POLICY.MAX_DELEGATIONS, 5);
  assert.equal(POLICY.MAX_CHARS_TRANSFER, 4000);
  assert.ok(POLICY.MIN_FREE_MEM_GB > 0);
});