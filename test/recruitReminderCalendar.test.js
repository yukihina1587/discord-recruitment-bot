import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import * as recruit from '../commands/recruit.js';
import { load, save } from '../lib/store.js';

const GUILD_ID = '12345678901234567';
const CHANNEL_ID = '22345678901234567';
const HOST_ID = '32345678901234567';
const MESSAGE_ID = '42345678901234567';

async function isolateData(t) {
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = await mkdtemp(join(tmpdir(), 'discord-bot-reminder-calendar-'));
  t.after(() => {
    if (previous === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous;
  });
}

function baseState(overrides = {}) {
  return {
    messageId: MESSAGE_ID,
    channelId: CHANNEL_ID,
    guildId: GUILD_ID,
    game: 'DBD',
    time: '2099-08-07 21:00 Asia/Tokyo',
    capacity: 2,
    hostId: HOST_ID,
    members: [],
    waitlist: [],
    vcId: null,
    closed: false,
    closedReason: null,
    createdAt: Date.now(),
    autoCloseEnabled: false,
    closeAt: null,
    closeText: null,
    startAt: Date.UTC(2099, 7, 7, 12, 0),
    startText: '2099-08-07 21:00',
    startTimeZone: 'Asia/Tokyo',
    reminderLeadMinutes: null,
    reminderSentAt: null,
    reminderLastAttemptAt: null,
    ...overrides,
  };
}

function createClient({ edits = [], send = async () => {} } = {}) {
  return {
    channels: {
      fetch: async () => ({
        messages: {
          fetch: async () => ({ edit: async (payload) => edits.push(payload) }),
        },
        send,
      }),
    },
  };
}

function componentData(payload) {
  return payload.components
    .flatMap((row) => row.components)
    .map((component) => component.data ?? component.toJSON());
}

function createRecruitInteraction({
  messageId = MESSAGE_ID,
  strings = { ゲーム: 'DBD', 開始日時: '2099-08-07 21:00' },
  integers = { あと何人: 2 },
  booleans = { 事前通知: true },
  replies = [],
  editReplies = [],
} = {}) {
  return {
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    user: { id: HOST_ID },
    options: {
      getString: (name) => strings[name] ?? null,
      getInteger: (name) => integers[name] ?? null,
      getBoolean: (name) => booleans[name] ?? null,
    },
    reply: async (payload) => {
      replies.push(payload);
      return { resource: { message: { id: messageId } } };
    },
    editReply: async (payload) => editReplies.push(payload),
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

function createEditInteraction(start, updates = []) {
  return {
    guildId: GUILD_ID,
    customId: 'recruit_edit_modal',
    message: { id: MESSAGE_ID },
    user: { id: HOST_ID },
    fields: {
      getTextInputValue: (name) => ({
        game: 'DBD',
        time: '日時未定',
        capacity: '2',
        start,
        autoCloseDeadline: 'OFF',
      })[name],
    },
    reply: async (payload) => updates.push(payload),
    update: async (payload) => updates.push(payload),
  };
}

test('/募集 exposes an intuitive reminder toggle with bounded custom minutes', async (t) => {
  await isolateData(t);
  const options = Object.fromEntries(recruit.data.toJSON().options.map((option) => [option.name, option]));
  assert.equal(options.事前通知.type, 5);
  assert.equal(options.事前通知.required, false);
  assert.equal(options.通知分.type, 4);
  assert.equal(options.通知分.min_value, 1);
  assert.equal(options.通知分.max_value, 10_080);

  await recruit.init(createClient(), { createPrivateVoiceChannels: false, mentionHere: false });
  const replies = [];
  await recruit.execute(createRecruitInteraction({
    strings: { ゲーム: 'DBD' },
    integers: { あと何人: 2 },
    booleans: { 事前通知: true },
    replies,
  }));

  assert.equal(replies[0].ephemeral, true);
  assert.match(replies[0].content, /開始日時/);
  assert.deepEqual(load('recruits', { recruits: {} }).recruits, {});
});

test('reminder enabled defaults to 30 minutes and accepts a custom minute value', async (t) => {
  await isolateData(t);
  await recruit.init(createClient(), { createPrivateVoiceChannels: false, mentionHere: false });
  await recruit.execute(createRecruitInteraction({ messageId: 'default' }));
  await recruit.execute(createRecruitInteraction({
    messageId: 'custom',
    integers: { あと何人: 2, 通知分: 90 },
  }));

  const states = load('recruits').recruits;
  assert.equal(states.default.reminderLeadMinutes, 30);
  assert.equal(states.custom.reminderLeadMinutes, 90);
});

test('date-only recruitment requires a time only when a reminder is requested', async (t) => {
  await isolateData(t);
  await recruit.init(createClient(), { createPrivateVoiceChannels: false, mentionHere: false });
  const replies = [];

  await recruit.execute(createRecruitInteraction({
    strings: { ゲーム: 'DBD', 開始日時: '2099-08-07' },
    booleans: { 事前通知: true },
    replies,
  }));

  assert.equal(replies[0].ephemeral, true);
  assert.match(replies[0].content, /事前通知.*時刻/u);
  assert.deepEqual(load('recruits', { recruits: {} }).recruits, {});
});

test('date-only recruitment creates an all-day Google Calendar link', async (t) => {
  await isolateData(t);
  const editReplies = [];
  await recruit.init(createClient(), {
    createPrivateVoiceChannels: false,
    enableXShare: true,
    mentionHere: false,
  });

  await recruit.execute(createRecruitInteraction({
    strings: { ゲーム: 'DBD', 開始日時: '2099-08-07' },
    booleans: {},
    editReplies,
  }));

  const calendarButton = componentData(editReplies.at(-1))
    .find((button) => button.label === 'カレンダーに追加');
  assert.ok(calendarButton);
  const url = new URL(calendarButton.url);
  assert.equal(url.searchParams.get('dates'), '20990807/20990808');
});

test('calendar link uses fixed Google origin, UTC dates, bounded sanitized text, and coexists with X', async (t) => {
  await isolateData(t);
  const replies = [];
  const editReplies = [];
  await recruit.init(createClient(), {
    createPrivateVoiceChannels: false,
    enableXShare: true,
    mentionHere: false,
  });
  await recruit.execute(createRecruitInteraction({
    strings: {
      ゲーム: `@everyone\n${'🎮'.repeat(40)}`,
      開始日時: '2099-08-07 21:00',
    },
    replies,
    editReplies,
  }));

  const rendered = editReplies.at(-1);
  const buttons = componentData(rendered);
  const calendarButton = buttons.find((button) => button.label === 'カレンダーに追加');
  assert.ok(calendarButton);
  assert.ok(buttons.some((button) => button.label === 'Xで共有'));
  assert.ok(rendered.components.every((row) => row.components.length <= 5));
  assert.ok(rendered.components.length <= 5);
  assert.ok(calendarButton.url.length <= 512);

  const url = new URL(calendarButton.url);
  assert.equal(url.origin, 'https://calendar.google.com');
  assert.equal(url.pathname, '/calendar/render');
  assert.equal(url.searchParams.get('action'), 'TEMPLATE');
  assert.equal(url.searchParams.get('dates'), '20990807T120000Z/20990807T140000Z');
  assert.doesNotMatch(url.searchParams.get('text'), /@everyone|[\r\n\u0000-\u001f]/u);
  assert.ok(url.searchParams.get('text').length <= 80);
  assert.ok(url.searchParams.get('details').length <= 300);

  const state = load('recruits').recruits[MESSAGE_ID];
  assert.equal(state.reminderLeadMinutes, 30);
  assert.equal(state.reminderSentAt, null);
});

test('calendar link is profile-independent but X remains public-only', async (t) => {
  await isolateData(t);
  save('recruits', { schemaVersion: 3, recruits: { [MESSAGE_ID]: baseState() }, vcChannels: [] });
  const edits = [];

  await recruit.init(createClient({ edits }), {
    createPrivateVoiceChannels: false,
    enableXShare: false,
    mentionHere: false,
  });

  const buttons = componentData(edits.at(-1));
  assert.ok(buttons.some((button) => button.label === 'カレンダーに追加'));
  assert.equal(buttons.some((button) => button.label === 'Xで共有'), false);
});

test('overlapping ticks send one mention-free reminder and persisted success survives restart', async (t) => {
  await isolateData(t);
  const now = Date.now();
  save('recruits', {
    schemaVersion: 4,
    recruits: {
      [MESSAGE_ID]: baseState({
        game: '@everyone <@99999999999999999>',
        startAt: now + 30 * 60_000,
        reminderLeadMinutes: 60,
      }),
    },
    vcChannels: [],
  });
  const sends = [];
  let releaseSend;
  const blockedSend = new Promise((resolve) => { releaseSend = resolve; });
  await recruit.init(createClient({
    send: async (payload) => {
      sends.push(payload);
      await blockedSend;
    },
  }), { createPrivateVoiceChannels: false, mentionHere: false });

  const first = recruit.tick(now);
  const second = recruit.tick(now);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends.length, 1);
  releaseSend();
  await Promise.all([first, second]);

  assert.deepEqual(sends[0].allowedMentions, { parse: [] });
  assert.doesNotMatch(sends[0].content, /@everyone|<@/);
  assert.ok(Number.isFinite(load('recruits').recruits[MESSAGE_ID].reminderSentAt));

  const sendsAfterRestart = [];
  await recruit.init(createClient({ send: async (payload) => sendsAfterRestart.push(payload) }), {
    createPrivateVoiceChannels: false,
    mentionHere: false,
  });
  await recruit.tick(now + 60_000);
  assert.deepEqual(sendsAfterRestart, []);
});

test('an edit while channel fetch is pending cancels the stale delivery without corrupting replacement state', async (t) => {
  await isolateData(t);
  const now = Date.now();
  save('recruits', {
    schemaVersion: 4,
    recruits: {
      [MESSAGE_ID]: baseState({
        startAt: now + 5 * 60_000,
        reminderLeadMinutes: 10,
      }),
    },
    vcChannels: [],
  });
  const sends = [];
  let initialized = false;
  let releaseFetch;
  let markFetchStarted;
  const fetchStarted = new Promise((resolve) => { markFetchStarted = resolve; });
  const blockedFetch = new Promise((resolve) => { releaseFetch = resolve; });
  let shouldBlock = true;
  const channel = {
    messages: { fetch: async () => ({ edit: async () => {} }) },
    send: async (payload) => sends.push(payload),
  };
  await recruit.init({
    channels: {
      fetch: async () => {
        if (initialized && shouldBlock) {
          shouldBlock = false;
          markFetchStarted();
          await blockedFetch;
        }
        return channel;
      },
    },
  }, { createPrivateVoiceChannels: false, mentionHere: false });
  initialized = true;

  const pendingTick = recruit.tick(now);
  await fetchStarted;
  const replacementText = formatTokyoMinute(now + 10 * 60_000);
  await recruit.handleModal(createEditInteraction(`${replacementText} | 20`));
  releaseFetch();
  await pendingTick;

  let state = load('recruits').recruits[MESSAGE_ID];
  assert.equal(sends.length, 0);
  assert.equal(state.reminderLeadMinutes, 20);
  assert.equal(state.reminderSentAt, null);
  assert.equal(state.reminderLastAttemptAt, null);

  await recruit.tick(Date.now());
  state = load('recruits').recruits[MESSAGE_ID];
  assert.equal(sends.length, 1);
  assert.ok(Number.isFinite(state.reminderSentAt));
  assert.match(sends[0].content, new RegExp(`<t:${Math.floor(state.startAt / 1_000)}:F>`));
});

test('an edit while Discord send is pending does not mark the replacement schedule as sent', async (t) => {
  await isolateData(t);
  const now = Date.now();
  save('recruits', {
    schemaVersion: 4,
    recruits: {
      [MESSAGE_ID]: baseState({ startAt: now + 5 * 60_000, reminderLeadMinutes: 10 }),
    },
    vcChannels: [],
  });
  const sends = [];
  let releaseFirstSend;
  let markSendStarted;
  const sendStarted = new Promise((resolve) => { markSendStarted = resolve; });
  const blockedSend = new Promise((resolve) => { releaseFirstSend = resolve; });
  await recruit.init(createClient({
    send: async (payload) => {
      sends.push(payload);
      if (sends.length === 1) {
        markSendStarted();
        await blockedSend;
      }
    },
  }), { createPrivateVoiceChannels: false, mentionHere: false });

  const pendingTick = recruit.tick(now);
  await sendStarted;
  const replacementText = formatTokyoMinute(now + 10 * 60_000);
  await recruit.handleModal(createEditInteraction(`${replacementText} | 20`));
  releaseFirstSend();
  await pendingTick;

  let state = load('recruits').recruits[MESSAGE_ID];
  assert.equal(state.reminderSentAt, null);
  assert.equal(state.reminderLastAttemptAt, null);

  await recruit.tick(Date.now());
  state = load('recruits').recruits[MESSAGE_ID];
  assert.equal(sends.length, 2);
  assert.ok(Number.isFinite(state.reminderSentAt));
});

test('reminder text neutralizes Markdown links and invisible spoofing and reports actual remaining time', async (t) => {
  await isolateData(t);
  const now = Date.now();
  save('recruits', {
    schemaVersion: 4,
    recruits: {
      [MESSAGE_ID]: baseState({
        game: '[click](https://evil.example)\u202E\u2066\u200B @everyone',
        startAt: now + 5 * 60_000,
        reminderLeadMinutes: 10,
      }),
    },
    vcChannels: [],
  });
  const sends = [];
  await recruit.init(createClient({ send: async (payload) => sends.push(payload) }), {
    createPrivateVoiceChannels: false,
    mentionHere: false,
  });

  await recruit.tick(now);

  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0].allowedMentions, { parse: [] });
  assert.doesNotMatch(sends[0].content, /\]\(|@everyone|[\u061c\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069]/u);
  assert.match(sends[0].content, /開始まで5分です/);
  assert.ok(sends[0].content.length <= 240);
});

