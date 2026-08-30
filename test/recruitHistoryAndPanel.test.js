import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PermissionFlagsBits } from 'discord.js';
import * as recruit from '../commands/recruit.js';
import * as recruitPanel from '../commands/recruitPanel.js';
import { load, save } from '../lib/store.js';

const GUILD_A = '12345678901234567';
const GUILD_B = '22345678901234567';
const HOST_A = '32345678901234567';
const HOST_B = '42345678901234567';

async function isolateData(t) {
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = await mkdtemp(join(tmpdir(), 'discord-bot-history-panel-'));
  t.after(() => {
    if (previous === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous;
  });
}

function record({
  messageId,
  guildId = GUILD_A,
  hostId = HOST_A,
  game,
  time = '21時',
  capacity = 2,
  createdAt,
  members = [],
  waitlist = [],
  startAt = null,
  startText = null,
  startTimeZone = null,
  reminderLeadMinutes = null,
}) {
  return {
    messageId,
    channelId: '52345678901234567',
    guildId,
    hostId,
    game,
    time,
    capacity,
    createdAt,
    members,
    waitlist,
    startAt,
    startText,
    startTimeZone,
    reminderLeadMinutes,
    closed: true,
  };
}

async function initialize(records = {}) {
  save('recruits', { recruits: records, vcChannels: [] });
  await recruit.init(
    {
      channels: {
        fetch: async () => ({ messages: { fetch: async () => ({ edit: async () => {} }) } }),
      },
    },
    { createPrivateVoiceChannels: false, mentionHere: false },
  );
}

function recruitInteraction({ historyId, messageId = '62345678901234567' } = {}) {
  const replies = [];
  return {
    replies,
    interaction: {
      guildId: GUILD_A,
      channelId: '52345678901234567',
      user: { id: HOST_A },
      options: {
        getString: (name) => (name === '履歴から' ? historyId ?? null : null),
        getInteger: () => null,
        getBoolean: () => null,
        getChannel: () => null,
      },
      reply: async (payload) => {
        replies.push(payload);
        return { resource: { message: { id: messageId } } };
      },
    },
  };
}

test('/募集 declares a history autocomplete source', () => {
  const options = Object.fromEntries(recruit.data.toJSON().options.map((option) => [option.name, option]));
  assert.equal(options.履歴から.type, 3);
  assert.equal(options.履歴から.autocomplete, true);
});

test('history autocomplete returns only the current guild and user, newest first, with duplicates removed', async (t) => {
  await isolateData(t);
  await initialize({
    oldDuplicate: record({ messageId: 'oldDuplicate', game: 'DBD', createdAt: 100 }),
    newest: record({ messageId: 'newest', game: 'DBD', createdAt: 500 }),
    second: record({ messageId: 'second', game: 'Apex', time: '今から', createdAt: 400 }),
    otherHost: record({ messageId: 'otherHost', hostId: HOST_B, game: '秘密', createdAt: 900 }),
    otherGuild: record({ messageId: 'otherGuild', guildId: GUILD_B, game: '別鯖', createdAt: 800 }),
  });
  const responses = [];

  await recruit.autocomplete({
    guildId: GUILD_A,
    user: { id: HOST_A },
    options: { getFocused: () => ({ name: '履歴から', value: '' }) },
    respond: async (choices) => responses.push(choices),
  });

  assert.deepEqual(responses[0].map((choice) => choice.value), ['newest', 'second']);
  assert.match(responses[0][0].name, /DBD/);
  assert.doesNotMatch(JSON.stringify(responses), /秘密|別鯖|oldDuplicate/);
});

test('a selected history entry is revalidated and never copies participants', async (t) => {
  await isolateData(t);
  await initialize({
    mine: record({
      messageId: 'mine', game: 'DBD', createdAt: 300,
      members: ['member'], waitlist: ['waiting'], capacity: 4,
    }),
    otherHost: record({ messageId: 'otherHost', hostId: HOST_B, game: '秘密', createdAt: 400 }),
  });

  const accepted = recruitInteraction({ historyId: 'mine' });
  await recruit.execute(accepted.interaction);
  const created = load('recruits').recruits['62345678901234567'];
  assert.equal(created.game, 'DBD');
  assert.equal(created.capacity, 4);
  assert.deepEqual(created.members, []);
  assert.deepEqual(created.waitlist, []);

  const rejected = recruitInteraction({ historyId: 'otherHost', messageId: 'rejected' });
  await recruit.execute(rejected.interaction);
  assert.equal(rejected.replies[0].ephemeral, true);
  assert.match(rejected.replies[0].content, /履歴/);
  assert.equal(load('recruits').recruits.rejected, undefined);
});

test('/募集パネル is administrator-installed and posts persistent quick-action buttons', async () => {
  const command = recruitPanel.data.toJSON();
  assert.equal(BigInt(command.default_member_permissions), PermissionFlagsBits.ManageGuild);
  const denied = [];
  await recruitPanel.execute({
    memberPermissions: { has: () => false },
    reply: async (payload) => denied.push(payload),
  });
  assert.equal(denied[0].ephemeral, true);

  const replies = [];
  await recruitPanel.execute({
    memberPermissions: { has: (permission) => permission === PermissionFlagsBits.ManageGuild },
    reply: async (payload) => replies.push(payload),
  });
  assert.equal(replies[0].ephemeral, undefined);
  assert.deepEqual(
    replies[0].components[0].components.map((button) => button.data.custom_id),
    ['recruitpanel_create', 'recruitpanel_repeat', 'recruitpanel_list'],
  );
  assert.deepEqual(replies[0].allowedMentions, { parse: [] });
});

test('panel list button uses the existing guild-scoped active list', async (t) => {
  await isolateData(t);
  await initialize({
    guildA: { ...record({ messageId: 'guildA', game: '自鯖', createdAt: 100 }), closed: false },
    guildB: {
      ...record({ messageId: 'guildB', guildId: GUILD_B, game: '別鯖', createdAt: 200 }),
      closed: false,
    },
  });
  const replies = [];
  await recruitPanel.handleButton({
    customId: 'recruitpanel_list',
    guildId: GUILD_A,
    user: { id: HOST_A },
    reply: async (payload) => replies.push(payload),
  });
  assert.match(JSON.stringify(replies[0]), /自鯖/);
  assert.doesNotMatch(JSON.stringify(replies[0]), /別鯖/);
  assert.equal(replies[0].ephemeral, true);
});

test('panel repeat opens a form only from the current guild and user history', async (t) => {
  await isolateData(t);
  await initialize({
    mine: record({
      messageId: 'mine', game: 'DBD', time: '2025-01-01 21:00 Asia/Tokyo', capacity: 3, createdAt: 100,
      startAt: Date.UTC(2025, 0, 1), startText: '2025-01-01 21:00', startTimeZone: 'Asia/Tokyo',
    }),
    otherHost: record({ messageId: 'otherHost', hostId: HOST_B, game: '秘密', createdAt: 900 }),
    otherGuild: record({ messageId: 'otherGuild', guildId: GUILD_B, game: '別鯖', createdAt: 800 }),
  });
  const modals = [];
  await recruitPanel.handleButton({
    customId: 'recruitpanel_repeat',
    guildId: GUILD_A,
    user: { id: HOST_A },
    showModal: async (modal) => modals.push(modal.toJSON()),
  });
  assert.equal(modals[0].custom_id, 'recruitpanel_repeat_modal:mine');
  assert.match(JSON.stringify(modals[0]), /DBD/);
  assert.doesNotMatch(JSON.stringify(modals[0]), /秘密|別鯖/);
  assert.doesNotMatch(JSON.stringify(modals[0]), /2025-01-01/);
  assert.match(JSON.stringify(modals[0]), /日時未定/);
});

test('panel modal validates capacity and delegates creation to the hardened recruit path', async (t) => {
  await isolateData(t);
  await initialize();
  const invalidReplies = [];
  await recruitPanel.handleModal({
    customId: 'recruitpanel_create_modal', guildId: GUILD_A,
    channelId: '52345678901234567', user: { id: HOST_A },
    fields: { getTextInputValue: (name) => ({ game: 'DBD', time: '今から', start: '', capacity: '999' })[name] },
    reply: async (payload) => invalidReplies.push(payload),
  });
  assert.equal(invalidReplies[0].ephemeral, true);
  assert.deepEqual(load('recruits').recruits, {});

  const replies = [];
  await recruitPanel.handleModal({
    customId: 'recruitpanel_create_modal', guildId: GUILD_A,
    channelId: '52345678901234567', user: { id: HOST_A },
    fields: { getTextInputValue: (name) => ({ game: 'DBD', time: '今から', start: '', capacity: '2' })[name] },
    reply: async (payload) => {
      replies.push(payload);
      return { resource: { message: { id: 'created' } } };
    },
  });
  assert.equal(replies[0].withResponse, true);
  assert.equal(load('recruits').recruits.created.game, 'DBD');
});

test('panel handlers fail closed for DMs, unknown actions, missing history, and malformed forms', async (t) => {
  await isolateData(t);
  await initialize();
  const replies = [];
  const reply = async (payload) => replies.push(payload);

  await recruitPanel.handleButton({ guildId: null, customId: 'recruitpanel_create', reply });
  assert.equal(replies.at(-1).ephemeral, true);
  assert.equal(await recruitPanel.handleButton({ guildId: GUILD_A, customId: 'unknown' }), undefined);

  await recruitPanel.handleButton({
    guildId: GUILD_A, customId: 'recruitpanel_repeat', user: { id: HOST_A }, reply,
  });
  assert.match(replies.at(-1).content, /履歴/);

  await recruitPanel.handleModal({ guildId: null, customId: 'recruitpanel_create_modal', reply });
  assert.equal(replies.at(-1).ephemeral, true);
  assert.equal(await recruitPanel.handleModal({ guildId: GUILD_A, customId: 'unknown' }), undefined);

  await recruitPanel.handleModal({
    guildId: GUILD_A,
    customId: 'recruitpanel_create_modal',
    fields: { getTextInputValue: () => { throw new Error('missing'); } },
    reply,
  });
  assert.match(replies.at(-1).content, /ゲーム名と時間/);
});

test('panel repeat modal revalidates its scoped source before creating', async (t) => {
  await isolateData(t);
  await initialize({
    mine: record({
      messageId: 'mine', game: 'DBD', time: '2099-08-22 21:00 Asia/Tokyo',
      capacity: 3, createdAt: 100, startAt: Date.UTC(2099, 7, 22, 12),
      startText: '2099-08-22 21:00', startTimeZone: 'Asia/Tokyo', reminderLeadMinutes: 30,
    }),
  });
  const replies = [];
  await recruitPanel.handleModal({
    customId: 'recruitpanel_repeat_modal:mine', guildId: GUILD_A,
    channelId: '52345678901234567', user: { id: HOST_A },
    fields: {
      getTextInputValue: (name) => ({
        game: 'DBD改', time: '23時', start: '2099-08-22 21:00', capacity: '',
      })[name],
    },
    reply: async (payload) => {
      replies.push(payload);
      return { resource: { message: { id: 'repeated' } } };
    },
  });

  const created = load('recruits').recruits.repeated;
  assert.equal(created.game, 'DBD改');
  assert.equal(created.time, '23時');
  assert.equal(created.capacity, 3);
  assert.equal(created.startText, '2099-08-22 21:00');
  assert.equal(created.reminderLeadMinutes, 30);
  assert.deepEqual(created.members, []);
});
