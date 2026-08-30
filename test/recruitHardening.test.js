import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import * as recruit from '../commands/recruit.js';
import { load, save } from '../lib/store.js';

async function prepareRecruit(t, overrides = {}, runtimeOverrides = {}) {
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = await mkdtemp(join(tmpdir(), 'discord-bot-recruit-hardening-'));
  t.after(() => {
    process.env.DATA_DIR = previous;
  });
  const state = {
    messageId: 'message',
    channelId: 'channel',
    guildId: 'guild',
    game: 'Apex',
    time: '今から',
    capacity: 2,
    hostId: 'host',
    members: [],
    waitlist: [],
    vcId: null,
    closed: false,
    createdAt: Date.now(),
    ...overrides,
  };
  save('recruits', { recruits: { message: state }, vcChannels: [] });
  const edits = [];
  const sent = [];
  const createdVoiceChannels = [];
  await recruit.init(
    {
      user: { id: 'bot' },
      guilds: {
        fetch: async () => ({
          roles: { everyone: { id: 'everyone' } },
          channels: {
            create: async (payload) => {
              createdVoiceChannels.push(payload);
              return { id: 'voice' };
            },
          },
        }),
      },
      channels: {
        fetch: async () => ({
          messages: {
            fetch: async () => ({ edit: async (payload) => edits.push(payload) }),
          },
          send: async (payload) => sent.push(payload),
        }),
      },
    },
    { createPrivateVoiceChannels: false, mentionHere: false, ...runtimeOverrides },
  );
  return { edits, sent, createdVoiceChannels };
}

test('edit modal declares Discord text limits', async (t) => {
  await prepareRecruit(t);
  let shownModal;
  await recruit.handleButton({
    guildId: 'guild',
    customId: 'recruit_edit',
    message: { id: 'message' },
    user: { id: 'host' },
    showModal: async (modal) => { shownModal = modal.toJSON(); },
  });

  const inputs = shownModal.components.map((row) => row.components[0]);
  assert.equal(inputs.find((input) => input.custom_id === 'game').max_length, 100);
  assert.equal(inputs.find((input) => input.custom_id === 'time').max_length, 100);
  assert.equal(inputs.find((input) => input.custom_id === 'capacity').max_length, 2);
  assert.equal(inputs.find((input) => input.custom_id === 'start').max_length, 40);
  assert.equal(inputs.find((input) => input.custom_id === 'autoCloseDeadline').max_length, 103);
});

