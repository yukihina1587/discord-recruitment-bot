import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const compose = readFileSync(new URL('../compose.yaml', import.meta.url), 'utf8');
const igdbCompose = readFileSync(new URL('../compose.igdb.yaml', import.meta.url), 'utf8');

test('container uses an isolated token, state volume, and bounded runtime', () => {
  assert.match(compose, /DISCORD_TOKEN_FILE: \/run\/secrets\/discord_token/);
  assert.match(compose, /- discord_token/);
  assert.match(compose, /- discord-bot-data:\/app\/data/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /cap_drop:\n      - ALL/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /pids_limit: \d+/);
  assert.match(compose, /mem_limit: \S+/);
  assert.match(compose, /cpus: [0-9.]+/);
});

test('container publishes no host port and uses only its egress network', () => {
  assert.doesNotMatch(compose, /^\s+ports:/m);
  assert.match(compose, /networks:\n      - discord-egress/);
  assert.match(compose, /^  discord-egress:\s*$/m);
});

test('token comes from a source-controlled-path-free secret file', () => {
  assert.match(
    compose,
    /^  discord_token:\n    file: \.\/secrets\/discord_token$/m,
  );
});

test('optional IGDB integration uses its own secret file', () => {
  assert.match(
    igdbCompose,
    /IGDB_CLIENT_SECRET_FILE: \/run\/secrets\/igdb_client_secret/,
  );
  assert.match(
    igdbCompose,
    /^  igdb_client_secret:\n    file: \.\/secrets\/igdb_client_secret$/m,
  );
});
