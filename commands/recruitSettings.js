import {
  ApplicationIntegrationType,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import {
  getDefaultAutoCloseEnabled,
  getRecruitTimeZone,
  updateRecruitSettings,
} from '../lib/recruitSettings.js';

export const data = new SlashCommandBuilder()
  .setName('募集設定')
  .setDescription('このサーバーの募集に使う標準設定を変更します')
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addBooleanOption((option) =>
    option
      .setName('自動締切デフォルト')
      .setDescription('募集で指定を省略した場合の時間自動締切（標準はOFF）')
      .setRequired(false),
  )
  .addStringOption((option) => option
    .setName('タイムゾーン')
    .setDescription('開始日時の地域（例: Asia/Tokyo、未指定なら現在値を表示）')
    .setMinLength(3)
    .setMaxLength(64)
    .setRequired(false));

function response(content) {
  return { content, ephemeral: true, allowedMentions: { parse: [] } };
}

export async function execute(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return interaction.reply(response('この設定を変更できるのはサーバー管理者だけです。'));
  }

  const requested = interaction.options.getBoolean('自動締切デフォルト');
  const requestedTimeZone = interaction.options.getString?.('タイムゾーン') ?? null;
  if (requested === null && requestedTimeZone === null) {
    const current = getDefaultAutoCloseEnabled(interaction.guildId);
    const timeZone = getRecruitTimeZone(interaction.guildId);
    return interaction.reply(response([
      `時間による自動締切のデフォルトは **${current ? 'ON' : 'OFF'}** です。`,
      `開始日時のタイムゾーンは **${timeZone}** です。`,
    ].join('\n')));
  }

  try {
    const updates = {};
    if (requested !== null) updates.autoCloseDefault = requested;
    if (requestedTimeZone !== null) updates.timeZone = requestedTimeZone;
    if (!updateRecruitSettings(interaction.guildId, updates)) {
      return interaction.reply(response('募集設定を保存できませんでした。時間を置いて再試行してください。'));
    }
  } catch (error) {
    if (error instanceof TypeError) return interaction.reply(response(error.message));
    throw error;
  }
  const messages = [];
  if (requested !== null) {
    messages.push(`時間による自動締切のデフォルトを **${requested ? 'ON' : 'OFF'}** にしました。`);
  }
  if (requestedTimeZone !== null) {
    messages.push(`開始日時のタイムゾーンを **${getRecruitTimeZone(interaction.guildId)}** にしました。`);
  }
  return interaction.reply(response(messages.join('\n')));
}
