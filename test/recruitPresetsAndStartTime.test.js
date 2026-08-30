import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PermissionFlagsBits } from 'discord.js';
import * as recruit from '../commands/recruit.js';
import * as listCommand from '../commands/list.js';
import * as recruitSettingsCommand from '../commands/recruitSettings.js';
import * as recruitTemplates from '../commands/recruitTemplates.js';
import {
  DEFAULT_RECRUIT_TIME_ZONE,
  deleteRecruitPreset,
  getRecruitPreset,
  getRecruitTimeZone,
  listRecruitPresets,
  setRecruitPreset,
  setRecruitTimeZone,
} from '../lib/recruitSettings.js';
import { parseRecruitStart, parseRecruitStartAt } from '../lib/recruitStartTime.js';
import { load, save } from '../lib/store.js';

const GUILD_A = '12345678901234567';
const GUILD_B = '22345678901234567';
const HOST_A = '32345678901234567';

async function isolateData(t) {
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = await mkdtemp(join(tmpdir(), 'discord-bot-presets-start-'));
  t.after(() => {
    if (previous === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous;
  });
}

async function initializeRecruit({ preserveMessages = false } = {}) {
  await recruit.init(
    {
      channels: {
        fetch: async () => (preserveMessages
          ? { messages: { fetch: async () => ({ edit: async () => {} }) } }
          : null),
      },
    },
    { createPrivateVoiceChannels: false, mentionHere: false },
  );
}

function createRecruitInteraction({
  guildId = GUILD_A,
  hostId = HOST_A,
  messageId = '42345678901234567',
  strings = { ゲーム: 'DBD' },
  integers = { あと何人: 2 },
  booleans = {},
  channels = {},
} = {}) {
  const replies = [];
  return {
    replies,
    interaction: {
      guildId,
      channelId: '52345678901234567',
      user: { id: hostId },
      options: {
        getString: (name) => strings[name] ?? null,
        getInteger: (name) => integers[name] ?? null,
        getBoolean: (name) => booleans[name] ?? null,
        getChannel: (name) => channels[name] ?? null,
      },
      reply: async (payload) => {
        replies.push(payload);
        return { resource: { message: { id: messageId } } };
      },
    },
  };
}

function managerPermissions(allowed = true) {
  return { has: (permission) => allowed && permission === PermissionFlagsBits.ManageGuild };
}

function createTemplateInteraction({
  subcommand,
  strings = {},
  integers = {},
  allowed = true,
} = {}) {
  const replies = [];
  return {
    replies,
    interaction: {
      guildId: GUILD_A,
      memberPermissions: managerPermissions(allowed),
      options: {
        getSubcommand: () => subcommand,
        getString: (name) => strings[name] ?? null,
        getInteger: (name) => integers[name] ?? null,
      },
      reply: async (payload) => replies.push(payload),
    },
  };
}

function formatTokyoMinute(epochMs) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(epochMs))
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

test('structured local start time becomes an exact epoch and rejects DST ambiguity', () => {
  assert.equal(
    parseRecruitStartAt('2026-08-07 21:00', 'Asia/Tokyo'),
    Date.UTC(2026, 7, 7, 12, 0),
  );
  assert.equal(
    parseRecruitStartAt('2026-08-07 21:00', 'America/New_York'),
    Date.UTC(2026, 7, 8, 1, 0),
  );
  assert.equal(parseRecruitStartAt('2026-02-30 21:00', 'Asia/Tokyo'), null);
  assert.equal(parseRecruitStartAt('2026-03-08 02:30', 'America/New_York'), null);
  assert.equal(parseRecruitStartAt('2026-11-01 01:30', 'America/New_York'), null);
  assert.equal(
    parseRecruitStartAt('２０２６／８／７　２１：００', 'Asia/Tokyo'),
    Date.UTC(2026, 7, 7, 12, 0),
  );
});

