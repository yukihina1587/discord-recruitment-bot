import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { GatewayIntentBits } from 'discord.js';
import {
  PUBLIC_COMMAND_KEYS,
  PUBLIC_INTENTS,
  PUBLIC_RECRUIT_OPTIONS,
} from '../runtime/public.js';
import { deploymentRoute } from '../runtime/deployment.js';

test('runtime exposes exactly the eight distribution commands', async () => {
  const source = await readFile(new URL('../runtime/public.js', import.meta.url), 'utf8');

  assert.deepEqual(PUBLIC_COMMAND_KEYS, [
    'recruit',
    'recruitPanel',
    'recruitSettings',
    'recruitTemplates',
    'list',
    'poll',
    'stats',
    'xShareSettings',
  ]);
  assert.doesNotMatch(
    source,
    /voiceTts|ttsClient|homelab|palworld|commands\/setup|serverSetup/i,
  );
  assert.deepEqual(PUBLIC_INTENTS, [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ]);
  assert.deepEqual(PUBLIC_RECRUIT_OPTIONS, {
    createPrivateVoiceChannels: false,
    enableXShare: true,
    mentionHere: true,
  });
});

test('deploys globally or to an explicit staging guild', () => {
  const routes = {
    applicationGuildCommands: (clientId, guildId) => `guild:${clientId}:${guildId}`,
    applicationCommands: (clientId) => `global:${clientId}`,
  };

  assert.equal(
    deploymentRoute({ CLIENT_ID: '12345678901234567' }, routes),
    'global:12345678901234567',
  );
  assert.equal(
    deploymentRoute({
      CLIENT_ID: '12345678901234567',
      PUBLIC_STAGING_GUILD_ID: '23456789012345678',
    }, routes),
    'guild:12345678901234567:23456789012345678',
  );
});

test('rejects malformed Discord IDs', () => {
  const routes = {
    applicationGuildCommands: () => 'guild',
    applicationCommands: () => 'global',
  };
  assert.throws(
    () => deploymentRoute({ CLIENT_ID: 'not-an-id' }, routes),
    /CLIENT_ID/,
  );
  assert.throws(
    () => deploymentRoute({
      CLIENT_ID: '12345678901234567',
      PUBLIC_STAGING_GUILD_ID: '../guild',
    }, routes),
    /PUBLIC_STAGING_GUILD_ID/,
  );
});
