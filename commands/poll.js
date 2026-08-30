import {
  ActionRowBuilder,
  ApplicationIntegrationType,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  InteractionContextType,
  SlashCommandBuilder,
} from 'discord.js';
import { load, save } from '../lib/store.js';

// ===== /投票 コマンド =====
export const data = new SlashCommandBuilder()
  .setName('投票')
  .setNameLocalizations({ 'en-US': 'poll' })
  .setDescription('ボタンで集計できる投票を作ります（例: 何時からやる？）')
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  .setContexts(InteractionContextType.Guild)
  .addStringOption((opt) =>
    opt.setName('質問').setDescription('投票のお題').setMaxLength(256).setRequired(true),
  )
  .addStringOption((opt) =>
    opt
      .setName('選択肢')
      .setDescription('カンマ区切りで最大5つ（例: 20時,21時,22時）')
      .setMaxLength(500)
      .setRequired(true),
  );

const STORE = 'polls';
const EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];
export const MAX_POLLS_PER_GUILD = 100;

// messageId -> { question, options:[...], votes: { userId: optionIndex } }
const polls = new Map();

export function init() {
  polls.clear();
  const db = load(STORE, { polls: {} });
  for (const [id, poll] of Object.entries(db.polls ?? {})) {
    poll.guildId ??= process.env.GUILD_ID;
    polls.set(id, poll);
  }
}

function persist() {
  const obj = {};
  for (const [id, p] of polls) obj[id] = p;
  save(STORE, { polls: obj });
}

function buildEmbed(poll) {
  const counts = poll.options.map(() => 0);
  for (const idx of Object.values(poll.votes)) counts[idx] = (counts[idx] ?? 0) + 1;
  const totalVotes = Object.keys(poll.votes).length;

  const lines = poll.options.map((opt, i) => {
    const n = counts[i];
    const ratio = totalVotes ? n / totalVotes : 0;
    const bar = '█'.repeat(Math.round(ratio * 10)).padEnd(10, '░');
    return `${EMOJIS[i]} **${opt}**\n\`${bar}\` ${n}票`;
  });

  return new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle(`🗳️ ${poll.question}`)
    .setDescription(lines.join('\n\n'))
    .setFooter({ text: `合計 ${totalVotes} 票 ・ ボタンで投票（押し直しで変更）` })
    .setTimestamp();
}

function buildButtons(poll) {
  const row = new ActionRowBuilder();
  poll.options.forEach((opt, i) => {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`poll_${i}`)
        .setLabel(opt.slice(0, 80))
        .setEmoji(EMOJIS[i])
        .setStyle(ButtonStyle.Primary),
    );
  });
  return [row];
}

export async function execute(interaction) {
  const guildPollCount = [...polls.values()]
    .filter((poll) => poll.guildId === interaction.guildId)
    .length;
  if (guildPollCount >= MAX_POLLS_PER_GUILD) {
    return interaction.reply({
      content: `このサーバーで保持できる投票は${MAX_POLLS_PER_GUILD}件までです。`,
      ephemeral: true,
    });
  }
  const question = interaction.options.getString('質問');
  const rawOptions = interaction.options.getString('選択肢');
  const options = rawOptions
    .split(/[,、]/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (
    question.length > 256
    || rawOptions.length > 500
    || options.length < 2
    || options.length > 5
    || options.some((option) => option.length > 80)
  ) {
    return interaction.reply({
      content: '質問は256文字以内、選択肢は2〜5個・各80文字以内で入れてね。',
      ephemeral: true,
    });
  }

  const poll = { guildId: interaction.guildId, question, options, votes: {} };

  const message = await interaction.reply({
    embeds: [buildEmbed(poll)],
    components: buildButtons(poll),
    withResponse: true,
  });

  polls.set(message.resource.message.id, poll);
  persist();
}

export async function handleButton(interaction) {
  const poll = polls.get(interaction.message.id);
  if (!poll) {
    return interaction.reply({ content: 'この投票はもう有効じゃないみたい。', ephemeral: true });
  }
  if (!interaction.guildId || poll.guildId !== interaction.guildId) {
    return interaction.reply({
      content: 'このサーバーからは別のサーバーの投票を操作できません。',
      ephemeral: true,
    });
  }

  const idx = Number.parseInt(interaction.customId.replace('poll_', ''), 10);
  if (!Number.isInteger(idx) || idx < 0 || idx >= poll.options.length) return;

  const userId = interaction.user.id;
  // 同じ選択肢をもう一度押したら取り消し、違う選択肢なら変更
  if (poll.votes[userId] === idx) {
    delete poll.votes[userId];
  } else {
    poll.votes[userId] = idx;
  }
  persist();

  await interaction.update({ embeds: [buildEmbed(poll)], components: buildButtons(poll) });
}
