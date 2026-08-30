import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { requireId, requireSecret } from '../lib/env.js';

test('requireSecret reads a direct environment value', () => {
  assert.equal(requireSecret('TOKEN', { TOKEN: ' secret ' }), 'secret');
});

test('requireSecret reads a mounted secret file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'discord-bot-test-'));
  const file = join(dir, 'token');
  try {
    writeFileSync(file, 'file-secret\n', { mode: 0o600 });
    assert.equal(requireSecret('TOKEN', { TOKEN_FILE: file }), 'file-secret');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('requireSecret rejects ambiguous and missing configuration', () => {
  assert.throws(
    () => requireSecret('TOKEN', { TOKEN: 'one', TOKEN_FILE: '/unused' }),
    /同時に設定できません/,
  );
  assert.throws(() => requireSecret('TOKEN', {}), /設定されていません/);
});

test('requireId accepts Discord snowflakes and rejects other values', () => {
  assert.equal(requireId('CLIENT_ID', { CLIENT_ID: '12345678901234567' }), '12345678901234567');
  assert.throws(() => requireId('CLIENT_ID', { CLIENT_ID: 'not-an-id' }), /Discord ID/);
});
