import assert from 'node:assert/strict';
import test from 'node:test';

import { deployCommands } from '../deploy-commands.js';

const routes = {
  applicationCommands: (clientId) => `global:${clientId}`,
  applicationGuildCommands: (clientId, guildId) => `guild:${clientId}:${guildId}`,
};

function createRest({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    setToken(token) {
      this.token = token;
      return this;
    },
    async put(route, options) {
      calls.push({ route, options });
      if (fail) throw new Error('Discord unavailable');
    },
  };
}

test('deploys exactly eight commands globally by default', async () => {
  const rest = createRest();
  const result = await deployCommands({
    environment: {
      CLIENT_ID: '12345678901234567',
      DISCORD_TOKEN: 'test-token',
    },
    rest,
    routes,
  });

  assert.deepEqual(result, { count: 8, scope: 'global' });
  assert.equal(rest.calls[0].route, 'global:12345678901234567');
  assert.equal(rest.calls[0].options.body.length, 8);
});

test('uses a staging guild when configured', async () => {
  const rest = createRest();
  const result = await deployCommands({
    environment: {
      CLIENT_ID: '12345678901234567',
      PUBLIC_STAGING_GUILD_ID: '23456789012345678',
      DISCORD_TOKEN: 'test-token',
    },
    rest,
    routes,
  });

  assert.deepEqual(result, { count: 8, scope: 'guild' });
  assert.equal(rest.calls[0].route, 'guild:12345678901234567:23456789012345678');
});

test('surfaces Discord registration failures', async () => {
  await assert.rejects(
    deployCommands({
      environment: {
        CLIENT_ID: '12345678901234567',
        DISCORD_TOKEN: 'test-token',
      },
      rest: createRest({ fail: true }),
      routes,
    }),
    /Discord unavailable/,
  );
});
