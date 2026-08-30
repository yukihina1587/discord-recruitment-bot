import {
  ActionRowBuilder,
  ApplicationIntegrationType,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  InteractionContextType,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';

import * as list from './list.js';
import {
  execute as executeRecruit,
  getRecruitmentHistoryEntry,
  listRecruitmentHistory,
} from './recruit.js';

const CREATE_BUTTON_ID = 'recruitpanel_create';
const REPEAT_BUTTON_ID = 'recruitpanel_repeat';
const LIST_BUTTON_ID = 'recruitpanel_list';
const CREATE_MODAL_ID = 'recruitpanel_create_modal';
const REPEAT_MODAL_PREFIX = 'recruitpanel_repeat_modal:';

export const data = new SlashCommandBuilder()
  .setName('募集パネル')
  .setNameLocalizations({ 'en-US': 'recruit-panel' })
  .setDescription('募集の作成・履歴・一覧をすぐ開けるパネルを投稿します')
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

function createPanelComponents() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(CREATE_BUTTON_ID)
      .setLabel('募集を作る')
      .setEmoji('➕')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(REPEAT_BUTTON_ID)
      .setLabel('前回から作る')
      .setEmoji('🔁')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(LIST_BUTTON_ID)
      .setLabel('募集中を見る')
      .setEmoji('📋')
      .setStyle(ButtonStyle.Secondary),
  )];
}

export async function execute(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return interaction.reply({
      content: '募集パネルを設置できるのはサーバー管理者だけです。',
      ephemeral: true,
    });
  }
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🎮 募集メニュー')
    .setDescription([
      'ボタンから募集作成、前回の複製、現在の募集一覧をすぐ開けます。',
      'VC・通知・自動締切などの詳細設定は `/募集` を使ってください。',
      'いつでも見つけられるように、このメッセージは必要に応じて手動でピン留めできます。',
    ].join('\n'));
  return interaction.reply({
    embeds: [embed],
    components: createPanelComponents(),
    allowedMentions: { parse: [] },
  });
}

function addInput(modal, input) {
  modal.addComponents(new ActionRowBuilder().addComponents(input));
}

function createRecruitModal(source = null) {
  const repeating = source !== null;
  const modal = new ModalBuilder()
    .setCustomId(repeating ? `${REPEAT_MODAL_PREFIX}${source.messageId}` : CREATE_MODAL_ID)
    .setTitle(repeating ? '前回の設定から募集' : 'かんたん募集作成');

  const game = new TextInputBuilder()
    .setCustomId('game')
    .setLabel('ゲーム名（例: めっちゃカメレオン）')
    .setPlaceholder('例: めっちゃカメレオン')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(100);
  if (source?.game) game.setValue(source.game.slice(0, 100));
  addInput(modal, game);

  const time = new TextInputBuilder()
    .setCustomId('time')
    .setLabel('時間（例: 今から / 21時）')
    .setPlaceholder('例: 今から')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(100)
    .setValue(source?.time?.slice(0, 100) || '今から');
  addInput(modal, time);

  const start = new TextInputBuilder()
    .setCustomId('start')
    .setLabel('開始日・日時（省略可）')
    .setPlaceholder('例: 8/22 または 8/22 21:00')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(32);
  if (source?.startText) start.setValue(source.startText.slice(0, 32));
  addInput(modal, start);

  const capacity = new TextInputBuilder()
    .setCustomId('capacity')
    .setLabel(repeating ? 'あと何人（空欄で前回と同じ）' : 'あと何人（空欄で人数指定なし）')
    .setPlaceholder('例: 2')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(2);
  if (Number.isInteger(source?.capacity)) capacity.setValue(String(source.capacity));
  addInput(modal, capacity);
  return modal;
}

export async function handleButton(interaction) {
  if (!interaction.guildId) {
    return interaction.reply({ content: 'この操作はサーバー内でのみ利用できます。', ephemeral: true });
  }
  if (interaction.customId === LIST_BUTTON_ID) return list.execute(interaction);
  if (interaction.customId === CREATE_BUTTON_ID) return interaction.showModal(createRecruitModal());
  if (interaction.customId === REPEAT_BUTTON_ID) {
    const source = listRecruitmentHistory(interaction.guildId, interaction.user.id, { limit: 1 })[0];
    if (!source) {
      return interaction.reply({
        content: 'このサーバーで複製できる自分の募集履歴がありません。',
        ephemeral: true,
      });
    }
    return interaction.showModal(createRecruitModal(source));
  }
  return undefined;
}

function getField(interaction, name) {
  try {
    return interaction.fields.getTextInputValue(name).trim();
  } catch {
    return '';
  }
}

export async function handleModal(interaction) {
  if (!interaction.guildId) {
    return interaction.reply({ content: 'この操作はサーバー内でのみ利用できます。', ephemeral: true });
  }
  const isCreate = interaction.customId === CREATE_MODAL_ID;
  const isRepeat = interaction.customId.startsWith(REPEAT_MODAL_PREFIX);
  if (!isCreate && !isRepeat) return undefined;

  const game = getField(interaction, 'game');
  const time = getField(interaction, 'time');
  const start = getField(interaction, 'start');
  const rawCapacity = getField(interaction, 'capacity').normalize('NFKC');
  if (!game || game.length > 100 || !time || time.length > 100) {
    return interaction.reply({
      content: 'ゲーム名と時間は1〜100文字で入力してね。',
      ephemeral: true,
    });
  }
  const capacity = rawCapacity === ''
    ? null
    : /^\d{1,2}$/u.test(rawCapacity) ? Number(rawCapacity) : Number.NaN;
  if (capacity !== null && (!Number.isInteger(capacity) || capacity < 1 || capacity > 50)) {
    return interaction.reply({ content: 'あと何人は1〜50の数字で入力してね。', ephemeral: true });
  }

  const historyMessageId = isRepeat
    ? interaction.customId.slice(REPEAT_MODAL_PREFIX.length)
    : null;
  const source = isRepeat
    ? getRecruitmentHistoryEntry(interaction.guildId, interaction.user.id, historyMessageId)
    : null;
  if (isRepeat && !source) {
    return interaction.reply({
      content: '指定した募集履歴は見つかりません。パネルから選び直してね。',
      ephemeral: true,
    });
  }
  const requestedStart = isRepeat && start === source.startText ? null : start || null;
  const stringOptions = {
    ゲーム: game,
    時間: time,
    開始日時: requestedStart,
    履歴から: historyMessageId,
  };
  const adaptedInteraction = {
    ...interaction,
    options: {
      getString: (name) => stringOptions[name] ?? null,
      getInteger: (name) => (name === 'あと何人' ? capacity : null),
      getBoolean: () => null,
      getChannel: () => null,
    },
  };
  return executeRecruit(adaptedInteraction);
}
