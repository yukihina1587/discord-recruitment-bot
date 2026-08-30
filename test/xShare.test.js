import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ApplicationIntegrationType,
  InteractionContextType,
  PermissionFlagsBits,
} from 'discord.js';
import * as recruit from '../commands/recruit.js';
import * as xShareSettings from '../commands/xShareSettings.js';
import {
  DEFAULT_X_SHARE_TEMPLATE,
  buildXShareIntentUrl,
  getXShareTemplate,
  resetXShareTemplate,
  setXShareTemplate,
  validateXShareTemplate,
} from '../lib/xShare.js';
import { save } from '../lib/store.js';

async function useTemporaryDataDir(t) {
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = await mkdtemp(join(tmpdir(), 'discord-bot-x-share-'));
  t.after(() => {
    if (previous === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous;
  });
}

test('X share intent uses the fixed X composer and inserts recruitment values', () => {
  const intent = buildXShareIntentUrl({
    template: DEFAULT_X_SHARE_TEMPLATE,
    guildId: '12345678901234567',
    channelId: '23456789012345678',
    messageId: '34567890123456789',
    game: 'Apex Legends',
    time: '21時から',
    capacity: 3,
  });
  const url = new URL(intent);

  assert.equal(url.origin, 'https://x.com');
  assert.equal(url.pathname, '/intent/tweet');
  assert.match(url.searchParams.get('text'), /Apex Legends/);
  assert.match(url.searchParams.get('text'), /21時から/);
  assert.match(url.searchParams.get('text'), /3/);
  assert.equal(
    url.searchParams.get('url'),
    'https://discord.com/channels/12345678901234567/23456789012345678/34567890123456789',
  );
  assert.ok(intent.length <= 512);
});

test('DBD template without a recruitment URL preserves the requested full post', () => {
  const template = [
    '{ゲーム} @{人数}',
    '上下報告してます◎(主はマップによっては分かりません)',
    '楽しくできる人お願いします！',
    'vc discordです',
    '#dbd募集',
  ].join('\n');
  const expected = [
    'dbd @1',
    '上下報告してます◎(主はマップによっては分かりません)',
    '楽しくできる人お願いします！',
    'vc discordです',
    '#dbd募集',
  ].join('\n');

  const intent = buildXShareIntentUrl({
    template,
    guildId: '12345678901234567',
    channelId: '23456789012345678',
    messageId: '34567890123456789',
    game: 'dbd',
    time: '今から',
    capacity: 1,
  });
  const url = new URL(intent);

  assert.equal(url.searchParams.get('text'), expected);
  assert.equal(url.searchParams.has('url'), false);
  assert.ok(intent.length <= 512);
});

test('X share placeholders use the current open slots instead of the original capacity', () => {
  const intent = buildXShareIntentUrl({
    template: '{ゲーム} @{人数}',
    guildId: '12345678901234567',
    channelId: '23456789012345678',
    messageId: '34567890123456789',
    game: 'dbd',
    time: '今から',
    capacity: 3,
    members: ['45678901234567890', '56789012345678901'],
  });

  assert.equal(new URL(intent).searchParams.get('text'), 'dbd @1');
});

test('X share intent truncates long multibyte content to Discord link limits', () => {
  const intent = buildXShareIntentUrl({
    template: '{ゲーム}\n{時間}\n募集人数：{人数}\n{募集URL}',
    guildId: '12345678901234567',
    channelId: '23456789012345678',
    messageId: '34567890123456789',
    game: '長'.repeat(100),
    time: '時'.repeat(100),
    capacity: null,
  });
  const url = new URL(intent);

  assert.ok(intent.length <= 512);
  assert.ok([...url.searchParams.get('text')].length <= 250);
  assert.match(url.searchParams.get('text'), /人数指定なし/);
  assert.match(url.searchParams.get('text'), /募集/);
  assert.equal(url.searchParams.get('url').startsWith('https://discord.com/channels/'), true);
});

test('X share templates reject unknown placeholders and unsafe control characters', () => {
  assert.throws(() => validateXShareTemplate('   '), /入力/);
  assert.throws(() => validateXShareTemplate('{ゲーム} {秘密}'), /使用できない置換項目/);
  assert.throws(() => validateXShareTemplate('固定文だけ'), /ゲーム/);
  assert.throws(() => validateXShareTemplate('{ゲーム}\u0000'), /制御文字/);
  assert.throws(() => validateXShareTemplate(`{ゲーム}${'長'.repeat(180)}`), /180文字/);
  assert.equal(validateXShareTemplate(' {ゲーム}\r\n{時間} '), '{ゲーム}\n{時間}');
  assert.equal(validateXShareTemplate('{ゲーム}\\n{時間}'), '{ゲーム}\n{時間}');
});

test('X share settings are isolated by guild and can be reset', async (t) => {
  await useTemporaryDataDir(t);
  const guildA = '12345678901234567';
  const guildB = '22345678901234567';

  assert.equal(getXShareTemplate(guildA), DEFAULT_X_SHARE_TEMPLATE);
  assert.equal(setXShareTemplate(guildA, '【{ゲーム}】{時間}／{人数}人\n{募集URL}'), true);
  assert.equal(getXShareTemplate(guildA), '【{ゲーム}】{時間}／{人数}人\n{募集URL}');
  assert.equal(getXShareTemplate(guildB), DEFAULT_X_SHARE_TEMPLATE);
  assert.equal(resetXShareTemplate(guildA), true);
  assert.equal(getXShareTemplate(guildA), DEFAULT_X_SHARE_TEMPLATE);
});

test('X share settings reject malformed guild IDs and malformed stored data', async (t) => {
  await useTemporaryDataDir(t);

  assert.throws(() => getXShareTemplate('../guild'), /Discord ID/);
  save('x-share-settings', []);
  assert.throws(() => getXShareTemplate('12345678901234567'), /形式が不正/);
  save('x-share-settings', { guilds: [] });
  assert.throws(() => getXShareTemplate('12345678901234567'), /サーバーデータが不正/);
});

test('X share settings command is guild-only and manager-only', () => {
  const json = xShareSettings.data.toJSON();

  assert.deepEqual(json.integration_types, [ApplicationIntegrationType.GuildInstall]);
  assert.deepEqual(json.contexts, [InteractionContextType.Guild]);
  assert.equal(BigInt(json.default_member_permissions), PermissionFlagsBits.ManageGuild);
});

test('X share settings rejects runtime calls from non-managers', async (t) => {
  await useTemporaryDataDir(t);
  const replies = [];
  const guildId = '12345678901234567';

  await xShareSettings.execute({
    guildId,
    memberPermissions: { has: () => false },
    options: {
      getString: () => '【{ゲーム}】募集中',
      getBoolean: () => false,
    },
    reply: async (payload) => replies.push(payload),
  });

  assert.equal(getXShareTemplate(guildId), DEFAULT_X_SHARE_TEMPLATE);
  assert.equal(replies[0].ephemeral, true);
  assert.match(replies[0].content, /管理/);
});

test('X share settings stores a manager template and returns it ephemerally', async (t) => {
  await useTemporaryDataDir(t);
  const replies = [];
  const guildId = '12345678901234567';
  const template = '【{ゲーム}】{時間}から／募集人数：{人数}\n{募集URL}';

  await xShareSettings.execute({
    guildId,
    memberPermissions: { has: (permission) => permission === PermissionFlagsBits.ManageGuild },
    options: {
      getString: () => template,
      getBoolean: () => false,
    },
    reply: async (payload) => replies.push(payload),
  });

  assert.equal(getXShareTemplate(guildId), template);
  assert.equal(replies[0].ephemeral, true);
  assert.deepEqual(replies[0].allowedMentions, { parse: [] });
  assert.match(replies[0].content, /保存/);
});

test('X share settings displays, rejects conflicting input, and resets to default', async (t) => {
  await useTemporaryDataDir(t);
  const guildId = '12345678901234567';
  const template = '【{ゲーム}】{時間}／{人数}\n{募集URL}';
  setXShareTemplate(guildId, template);

  const displayed = [];
  await xShareSettings.execute(createSettingsInteraction({
    guildId,
    template: null,
    reset: false,
    replies: displayed,
  }));
  assert.match(displayed[0].content, /現在/);
  assert.match(displayed[0].content, /【\{ゲーム\}】/);

  const conflicted = [];
  await xShareSettings.execute(createSettingsInteraction({
    guildId,
    template,
    reset: true,
    replies: conflicted,
  }));
  assert.match(conflicted[0].content, /同時/);
  assert.equal(getXShareTemplate(guildId), template);

  const resetReplies = [];
  await xShareSettings.execute(createSettingsInteraction({
    guildId,
    template: null,
    reset: true,
    replies: resetReplies,
  }));
  assert.match(resetReplies[0].content, /標準へ戻/);
  assert.equal(getXShareTemplate(guildId), DEFAULT_X_SHARE_TEMPLATE);
});

test('X share settings reports invalid templates without persisting them', async (t) => {
  await useTemporaryDataDir(t);
  const guildId = '12345678901234567';
  const replies = [];

  await xShareSettings.execute(createSettingsInteraction({
    guildId,
    template: '{ゲーム} {未知}',
    reset: false,
    replies,
  }));

  assert.match(replies[0].content, /使用できない置換項目/);
  assert.equal(getXShareTemplate(guildId), DEFAULT_X_SHARE_TEMPLATE);
});

test('public recruitment messages get an X share link while private messages do not', async (t) => {
  await useTemporaryDataDir(t);
  const state = {
    messageId: '34567890123456789',
    channelId: '23456789012345678',
    guildId: '12345678901234567',
    game: 'Apex',
    time: '21時',
    capacity: 2,
    hostId: 'host',
    members: [],
    waitlist: [],
    vcId: null,
    closed: false,
    createdAt: Date.now(),
  };
  save('recruits', { recruits: { [state.messageId]: state }, vcChannels: [] });

  const publicEdits = [];
  const client = {
    channels: {
      fetch: async () => ({
        messages: {
          fetch: async () => ({ edit: async (payload) => publicEdits.push(payload) }),
        },
      }),
    },
  };
  await recruit.init(client, {
    createPrivateVoiceChannels: false,
    enableXShare: true,
    mentionHere: false,
  });
  const publicButtons = publicEdits.at(-1).components
    .flatMap((row) => row.components)
    .map((button) => button.data ?? button.toJSON());
  const shareButton = publicButtons.find((button) => button.label === 'Xで共有');
  assert.equal(shareButton.style, 5);
  assert.match(shareButton.url, /^https:\/\/x\.com\/intent\/tweet\?/);

  const privateEdits = [];
  await recruit.init(
    {
      channels: {
        fetch: async () => ({
          messages: {
            fetch: async () => ({ edit: async (payload) => privateEdits.push(payload) }),
          },
        }),
      },
    },
    { createPrivateVoiceChannels: false, enableXShare: false, mentionHere: false },
  );
  const privateButtons = privateEdits.at(-1).components
    .flatMap((row) => row.components)
    .map((button) => button.data ?? button.toJSON());
  assert.equal(privateButtons.some((button) => button.label === 'Xで共有'), false);
});

function createSettingsInteraction({ guildId, template, reset, replies }) {
  return {
    guildId,
    memberPermissions: { has: (permission) => permission === PermissionFlagsBits.ManageGuild },
    options: {
      getString: () => template,
      getBoolean: () => reset,
    },
    reply: async (payload) => replies.push(payload),
  };
}