test('a reminder sent less than one minute before start uses precise wording', async (t) => {
  await isolateData(t);
  const now = Date.now();
  save('recruits', {
    schemaVersion: 4,
    recruits: {
      [MESSAGE_ID]: baseState({ startAt: now + 30_000, reminderLeadMinutes: 1 }),
    },
    vcChannels: [],
  });
  const sends = [];
  await recruit.init(createClient({ send: async (payload) => sends.push(payload) }), {
    createPrivateVoiceChannels: false,
    mentionHere: false,
  });

  await recruit.tick(now);

  assert.match(sends[0].content, /開始まで1分未満です/);
});

test('recruitment card displays its configured reminder lead', async (t) => {
  await isolateData(t);
  const edits = [];
  save('recruits', {
    schemaVersion: 4,
    recruits: { [MESSAGE_ID]: baseState({ reminderLeadMinutes: 30 }) },
    vcChannels: [],
  });

  await recruit.init(createClient({ edits }), {
    createPrivateVoiceChannels: false,
    mentionHere: false,
  });

  const reminderField = edits.at(-1).embeds[0].data.fields
    .find((field) => field.name === '🔔 事前通知');
  assert.equal(reminderField.value, '30分前');
});

test('fetch and send failures retry at most once per interval and stop at the start time', async (t) => {
  await isolateData(t);
  const now = Date.now();
  save('recruits', {
    schemaVersion: 4,
    recruits: {
      [MESSAGE_ID]: baseState({
        startAt: now + 5 * 60_000,
        reminderLeadMinutes: 10,
      }),
    },
    vcChannels: [],
  });
  let fetches = 0;
  let sends = 0;
  let initialized = false;
  const client = {
    channels: {
      fetch: async () => {
        fetches += 1;
        if (!initialized) {
          return {
            messages: { fetch: async () => ({ edit: async () => {} }) },
            send: async () => {},
          };
        }
        if (fetches === 1) return null;
        return {
          messages: { fetch: async () => ({ edit: async () => {} }) },
          send: async () => {
            sends += 1;
            if (sends === 1) throw new Error('temporary send failure');
          },
        };
      },
    },
  };
  await recruit.init(client, { createPrivateVoiceChannels: false, mentionHere: false });
  initialized = true;
  fetches = 0;

  await recruit.tick(now);
  await recruit.tick(now + 29_999);
  assert.equal(fetches, 1);
  await recruit.tick(now + 30_000);
  assert.equal(sends, 1);
  await recruit.tick(now + 60_000);
  assert.equal(sends, 2);
  assert.ok(Number.isFinite(load('recruits').recruits[MESSAGE_ID].reminderSentAt));

  await recruit.tick(now + 5 * 60_000);
  assert.equal(sends, 2);
});