test('friendly start formats normalize to a stable full local date', () => {
  const now = Date.UTC(2026, 7, 5, 12, 0); // 2026-08-05 21:00 Asia/Tokyo
  for (const input of ['2026/8/6 21:00', '8/6 21:00', '8月6日 21:00']) {
    assert.deepEqual(parseRecruitStart(input, 'Asia/Tokyo', now), {
      startAt: Date.UTC(2026, 7, 6, 12, 0),
      startText: '2026-08-06 21:00',
    });
  }
  assert.deepEqual(parseRecruitStart('明日 22:30', 'Asia/Tokyo', now), {
    startAt: Date.UTC(2026, 7, 6, 13, 30),
    startText: '2026-08-06 22:30',
  });
  assert.deepEqual(parseRecruitStart('今日 23:00', 'Asia/Tokyo', now), {
    startAt: Date.UTC(2026, 7, 5, 14, 0),
    startText: '2026-08-05 23:00',
  });
  assert.deepEqual(parseRecruitStart('1/2 20:00', 'Asia/Tokyo', now), {
    startAt: Date.UTC(2027, 0, 2, 11, 0),
    startText: '2027-01-02 20:00',
  });
  assert.deepEqual(parseRecruitStart('8/5 20:00', 'Asia/Tokyo', now), {
    startAt: Date.UTC(2026, 7, 5, 11, 0),
    startText: '2026-08-05 20:00',
  });
});

test('date-only start formats accept fullwidth input without inventing a time', () => {
  const now = Date.UTC(2026, 7, 5, 12, 0); // 2026-08-05 21:00 Asia/Tokyo
  for (const input of ['2026-08-22', '2026/8/22', '8/22', '8月22日', '２０２６－０８－２２']) {
    assert.deepEqual(parseRecruitStart(input, 'Asia/Tokyo', now), {
      startAt: null,
      startText: '2026-08-22',
    });
  }
  assert.deepEqual(parseRecruitStart('今日', 'Asia/Tokyo', now), {
    startAt: null,
    startText: '2026-08-05',
  });
  assert.deepEqual(parseRecruitStart('明日', 'Asia/Tokyo', now), {
    startAt: null,
    startText: '2026-08-06',
  });
  assert.equal(parseRecruitStart('2026-02-30', 'Asia/Tokyo', now), null);
});

test('guild time zones and presets are validated, isolated, and preserve old settings', async (t) => {
  await isolateData(t);
  assert.equal(getRecruitTimeZone(GUILD_A), DEFAULT_RECRUIT_TIME_ZONE);

  assert.equal(setRecruitTimeZone(GUILD_A, 'America/New_York'), true);
  assert.equal(setRecruitPreset(GUILD_A, {
    name: '金曜DBD', game: 'Dead by Daylight', time: '21時', capacity: 3,
  }), true);
  assert.equal(getRecruitTimeZone(GUILD_A), 'America/New_York');
  assert.equal(getRecruitTimeZone(GUILD_B), DEFAULT_RECRUIT_TIME_ZONE);
  assert.deepEqual(getRecruitPreset(GUILD_A, '金曜DBD'), {
    name: '金曜DBD', game: 'Dead by Daylight', time: '21時', capacity: 3,
  });
  assert.equal(getRecruitPreset(GUILD_B, '金曜DBD'), null);

  assert.throws(() => setRecruitTimeZone(GUILD_A, 'not/a_zone'), /タイムゾーン/);
  assert.throws(() => setRecruitPreset(GUILD_A, {
    name: '@everyone', game: 'DBD', time: '今から', capacity: 2,
  }), /テンプレート名/);
  assert.throws(() => setRecruitPreset(GUILD_A, {
    name: 'bad', game: 'DBD\u0000', time: '今から', capacity: 2,
  }), /ゲーム名/);

  assert.equal(deleteRecruitPreset(GUILD_A, '金曜DBD'), true);
  assert.deepEqual(listRecruitPresets(GUILD_A), []);
  assert.equal(getRecruitTimeZone(GUILD_A), 'America/New_York');
});

test('settings migration preserves an existing auto-close default while adding new fields', async (t) => {
  await isolateData(t);
  save('recruit-settings', { guilds: { [GUILD_A]: { autoCloseDefault: true } } });

  assert.equal(getRecruitTimeZone(GUILD_A), DEFAULT_RECRUIT_TIME_ZONE);
  assert.equal(setRecruitTimeZone(GUILD_A, 'Europe/London'), true);
  assert.equal(load('recruit-settings').guilds[GUILD_A].autoCloseDefault, true);
  assert.equal(load('recruit-settings').schemaVersion, 2);
});

