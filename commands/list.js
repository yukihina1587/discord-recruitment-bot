import {
  ApplicationIntegrationType,
  EmbedBuilder,
  InteractionContextType,
  SlashCommandBuilder,
} from 'discord.js';
import { listActive } from './recruit.js';
import { sanitizeDiscordMarkdownText } from '../lib/discordText.js';
import { isDateOnlyRecruitStart, isRecruitStartUsable } from '../lib/recruitStartTime.js';

const MAX_EMBED_DESCRIPTION_LENGTH = 4_096;

export const data = new SlashCommandBuilder()
  .setName('募集一覧')
  .setNameLocalizations({ 'en-US': 'recruits' })
  .setDescription('いま募集中のゲームを一覧表示します')
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  .setContexts(InteractionContextType.Guild);

function boundedDescription(lines) {
  let description = '';
  for (let index = 0; index < lines.length; index += 1) {
    const separator = description ? '\n\n' : '';
    const omitted = lines.length - index - 1;
    const suffix = omitted > 0 ? `\n\n…ほか${omitted}件` : '';
    if (`${description}${separator}${lines[index]}${suffix}`.length > MAX_EMBED_DESCRIPTION_LENGTH) {
      return `${description}\n\n…ほか${lines.length - index}件`;
    }
    description = `${description}${separator}${lines[index]}`;
  }
  return description;
}

function formatRecruitStart(state, now) {
  if (!isRecruitStartUsable(state, now)) {
    return sanitizeDiscordMarkdownText(state.time, { maxLength: 100 }) || '日時未定';
  }
  if (Number.isFinite(state.startAt)) {
    return `<t:${Math.floor(state.startAt / 1_000)}:F> (<t:${Math.floor(state.startAt / 1_000)}:R>)`;
  }
  if (isDateOnlyRecruitStart(state.startText)) return `📅 ${state.startText}`;
  return '日時未定';
}

export async function execute(interaction) {
  const active = listActive(interaction.guildId);

  if (active.length === 0) {
    return interaction.reply({
      content: 'いまアクティブな募集はないみたい。`/募集` で立ててみてね！',
      ephemeral: true,
    });
  }

  const now = Date.now();
  const hasFutureStart = (state) => isRecruitStartUsable(state, now);
  const startSortValue = (state) => Number.isFinite(state.startAt)
    ? state.startAt
    : Date.parse(`${state.startText}T00:00:00Z`);
  const lines = active
    .sort((left, right) => {
      const leftHasStart = hasFutureStart(left);
      const rightHasStart = hasFutureStart(right);
      if (leftHasStart !== rightHasStart) return leftHasStart ? -1 : 1;
      if (leftHasStart && startSortValue(left) !== startSortValue(right)) {
        return startSortValue(left) - startSortValue(right);
      }
      if ((left.createdAt ?? 0) !== (right.createdAt ?? 0)) {
        return (left.createdAt ?? 0) - (right.createdAt ?? 0);
      }
      return String(left.messageId).localeCompare(String(right.messageId));
    })
    .map((s) => {
      const joined = s.members.length;
      const slots = s.capacity ? `${joined}/${s.capacity}人` : `${joined}人`;
      const url = `https://discord.com/channels/${s.guildId}/${s.channelId}/${s.messageId}`;
      const wait = s.waitlist.length > 0 ? ` ⏳補欠${s.waitlist.length}` : '';
      const close = s.closeAt ? ` ⌛<t:${Math.floor(s.closeAt / 1000)}:R>` : '';
      const start = formatRecruitStart(s, now);
      const game = sanitizeDiscordMarkdownText(s.game, { maxLength: 100 }) || 'イベント';
      return `🎮 **${game}**（${slots}${wait}）主催 <@${s.hostId}> ⏰${start}${close}\n→ [募集を開く](${url})`;
    });

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`📋 募集中のゲーム（${active.length}件）`)
    .setDescription(boundedDescription(lines))
    .setTimestamp();

  return interaction.reply({ embeds: [embed], ephemeral: true });
}
