import {
  ApplicationIntegrationType,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import {
  DEFAULT_X_SHARE_TEMPLATE,
  MAX_X_SHARE_TEMPLATE_LENGTH,
  getXShareTemplate,
  resetXShareTemplate,
  setXShareTemplate,
  validateXShareTemplate,
} from '../lib/xShare.js';
import { refreshGuildMessages } from './recruit.js';

export const data = new SlashCommandBuilder()
  .setName('x共有設定')
  .setDescription('募集の「Xで共有」ボタンに埋め込む文章を設定します')
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption((option) =>
    option
      .setName('募集文')
      .setDescription('使用可: {ゲーム} {人数} {時間} {募集URL}（省略すると現在値を表示）')
      .setMaxLength(MAX_X_SHARE_TEMPLATE_LENGTH)
      .setRequired(false),
  )
  .addBooleanOption((option) =>
    option
      .setName('初期化')
      .setDescription('設定した募集文を標準に戻します')
      .setRequired(false),
  );

function displayTemplate(template) {
  return template.replace(/`/gu, 'ˋ');
}

function response(content) {
  return {
    content,
    ephemeral: true,
    allowedMentions: { parse: [] },
  };
}

async function replyAndRefresh(interaction, content) {
  await interaction.reply(response(content));
  await refreshGuildMessages(interaction.guildId).catch((error) => {
    console.error('X共有ボタンの更新に失敗:', error);
  });
}

export async function execute(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return interaction.reply(response('この設定を変更できるのはサーバー管理者だけです。'));
  }

  const requestedTemplate = interaction.options.getString('募集文');
  const shouldReset = interaction.options.getBoolean('初期化') ?? false;
  if (requestedTemplate && shouldReset) {
    return interaction.reply(response('募集文の設定と初期化は同時に指定できません。'));
  }

  if (shouldReset) {
    if (!resetXShareTemplate(interaction.guildId)) {
      return interaction.reply(response('募集文を初期化できませんでした。時間を置いて再試行してください。'));
    }
    return replyAndRefresh(
      interaction,
      `X共有の募集文を標準へ戻しました。\n\`\`\`\n${displayTemplate(DEFAULT_X_SHARE_TEMPLATE)}\n\`\`\``,
    );
  }

  if (requestedTemplate) {
    let normalized;
    try {
      normalized = validateXShareTemplate(requestedTemplate);
    } catch (error) {
      return interaction.reply(response(error.message));
    }
    if (!setXShareTemplate(interaction.guildId, normalized)) {
      return interaction.reply(response('募集文を保存できませんでした。時間を置いて再試行してください。'));
    }
    return replyAndRefresh(
      interaction,
      `X共有の募集文を保存しました。\n\`\`\`\n${displayTemplate(normalized)}\n\`\`\``,
    );
  }

  const current = getXShareTemplate(interaction.guildId);
  return interaction.reply(response(
    [
      '現在のX共有用募集文です。',
      '使用できる置換項目: `{ゲーム}` `{人数}` `{時間}` `{募集URL}`',
      `\`\`\`\n${displayTemplate(current)}\n\`\`\``,
    ].join('\n'),
  ));
}