test('/募集 and manager commands declare preset, repeat, start, voice, and timezone UX', () => {
  const recruitOptions = Object.fromEntries(
    recruit.data.toJSON().options.map((option) => [option.name, option]),
  );
  assert.equal(recruitOptions.サーバーテンプレ.autocomplete, true);
  assert.equal(recruitOptions.前回を複製.type, 5);
  assert.equal(recruitOptions.開始日時.min_length, undefined);
  assert.equal(recruitOptions.開始日時.max_length, 32);
  assert.equal(
    recruitOptions.開始日時.description,
    '省略すると今から。例: 日付のみ 8/22、日時 8/22 21:00（全角OK）',
  );
  assert.equal(recruitOptions.対象vc.type, 7);
  assert.deepEqual(recruitOptions.対象vc.channel_types, [2]);
  assert.equal(recruitOptions.vc集合で自動終了.type, 5);
  assert.equal(recruitOptions.事前通知.type, 5);
  assert.equal(recruitOptions.通知分.type, 4);
  assert.match(recruitOptions.事前通知.description, /30分前/);

  const settings = recruitSettingsCommand.data.toJSON();
  assert.equal(BigInt(settings.default_member_permissions), PermissionFlagsBits.ManageGuild);
  assert.ok(settings.options.some((option) => option.name === 'タイムゾーン'));

  const templates = recruitTemplates.data.toJSON();
  assert.equal(BigInt(templates.default_member_permissions), PermissionFlagsBits.ManageGuild);
  assert.deepEqual(templates.options.map((option) => option.name), ['保存', '削除', '一覧']);
});

test('structured start uses the guild timezone, renders Discord time, and keeps legacy time text', async (t) => {
  await isolateData(t);
  setRecruitTimeZone(GUILD_A, 'Asia/Tokyo');
  await initializeRecruit({ preserveMessages: true });
  const command = createRecruitInteraction({
    strings: { ゲーム: 'DBD', 時間: '金曜の夜', 開始日時: '2099-08-07 21:00' },
  });

  await recruit.execute(command.interaction);

  const state = load('recruits').recruits['42345678901234567'];
  assert.equal(state.time, '金曜の夜');
  assert.equal(state.startAt, Date.UTC(2099, 7, 7, 12, 0));
  assert.equal(state.startTimeZone, 'Asia/Tokyo');
  assert.equal(state.startText, '2099-08-07 21:00');
  assert.match(JSON.stringify(command.replies[0]), /<t:4089787200:F>/);
});

test('friendly start input is accepted and stored canonically', async (t) => {
  await isolateData(t);
  setRecruitTimeZone(GUILD_A, 'Asia/Tokyo');
  await initializeRecruit({ preserveMessages: true });
  const nextYear = new Date().getUTCFullYear() + 1;
  const command = createRecruitInteraction({
    strings: { ゲーム: 'DBD', 開始日時: `${nextYear}/8/7 21:00` },
    integers: { あと何人: 2 },
    booleans: { 事前通知: true },
  });

  await recruit.execute(command.interaction);

  const state = load('recruits').recruits['42345678901234567'];
  assert.equal(state.startText, `${nextYear}-08-07 21:00`);
  assert.match(state.time, new RegExp(`${nextYear}-08-07 21:00 Asia/Tokyo`));
});

test('date-only start is accepted, stored without an epoch, and rendered without a fake time', async (t) => {
  await isolateData(t);
  setRecruitTimeZone(GUILD_A, 'Asia/Tokyo');
  await initializeRecruit({ preserveMessages: true });
  const nextYear = new Date().getUTCFullYear() + 1;
  const command = createRecruitInteraction({
    strings: { ゲーム: 'DBD', 開始日時: `２０${String(nextYear).slice(2)}－０８－２２` },
    integers: { あと何人: 2 },
  });

  await recruit.execute(command.interaction);

  const state = load('recruits').recruits['42345678901234567'];
  assert.equal(state.startAt, null);
  assert.equal(state.startText, `${nextYear}-08-22`);
  assert.equal(state.startTimeZone, 'Asia/Tokyo');
  assert.equal(state.time, `${nextYear}-08-22 Asia/Tokyo`);
  const startField = command.replies[0].embeds[0].data.fields
    .find((field) => field.name === '📅 開始日');
  assert.equal(startField.value, `${nextYear}-08-22 Asia/Tokyo`);
  assert.doesNotMatch(startField.value, /<t:/u);
});