test('a fixed game renders its official name and Steam thumbnail', async (t) => {
  const { edits } = await prepareRecruit(t, { game: 'repo' });
  const embed = edits.at(-1).embeds[0].data;

  assert.match(embed.title, /R\.E\.P\.O\./);
  assert.match(embed.thumbnail.url, /steamstatic\.com\/store_item_assets\/steam\/apps\/3241660\//);
});

test('edit modal validates all fields before mutating state', async (t) => {
  await prepareRecruit(t);
  const replies = [];
  await recruit.handleModal(createEditModal({
    game: 'Changed',
    time: 'Changed time',
    capacity: '51',
  }, replies));

  const state = load('recruits').recruits.message;
  assert.equal(state.game, 'Apex');
  assert.equal(state.time, '今から');
  assert.equal(state.capacity, 2);
  assert.equal(replies[0].ephemeral, true);
});

test('add-more archives the old card and posts a fresh recruitment without old participants', async (t) => {
  const { edits, sent } = await prepareRecruit(t, {
    capacity: 49,
    members: ['remaining'],
    waitlist: ['waiting'],
    closed: true,
    closedReason: 'manual',
    startAt: Date.now() - 60_000,
    startText: '2025-01-01 21:00',
    startTimeZone: 'Asia/Tokyo',
  }, { mentionHere: true });
  const replies = [];
  await recruit.handleModal({
    guildId: 'guild',
    customId: 'recruit_addmore_modal',
    message: { id: 'message' },
    user: { id: 'host' },
    fields: { getTextInputValue: () => '1' },
    reply: async (payload) => {
      replies.push(payload);
      return { resource: { message: { id: 'new-message' } } };
    },
    editReply: async () => {},
  });

  const states = load('recruits').recruits;
  assert.equal(states.message.closed, true);
  assert.equal(states.message.supersededByMessageId, 'new-message');
  assert.deepEqual(states.message.members, ['remaining']);
  assert.deepEqual(states.message.waitlist, ['waiting']);
  assert.equal(states['new-message'].capacity, 1);
  assert.deepEqual(states['new-message'].members, []);
  assert.deepEqual(states['new-message'].waitlist, []);
  assert.equal(states['new-message'].hostId, 'host');
  assert.equal(states['new-message'].autoCloseEnabled, false);
  assert.equal(states['new-message'].startAt, null);
  assert.equal(states['new-message'].startText, null);
  assert.equal(states['new-message'].startTimeZone, null);

  const newFields = replies[0].embeds[0].data.fields;
  assert.match(replies[0].content, /@here/);
  assert.deepEqual(replies[0].allowedMentions, { parse: ['everyone'] });
  const openSlots = newFields.find((field) => field.name === '📣 あと何人');
  assert.equal(openSlots.value, 'あと 1 人');
  assert.doesNotMatch(openSlots.value, /\//);

  const archivedButtons = edits.at(-1).components
    .flatMap((row) => row.components)
    .map((button) => button.data ?? button.toJSON());
  assert.equal(archivedButtons.length, 1);
  assert.match(archivedButtons[0].url, /\/channels\/guild\/channel\/new-message$/);

  const duplicateReplies = [];
  await recruit.handleModal({
    guildId: 'guild',
    customId: 'recruit_addmore_modal',
    message: { id: 'message' },
    user: { id: 'host' },
    fields: { getTextInputValue: () => '1' },
    reply: async (payload) => duplicateReplies.push(payload),
  });
  assert.equal(Object.keys(load('recruits').recruits).length, 2);
  assert.equal(duplicateReplies[0].ephemeral, true);
  assert.match(duplicateReplies[0].content, /作成済み/);

  await recruit.handleButton({
    guildId: 'guild',
    customId: 'recruit_join',
    message: { id: 'new-message' },
    user: { id: 'newcomer' },
    update: async () => {},
    followUp: async () => {},
  });
  assert.match(sent.at(-1).content, /<@host>/);
  assert.match(sent.at(-1).content, /<@newcomer>/);
  assert.doesNotMatch(sent.at(-1).content, /remaining|waiting/);
});

test('a full recruitment keeps the leave button and reopens when a member leaves', async (t) => {
  const { edits } = await prepareRecruit(t, {
    capacity: 2,
    members: ['leaver', 'remaining'],
    closed: true,
    closedReason: 'full',
  });
  const initialButtons = edits.at(-1).components
    .flatMap((row) => row.components)
    .map((button) => button.data ?? button.toJSON());
  assert.equal(initialButtons.some((button) => button.custom_id === 'recruit_leave'), true);

  const updates = [];
  await recruit.handleButton({
    guildId: 'guild',
    customId: 'recruit_leave',
    message: { id: 'message' },
    user: { id: 'leaver' },
    update: async (payload) => updates.push(payload),
  });

  const state = load('recruits').recruits.message;
  assert.deepEqual(state.members, ['remaining']);
  assert.equal(state.closed, false);
  assert.equal(state.closedReason, null);
  assert.equal(state.autoCloseEnabled, false);
  assert.equal(state.closeAt, null);
  assert.match(updates.at(-1).content, /募集が立ってる/);
});

test('becoming full records a full close reason for later automatic reopening', async (t) => {
  await prepareRecruit(t, {
    capacity: 2,
    members: ['first'],
  });

  await recruit.handleButton({
    guildId: 'guild',
    customId: 'recruit_join',
    message: { id: 'message' },
    user: { id: 'second' },
    update: async () => {},
    followUp: async () => {},
  });

  const state = load('recruits').recruits.message;
  assert.equal(state.closed, true);
  assert.equal(state.closedReason, 'full');
});

test('a waiting member is promoted without reopening a full recruitment', async (t) => {
  await prepareRecruit(t, {
    capacity: 2,
    members: ['leaver', 'remaining'],
    waitlist: ['waiting'],
    closed: true,
    closedReason: 'full',
  });

  await recruit.handleButton({
    guildId: 'guild',
    customId: 'recruit_leave',
    message: { id: 'message' },
    user: { id: 'leaver' },
    update: async () => {},
    followUp: async () => {},
  });

  const state = load('recruits').recruits.message;
  assert.deepEqual(state.members, ['remaining', 'waiting']);
  assert.deepEqual(state.waitlist, []);
  assert.equal(state.closed, true);
  assert.equal(state.closedReason, 'full');
});

test('leaving does not reopen a recruitment closed manually', async (t) => {
  await prepareRecruit(t, {
    capacity: 2,
    members: ['leaver', 'remaining'],
    closed: true,
    closedReason: 'manual',
  });

  await recruit.handleButton({
    guildId: 'guild',
    customId: 'recruit_leave',
    message: { id: 'message' },
    user: { id: 'leaver' },
    update: async () => {},
  });

  const state = load('recruits').recruits.message;
  assert.equal(state.closed, true);
  assert.equal(state.closedReason, 'manual');
});

test('an open recruitment offers notified close and silent end as explicit actions', async (t) => {
  const { edits, sent, createdVoiceChannels } = await prepareRecruit(t, {
    members: ['member'],
  }, { createPrivateVoiceChannels: true });

  const buttons = edits.at(-1).components
    .flatMap((row) => row.components)
    .map((button) => button.data ?? button.toJSON());
  assert.equal(
    buttons.find((button) => button.custom_id === 'recruit_close')?.label,
    '集合して締切',
  );
  assert.equal(
    buttons.find((button) => button.custom_id === 'recruit_close_silent')?.label,
    '通知せず終了',
  );

  const updates = [];
  const followUps = [];
  await recruit.handleButton({
    guildId: 'guild',
    customId: 'recruit_close_silent',
    message: { id: 'message' },
    user: { id: 'host' },
    update: async (payload) => updates.push(payload),
    followUp: async (payload) => followUps.push(payload),
  });

  const state = load('recruits').recruits.message;
  assert.equal(state.closed, true);
  assert.equal(state.closedReason, 'manual');
  assert.equal(sent.length, 0);
  assert.equal(createdVoiceChannels.length, 0);
  assert.equal(updates.length, 1);
  assert.deepEqual(followUps, [{ content: '🔕 通知せず募集を終了しました。', ephemeral: true }]);
});

test('only the host can silently end a recruitment', async (t) => {
  const { sent } = await prepareRecruit(t, { members: ['member'] });
  const replies = [];

  await recruit.handleButton({
    guildId: 'guild',
    customId: 'recruit_close_silent',
    message: { id: 'message' },
    user: { id: 'member' },
    reply: async (payload) => replies.push(payload),
  });

  const state = load('recruits').recruits.message;
  assert.equal(state.closed, false);
  assert.equal(sent.length, 0);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].ephemeral, true);
  assert.match(replies[0].content, /募集を立てた人だけ/);
});

test('large member and waitlist data renders within Discord field limits', async (t) => {
  const members = Array.from({ length: 50 }, (_, index) => `12345678901234${String(index).padStart(3, '0')}`);
  const waitlist = Array.from({ length: 50 }, (_, index) => `22345678901234${String(index).padStart(3, '0')}`);
  const { edits } = await prepareRecruit(t, {
    capacity: 50,
    members,
    waitlist,
  });

  assert.ok(edits.length > 0);
  const fields = edits.at(-1).embeds[0].data.fields;
  assert.ok(fields.every((field) => field.value.length <= 1_024));
  assert.ok(fields.length <= 25);
});

function createEditModal(values, replies) {
  return {
    guildId: 'guild',
    customId: 'recruit_edit_modal',
    message: { id: 'message' },
    user: { id: 'host' },
    fields: { getTextInputValue: (name) => values[name] },
    reply: async (payload) => replies.push(payload),
    update: async () => {},
  };
}
