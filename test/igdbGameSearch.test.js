import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createIgdbGameSearch,
  createIgdbGameSearchFromEnv,
  igdbCoverUrl,
  parseIgdbChoiceValue,
} from '../lib/igdbGameSearch.js';

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test('IGDB search authenticates server-side, escapes input, normalizes results, and caches requests', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.includes('id.twitch.tv')) {
      return jsonResponse({ access_token: 'access-token', expires_in: 3600 });
    }
    return jsonResponse([
      {
        id: 123,
        name: 'Mecha Chameleon',
        cover: { image_id: 'co123_safe' },
        alternative_names: [{ name: 'めっちゃカメレオン' }],
        game_localizations: [{ name: 'メチャカメレオン' }],
      },
      { id: 'bad', name: 'invalid' },
    ]);
  };
  const search = createIgdbGameSearch({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    fetchImpl,
    now: () => 1_000,
    sleep: async () => {},
  });

  const first = await search.search('  \u0000めっちゃ"カメレオン\\  ');
  const second = await search.search('めっちゃ"カメレオン\\');

  assert.deepEqual(first, [{
    id: 123,
    name: 'Mecha Chameleon',
    imageId: 'co123_safe',
    aliases: ['めっちゃカメレオン', 'メチャカメレオン'],
  }]);
  assert.deepEqual(second, first);
  assert.equal(calls.length, 2);

  const auth = calls[0];
  assert.equal(auth.url, 'https://id.twitch.tv/oauth2/token');
  assert.equal(auth.options.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.doesNotMatch(auth.url, /client-secret/);
  assert.match(String(auth.options.body), /client_secret=client-secret/);

  const games = calls[1];
  assert.equal(games.options.headers['Client-ID'], 'client-id');
  assert.equal(games.options.headers.Authorization, 'Bearer access-token');
  assert.match(games.options.body, /search "めっちゃ\\"カメレオン\\\\";/u);
  assert.match(games.options.body, /fields name,cover\.image_id,alternative_names\.name,game_localizations\.name;/);
  assert.doesNotMatch(games.options.body, /\u0000/u);
});

test('IGDB selected ids are re-fetched and exact aliases resolve without guessing', async () => {
  const requestBodies = [];
  const fetchImpl = async (url, options) => {
    if (url.includes('id.twitch.tv')) {
      return jsonResponse({ access_token: 'token', expires_in: 3600 });
    }
    requestBodies.push(options.body);
    if (options.body.includes('where id = 42')) {
      return jsonResponse([{
        id: 42,
        name: 'The Chameleon',
        cover: { image_id: 'cover42' },
        alternative_names: [{ name: 'めっちゃカメレオン' }],
      }]);
    }
    return jsonResponse([
      { id: 42, name: 'The Chameleon', alternative_names: [{ name: 'めっちゃカメレオン' }] },
      { id: 99, name: 'Chameleon Run' },
    ]);
  };
  const search = createIgdbGameSearch({
    clientId: 'id', clientSecret: 'secret', fetchImpl, sleep: async () => {},
  });

  assert.equal((await search.getById(42))?.imageId, 'cover42');
  assert.equal((await search.findExact('ＭＥＣＨＡ　ＣＨＡＭＥＬＥＯＮ')), null);
  assert.equal((await search.findExact('めっちゃカメレオン'))?.id, 42);
  assert.ok(requestBodies.some((body) => body.includes('where id = 42')));
});

test('IGDB helpers accept only bounded ids and trusted image hashes', () => {
  assert.equal(parseIgdbChoiceValue('igdb:123'), 123);
  assert.equal(parseIgdbChoiceValue('igdb:0'), null);
  assert.equal(parseIgdbChoiceValue('igdb:1 OR 1=1'), null);
  assert.equal(parseIgdbChoiceValue('Apex'), null);
  assert.equal(
    igdbCoverUrl('co123_safe'),
    'https://images.igdb.com/igdb/image/upload/t_cover_big/co123_safe.jpg',
  );
  assert.equal(igdbCoverUrl('../secret'), null);
  assert.equal(igdbCoverUrl('x'.repeat(101)), null);
});

test('optional IGDB environment configuration disables cleanly and rejects partial credentials', () => {
  assert.equal(createIgdbGameSearchFromEnv({}), null);
  assert.equal(createIgdbGameSearchFromEnv({
    IGDB_CLIENT_SECRET_FILE: '/run/secrets/optional-igdb-secret',
  }), null);
  assert.throws(
    () => createIgdbGameSearchFromEnv({ IGDB_CLIENT_ID: 'client-id' }),
    /IGDB_CLIENT_SECRET/,
  );
  assert.throws(
    () => createIgdbGameSearchFromEnv({ IGDB_CLIENT_SECRET: 'secret' }),
    /IGDB_CLIENT_ID/,
  );

  const dir = mkdtempSync(join(tmpdir(), 'discord-bot-igdb-'));
  const secretFile = join(dir, 'client-secret');
  try {
    writeFileSync(secretFile, 'mounted-secret\n', { mode: 0o600 });
    const service = createIgdbGameSearchFromEnv({
      IGDB_CLIENT_ID: 'client-id',
      IGDB_CLIENT_SECRET_FILE: secretFile,
    }, { fetchImpl: async () => jsonResponse([]) });
    assert.equal(typeof service.search, 'function');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('IGDB failures do not expose credentials in error messages', async () => {
  const search = createIgdbGameSearch({
    clientId: 'client-id',
    clientSecret: 'super-secret-value',
    fetchImpl: async () => jsonResponse({ message: 'denied' }, 401),
  });

  await assert.rejects(
    search.search('Apex'),
    (error) => !String(error).includes('super-secret-value') && /IGDB認証/u.test(String(error)),
  );
});

test('IGDB client rejects invalid dependencies and malformed authentication responses', async () => {
  assert.throws(() => createIgdbGameSearch(), /IGDB_CLIENT_ID/);
  assert.throws(
    () => createIgdbGameSearch({ clientId: 'id' }),
    /IGDB_CLIENT_SECRET/,
  );
  assert.throws(
    () => createIgdbGameSearch({ clientId: 'id', clientSecret: 'secret', fetchImpl: null }),
    /fetchImpl/,
  );

  const malformedToken = createIgdbGameSearch({
    clientId: 'id',
    clientSecret: 'secret',
    fetchImpl: async () => jsonResponse({ access_token: '', expires_in: 0 }),
  });
  await assert.rejects(malformedToken.search('Apex'), /応答形式が不正/);

  const invalidJson = createIgdbGameSearch({
    clientId: 'id',
    clientSecret: 'secret',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad'); } }),
  });
  await assert.rejects(invalidJson.search('Apex'), /応答形式が不正/);
});

test('IGDB client handles empty searches, invalid ids, and unauthorized game responses safely', async () => {
  const search = createIgdbGameSearch({
    clientId: 'id',
    clientSecret: 'secret',
    fetchImpl: async (url) => url.includes('id.twitch.tv')
      ? jsonResponse({ access_token: 'token', expires_in: 3600 })
      : jsonResponse({ message: 'expired' }, 401),
  });

  assert.deepEqual(await search.search('a'), []);
  assert.equal(await search.getById(0), null);
  await assert.rejects(search.search('Apex'), /IGDBゲーム検索に失敗/);
  assert.equal(parseIgdbChoiceValue('igdb:9999999999999999'), null);
});