test('new structured starts must be at least one minute in the future', async (t) => {
  await isolateData(t);
  setRecruitTimeZone(GUILD_A, 'Asia/Tokyo');
  await initializeRecruit({ preserveMessages: true });
  const now = Date.now();
  const tooSoon = createRecruitInteraction({
    messageId: 'too-soon',
    strings: { ゲーム: 'DBD', 開始日時: formatTokyoMinute(now + 60_000) },
  });

  await recruit.execute(tooSoon.interaction);

  assert.equal(tooSoon.replies[0].ephemeral, true);
  assert.match(tooSoon.replies[0].content, /1分以上先/);
  assert.deepEqual(load('recruits', { recruits: {} }).recruits, {});

  const future = createRecruitInteraction({
    messageId: 'future',
    strings: { ゲーム: 'DBD', 開始日時: formatTokyoMinute(now + 120_000) },
  });
  await recruit.execute(future.interaction);
  assert.ok(load('recruits').recruits.future.startAt >= now + 60_000);
});

test('invalid structured start is rejected without storing a recruitment', async (t) => {
  await isolateData(t);
  setRecruitTimeZone(GUILD_A, 'America/New_York');
  await initializeRecruit({ preserveMessages: true });
  const command = createRecruitInteraction({
    strings: { ゲーム: 'DBD', 開始日時: '2026-11-01 01:30' },
  });

  await recruit.execute(command.interaction);

  assert.equal(command.replies[0].ephemeral, true);
  assert.match(command.replies[0].content, /開始日時/);
  assert.deepEqual(load('recruits', { recruits: {} }).recruits, {});
});

test('a guild preset supplies defaults and explicit fields override it', async (t) => {
  await isolateData(t);
  setRecruitPreset(GUILD_A, {
    name: '金曜DBD', game: 'Dead by Daylight', time: '21時', capacity: 3,
  });
  await initializeRecruit({ preserveMessages: true });
  const command = createRecruitInteraction({
    strings: { サーバーテンプレ: '金曜DBD', 時間: '22時' },
    integers: {},
  });

  await recruit.execute(command.interaction);

  const state = load('recruits').recruits['42345678901234567'];
  assert.equal(state.game, 'Dead by Daylight');
  assert.equal(state.time, '22時');
  assert.equal(state.capacity, 3);
});

test('repeat-last is host- and guild-scoped and never copies participants or waitlists', async (t) => {
  await isolateData(t);
  const previousStart = Date.UTC(2099, 7, 9, 12, 0);
  save('recruits', {
    schemaVersion: 3,
    recruits: {
      otherGuild: {
        messageId: 'otherGuild', channelId: 'channel', guildId: GUILD_B,
        game: 'Other guild', time: '20時', capacity: 1, hostId: HOST_A,
        members: ['member-a'], waitlist: ['waiting-a'], closed: true, createdAt: 300,
      },
      otherHost: {
        messageId: 'otherHost', channelId: 'channel', guildId: GUILD_A,
        game: 'Other host', time: '20時', capacity: 1, hostId: 'different-host',
        members: ['member-b'], waitlist: [], closed: true, createdAt: 400,
      },
      mine: {
        messageId: 'mine', channelId: 'channel', guildId: GUILD_A,
        game: 'My game', time: '21時', capacity: 4, hostId: HOST_A,
        members: ['member-c'], waitlist: ['waiting-c'], closed: true, createdAt: 200,
        startAt: previousStart, startText: '2099-08-09 21:00', startTimeZone: 'Asia/Tokyo',
      },
    },
    vcChannels: [],
  });
  await recruit.init(
    { channels: { fetch: async () => ({ messages: { fetch: async () => ({ edit: async () => {} }) } }) } },
    { createPrivateVoiceChannels: false, mentionHere: false },
  );
  const command = createRecruitInteraction({
    messageId: 'new-message',
    strings: {},
    integers: {},
    booleans: { 前回を複製: true },
  });

  await recruit.execute(command.interaction);

  const state = load('recruits').recruits['new-message'];
  assert.equal(state.game, 'My game');
  assert.equal(state.time, '21時');
  assert.equal(state.capacity, 4);
  assert.deepEqual(state.members, []);
  assert.deepEqual(state.waitlist, []);
  assert.equal(state.hostId, HOST_A);
  assert.equal(state.startAt, previousStart);
});

