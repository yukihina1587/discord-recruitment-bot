import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ApplicationIntegrationType,
  InteractionContextType,
} from 'discord.js';
import * as list from '../commands/list.js';
import * as poll from '../commands/poll.js';
import * as recruit from '../commands/recruit.js';
import * as recruitPanel from '../commands/recruitPanel.js';
import * as recruitSettings from '../commands/recruitSettings.js';
import * as recruitTemplates from '../commands/recruitTemplates.js';
import * as stats from '../commands/stats.js';
import * as xShareSettings from '../commands/xShareSettings.js';
import { handlePublicInteraction } from '../runtime/public.js';
import { save } from '../lib/store.js';

const sharedCommands = [
  recruit,
  recruitPanel,
  recruitSettings,
  recruitTemplates,
  list,
  poll,
  stats,
  xShareSettings,
];

test('all public commands are guild-install and guild-context only', () => {
  for (const command of sharedCommands) {
    const json = command.data.toJSON();
    assert.deepEqual(json.integration_types, [ApplicationIntegrationType.GuildInstall]);
    assert.deepEqual(json.contexts, [InteractionContextType.Guild]);
  }
});

test('public runtime rejects a DM before dispatching any handler', async () => {
  let executed = false;
  const replies = [];
  const commands = new Map([
    ['募集', { execute: async () => { executed = true; } }],
  ]);
  const interaction = {
    guildId: null,
    commandName: '募集',
    isChatInputCommand: () => true,
    isButton: () => false,
    isModalSubmit: () => false,
    isRepliable: () => true,
    reply: async (payload) => replies.push(payload),
  };

  await handlePublicInteraction(commands, interaction);

  assert.equal(executed, false);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].ephemeral, true);
});

test('public runtime routes persistent recruit panel buttons', async () => {
  const modals = [];
  await handlePublicInteraction(new Map(), {
    guildId: 'guild-a',
    customId: 'recruitpanel_create',
    user: { id: 'host' },
    isAutocomplete: () => false,
    isChatInputCommand: () => false,
    isButton: () => true,
    isModalSubmit: () => false,
    showModal: async (modal) => modals.push(modal.toJSON()),
  });

  assert.equal(modals[0].custom_id, 'recruitpanel_create_modal');
});

test('per-guild recruit limit does not block a different guild', async (t) => {
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = await mkdtemp(join(tmpdir(), 'discord-bot-recruit-limit-'));
  t.after(() => {
    process.env.DATA_DIR = previous;
  });
  const recruits = Object.fromEntries(
    Array.from({ length: 100 }, (_, index) => [
      `a-${index}`,
      {
        messageId: `a-${index}`,
        channelId: 'channel',
        guildId: 'guild-a',
        game: 'Apex',
        time: '今から',
        capacity: 2,
        hostId: 'host',
        members: [],
        waitlist: [],
        closed: false,
        createdAt: Date.now(),
      },
    ]),
  );
  save('recruits', { recruits, vcChannels: [] });
  await recruit.init(
    {
      channels: {
        fetch: async () => ({
          messages: { fetch: async () => ({ edit: async () => {} }) },
        }),
      },
    },
    { createPrivateVoiceChannels: false, mentionHere: false },
  );

  const aReplies = [];
  await recruit.execute(createRecruitInteraction('guild-a', aReplies));
  const bReplies = [];
  await recruit.execute(createRecruitInteraction('guild-b', bReplies));

  assert.equal(aReplies[0].ephemeral, true);
  assert.equal(bReplies[0].withResponse, true);
});

test('per-guild poll limit does not block a different guild', async (t) => {
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = await mkdtemp(join(tmpdir(), 'discord-bot-poll-limit-'));
  t.after(() => {
    process.env.DATA_DIR = previous;
  });
  const polls = Object.fromEntries(
    Array.from({ length: 100 }, (_, index) => [
      `a-${index}`,
      {
        guildId: 'guild-a',
        question: 'いつ？',
        options: ['20時', '21時'],
        votes: {},
      },
    ]),
  );
  save('polls', { polls });
  poll.init();

  const aReplies = [];
  await poll.execute(createPollInteraction('guild-a', aReplies));
  const bReplies = [];
  await poll.execute(createPollInteraction('guild-b', bReplies));

  assert.equal(aReplies[0].ephemeral, true);
  assert.equal(bReplies[0].withResponse, true);
});

function createRecruitInteraction(guildId, replies) {
  return {
    guildId,
    channelId: 'channel',
    user: { id: 'host' },
    options: {
      getString: (name) => (name === 'ゲーム' ? 'Apex' : null),
      getInteger: (name) => (name === 'あと何人' ? 2 : null),
    },
    reply: async (payload) => {
      replies.push(payload);
      return { resource: { message: { id: `${guildId}-new` } } };
    },
  };
}

function createPollInteraction(guildId, replies) {
  return {
    guildId,
    options: {
      getString: (name) => (name === '質問' ? 'いつ？' : '20時,21時'),
    },
    reply: async (payload) => {
      replies.push(payload);
      return { resource: { message: { id: `${guildId}-new` } } };
    },
  };
}