test('editing a start or lead resets delivery and refreshes/removes the calendar link', async (t) => {
  await isolateData(t);
  save('recruits', {
    schemaVersion: 4,
    recruits: {
      [MESSAGE_ID]: baseState({
        reminderLeadMinutes: 30,
        reminderSentAt: Date.now(),
        reminderLastAttemptAt: Date.now(),
      }),
    },
    vcChannels: [],
  });
  await recruit.init(createClient(), { createPrivateVoiceChannels: false, mentionHere: false });
  const updates = [];
  const submit = async (start) => recruit.handleModal({
    guildId: GUILD_ID,
    customId: 'recruit_edit_modal',
    message: { id: MESSAGE_ID },
    user: { id: HOST_ID },
    fields: {
      getTextInputValue: (name) => ({
        game: 'DBD',
        time: '2099-08-07 21:00 Asia/Tokyo',
        capacity: '2',
        start,
        autoCloseDeadline: 'OFF',
      })[name],
    },
    reply: async (payload) => updates.push(payload),
    update: async (payload) => updates.push(payload),
  });

  await submit('2099-08-08 22:30 | 45');
  let state = load('recruits').recruits[MESSAGE_ID];
  assert.equal(state.startAt, Date.UTC(2099, 7, 8, 13, 30));
  assert.equal(state.reminderLeadMinutes, 45);
  assert.equal(state.reminderSentAt, null);
  assert.equal(state.reminderLastAttemptAt, null);
  let calendarUrl = new URL(componentData(updates.at(-1))
    .find((button) => button.label === 'カレンダーに追加').url);
  assert.equal(calendarUrl.searchParams.get('dates'), '20990808T133000Z/20990808T153000Z');

  await submit('');
  state = load('recruits').recruits[MESSAGE_ID];
  assert.equal(state.startAt, null);
  assert.equal(state.reminderLeadMinutes, null);
  assert.equal(componentData(updates.at(-1))
    .some((button) => button.label === 'カレンダーに追加'), false);
});

