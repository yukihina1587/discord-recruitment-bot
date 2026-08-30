import {
  Client,
  Events,
  GatewayIntentBits,
} from 'discord.js';
import { rmSync, writeFileSync } from 'node:fs';

import * as recruit from '../commands/recruit.js';
import * as recruitPanel from '../commands/recruitPanel.js';
import * as recruitSettings from '../commands/recruitSettings.js';
import * as recruitTemplates from '../commands/recruitTemplates.js';
import * as list from '../commands/list.js';
import * as poll from '../commands/poll.js';
import * as stats from '../commands/stats.js';
import * as xShareSettings from '../commands/xShareSettings.js';
import { requireSecret } from '../lib/env.js';
import { createIgdbGameSearchFromEnv } from '../lib/igdbGameSearch.js';

export const PUBLIC_COMMAND_KEYS = [
  'recruit',
  'recruitPanel',
  'recruitSettings',
  'recruitTemplates',
  'list',
  'poll',
  'stats',
  'xShareSettings',
];
export const PUBLIC_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildVoiceStates,
];
export const PUBLIC_RECRUIT_OPTIONS = Object.freeze({
  createPrivateVoiceChannels: false,
  enableXShare: true,
  mentionHere: true,
});

const commandModules = {
  recruit,
  recruitPanel,
  recruitSettings,
  recruitTemplates,
  list,
  poll,
  stats,
  xShareSettings,
};

export function publicCommandData() {
  return PUBLIC_COMMAND_KEYS.map((key) => commandModules[key].data);
}

function createCommandMap() {
  return new Map(
    PUBLIC_COMMAND_KEYS.map((key) => {
      const command = commandModules[key];
      return [command.data.name, command];
    }),
  );
}

export async function handlePublicInteraction(commands, interaction) {
  if (!interaction.guildId) {
    if (interaction.isRepliable()) {
      await interaction.reply({
        content: 'このコマンドはサーバー内でのみ利用できます。',
        ephemeral: true,
      });
    }
    return;
  }
  if (interaction.isAutocomplete?.()) {
    return commands.get(interaction.commandName)?.autocomplete?.(interaction);
  }
  if (interaction.isChatInputCommand()) {
    return commands.get(interaction.commandName)?.execute(interaction);
  }
  if (interaction.isButton()) {
    if (interaction.customId.startsWith('poll_')) return poll.handleButton(interaction);
    if (interaction.customId.startsWith('recruitpanel_')) return recruitPanel.handleButton(interaction);
    if (interaction.customId.startsWith('recruit_')) return recruit.handleButton(interaction);
  }
  if (interaction.isModalSubmit() && interaction.customId.startsWith('recruitpanel_')) {
    return recruitPanel.handleModal(interaction);
  }
  if (interaction.isModalSubmit() && interaction.customId.startsWith('recruit_')) {
    return recruit.handleModal(interaction);
  }
  return undefined;
}

export async function start(options = {}) {
  const client = options.client ?? new Client({ intents: PUBLIC_INTENTS });
  const commands = createCommandMap();
  const healthcheckFile = options.healthcheckFile
    ?? process.env.HEALTHCHECK_FILE
    ?? '/tmp/discord-bot-ready';
  const writeFile = options.writeFile ?? writeFileSync;
  const removeFile = options.removeFile ?? rmSync;
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const signals = options.signals ?? process;
  const exit = options.exit ?? ((code) => process.exit(code));
  const token = options.token ?? requireSecret('DISCORD_TOKEN');
  const gameSearch = Object.hasOwn(options, 'gameSearch')
    ? options.gameSearch
    : createIgdbGameSearchFromEnv(process.env);

  function updateHealthcheck() {
    if (client.isReady()) {
      writeFile(healthcheckFile, `${Date.now()}\n`, { mode: 0o600 });
    } else {
      removeFile(healthcheckFile, { force: true });
    }
  }

  function shutdown(signal) {
    console.log(`${signal}を受信したためDiscord接続を終了します`);
    removeFile(healthcheckFile, { force: true });
    client.destroy();
    exit(0);
  }

  signals.once('SIGTERM', () => shutdown('SIGTERM'));
  signals.once('SIGINT', () => shutdown('SIGINT'));

  client.once(Events.ClientReady, async (readyClient) => {
    console.log(`✅ 公開Botログイン成功: ${readyClient.user.tag}`);
    console.log(`   ${readyClient.guilds.cache.size} 個のサーバーで稼働中`);
    await recruit.init(readyClient, { ...PUBLIC_RECRUIT_OPTIONS, gameSearch });
    poll.init();
    updateHealthcheck();
    setIntervalFn(() => {
      recruit.tick().catch((error) => console.error('tickエラー:', error));
    }, 30_000);
    setIntervalFn(updateHealthcheck, 15_000);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      await handlePublicInteraction(commands, interaction);
    } catch (error) {
      console.error('インタラクション処理でエラー:', error);
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction
          .reply({ content: 'エラーが出ちゃった😢', ephemeral: true })
          .catch(() => {});
      }
    }
  });

  client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
    try {
      await recruit.handleVoiceStateUpdate(oldState, newState);
    } catch (error) {
      console.error('VoiceStateUpdate処理でエラー:', error);
    }
  });

  await client.login(token);
  return client;
}
