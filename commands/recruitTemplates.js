import {
  ApplicationIntegrationType,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import {
  deleteRecruitPreset,
  listRecruitPresets,
  setRecruitPreset,
} from '../lib/recruitSettings.js';

const MAX_DISCORD_CONTENT_LENGTH = 2_000;

export const data = new SlashCommandBuilder()
  .setName('テンプレ管理')
  .setDescription('このサーバーの募集テンプレートを管理します')
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((subcommand) => subcommand
    .setName('保存')
    .setDescription('募集テンプレートを保存または上書きします')
    .addStringOption((option) => option
      .setName('名前')
      .setDescription('テンプレート名（32文字以内）')
      .setMinLength(1)
      .setMaxLength(32)
      .setRequired(true))
    .addStringOption((option) => option
      .setName('ゲーム')
      .setDescription('遊ぶゲーム名')
      .setMinLength(1)
      .setMaxLength(100)
      .setRequired(true))
    .addStringOption((option) => option
      .setName('時間')
      .setDescription('表示用の時間（例: 毎週金曜21時）')
      .setMinLength(1)
      .setMaxLength(100)
      .setRequired(true))
    .addIntegerOption((option) => option
      .setName('あと何人')
      .setDescription('主催者を除く募集人数（省略すると無制限）')
      .setMinValue(1)
      .setMaxValue(50)
      .setRequired(false)))
  .addSubcommand((subcommand) => subcommand
    .setName('削除')
    .setDescription('募集テンプレートを削除します')
    .addStringOption((option) => option
      .setName('名前')
      .setDescription('削除するテンプレート')
      .setAutocomplete(true)
      .setRequired(true)))
  .addSubcommand((subcommand) => subcommand
    .setName('一覧')
    .setDescription('保存済みの募集テンプレートを表示します'));

function response(content) {
  return { content, ephemeral: true, allowedMentions: { parse: [] } };
}

function canManageGuild(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) === true;
}

function formatPresetList(presets) {
  let content = `保存済みの募集テンプレート（${presets.length}件）`;
  for (let index = 0; index < presets.length; index += 1) {
    const preset = presets[index];
    const line = `・${preset.name}: ${preset.game} / ${preset.time} / ${preset.capacity ?? '人数指定なし'}`;
    const omitted = presets.length - index - 1;
    const suffix = omitted > 0 ? `\n…ほか${omitted}件` : '';
    if (`${content}\n${line}${suffix}`.length > MAX_DISCORD_CONTENT_LENGTH) {
      return `${content}\n…ほか${presets.length - index}件`;
    }
    content = `${content}\n${line}`;
  }
  return content;
}

export async function execute(interaction) {
  if (!canManageGuild(interaction)) {
    return interaction.reply(response('テンプレートを管理できるのはサーバー管理者だけです。'));
  }

  const subcommand = interaction.options.getSubcommand();
  try {
    if (subcommand === '保存') {
      const preset = {
        name: interaction.options.getString('名前'),
        game: interaction.options.getString('ゲーム'),
        time: interaction.options.getString('時間'),
        capacity: interaction.options.getInteger('あと何人'),
      };
      if (!setRecruitPreset(interaction.guildId, preset)) {
        return interaction.reply(response('募集テンプレートを保存できませんでした。時間を置いて再試行してください。'));
      }
      return interaction.reply(response(`募集テンプレート「${preset.name}」を保存しました。`));
    }

    if (subcommand === '削除') {
      const name = interaction.options.getString('名前');
      const deleted = deleteRecruitPreset(interaction.guildId, name);
      if (deleted === null) {
        return interaction.reply(response('募集テンプレートの削除を保存できませんでした。時間を置いて再試行してください。'));
      }
      if (!deleted) {
        return interaction.reply(response('指定した募集テンプレートは見つかりません。'));
      }
      return interaction.reply(response(`募集テンプレート「${name}」を削除しました。`));
    }

    const presets = listRecruitPresets(interaction.guildId);
    if (presets.length === 0) {
      return interaction.reply(response('保存済みの募集テンプレートはありません。'));
    }
    return interaction.reply(response(formatPresetList(presets)));
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) {
      return interaction.reply(response(error.message));
    }
    throw error;
  }
}

export async function autocomplete(interaction) {
  if (!interaction.guildId) return interaction.respond([]);
  const focused = interaction.options.getFocused(true);
  if (focused.name !== '名前') return interaction.respond([]);
  const query = String(focused.value).normalize('NFKC').toLocaleLowerCase('ja-JP');
  const choices = listRecruitPresets(interaction.guildId)
    .filter((preset) => preset.name.toLocaleLowerCase('ja-JP').includes(query))
    .slice(0, 25)
    .map((preset) => ({ name: preset.name, value: preset.name }));
  return interaction.respond(choices);
}