test('repeat-last clears an expired structured start and its generated display text', async (t) => {
  await isolateData(t);
  save('recruits', {
    schemaVersion: 3,
    recruits: {
      expired: {
        messageId: 'expired', channelId: 'channel', guildId: GUILD_A,
        game: 'DBD', time: '2025-08-09 21:00 Asia/Tokyo', capacity: 2, hostId: HOST_A,
        members: [], waitlist: [], closed: true, createdAt: 200,
        startAt: Date.UTC(2025, 7, 9, 12, 0),
        startText: '2025-08-09 21:00', startTimeZone: 'Asia/Tokyo',
      },
    },
    vcChannels: [],
  });
  await initializeRecruit({ preserveMessages: true });
  const command = createRecruitInteraction({
    messageId: 'repeated', strings: {}, integers: {}, booleans: { 前回を複製: true },
  });

  await recruit.execute(command.interaction);

  const state = load('recruits').recruits.repeated;
  assert.equal(state.startAt, null);
  assert.equal(state.startText, null);
  assert.equal(state.startTimeZone, null);
  assert.equal(state.time, '日時未定');
});

test('legacy recruit records migrate to the current schema without changing free-text time', async (t) => {
  await isolateData(t);
  save('recruits', {
    schemaVersion: 2,
    recruits: {
      legacy: {
        messageId: 'legacy', channelId: 'channel', guildId: GUILD_A,
        game: 'DBD', time: 'いつもの時間', capacity: 2, hostId: HOST_A,
        members: [], waitlist: [], closed: false, createdAt: 100,
      },
    },
    vcChannels: [],
  });
  await recruit.init(
    { channels: { fetch: async () => ({ messages: { fetch: async () => ({ edit: async () => {} }) } }) } },
    { createPrivateVoiceChannels: false, mentionHere: false },
  );

  const database = load('recruits');
  assert.equal(database.schemaVersion, 5);
  assert.equal(database.recruits.legacy.time, 'いつもの時間');
  assert.equal(database.recruits.legacy.startAt, null);
  assert.equal(database.recruits.legacy.startText, null);
  assert.equal(database.recruits.legacy.startTimeZone, null);
});

test('preset autocomplete only returns values from the current guild', async (t) => {
  await isolateData(t);
  setRecruitPreset(GUILD_A, { name: '金曜DBD', game: 'DBD', time: '21時', capacity: 3 });
  setRecruitPreset(GUILD_B, { name: '別Guild', game: 'Apex', time: '20時', capacity: 2 });
  const responses = [];

  await recruit.autocomplete({
    guildId: GUILD_A,
    options: { getFocused: () => ({ name: 'サーバーテンプレ', value: '金曜' }) },
    respond: async (choices) => responses.push(choices),
  });

  assert.deepEqual(responses, [[{ name: '金曜DBD', value: '金曜DBD' }]]);
});

