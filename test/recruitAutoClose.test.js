import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PermissionFlagsBits } from 'discord.js';
import * as recruit from '../commands/recruit.js';
import * as recruitSettings from '../commands/recruitSettings.js';
import {
  DEFAULT_AUTO_CLOSE_ENABLED,
  getDefaultAutoCloseEnabled,
} from '../lib/recruitSettings.js';
import { load, save } from '../lib/store.js';

const GUILD_A = '12345678901234567';
const GUILD_B = '22345678901234567';

async function useTemporaryData(t) {
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = await mkdtemp(join(tmpdir(), 'discord-bot-auto-close-'));
  t.after(() => {
    if (previous === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous;
  });
}

async function initializeRecruit() {
  await recruit.init(
    { channels: { fetch: async () => null } },
    { createPrivateVoiceChannels: false, mentionHere: false },
  );
}

function createRecruitInteraction({ guildId = GUILD_A, autoClose = null, deadline = null, time = '今から' } = {}) {
  const replies = [];
  return {
    replies,
    interaction: {
      guildId,
      channelId: '32345678901234567',
      user: { id: '42345678901234567' },
      options: {
        getString: (name) => ({ ゲーム: 'DBD', 時間: time, 締切: deadline }[name] ?? null),
        getInteger: (name) => (name === 'あと何人' ? 2 : null),
        getBoolean: (name) => (name === '自動締切' ? autoClose : null),
      },
      reply: async (payload) => {
        replies.push(payload);
        return { resource: { message: { id: '52345678901234567' } } };
      },
    },
  };
}

test('/募集 declares separate auto-close and deadline options', () => {
  const command = recruit.data.toJSON();
  const options = Object.fromEntries(command.options.map((option) => [option.name, option]));
  assert.equal(options.人数, undefined);
  assert.equal(options.あと何人.type, 4);
  assert.match(options.あと何人.description, /主催者を含めず/);
  assert.match(options.あと何人.description, /2人分空いているなら2/);
  assert.equal(options.自動締切.type, 5);
  assert.equal(options.締切.type, 3);
  assert.doesNotMatch(options.時間.description, /自動締め切り/);
});

test('/募集設定 is guild manager-only', () => {
  const command = recruitSettings.data.toJSON();
  assert.equal(BigInt(command.default_member_permissions), PermissionFlagsBits.ManageGuild);
});

test('new recruitment defaults time-based auto-close to off', async (t) => {
  await useTemporaryData(t);
  await initializeRecruit();
  const command = createRecruitInteraction({ time: '21時' });
  await recruit.execute(command.interaction);

  const state = load('recruits').recruits['52345678901234567'];
  assert.equal(state.autoCloseEnabled, false);
  assert.equal(state.closeAt, null);
  assert.equal(state.closeText, null);
  assert.doesNotMatch(JSON.stringify(command.replies[0]), /自動締め切り/);
});

test('explicit auto-close stores a separately parsed deadline', async (t) => {
  await useTemporaryData(t);
  await initializeRecruit();
  const command = createRecruitInteraction({ autoClose: true, deadline: '30分後' });
  const before = Date.now();
  await recruit.execute(command.interaction);

  const state = load('recruits').recruits['52345678901234567'];
  assert.equal(state.autoCloseEnabled, true);
  assert.equal(state.closeText, '30分後');
  assert.ok(state.closeAt >= before + 29 * 60 * 1000);
  assert.match(JSON.stringify(command.replies[0]), /自動締め切り/);
});

test('auto-close on rejects a missing or unrecognized deadline without creating data', async (t) => {
  await useTemporaryData(t);
  await initializeRecruit();

  for (const deadline of [null, 'いつか']) {
    const command = createRecruitInteraction({ autoClose: true, deadline });
    await recruit.execute(command.interaction);
    assert.equal(command.replies[0].ephemeral, true);
    assert.match(command.replies[0].content, /締切/);
    assert.deepEqual(load('recruits', { recruits: {} }).recruits, {});
  }
});

test('guild default is manager-only, isolated, and used when /募集 omits its override', async (t) => {
  await useTemporaryData(t);
  assert.equal(DEFAULT_AUTO_CLOSE_ENABLED, false);

  const denied = [];
  await recruitSettings.execute({
    guildId: GUILD_A,
    memberPermissions: { has: () => false },
    options: { getBoolean: () => true },
    reply: async (payload) => denied.push(payload),
  });
  assert.equal(getDefaultAutoCloseEnabled(GUILD_A), false);
  assert.match(denied[0].content, /管理者/);

  await recruitSettings.execute({
    guildId: GUILD_A,
    memberPermissions: { has: (permission) => permission === PermissionFlagsBits.ManageGuild },
    options: { getBoolean: () => true },
    reply: async () => {},
  });
  assert.equal(getDefaultAutoCloseEnabled(GUILD_A), true);
  assert.equal(getDefaultAutoCloseEnabled(GUILD_B), false);

  await initializeRecruit();
  const command = createRecruitInteraction({ guildId: GUILD_A, deadline: '1時間後' });
  await recruit.execute(command.interaction);
  assert.equal(load('recruits').recruits['52345678901234567'].autoCloseEnabled, true);

  const overridden = createRecruitInteraction({ guildId: GUILD_A, autoClose: false });
  await recruit.execute(overridden.interaction);
  const overriddenState = load('recruits').recruits['52345678901234567'];
  assert.equal(overriddenState.autoCloseEnabled, false);
  assert.equal(overriddenState.closeAt, null);
});

test('legacy closeAt data keeps its old behavior while records without closeAt migrate off', async (t) => {
  await useTemporaryData(t);
  const future = Date.now() + 60 * 60 * 1000;
  const base = {
    channelId: '32345678901234567', guildId: GUILD_A, game: 'DBD', time: '今から', capacity: 2,
    hostId: '42345678901234567', members: [], waitlist: [], closed: false, createdAt: Date.now(),
  };
  save('recruits', {
    recruits: {
      legacyOn: { ...base, messageId: 'legacyOn', closeAt: future },
      legacyOff: { ...base, messageId: 'legacyOff' },
      explicitOff: { ...base, messageId: 'explicitOff', autoCloseEnabled: false, closeAt: future },
    },
    vcChannels: [],
  });

  await recruit.init(
    { channels: { fetch: async () => ({ messages: { fetch: async () => ({ edit: async () => {} }) } }) } },
    { createPrivateVoiceChannels: false, mentionHere: false },
  );

  const states = load('recruits').recruits;
  assert.equal(load('recruits').schemaVersion, 5);
  assert.equal(states.legacyOn.autoCloseEnabled, true);
  assert.equal(states.legacyOn.closeAt, future);
  assert.equal(states.legacyOff.autoCloseEnabled, false);
  assert.equal(states.legacyOff.closeAt, null);
  assert.equal(states.explicitOff.autoCloseEnabled, false);
  assert.equal(states.explicitOff.closeAt, null);
});

test('edit modal can turn auto-close off and clears its deadline', async (t) => {
  await useTemporaryData(t);
  save('recruits', {
    recruits: {
      message: {
        messageId: 'message', channelId: '32345678901234567', guildId: GUILD_A,
        game: 'DBD', time: '今から', capacity: 2, hostId: '42345678901234567',
        members: [], waitlist: [], closed: false, createdAt: Date.now(),
        autoCloseEnabled: true, closeAt: Date.now() + 60 * 60 * 1000, closeText: '1時間後',
      },
    },
    vcChannels: [],
  });
  await recruit.init(
    { channels: { fetch: async () => ({ messages: { fetch: async () => ({ edit: async () => {} }) } }) } },
    { createPrivateVoiceChannels: false, mentionHere: false },
  );

  await recruit.handleModal({
    guildId: GUILD_A,
    customId: 'recruit_edit_modal',
    message: { id: 'message' },
    user: { id: '42345678901234567' },
    fields: {
      getTextInputValue: (name) => ({
        game: 'DBD', time: '今から', capacity: '2', autoClose: 'OFF', deadline: '1時間後',
      })[name],
    },
    update: async () => {},
  });

  const state = load('recruits').recruits.message;
  assert.equal(state.autoCloseEnabled, false);
  assert.equal(state.closeAt, null);
  assert.equal(state.closeText, null);
});

test('edit modal rejects invalid auto-close data before mutating the recruitment', async (t) => {
  await useTemporaryData(t);
  save('recruits', {
    recruits: {
      message: {
        messageId: 'message', channelId: '32345678901234567', guildId: GUILD_A,
        game: 'DBD', time: '今から', capacity: 2, hostId: '42345678901234567',
        members: [], waitlist: [], closed: false, createdAt: Date.now(),
        autoCloseEnabled: false, closeAt: null, closeText: null,
      },
    },
    vcChannels: [],
  });
  await recruit.init(
    { channels: { fetch: async () => ({ messages: { fetch: async () => ({ edit: async () => {} }) } }) } },
    { createPrivateVoiceChannels: false, mentionHere: false },
  );
  const replies = [];

  await recruit.handleModal({
    guildId: GUILD_A,
    customId: 'recruit_edit_modal',
    message: { id: 'message' },
    user: { id: '42345678901234567' },
    fields: {
      getTextInputValue: (name) => ({
        game: 'Changed', time: '21時', capacity: '3', autoClose: 'ON', deadline: 'いつか',
      })[name],
    },
    reply: async (payload) => replies.push(payload),
  });

  const state = load('recruits').recruits.message;
  assert.equal(state.game, 'DBD');
  assert.equal(state.time, '今から');
  assert.equal(state.capacity, 2);
  assert.equal(state.autoCloseEnabled, false);
  assert.match(replies[0].content, /締切/);
});
