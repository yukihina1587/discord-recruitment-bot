import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import * as list from '../commands/list.js';
import * as recruit from '../commands/recruit.js';
import { sanitizeDiscordMarkdownText } from '../lib/discordText.js';
import { save } from '../lib/store.js';

const DANGEROUS_GAME = '[game](https://evil.example)\u202E\u2066\u200B @everyone';
const DANGEROUS_TIME = '[time](https://time.example)\u202D\u200B @here';
const INVISIBLE_OR_BIDI = /[\u061c\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

async function isolateData(t) {
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = await mkdtemp(join(tmpdir(), 'discord-bot-markdown-safety-'));
  t.after(() => {
    if (previous === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous;
  });
}

function dangerousState(overrides = {}) {
  return {
    messageId: 'message',
    channelId: 'channel',
    guildId: 'guild',
    game: DANGEROUS_GAME,
    time: DANGEROUS_TIME,
    capacity: 2,
    hostId: 'host',
    members: ['member'],
    waitlist: [],
    vcId: null,
    closed: false,
    closedReason: null,
    createdAt: Date.now(),
    autoCloseEnabled: false,
    closeAt: null,
    closeText: null,
    startAt: null,
    startText: null,
    startTimeZone: null,
    reminderLeadMinutes: null,
    reminderSentAt: null,
    reminderLastAttemptAt: null,
    ...overrides,
  };
}

function assertUntrustedMarkdownNeutralized(value) {
  assert.doesNotMatch(value, /(?<!\\)\]\(/u);
  assert.doesNotMatch(value, /@everyone|@here/u);
  assert.doesNotMatch(value, INVISIBLE_OR_BIDI);
}

test('sanitizer escapes line-leading Markdown controls without mangling ordinary punctuation', () => {
  const cases = [
    ['# heading', '\\# heading'],
    ['- item', '\\- item'],
    ['+ item', '\\+ item'],
    ['1. item', '1\\. item'],
    ['> quote', '\\> quote'],
    ['-# text', '\\-# text'],
    ['-#', '\\-#'],
  ];
  for (const [input, expected] of cases) {
    const sanitized = sanitizeDiscordMarkdownText(input, { maxLength: 100 });
    assert.equal(sanitized, expected);
    assert.equal(sanitized.replace('\\', ''), input);
  }
  assert.equal(
    sanitizeDiscordMarkdownText('R.E.P.O. co-op', { maxLength: 100 }),
    'R.E.P.O. co-op',
  );
  assert.equal(
    sanitizeDiscordMarkdownText('game-#tag', { maxLength: 100 }),
    'game-#tag',
  );
  assert.equal(
    sanitizeDiscordMarkdownText('-#not-subtext', { maxLength: 100 }),
    '-#not-subtext',
  );
});

test('recruitment card neutralizes untrusted game/time Markdown while preserving bot mentions', async (t) => {
  await isolateData(t);
  save('recruits', {
    schemaVersion: 4,
    recruits: { message: dangerousState() },
    vcChannels: [],
  });
  const edits = [];
  await recruit.init({
    channels: {
      fetch: async () => ({
        messages: { fetch: async () => ({ edit: async (payload) => edits.push(payload) }) },
      }),
    },
  }, { createPrivateVoiceChannels: false, mentionHere: false });

  const embed = edits.at(-1).embeds[0].data;
  const timeField = embed.fields.find((field) => field.name === '⏰ 時間');
  assertUntrustedMarkdownNeutralized(embed.title);
  assertUntrustedMarkdownNeutralized(timeField.value);
  assert.match(embed.fields.find((field) => field.name === '👑 主催者').value, /<@host>/);
  assert.ok(embed.title.length <= 256);
  assert.ok(timeField.value.length <= 1_024);
});

test('/募集一覧 neutralizes user Markdown while preserving its fixed link, host mention, and timestamp', async (t) => {
  await isolateData(t);
  const closeAt = Date.now() + 30 * 60_000;
  save('recruits', {
    schemaVersion: 4,
    recruits: {
      message: dangerousState({ autoCloseEnabled: true, closeAt, closeText: '30分後' }),
    },
    vcChannels: [],
  });
  await recruit.init({
    channels: {
      fetch: async () => ({
        messages: { fetch: async () => ({ edit: async () => {} }) },
      }),
    },
  }, { createPrivateVoiceChannels: false, mentionHere: false });
  const replies = [];

  await list.execute({ guildId: 'guild', reply: async (payload) => replies.push(payload) });

  const description = replies[0].embeds[0].data.description;
  assert.equal([...description.matchAll(/(?<!\\)\]\(/gu)].length, 1);
  assert.match(description, /\[募集を開く\]\(https:\/\/discord\.com\/channels\/guild\/channel\/message\)/u);
  assert.match(description, /<@host>/u);
  assert.match(description, new RegExp(`<t:${Math.floor(closeAt / 1_000)}:R>`));
  assert.doesNotMatch(description, /@everyone|@here/u);
  assert.doesNotMatch(description, INVISIBLE_OR_BIDI);
  assert.ok(description.length <= 4_096);
});

test('collection notification neutralizes untrusted game Markdown but preserves participant mentions', async (t) => {
  await isolateData(t);
  save('recruits', {
    schemaVersion: 4,
    recruits: { message: dangerousState() },
    vcChannels: [],
  });
  const sends = [];
  await recruit.init({
    channels: {
      fetch: async () => ({
        messages: { fetch: async () => ({ edit: async () => {} }) },
        send: async (payload) => sends.push(payload),
      }),
    },
  }, { createPrivateVoiceChannels: false, mentionHere: false });

  await recruit.handleButton({
    guildId: 'guild',
    customId: 'recruit_close',
    message: { id: 'message' },
    user: { id: 'host' },
    update: async () => {},
    followUp: async () => {},
  });

  assert.equal(sends.length, 1);
  assertUntrustedMarkdownNeutralized(sends[0].content);
  assert.match(sends[0].content, /<@host>/u);
  assert.match(sends[0].content, /<@member>/u);
  assert.deepEqual(sends[0].allowedMentions, { users: ['host', 'member'] });
  assert.ok(sends[0].content.length <= 2_000);
});

test('invisible-only game/time use safe nonempty fallbacks in card, list, collection, and reminder', async (t) => {
  await isolateData(t);
  const invisible = '\u200B\u202E\u2066';
  save('recruits', {
    schemaVersion: 4,
    recruits: { message: dangerousState({ game: invisible, time: invisible }) },
    vcChannels: [],
  });
  const edits = [];
  const sends = [];
  const client = {
    channels: {
      fetch: async () => ({
        messages: { fetch: async () => ({ edit: async (payload) => edits.push(payload) }) },
        send: async (payload) => sends.push(payload),
      }),
    },
  };
  await recruit.init(client, { createPrivateVoiceChannels: false, mentionHere: false });

  const card = edits.at(-1).embeds[0].data;
  assert.match(card.title, /イベント/u);
  assert.equal(card.fields.find((field) => field.name === '⏰ 時間').value, '日時未定');

  const listReplies = [];
  await list.execute({ guildId: 'guild', reply: async (payload) => listReplies.push(payload) });
  const description = listReplies[0].embeds[0].data.description;
  assert.match(description, /\*\*イベント\*\*/u);
  assert.match(description, /⏰日時未定/u);

  await recruit.handleButton({
    guildId: 'guild',
    customId: 'recruit_close',
    message: { id: 'message' },
    user: { id: 'host' },
    update: async () => {},
    followUp: async () => {},
  });
  assert.match(sends.at(-1).content, /\*\*イベント\*\*/u);

  const now = Date.now();
  save('recruits', {
    schemaVersion: 4,
    recruits: {
      reminder: dangerousState({
        messageId: 'reminder',
        game: invisible,
        time: invisible,
        startAt: now + 5 * 60_000,
        startText: '2099-01-01 00:00',
        startTimeZone: 'Asia/Tokyo',
        reminderLeadMinutes: 10,
      }),
    },
    vcChannels: [],
  });
  await recruit.init(client, { createPrivateVoiceChannels: false, mentionHere: false });
  await recruit.tick(now);
  assert.match(sends.at(-1).content, /\*\*イベント\*\*/u);
});