test('template command executes permission, save, overwrite, list, delete, and autocomplete paths', async (t) => {
  await isolateData(t);
  const denied = createTemplateInteraction({ subcommand: '一覧', allowed: false });
  await recruitTemplates.execute(denied.interaction);
  assert.match(denied.replies[0].content, /管理者/);

  const first = createTemplateInteraction({
    subcommand: '保存',
    strings: { 名前: '金曜DBD', ゲーム: 'DBD', 時間: '21時' },
    integers: { あと何人: 2 },
  });
  await recruitTemplates.execute(first.interaction);
  assert.match(first.replies[0].content, /保存しました/);

  const overwrite = createTemplateInteraction({
    subcommand: '保存',
    strings: { 名前: '金曜DBD', ゲーム: 'Dead by Daylight', 時間: '22時' },
    integers: { あと何人: 3 },
  });
  await recruitTemplates.execute(overwrite.interaction);
  assert.deepEqual(getRecruitPreset(GUILD_A, '金曜DBD'), {
    name: '金曜DBD', game: 'Dead by Daylight', time: '22時', capacity: 3,
  });

  const listed = createTemplateInteraction({ subcommand: '一覧' });
  await recruitTemplates.execute(listed.interaction);
  assert.match(listed.replies[0].content, /Dead by Daylight \/ 22時/);
  assert.equal(listed.replies[0].ephemeral, true);

  const autocompleteResponses = [];
  await recruitTemplates.autocomplete({
    guildId: GUILD_A,
    options: { getFocused: () => ({ name: '名前', value: '金曜' }) },
    respond: async (choices) => autocompleteResponses.push(choices),
  });
  assert.deepEqual(autocompleteResponses, [[{ name: '金曜DBD', value: '金曜DBD' }]]);

  const deleted = createTemplateInteraction({ subcommand: '削除', strings: { 名前: '金曜DBD' } });
  await recruitTemplates.execute(deleted.interaction);
  assert.match(deleted.replies[0].content, /削除しました/);
  assert.equal(getRecruitPreset(GUILD_A, '金曜DBD'), null);
});

test('template list content stays within Discord limits and reports omitted entries', async (t) => {
  await isolateData(t);
  for (let index = 0; index < 20; index += 1) {
    setRecruitPreset(GUILD_A, {
      name: `template-${String(index).padStart(2, '0')}`,
      game: `game-${index}-${'ゲ'.repeat(90)}`,
      time: `time-${index}-${'時'.repeat(90)}`,
      capacity: 50,
    });
  }
  const listed = createTemplateInteraction({ subcommand: '一覧' });

  await recruitTemplates.execute(listed.interaction);

  assert.ok(listed.replies[0].content.length <= 2_000);
  assert.match(listed.replies[0].content, /ほか\d+件/);
});

test('template save and delete distinguish persistence failure from a missing preset', async (t) => {
  await isolateData(t);
  setRecruitPreset(GUILD_A, { name: '既存', game: 'DBD', time: '21時', capacity: 2 });
  await mkdir(join(process.env.DATA_DIR, `.recruit-settings.${process.pid}.tmp`));

  const failedSave = createTemplateInteraction({
    subcommand: '保存',
    strings: { 名前: '新規', ゲーム: 'Apex', 時間: '22時' },
    integers: { あと何人: 2 },
  });
  await recruitTemplates.execute(failedSave.interaction);
  assert.match(failedSave.replies[0].content, /保存できませんでした/);

  const failedDelete = createTemplateInteraction({ subcommand: '削除', strings: { 名前: '既存' } });
  await recruitTemplates.execute(failedDelete.interaction);
  assert.match(failedDelete.replies[0].content, /削除を保存できませんでした/);
  assert.notEqual(getRecruitPreset(GUILD_A, '既存'), null);
});

test('timezone settings execute view, update, validation, and permission paths', async (t) => {
  await isolateData(t);
  const replies = [];
  const createSettingsInteraction = ({ timeZone = null, allowed = true } = {}) => ({
    guildId: GUILD_A,
    memberPermissions: managerPermissions(allowed),
    options: {
      getBoolean: () => null,
      getString: () => timeZone,
    },
    reply: async (payload) => replies.push(payload),
  });

  await recruitSettingsCommand.execute(createSettingsInteraction());
  assert.match(replies.at(-1).content, /Asia\/Tokyo/);
  await recruitSettingsCommand.execute(createSettingsInteraction({ timeZone: 'Europe/London' }));
  assert.match(replies.at(-1).content, /Europe\/London/);
  assert.equal(getRecruitTimeZone(GUILD_A), 'Europe/London');
  await recruitSettingsCommand.execute(createSettingsInteraction({ timeZone: 'invalid/timezone' }));
  assert.match(replies.at(-1).content, /タイムゾーン/);
  await recruitSettingsCommand.execute(createSettingsInteraction({ timeZone: 'UTC', allowed: false }));
  assert.match(replies.at(-1).content, /管理者/);
  assert.equal(getRecruitTimeZone(GUILD_A), 'Europe/London');
});

