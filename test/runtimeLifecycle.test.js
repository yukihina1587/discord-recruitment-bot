import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { Events, GatewayIntentBits } from 'discord.js';
import { start } from '../runtime/public.js';

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.user = { tag: 'public-test' };
    this.guilds = { cache: new Map() };
    this.channels = { fetch: async () => null };
    this.loggedInWith = null;
    this.destroyed = false;
  }

  isReady() {
    return true;
  }

  async login(token) {
    this.loggedInWith = token;
    this.emit(Events.ClientReady, this);
  }

  destroy() {
    this.destroyed = true;
  }
}

test('public runtime logs in, becomes ready, schedules work, and shuts down cleanly', async () => {
  const client = new FakeClient();
  const signals = new EventEmitter();
  const writes = [];
  const removals = [];
  const intervals = [];
  const exits = [];

  const result = await start({
    client,
    token: 'public-token',
    healthcheckFile: '/tmp/public-ready-test',
    writeFile: (...args) => writes.push(args),
    removeFile: (...args) => removals.push(args),
    setIntervalFn: (handler, delay) => {
      intervals.push({ handler, delay });
      return { unref() {} };
    },
    signals,
    exit: (code) => exits.push(code),
    gameSearch: null,
  });

  assert.equal(result, client);
  assert.equal(client.loggedInWith, 'public-token');
  assert.deepEqual(result.options?.intents ?? [GatewayIntentBits.Guilds], [GatewayIntentBits.Guilds]);
  assert.ok(writes.some(([path]) => path === '/tmp/public-ready-test'));
  assert.deepEqual(intervals.map(({ delay }) => delay), [30_000, 15_000]);

  signals.emit('SIGTERM');
  assert.equal(client.destroyed, true);
  assert.ok(removals.some(([path]) => path === '/tmp/public-ready-test'));
  assert.deepEqual(exits, [0]);
});
