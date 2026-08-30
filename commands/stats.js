import {
  ApplicationIntegrationType,
  EmbedBuilder,
  InteractionContextType,
  SlashCommandBuilder,
} from 'discord.js';
import { summarize } from '../lib/stats.js';

export const data = new SlashCommandBuilder()
  .setName('統計')
  .setNameLocalizations({ 'en-US': 'stats' })
  .setDescription('直近30日のゲーム参加状況を表示します')
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  .setContexts(InteractionContextType.Guild)
  .addUserOption((opt) =>
    opt.setName('ユーザー').setDescription('だれの統計を見る？（省略で自分）').setRequired(false),
  );

export async function execute(interaction) {
  const target = interaction.options.getUser('ユーザー') ?? interaction.user;
  const { joinCount, topGames, topMates, sinceDays } = summarize(target.id, interaction.guildId);

  if (joinCount === 0) {
    return interaction.reply({
      content: `<@${target.id}> さんの直近${sinceDays}日の参加記録はまだないみたい。`,
      ephemeral: true,
    });
  }

  const gamesText =
    topGames.map(([g, n], i) => `${i + 1}. ${g}（${n}回）`).join('\n') || '（なし）';
  const matesText =
    topMates.map(([id, n], i) => `${i + 1}. <@${id}>（${n}回）`).join('\n') || '（なし）';

  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle(`📊 ${target.username} さんの統計（直近${sinceDays}日）`)
    .addFields(
      { name: '🎯 参加した募集', value: `${joinCount} 回`, inline: true },
      { name: '🎮 よく遊んだゲーム', value: gamesText },
      { name: '🤝 よく一緒に遊んだ人', value: matesText },
    )
    .setTimestamp();

  return interaction.reply({ embeds: [embed] });
}