test('/募集一覧 sorts future starts first, renders Discord timestamps, and orders undated entries deterministically', async (t) => {
  await isolateData(t);
  const now = Date.now();
  const base = {
    channelId: 'channel', guildId: GUILD_A, time: 'free text', capacity: 2,
    hostId: HOST_A, members: [], waitlist: [], closed: false,
  };
  save('recruits', {
    schemaVersion: 3,
    recruits: {
      undatedNew: { ...base, messageId: 'undatedNew', game: 'Undated new', createdAt: 400 },
      later: { ...base, messageId: 'later', game: 'Later', createdAt: 100, startAt: now + 7_200_000 },
      expired: { ...base, messageId: 'expired', game: 'Expired', createdAt: 200, startAt: now - 60_000 },
      earlier: { ...base, messageId: 'earlier', game: 'Earlier', createdAt: 300, startAt: now + 3_600_000 },
      undatedOld: { ...base, messageId: 'undatedOld', game: 'Undated old', createdAt: 200 },
    },
    vcChannels: [],
  });
  await initializeRecruit({ preserveMessages: true });
  const replies = [];

  await listCommand.execute({
    guildId: GUILD_A,
    reply: async (payload) => replies.push(payload),
  });

  const description = replies[0].embeds[0].data.description;
  const names = ['Earlier', 'Later', 'Expired', 'Undated old', 'Undated new'];
  const positions = names.map((name) => description.indexOf(name));
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right));
  assert.match(description, new RegExp(`<t:${Math.floor((now + 3_600_000) / 1_000)}:F>`));
  assert.doesNotMatch(description.slice(description.indexOf('Expired')), /Expired[^\n]*<t:/);
});

test('/募集一覧 bounds 100 max-sized active recruits within the Embed description limit', async (t) => {
  await isolateData(t);
  const now = Date.now();
  const recruits = {};
  for (let index = 0; index < 99; index += 1) {
    const id = `undated-${String(index).padStart(2, '0')}`;
    recruits[id] = {
      messageId: id,
      channelId: '52345678901234567',
      guildId: GUILD_A,
      game: `Game${String(index).padStart(2, '0')}${'G'.repeat(94)}`,
      time: `Time${String(index).padStart(2, '0')}${'T'.repeat(94)}`,
      capacity: 50,
      hostId: HOST_A,
      members: [],
      waitlist: [],
      closed: false,
      createdAt: index,
    };
  }
  recruits.future = {
    ...recruits['undated-98'],
    messageId: 'future',
    game: `Future${'F'.repeat(94)}`,
    startAt: now + 3_600_000,
    createdAt: 1_000,
  };
  save('recruits', { schemaVersion: 3, recruits, vcChannels: [] });
  await initializeRecruit({ preserveMessages: true });
  const replies = [];

  await listCommand.execute({
    guildId: GUILD_A,
    reply: async (payload) => replies.push(payload),
  });

  const description = replies[0].embeds[0].data.description;
  assert.ok(description.length <= 4_096);
  assert.match(description, /^🎮 \*\*Future/);
  assert.ok(description.indexOf('Game00') < description.indexOf('Game01'));
  assert.match(description, /…ほか\d+件$/);
});

