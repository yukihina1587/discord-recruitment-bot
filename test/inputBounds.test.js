import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import * as poll from '../commands/poll.js';
import * as recruit from '../commands/recruit.js';

async function isolateData(t) {
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = await mkdtemp(join(tmpdir(), 'discord-bot-input-'));
  t.after(() => {
    if (previous === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous;
  });
}

test('poll rejects oversized questions and options', async (t) => {
  await isolateData(t);
  poll.init();
  const replies = [];
  await poll.execute({
    guildId: 'guild',
    options: {
      getString: (name) => (name === '質問' ? 'q'.repeat(257) : `ok,${'x'.repeat(81)}`),
    },
    reply: async (payload) => replies.push(payload),
  });

  assert.equal(replies.length, 1);
  assert.equal(replies[0].ephemeral, true);
});

test('poll rejects more than five choices instead of silently truncating', async (t) => {
  await isolateData(t);
  poll.init();
  const replies = [];
  await poll.execute({
    guildId: 'guild',
    options: {
      getString: (name) => (name === '質問' ? 'いつ？' : '1,2,3,4,5,6'),
    },
    reply: async (payload) => replies.push(payload),
  });

  assert.equal(replies.length, 1);
  assert.equal(replies[0].ephemeral, true);
});

test('recruit rejects oversized text even if Discord-side validation is bypassed', async (t) => {
  await isolateData(t);
  await recruit.init(
    { channels: { fetch: async () => null } },
    { createPrivateVoiceChannels: false, mentionHere: false },
  );
  const replies = [];
  await recruit.execute({
    guildId: 'guild',
    channelId: 'channel',
    user: { id: 'host' },
    options: {
      getString: (name) => (name === 'ゲーム' ? 'x'.repeat(101) : null),
      getInteger: (name) => (name === 'あと何人' ? 2 : null),
    },
    reply: async (payload) => replies.push(payload),
  });

  assert.equal(replies.length, 1);
  assert.equal(replies[0].ephemeral, true);
});

test('recruit modal requires a bounded strict integer', async (t) => {
  await isolateData(t);
  await recruit.init(
    { channels: { fetch: async () => null } },
    { createPrivateVoiceChannels: false, mentionHere: false },
  );
  await recruit.execute({
    guildId: 'guild',
    channelId: 'channel',
    user: { id: 'host' },
    options: {
      getString: (name) => (name === 'ゲーム' ? 'Apex' : null),
      getInteger: (name) => (name === 'あと何人' ? 2 : null),
    },
    reply: async () => ({ resource: { message: { id: 'message' } } }),
  });

  for (const value of ['2abc', '51']) {
    const replies = [];
    await recruit.handleModal({
      guildId: 'guild',
      customId: 'recruit_addmore_modal',
      message: { id: 'message' },
      user: { id: 'host' },
      fields: { getTextInputValue: () => value },
      reply: async (payload) => replies.push(payload),
    });
    assert.equal(replies.length, 1);
    assert.equal(replies[0].ephemeral, true);
  }
});
