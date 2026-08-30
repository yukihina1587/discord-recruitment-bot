import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import * as recruit from '../commands/recruit.js';
import { load, save } from '../lib/store.js';

const GAME = Object.freeze({
  id: 123,
  name: 'The Chameleon',
  imageId: 'co123',
  aliases: ['めっちゃカメレオン'],
});

async function isolateData(t) {
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = await mkdtemp(join(tmpdir(), 'discord-bot-recruit-igdb-'));
  t.after(() => {
    if (previous === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous;
  });
}

function gameSearch() {
  return {
    search: async () => [GAME],
    getById: async (id) => (id === GAME.id ? GAME : null),
    findExact: async (name) => (name === 'めっちゃカメレオン' ? GAME : null),
  };
}

function interaction(game, messageId = 'message') {
  const replies = [];
  return {
    replies,
    value: {
      guildId: '12345678901234567',
      channelId: '22345678901234567',
      user: { id: '32345678901234567' },
      options: {
        getString: (name) => (name === 'ゲーム' ? game : null),
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

test('/募集 game option uses predictive autocomplete', () => {
  const option = recruit.data.toJSON().options.find(({ name }) => name === 'ゲーム');
  assert.equal(option.autocomplete, true);
});

test('game autocomplete merges fixed titles with IGDB predictions', async (t) => {
  await isolateData(t);
  await recruit.init({ channels: { fetch: async () => null } }, {
    createPrivateVoiceChannels: false,
    mentionHere: false,
    gameSearch: gameSearch(),
  });
  const responses = [];

  await recruit.autocomplete({
    guildId: '12345678901234567',
    user: { id: '32345678901234567' },
    options: { getFocused: () => ({ name: 'ゲーム', value: 'dead' }) },
    respond: async (choices) => responses.push(choices),
  });

  assert.ok(responses[0].some((choice) => choice.name === 'Dead by Daylight'));
  assert.ok(responses[0].some((choice) => choice.value === 'igdb:123'));
  assert.ok(responses[0].length <= 25);
});

test('selected IGDB choice stores a revalidated game id and renders its cover', async (t) => {
  await isolateData(t);
  await recruit.init({ channels: { fetch: async () => null } }, {
    createPrivateVoiceChannels: false,
    mentionHere: false,
    gameSearch: gameSearch(),
  });
  const created = interaction('igdb:123');

  await recruit.execute(created.value);

  const state = load('recruits').recruits.message;
  assert.equal(state.game, 'The Chameleon');
  assert.equal(state.gameProvider, 'igdb');
  assert.equal(state.gameExternalId, 123);
  assert.equal(state.gameImageId, 'co123');
  assert.equal(
    created.replies[0].embeds[0].data.thumbnail.url,
    'https://images.igdb.com/igdb/image/upload/t_cover_big/co123.jpg',
  );
});

test('free text uses an exact IGDB alias but ambiguous or unavailable input stays image-free', async (t) => {
  await isolateData(t);
  await recruit.init({ channels: { fetch: async () => null } }, {
    createPrivateVoiceChannels: false,
    mentionHere: false,
    gameSearch: gameSearch(),
  });

  const exact = interaction('めっちゃカメレオン', 'exact');
  await recruit.execute(exact.value);
  assert.equal(load('recruits').recruits.exact.gameExternalId, 123);

  const unknown = interaction('カメレオンっぽいゲーム', 'unknown');
  await recruit.execute(unknown.value);
  const unknownState = load('recruits').recruits.unknown;
  assert.equal(unknownState.game, 'カメレオンっぽいゲーム');
  assert.equal(unknownState.gameProvider, undefined);
  assert.equal(unknown.replies[0].embeds[0].data.thumbnail, undefined);
});

test('forged or stale IGDB choice is rejected instead of becoming a raw title', async (t) => {
  await isolateData(t);
  await recruit.init({ channels: { fetch: async () => null } }, {
    createPrivateVoiceChannels: false,
    mentionHere: false,
    gameSearch: gameSearch(),
  });
  const stale = interaction('igdb:999');

  await recruit.execute(stale.value);

  assert.equal(stale.replies[0].ephemeral, true);
  assert.match(stale.replies[0].content, /候補/u);
  assert.deepEqual(load('recruits').recruits, {});
});

test('persisted IGDB metadata is copied by history without another API call', async (t) => {
  await isolateData(t);
  save('recruits', {
    recruits: {
      history: {
        messageId: 'history',
        channelId: '22345678901234567',
        guildId: '12345678901234567',
        hostId: '32345678901234567',
        game: GAME.name,
        gameProvider: 'igdb',
        gameExternalId: GAME.id,
        gameImageId: GAME.imageId,
        time: '今から', capacity: 2, members: [], waitlist: [], closed: true, createdAt: 1,
      },
    },
    vcChannels: [],
  });
  await recruit.init({
    channels: { fetch: async () => ({ messages: { fetch: async () => ({ edit: async () => {} }) } }) },
  }, { createPrivateVoiceChannels: false, mentionHere: false, gameSearch: null });
  const copied = interaction(null, 'copied');
  copied.value.options.getString = (name) => (name === '履歴から' ? 'history' : null);

  await recruit.execute(copied.value);

  const state = load('recruits').recruits.copied;
  assert.equal(state.gameExternalId, GAME.id);
  assert.equal(state.gameImageId, GAME.imageId);
});

test('untrusted persisted IGDB image ids are removed before rendering', async (t) => {
  await isolateData(t);
  save('recruits', {
    recruits: {
      unsafe: {
        messageId: 'unsafe',
        channelId: '22345678901234567', guildId: '12345678901234567',
        hostId: '32345678901234567', game: 'Unsafe', time: '今から', capacity: 2,
        gameProvider: 'igdb', gameExternalId: 123, gameImageId: '../private',
        members: [], waitlist: [], closed: true, createdAt: 1,
      },
    },
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

  const state = load('recruits').recruits.unsafe;
  assert.equal(state.gameProvider, undefined);
  assert.equal(state.gameImageId, undefined);
  assert.equal(edits[0].embeds[0].data.thumbnail, undefined);
});
