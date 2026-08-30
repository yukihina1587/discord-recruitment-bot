import assert from 'node:assert/strict';
import test from 'node:test';

import { findFixedGame } from '../lib/gameCatalog.js';

test('fixed game catalog recognizes DBD aliases', () => {
  for (const alias of ['DBD', 'dbd', 'Dead by Daylight', 'デッドバイデイライト', 'デドバ']) {
    const game = findFixedGame(alias);
    assert.equal(game?.name, 'Dead by Daylight');
    assert.equal(game?.steamAppId, 381210);
  }
});

test('fixed game catalog recognizes R.E.P.O. aliases', () => {
  for (const alias of ['Repo', 'R.E.P.O.', 'r e p o', 'レポ']) {
    const game = findFixedGame(alias);
    assert.equal(game?.name, 'R.E.P.O.');
    assert.equal(game?.steamAppId, 3241660);
  }
});

test('fixed game catalog recognizes Phasmophobia aliases', () => {
  for (const alias of ['Phasmophobia', 'phasmo', 'ファズモフォビア', 'ファズモ']) {
    const game = findFixedGame(alias);
    assert.equal(game?.name, 'Phasmophobia');
    assert.equal(game?.steamAppId, 739630);
  }
});

test('fixed game catalog uses exact normalized aliases and fixed Steam image URLs', () => {
  assert.equal(findFixedGame('repository'), null);
  assert.equal(findFixedGame('dbd mobile'), null);
  assert.equal(findFixedGame(''), null);

  for (const alias of ['dbd', 'repo', 'phasmo']) {
    const game = findFixedGame(alias);
    const image = new URL(game.thumbnailUrl);
    assert.equal(image.protocol, 'https:');
    assert.equal(image.hostname, 'shared.akamai.steamstatic.com');
    assert.match(image.pathname, new RegExp(`/steam/apps/${game.steamAppId}/`));
  }
});