test('closed, timed-out, and already-started recruitments never send reminders', async (t) => {
  await isolateData(t);
  const now = Date.now();
  save('recruits', {
    schemaVersion: 4,
    recruits: {
      closed: baseState({ messageId: 'closed', closed: true, startAt: now + 60_000, reminderLeadMinutes: 5 }),
      expired: baseState({ messageId: 'expired', startAt: now, reminderLeadMinutes: 5 }),
      timedOut: baseState({
        messageId: 'timedOut',
        startAt: now + 60_000,
        reminderLeadMinutes: 5,
        autoCloseEnabled: true,
        closeAt: now,
        closeText: '今',
      }),
    },
    vcChannels: [],
  });
  const sends = [];
  await recruit.init(createClient({ send: async (payload) => sends.push(payload) }), {
    createPrivateVoiceChannels: false,
    mentionHere: false,
  });

  await recruit.tick(now);

  assert.equal(sends.filter((payload) => /開始まで/.test(payload.content)).length, 0);
  assert.equal(load('recruits').recruits.timedOut.closedReason, 'timeout');
});

test('repeat and add-more copy only a future reminder schedule and never sent state', async (t) => {
  await isolateData(t);
  const futureStart = Date.UTC(2099, 7, 7, 12, 0);
  save('recruits', {
    schemaVersion: 4,
    recruits: {
      previous: baseState({
        messageId: 'previous',
        closed: true,
        createdAt: 100,
        startAt: futureStart,
        reminderLeadMinutes: 30,
        reminderSentAt: Date.now(),
        reminderLastAttemptAt: Date.now(),
      }),
    },
    vcChannels: [],
  });
  await recruit.init(createClient(), { createPrivateVoiceChannels: false, mentionHere: false });

  await recruit.execute(createRecruitInteraction({
    messageId: 'repeated',
    strings: {},
    integers: {},
    booleans: { 前回を複製: true },
  }));
  let state = load('recruits').recruits.repeated;
  assert.equal(state.startAt, futureStart);
  assert.equal(state.reminderLeadMinutes, 30);
  assert.equal(state.reminderSentAt, null);

  await recruit.handleModal({
    guildId: GUILD_ID,
    customId: 'recruit_addmore_modal',
    message: { id: 'previous' },
    user: { id: HOST_ID },
    fields: { getTextInputValue: () => '1' },
    reply: async () => ({ resource: { message: { id: 'additional' } } }),
  });
  state = load('recruits').recruits.additional;
  assert.equal(state.startAt, futureStart);
  assert.equal(state.reminderLeadMinutes, 30);
  assert.equal(state.reminderSentAt, null);
  assert.equal(state.reminderLastAttemptAt, null);
});

test('schema 3 records migrate safely with reminders off', async (t) => {
  await isolateData(t);
  save('recruits', {
    schemaVersion: 3,
    recruits: { [MESSAGE_ID]: baseState({
      reminderLeadMinutes: undefined,
      reminderSentAt: undefined,
      reminderLastAttemptAt: undefined,
    }) },
    vcChannels: [],
  });

  await recruit.init(createClient(), { createPrivateVoiceChannels: false, mentionHere: false });

  const database = load('recruits');
  assert.equal(database.schemaVersion, 5);
  assert.equal(database.recruits[MESSAGE_ID].reminderLeadMinutes, null);
  assert.equal(database.recruits[MESSAGE_ID].reminderSentAt, null);
  assert.equal(database.recruits[MESSAGE_ID].reminderLastAttemptAt, null);
});
