import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { load, save } from '../lib/store.js';

const execFileAsync = promisify(execFile);

async function directorySnapshot(directory) {
  try {
    return await readdir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

test('store writes to DATA_DIR', async (t) => {
  const original = process.env.DATA_DIR;
  const directory = await mkdtemp(join(tmpdir(), 'discord-bot-store-'));
  process.env.DATA_DIR = directory;
  t.after(() => {
    if (original === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = original;
  });

  assert.equal(save('polls', { ok: true }), true);
  assert.deepEqual(load('polls'), { ok: true });
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'polls.json'), 'utf8')), {
    ok: true,
  });
});

test('store rejects traversal and unsafe names', () => {
  for (const name of ['../secret', 'nested/file', '.', '', 'polls.tmp']) {
    assert.throws(() => load(name), /safe store name/);
    assert.throws(() => save(name, {}), /safe store name/);
  }
});

test('process-level DATA_DIR leaves workspace data untouched', async () => {
  const workspaceData = new URL('../data/', import.meta.url);
  const beforeFiles = await directorySnapshot(workspaceData);
  const directory = await mkdtemp(join(tmpdir(), 'discord-bot-process-store-'));

  await execFileAsync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      "import { save } from './lib/store.js'; if (!save('probe', { isolated: true })) process.exit(1)",
    ],
    {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, DATA_DIR: directory },
    },
  );

  assert.deepEqual(await directorySnapshot(workspaceData), beforeFiles);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'probe.json'), 'utf8')), {
    isolated: true,
  });
});

test('malformed JSON fails closed instead of returning fallback data', async (t) => {
  const original = process.env.DATA_DIR;
  const directory = await mkdtemp(join(tmpdir(), 'discord-bot-corrupt-store-'));
  process.env.DATA_DIR = directory;
  t.after(() => {
    if (original === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = original;
  });
  const path = join(directory, 'polls.json');
  await writeFile(path, '{"polls":', 'utf8');

  assert.throws(() => load('polls', { polls: {} }), /failed to read store/i);
  assert.equal(await readFile(path, 'utf8'), '{"polls":');
});