test('structured start can be changed or cleared in the guild timezone without stale generated time text', async (t) => {
  await isolateData(t);
  setRecruitTimeZone(GUILD_A, 'Asia/Tokyo');
  const oldStart = Date.UTC(2099, 7, 7, 12, 0);
  save('recruits', {
    schemaVersion: 3,
    recruits: {
      message: {
        messageId: 'message', channelId: 'channel', guildId: GUILD_A,
        game: 'DBD', time: '2099-08-07 21:00 Asia/Tokyo', capacity: 2, hostId: HOST_A,
        members: [], waitlist: [], closed: false, createdAt: 100,
        autoCloseEnabled: false, closeAt: null, closeText: null,
        startAt: oldStart, startText: '2099-08-07 21:00', startTimeZone: 'Asia/Tokyo',
      },
    },
    vcChannels: [],
  });
  await initializeRecruit({ preserveMessages: true });
  let shownModal;
  await recruit.handleButton({
    guildId: GUILD_A,
    customId: 'recruit_edit',
    message: { id: 'message' },
    user: { id: HOST_A },
    showModal: async (modal) => { shownModal = modal.toJSON(); },
  });
  const inputs = shownModal.components.map((row) => row.components[0]);
  assert.equal(inputs.length, 5);
  assert.equal(inputs.find((input) => input.custom_id === 'start').max_length, 40);
  assert.equal(inputs.find((input) => input.custom_id === 'start').value, '2099-08-07 21:00');

  const replies = [];
  const submit = async (values) => recruit.handleModal({
    guildId: GUILD_A,
    customId: 'recruit_edit_modal',
    message: { id: 'message' },
    user: { id: HOST_A },
    fields: {
      getTextInputValue: (name) => {
        if (!(name in values)) throw new Error(`missing field: ${name}`);
        return values[name];
      },
    },
    reply: async (payload) => replies.push(payload),
    update: async () => {},
  });
  await submit({
    game: 'DBD', time: '2099-08-07 21:00 Asia/Tokyo', capacity: '2',
    start: '2099-08-08 22:30', autoCloseDeadline: 'OFF',
  });
  let state = load('recruits').recruits.message;
  assert.equal(state.startAt, Date.UTC(2099, 7, 8, 13, 30));
  assert.equal(state.startText, '2099-08-08 22:30');
  assert.equal(state.startTimeZone, 'Asia/Tokyo');
  assert.equal(state.time, '2099-08-08 22:30 Asia/Tokyo');

  await submit({
    game: 'DBD', time: '2099-08-08 22:30 Asia/Tokyo', capacity: '2',
    start: '', autoCloseDeadline: 'OFF',
  });
  state = load('recruits').recruits.message;
  assert.equal(state.startAt, null);
  assert.equal(state.startText, null);
  assert.equal(state.startTimeZone, null);
  assert.equal(state.time, '日時未定');
});

test('unchanged structured edit preserves its original timezone after the guild timezone changes', async (t) => {
  await isolateData(t);
  const originalStart = Date.UTC(2099, 7, 7, 12, 0);
  setRecruitTimeZone(GUILD_A, 'Asia/Tokyo');
  save('recruits', {
    schemaVersion: 3,
    recruits: {
      message: {
        messageId: 'message', channelId: 'channel', guildId: GUILD_A,
        game: 'DBD', time: '2099-08-07 21:00 Asia/Tokyo', capacity: 2, hostId: HOST_A,
        members: [], waitlist: [], closed: false, createdAt: 100,
        autoCloseEnabled: false, closeAt: null, closeText: null,
        startAt: originalStart, startText: '2099-08-07 21:00', startTimeZone: 'Asia/Tokyo',
      },
    },
    vcChannels: [],
  });
  await initializeRecruit({ preserveMessages: true });
  setRecruitTimeZone(GUILD_A, 'Europe/London');

  const submit = async (start, time) => recruit.handleModal({
    guildId: GUILD_A,
    customId: 'recruit_edit_modal',
    message: { id: 'message' },
    user: { id: HOST_A },
    fields: {
      getTextInputValue: (name) => ({
        game: 'DBD', time, capacity: '2', start, autoCloseDeadline: 'OFF',
      })[name],
    },
    update: async () => {},
  });

  await submit('2099-08-07 21:00', '2099-08-07 21:00 Asia/Tokyo');
  let state = load('recruits').recruits.message;
  assert.equal(state.startAt, originalStart);
  assert.equal(state.startText, '2099-08-07 21:00');
  assert.equal(state.startTimeZone, 'Asia/Tokyo');
  assert.equal(state.time, '2099-08-07 21:00 Asia/Tokyo');

  await submit('2099-08-08 22:30', '2099-08-07 21:00 Asia/Tokyo');
  state = load('recruits').recruits.message;
  assert.equal(state.startAt, Date.UTC(2099, 7, 8, 21, 30));
  assert.equal(state.startText, '2099-08-08 22:30');
  assert.equal(state.startTimeZone, 'Europe/London');
  assert.equal(state.time, '2099-08-08 22:30 Europe/London');
});
