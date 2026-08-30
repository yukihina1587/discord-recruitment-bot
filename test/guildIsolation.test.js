import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import * as poll from '../commands/poll.js';
import * as recruit from '../commands/recruit.js';
import { load, save } from '../lib/store.js';
import { recordSession, summarize } from '../lib/stats.js';

function useTemporaryData(t) {
  const previous = process.env.DATA_DIR;
  return mkdtemp(join(tmpdir(), 'discord-bot-guild-')).then((directory) => {
    process.env.DATA_DIR = directory;
    t.after(() => {
      if (previous === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = previous;
    });
  });
}

function createRecruitCommand(guildId = 'guild-a') {
  let response;
  return {
    interaction: {
      guildId,
      channelId: 'channel-a',
      user: { id: 'host' },
      options: {
        getString: (name) => (name === 'ゲーム' ? 'Apex' : null),
        getInteger: (name) => (name === 'あと何人' ? 2 : null),
      },
      async reply(payload) {
        response = payload;
        return { resource: { message: { id: 'recruit-message' } } };
      },
    },
    response: () => response,
  };
}

function createPollCommand(guildId = 'guild-a') {
  return {
    guildId,
    options: {
      getString: (name) => (name === '質問' ? 'いつ？' : '20時,21時'),
    },
    async reply() {
      return { resource: { message: { id: 'poll-message' } } };
    },
  };
}

test('recruit buttons and modals cannot cross guild boundaries', async (t) => {
  await useTemporaryData(t);
  await recruit.init(
    { channels: { fetch: async () => null } },
    { createPrivateVoiceChannels: false, mentionHere: false },
  );
  const command = createRecruitCommand();
  await recruit.execute(command.interaction);

  const replies = [];
  const wrongGuildBase = {
    guildId: 'guild-b',
    message: { id: 'recruit-message' },
    user: { id: 'outsider' },
    reply: async (payload) => replies.push(payload),
  };
  await recruit.handleButton({
    ...wrongGuildBase,
    customId: 'recruit_join',
    update: async () => assert.fail('must not update a recruitment from another guild'),
  });
  await recruit.handleModal({
    ...wrongGuildBase,
    customId: 'recruit_addmore_modal',
    fields: { getTextInputValue: () => '2' },
  });

  assert.equal(replies.length, 2);
  assert.ok(replies.every((reply) => reply.ephemeral));
});

test('public recruit mentions here only on creation and creates no private voice channel', async (t) => {
  await useTemporaryData(t);
  await recruit.init(
    { channels: { fetch: async () => null } },
    { createPrivateVoiceChannels: false, mentionHere: true },
  );
  const command = createRecruitCommand();
  await recruit.execute(command.interaction);
  assert.match(command.response().content, /@here/);
  assert.deepEqual(command.response().allowedMentions, { parse: ['everyone'] });

  const joinUpdates = [];
  await recruit.handleButton({
    guildId: 'guild-a',
    customId: 'recruit_join',
    message: { id: 'recruit-message' },
    user: { id: 'member' },
    update: async (payload) => joinUpdates.push(payload),
    followUp: async () => {},
  });
  assert.equal(joinUpdates.length, 1);
  assert.match(joinUpdates[0].content, /@here/);
  assert.deepEqual(joinUpdates[0].allowedMentions, { parse: [] });

  const updates = [];
  await recruit.handleButton({
    guildId: 'guild-a',
    customId: 'recruit_close',
    message: { id: 'recruit-message' },
    user: { id: 'host' },
    update: async (payload) => updates.push(payload),
    followUp: async () => {},
  });

  assert.equal(updates.length, 1);
  assert.doesNotMatch(JSON.stringify(updates[0]), /ボイスチャンネル|<#/);
});

test('poll buttons cannot vote from another guild', async (t) => {
  await useTemporaryData(t);
  poll.init();
  await poll.execute(createPollCommand());

  const replies = [];
  await poll.handleButton({
    guildId: 'guild-b',
    customId: 'poll_0',
    message: { id: 'poll-message' },
    user: { id: 'user-a' },
    reply: async (payload) => replies.push(payload),
    update: async () => assert.fail('must not update a poll from another guild'),
  });

  assert.equal(replies.length, 1);
  assert.equal(replies[0].ephemeral, true);
});

test('statistics include only sessions from the requested guild', async (t) => {
  await useTemporaryData(t);
  recordSession({
    guildId: 'guild-a',
    game: 'Apex',
    hostId: 'host',
    members: ['user'],
  });
  recordSession({
    guildId: 'guild-b',
    game: 'Valorant',
    hostId: 'host',
    members: ['user'],
  });

  const summary = summarize('user', 'guild-a');
  assert.equal(summary.joinCount, 1);
  assert.deepEqual(summary.topGames, [['Apex', 1]]);
});

test('legacy statistics are visible only in the configured private guild', async (t) => {
  await useTemporaryData(t);
  const previousGuild = process.env.GUILD_ID;
  process.env.GUILD_ID = 'private-guild';
  t.after(() => {
    if (previousGuild === undefined) delete process.env.GUILD_ID;
    else process.env.GUILD_ID = previousGuild;
  });

  recordSession({ game: 'Legacy', hostId: 'host', members: ['user'] });
  assert.equal(summarize('user', 'private-guild').joinCount, 1);
  assert.equal(summarize('user', 'other-guild').joinCount, 0);
});

test('legacy recruits migrate only when private runtime supplies its guild', async (t) => {
  await useTemporaryData(t);
  save('recruits', {
    recruits: {
      legacy: {
        messageId: 'legacy',
        channelId: 'channel',
        game: 'Legacy',
        time: '今から',
        capacity: 2,
        hostId: 'host',
        members: [],
        waitlist: [],
        closed: false,
        createdAt: Date.now(),
      },
    },
    vcChannels: [],
  });
  const client = {
    channels: {
      fetch: async () => ({
        messages: { fetch: async () => ({ edit: async () => {} }) },
      }),
    },
  };

  await recruit.init(client, {
    createPrivateVoiceChannels: false,
    mentionHere: false,
  });
  assert.deepEqual(recruit.listActive('private-guild'), []);

  save('recruits', {
    recruits: {
      legacy: {
        messageId: 'legacy',
        channelId: 'channel',
        game: 'Legacy',
        time: '今から',
        capacity: 2,
        hostId: 'host',
        members: [],
        waitlist: [],
        closed: false,
        createdAt: Date.now(),
      },
    },
    vcChannels: [],
  });
  await recruit.init(client, {
    createPrivateVoiceChannels: true,
    mentionHere: true,
    legacyGuildId: 'private-guild',
  });

  assert.equal(recruit.listActive('private-guild').length, 1);
  assert.equal(load('recruits').recruits.legacy.guildId, 'private-guild');
});

test('statistics retention is capped independently per guild', async (t) => {
  await useTemporaryData(t);
  const now = Date.now();
  save('stats', {
    sessions: [
      ...Array.from({ length: 2_000 }, (_, index) => ({
        guildId: 'guild-a',
        game: `A-${index}`,
        hostId: 'host',
        members: ['host'],
        closedAt: now + index,
      })),
      {
        guildId: 'guild-b',
        game: 'B-kept',
        hostId: 'host',
        members: ['host'],
        closedAt: now,
      },
    ],
  });

  recordSession({
    guildId: 'guild-a',
    game: 'A-new',
    hostId: 'host',
    members: [],
  });

  const sessions = load('stats').sessions;
  assert.equal(sessions.filter((session) => session.guildId === 'guild-a').length, 2_000);
  assert.equal(sessions.filter((session) => session.guildId === 'guild-b').length, 1);
  assert.ok(sessions.some((session) => session.game === 'B-kept'));
});
