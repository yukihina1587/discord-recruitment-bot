import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { GatewayIntentBits } from 'discord.js';
import * as recruit from '../commands/recruit.js';
import { load, save } from '../lib/store.js';
import { PUBLIC_INTENTS } from '../runtime/public.js';

const GUILD = '12345678901234567';
const OTHER_GUILD = '22345678901234567';
const TEXT_CHANNEL = '32345678901234567';
const VOICE_CHANNEL = '42345678901234567';
const OTHER_VOICE_CHANNEL = '52345678901234567';
const HOST = '62345678901234567';
const MEMBER = '72345678901234567';

async function isolateData(t) {
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = await mkdtemp(join(tmpdir(), 'discord-bot-voice-ready-'));
  t.after(() => {
    if (previous === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous;
  });
}

function voiceStateCache(entries) {
  return new Map(entries.map(([id, channelId]) => [id, { channelId }]));
}

function createClient({ voiceStates = [], edits = [], sends = [] } = {}) {
  const guild = {
    id: GUILD,
    voiceStates: { cache: voiceStateCache(voiceStates) },
  };
  return {
    guild,
    client: {
      guilds: { cache: new Map([[GUILD, guild]]) },
      channels: {
        fetch: async () => ({
          messages: { fetch: async () => ({ edit: async (payload) => edits.push(payload) }) },
          send: async (payload) => sends.push(payload),
        }),
      },
    },
  };
}

function openRecruit(overrides = {}) {
  return {
    messageId: 'message',
    channelId: TEXT_CHANNEL,
    guildId: GUILD,
    game: 'DBD',
    time: '今から',
    capacity: 2,
    hostId: HOST,
    members: [MEMBER],
    waitlist: [],
    vcId: null,
    closed: false,
    closedReason: null,
    createdAt: Date.now(),
    autoCloseEnabled: false,
    closeAt: null,
    closeText: null,
    voiceChannelId: VOICE_CHANNEL,
    autoCloseWhenVoiceReady: true,
    ...overrides,
  };
}

test('public runtime subscribes to non-privileged voice state updates', async () => {
  assert.deepEqual(PUBLIC_INTENTS, [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ]);
  const source = await readFile(new URL('../runtime/public.js', import.meta.url), 'utf8');
  assert.match(source, /Events\.VoiceStateUpdate/u);
  assert.doesNotMatch(source, /GuildMembers|MessageContent/u);
});

test('voice auto-close requires an explicitly selected voice channel', async (t) => {
  await isolateData(t);
  const { client } = createClient();
  await recruit.init(client, { createPrivateVoiceChannels: false, mentionHere: false });
  const replies = [];
  await recruit.execute({
    guildId: GUILD,
    channelId: TEXT_CHANNEL,
    user: { id: HOST },
    options: {
      getString: (name) => (name === 'ゲーム' ? 'DBD' : null),
      getInteger: (name) => (name === 'あと何人' ? 2 : null),
      getBoolean: (name) => (name === 'vc集合で自動終了' ? true : null),
      getChannel: () => null,
    },
    reply: async (payload) => replies.push(payload),
  });

  assert.equal(replies[0].ephemeral, true);
  assert.match(replies[0].content, /対象VC/);
  assert.deepEqual(load('recruits', { recruits: {} }).recruits, {});
});

test('voice auto-close rejects a non-voice channel even if Discord validation is bypassed', async (t) => {
  await isolateData(t);
  const { client } = createClient();
  await recruit.init(client, { createPrivateVoiceChannels: false, mentionHere: false });
  const replies = [];
  await recruit.execute({
    guildId: GUILD,
    channelId: TEXT_CHANNEL,
    user: { id: HOST },
    options: {
      getString: (name) => (name === 'ゲーム' ? 'DBD' : null),
      getInteger: (name) => (name === 'あと何人' ? 2 : null),
      getBoolean: (name) => (name === 'vc集合で自動終了' ? true : null),
      getChannel: () => ({ id: VOICE_CHANNEL, type: 0, guildId: GUILD }),
    },
    reply: async (payload) => replies.push(payload),
  });

  assert.equal(replies[0].ephemeral, true);
  assert.match(replies[0].content, /ボイスチャンネル/);
  assert.deepEqual(load('recruits', { recruits: {} }).recruits, {});
});

test('voice auto-close rejects a voice channel from another guild', async (t) => {
  await isolateData(t);
  const { client } = createClient();
  await recruit.init(client, { createPrivateVoiceChannels: false, mentionHere: false });
  const replies = [];
  await recruit.execute({
    guildId: GUILD,
    channelId: TEXT_CHANNEL,
    user: { id: HOST },
    options: {
      getString: (name) => (name === 'ゲーム' ? 'DBD' : null),
      getInteger: (name) => (name === 'あと何人' ? 2 : null),
      getBoolean: (name) => (name === 'vc集合で自動終了' ? true : null),
      getChannel: () => ({ id: VOICE_CHANNEL, type: 2, guildId: OTHER_GUILD }),
    },
    reply: async (payload) => replies.push(payload),
  });

  assert.equal(replies[0].ephemeral, true);
  assert.match(replies[0].content, /このサーバー/);
  assert.deepEqual(load('recruits', { recruits: {} }).recruits, {});
});

test('a selected voice channel and opt-in are stored and shown on the card', async (t) => {
  await isolateData(t);
  const { client } = createClient();
  await recruit.init(client, { createPrivateVoiceChannels: false, mentionHere: false });
  const replies = [];
  await recruit.execute({
    guildId: GUILD,
    channelId: TEXT_CHANNEL,
    user: { id: HOST },
    options: {
      getString: (name) => (name === 'ゲーム' ? 'DBD' : null),
      getInteger: (name) => (name === 'あと何人' ? 2 : null),
      getBoolean: (name) => (name === 'vc集合で自動終了' ? true : null),
      getChannel: () => ({ id: VOICE_CHANNEL, type: 2, guildId: GUILD }),
    },
    reply: async (payload) => {
      replies.push(payload);
      return { resource: { message: { id: 'created' } } };
    },
  });

  const state = load('recruits').recruits.created;
  assert.equal(state.voiceChannelId, VOICE_CHANNEL);
  assert.equal(state.autoCloseWhenVoiceReady, true);
  const field = replies[0].embeds[0].data.fields.find(({ name }) => name === '🔊 対象VC');
  assert.equal(field.value, `<#${VOICE_CHANNEL}>\n全員集合で通知なし終了: ON`);
});

test('all registered participants in the selected VC close silently once', async (t) => {
  await isolateData(t);
  save('recruits', {
    schemaVersion: 5,
    recruits: { message: openRecruit({ waitlist: ['waiting'] }) },
    vcChannels: [],
  });
  const edits = [];
  const sends = [];
  const { client, guild } = createClient({
    voiceStates: [[HOST, VOICE_CHANNEL], [MEMBER, VOICE_CHANNEL]],
    edits,
    sends,
  });
  await recruit.init(client, { createPrivateVoiceChannels: false, mentionHere: false });

  await Promise.all([
    recruit.handleVoiceStateUpdate({ guild }, { guild }),
    recruit.handleVoiceStateUpdate({ guild }, { guild }),
  ]);

  const state = load('recruits').recruits.message;
  assert.equal(state.closed, true);
  assert.equal(state.closedReason, 'voice-ready');
  assert.equal(sends.length, 0);
  assert.equal(load('stats').sessions.length, 1);
  assert.match(edits.at(-1).content, /締め切られました/);
});

test('joining while already in the selected VC closes without waiting for another voice event', async (t) => {
  await isolateData(t);
  save('recruits', {
    schemaVersion: 5,
    recruits: { message: openRecruit({ members: [] }) },
    vcChannels: [],
  });
  const edits = [];
  const sends = [];
  const { client, guild } = createClient({
    voiceStates: [[HOST, VOICE_CHANNEL], [MEMBER, VOICE_CHANNEL]],
    edits,
    sends,
  });
  await recruit.init(client, { createPrivateVoiceChannels: false, mentionHere: false });
  const updates = [];
  await recruit.handleButton({
    guildId: GUILD,
    guild,
    customId: 'recruit_join',
    message: { id: 'message' },
    user: { id: MEMBER },
    update: async (payload) => updates.push(payload),
    followUp: async () => {},
  });

  const state = load('recruits').recruits.message;
  assert.equal(state.closed, true);
  assert.equal(state.closedReason, 'voice-ready');
  assert.equal(sends.length, 0);
  assert.equal(updates.length, 1);
});

test('the scheduler reconciles a voice-ready recruitment after startup', async (t) => {
  await isolateData(t);
  save('recruits', {
    schemaVersion: 5,
    recruits: { message: openRecruit() },
    vcChannels: [],
  });
  const sends = [];
  const { client } = createClient({
    voiceStates: [[HOST, VOICE_CHANNEL], [MEMBER, VOICE_CHANNEL]],
    sends,
  });
  await recruit.init(client, { createPrivateVoiceChannels: false, mentionHere: false });

  await recruit.tick();

  const state = load('recruits').recruits.message;
  assert.equal(state.closed, true);
  assert.equal(state.closedReason, 'voice-ready');
  assert.equal(sends.length, 0);
});

test('voice auto-close ignores host-only, missing members, other VCs, and other guilds', async (t) => {
  await isolateData(t);
  save('recruits', {
    schemaVersion: 5,
    recruits: {
      hostOnly: openRecruit({ messageId: 'hostOnly', members: [] }),
      missing: openRecruit({ messageId: 'missing' }),
      wrongVc: openRecruit({ messageId: 'wrongVc' }),
    },
    vcChannels: [],
  });
  const { client, guild } = createClient({
    voiceStates: [[HOST, VOICE_CHANNEL], [MEMBER, OTHER_VOICE_CHANNEL]],
  });
  await recruit.init(client, { createPrivateVoiceChannels: false, mentionHere: false });

  await recruit.handleVoiceStateUpdate(
    { guild: { ...guild, id: OTHER_GUILD } },
    { guild: { ...guild, id: OTHER_GUILD } },
  );
  await recruit.handleVoiceStateUpdate({ guild }, { guild });

  const states = load('recruits').recruits;
  assert.equal(states.hostOnly.closed, false);
  assert.equal(states.missing.closed, false);
  assert.equal(states.wrongVc.closed, false);
  assert.deepEqual(load('stats', { sessions: [] }).sessions, []);
});

test('legacy records migrate with VC auto-close disabled', async (t) => {
  await isolateData(t);
  save('recruits', {
    schemaVersion: 4,
    recruits: { message: openRecruit({
      voiceChannelId: undefined,
      autoCloseWhenVoiceReady: undefined,
    }) },
    vcChannels: [],
  });
  const { client } = createClient();
  await recruit.init(client, { createPrivateVoiceChannels: false, mentionHere: false });

  const stored = load('recruits');
  assert.equal(stored.schemaVersion, 5);
  assert.equal(stored.recruits.message.voiceChannelId, null);
  assert.equal(stored.recruits.message.autoCloseWhenVoiceReady, false);
});
