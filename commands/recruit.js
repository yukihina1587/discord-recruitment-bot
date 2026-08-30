import {
  ActionRowBuilder,
  ApplicationIntegrationType,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  InteractionContextType,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { load, save } from '../lib/store.js';
import { findFixedGame, searchFixedGames } from '../lib/gameCatalog.js';
import { igdbCoverUrl, parseIgdbChoiceValue } from '../lib/igdbGameSearch.js';
import { sanitizeDiscordMarkdownText } from '../lib/discordText.js';
import {
  getDefaultAutoCloseEnabled,
  getRecruitPreset,
  getRecruitTimeZone,
  listRecruitPresets,
} from '../lib/recruitSettings.js';
import {
  isDateOnlyRecruitStart,
  isRecruitStartUsable,
  parseRecruitStart,
} from '../lib/recruitStartTime.js';
import { parseCloseAt } from '../lib/timeparse.js';
import { recordSession } from '../lib/stats.js';
import { buildXShareIntentUrl } from '../lib/xShare.js';
import { TEMPLATES } from '../config.js';

// ===== /募集 コマンドの定義 =====
export const data = new SlashCommandBuilder()
  .setName('募集')
  .setNameLocalizations({ 'en-US': 'recruit' })
  .setDescription('ゲームの参加者を募集します')
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  .setContexts(InteractionContextType.Guild)
  .addStringOption((opt) => {
    opt
      .setName('テンプレ')
      .setDescription('よく遊ぶゲームのテンプレ（選ぶとゲーム名・人数が自動入力されます）')
      .setRequired(false);
    for (const [i, t] of TEMPLATES.entries()) {
      opt.addChoices({ name: t.name, value: String(i) });
    }
    return opt;
  })
  .addStringOption((opt) => opt
    .setName('サーバーテンプレ')
    .setDescription('このサーバーの管理者が保存した募集テンプレート')
    .setAutocomplete(true)
    .setRequired(false))
  .addBooleanOption((opt) => opt
    .setName('前回を複製')
    .setDescription('このサーバーで自分が前回立てた募集を複製します')
    .setRequired(false))
  .addStringOption((opt) => opt
    .setName('履歴から')
    .setDescription('このサーバーで自分が以前立てた募集を選んで複製します')
    .setAutocomplete(true)
    .setRequired(false))
  .addStringOption((opt) =>
    opt
      .setName('ゲーム')
      .setDescription('遊ぶゲーム名（入力途中に候補を表示。テンプレなしでは必須）')
      .setAutocomplete(true)
      .setMaxLength(100)
      .setRequired(false),
  )
  .addStringOption((opt) => opt
    .setName('開始日時')
    .setDescription('省略すると今から。例: 日付のみ 8/22、日時 8/22 21:00（全角OK）')
    .setMaxLength(32)
    .setRequired(false))
  .addChannelOption((opt) => opt
    .setName('対象vc')
    .setDescription('参加予定者が全員揃ったら通知なしで終了する対象VC')
    .addChannelTypes(ChannelType.GuildVoice)
    .setRequired(false))
  .addBooleanOption((opt) => opt
    .setName('vc集合で自動終了')
    .setDescription('主催者と参加登録者が対象VCへ揃ったら自動終了（標準OFF）')
    .setRequired(false))
  .addBooleanOption((opt) => opt
    .setName('事前通知')
    .setDescription('開始30分前に通知する（通知分を指定した場合はその分数）')
    .setRequired(false))
  .addIntegerOption((opt) => opt
    .setName('通知分')
    .setDescription('事前通知を開始何分前に送るか（省略時30分前）')
    .setMinValue(1)
    .setMaxValue(10_080)
    .setRequired(false))
  .addStringOption((opt) =>
    opt
      .setName('時間')
      .setDescription('いつやる？（例: 今から, 21時, 30分後）')
      .setMaxLength(100)
      .setRequired(false),
  )
  .addIntegerOption((opt) =>
    opt
      .setName('あと何人')
      .setDescription('主催者を含めず、空いている人数（例: 2人分空いているなら2）')
      .setMinValue(1)
      .setMaxValue(50)
      .setRequired(false),
  )
  .addBooleanOption((opt) =>
    opt
      .setName('自動締切')
      .setDescription('指定した締切時間に自動で締め切る（標準はOFF）')
      .setRequired(false),
  )
  .addStringOption((opt) =>
    opt
      .setName('締切')
      .setDescription('自動締切ON時に必須（例: 30分後, 2時間後, 22時）')
      .setMaxLength(100)
      .setRequired(false),
  );

// ===== 状態管理（メモリ） =====
// messageId -> state。state は永続化のため Set ではなく配列で持つ。
const recruitments = new Map();
// Botが作った専用VCのID（全員退出で自動削除する対象）
const managedVoiceChannels = new Set();
// tickの重複実行中だけ使うlock。再起動時の配送済み判定は永続化fieldで行う。
const reminderDeliveriesInFlight = new Set();
const voiceReadyClosuresInFlight = new Set();
// discord.js Client（init で受け取る。スケジューラや自動締め切りで使用）
let client = null;
let runtimeOptions = {
  createPrivateVoiceChannels: true,
  enableXShare: false,
  legacyGuildId: null,
  mentionHere: true,
  gameSearch: null,
};

const STORE = 'recruits';
const STORE_SCHEMA_VERSION = 5;
export const MAX_ACTIVE_RECRUITS_PER_GUILD = 100;
export const MAX_WAITLIST_SIZE = 50;
export const MAX_REMINDER_LEAD_MINUTES = 10_080;
export const REMINDER_RETRY_INTERVAL_MS = 30_000;
// Discordの入力は分単位のため、現在分の逃げ道にならない最小境界を1分とする。
export const MIN_RECRUIT_START_LEAD_MS = 60_000;
const CALENDAR_ORIGIN = 'https://calendar.google.com/calendar/render';
const CALENDAR_DURATION_MS = 2 * 60 * 60_000;
const MAX_DISCORD_BUTTON_URL_LENGTH = 512;
const GAME_AUTOCOMPLETE_TIMEOUT_MS = 1_800;

function withFallbackTimeout(promise, fallback, timeoutMs) {
  let timeoutId;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve(fallback), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function clearGameMetadata(state) {
  delete state.gameProvider;
  delete state.gameExternalId;
  delete state.gameImageId;
}

function normalizeStoredGameMetadata(state) {
  const valid = typeof state.game === 'string'
    && state.game.length >= 1
    && state.game.length <= 100
    && state.gameProvider === 'igdb'
    && Number.isSafeInteger(state.gameExternalId)
    && state.gameExternalId > 0
    && (state.gameImageId === null || igdbCoverUrl(state.gameImageId));
  if (!valid) clearGameMetadata(state);
}

function gameSelection(game, igdbGame = null) {
  if (!igdbGame) return { game };
  return {
    game: igdbGame.name,
    gameProvider: 'igdb',
    gameExternalId: igdbGame.id,
    gameImageId: igdbGame.imageId ?? null,
  };
}

function copyStoredGameSelection(source) {
  if (!source) return null;
  const copied = { ...source };
  normalizeStoredGameMetadata(copied);
  if (copied.gameProvider !== 'igdb') return null;
  return {
    game: copied.game,
    gameProvider: copied.gameProvider,
    gameExternalId: copied.gameExternalId,
    gameImageId: copied.gameImageId,
  };
}

async function resolveGameSelection(rawGame, { source = null } = {}) {
  const copied = copyStoredGameSelection(source);
  if (copied && rawGame === source.game) return copied;
  if (findFixedGame(rawGame)) return gameSelection(rawGame);

  const selectedId = parseIgdbChoiceValue(rawGame);
  if (selectedId !== null) {
    if (!runtimeOptions.gameSearch) return null;
    try {
      const selected = await runtimeOptions.gameSearch.getById(selectedId);
      return selected ? gameSelection(selected.name, selected) : null;
    } catch {
      return null;
    }
  }
  if (String(rawGame).startsWith('igdb:')) return null;
  if (!runtimeOptions.gameSearch) return gameSelection(rawGame);
  try {
    const exact = await runtimeOptions.gameSearch.findExact(rawGame);
    return exact ? gameSelection(exact.name, exact) : gameSelection(rawGame);
  } catch {
    return gameSelection(rawGame);
  }
}

// ===== 永続化 =====
function persist() {
  const obj = {};
  for (const [id, s] of recruitments) obj[id] = s;
  return save(STORE, {
    schemaVersion: STORE_SCHEMA_VERSION,
    recruits: obj,
    vcChannels: [...managedVoiceChannels],
  });
}

// 起動時にメモリを復元する（client.once(ready) から呼ぶ）
export async function init(c, options = {}) {
  client = c;
  runtimeOptions = {
    createPrivateVoiceChannels: true,
    enableXShare: false,
    legacyGuildId: null,
    mentionHere: true,
    gameSearch: null,
    ...options,
  };
  recruitments.clear();
  managedVoiceChannels.clear();
  reminderDeliveriesInFlight.clear();
  voiceReadyClosuresInFlight.clear();
  const db = load(STORE, { recruits: {}, vcChannels: [] });
  for (const [id, s] of Object.entries(db.recruits ?? {})) {
    if (!s.guildId) {
      if (!runtimeOptions.legacyGuildId) continue;
      s.guildId = runtimeOptions.legacyGuildId;
    }
    // 後方互換：欠けているフィールドを補う
    s.members ??= [];
    s.waitlist ??= [];
    s.closed ??= false;
    s.closedReason ??= null;
    if (!Number.isFinite(s.startAt) || s.startAt <= 0) s.startAt = null;
    if (typeof s.startText !== 'string' || !s.startText) s.startText = null;
    if (typeof s.startTimeZone !== 'string' || !s.startTimeZone) s.startTimeZone = null;
    if (
      !s.startAt
      || !Number.isInteger(s.reminderLeadMinutes)
      || s.reminderLeadMinutes < 1
      || s.reminderLeadMinutes > MAX_REMINDER_LEAD_MINUTES
    ) {
      s.reminderLeadMinutes = null;
    }
    if (!Number.isFinite(s.reminderSentAt) || s.reminderSentAt <= 0) s.reminderSentAt = null;
    if (!Number.isFinite(s.reminderLastAttemptAt) || s.reminderLastAttemptAt <= 0) {
      s.reminderLastAttemptAt = null;
    }
    if (!s.reminderLeadMinutes) {
      s.reminderSentAt = null;
      s.reminderLastAttemptAt = null;
    }
    // 作成途中で再起動した場合、追加募集を再試行できるよう一時lockだけ解除する。
    s.reopening = false;
    // 旧データはcloseAtがあれば従来どおり自動締切ONとして扱う。
    if (typeof s.autoCloseEnabled !== 'boolean') {
      s.autoCloseEnabled = Number.isFinite(s.closeAt) && s.closeAt > 0;
    }
    if (!s.autoCloseEnabled || !Number.isFinite(s.closeAt) || s.closeAt <= 0) {
      s.autoCloseEnabled = false;
      s.closeAt = null;
      s.closeText = null;
    } else if (typeof s.closeText !== 'string' || !s.closeText.trim()) {
      s.closeText = null;
    }
    if (typeof s.voiceChannelId !== 'string' || !/^\d{17,20}$/.test(s.voiceChannelId)) {
      s.voiceChannelId = null;
    }
    normalizeStoredGameMetadata(s);
    s.autoCloseWhenVoiceReady = s.autoCloseWhenVoiceReady === true && Boolean(s.voiceChannelId);
    recruitments.set(id, s);
  }
  for (const vid of db.vcChannels ?? []) managedVoiceChannels.add(vid);
  console.log(`   募集データを復元: ${recruitments.size}件`);

  // 復元した募集メッセージのボタンを貼り直す（再起動でボタンが死ぬのを防ぐ）
  for (const state of recruitments.values()) {
    try {
      const msg = await fetchMessage(state);
      if (msg) {
        await msg.edit(renderMessage(state)).catch(() => {});
      } else {
        // メッセージが消えていたら募集も破棄
        recruitments.delete(state.messageId);
      }
    } catch {
      /* 取得失敗は無視（次回tickで再試行されないので削除はしない） */
    }
  }
  persist();
}

// ===== ヘルパー =====
function isHostOrMember(state, userId) {
  return userId === state.hostId || state.members.includes(userId);
}

function getOptionSafely(options, method, name) {
  try {
    return typeof options?.[method] === 'function' ? options[method](name) : null;
  } catch {
    // global command反映中の旧option typeでも処理を継続する。
    return null;
  }
}

function hasUsableFutureStart(state, now = Date.now()) {
  return isRecruitStartUsable(state, now, MIN_RECRUIT_START_LEAD_MS);
}

function generatedStartTime(state) {
  if (!state?.startText || !state?.startTimeZone) return null;
  return `${state.startText} ${state.startTimeZone}`;
}

function copyFutureStart(state, now = Date.now()) {
  if (!hasUsableFutureStart(state, now)) {
    return { startAt: null, startText: null, startTimeZone: null };
  }
  return {
    startAt: state.startAt,
    startText: state.startText ?? null,
    startTimeZone: state.startTimeZone ?? null,
  };
}

function copyFutureReminderLead(state, now = Date.now()) {
  if (
    !hasUsableFutureStart(state, now)
    || !Number.isFinite(state?.startAt)
    || !Number.isInteger(state?.reminderLeadMinutes)
    || state.reminderLeadMinutes < 1
    || state.reminderLeadMinutes > MAX_REMINDER_LEAD_MINUTES
  ) {
    return null;
  }
  return state.reminderLeadMinutes;
}

function copyTimeWithoutExpiredGeneratedStart(state, now = Date.now()) {
  if (!hasUsableFutureStart(state, now) && state?.time === generatedStartTime(state)) {
    return '日時未定';
  }
  return state?.time;
}

function truncateUtf16(value, maxLength) {
  let result = '';
  for (const character of value) {
    if (result.length + character.length > maxLength) break;
    result += character;
  }
  return result;
}

function sanitizePlainText(value, maxLength) {
  const normalized = String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    .replace(/@/gu, '＠')
    .replace(/\s+/gu, ' ')
    .trim();
  return truncateUtf16(normalized, maxLength);
}

function toCalendarUtc(epochMs) {
  try {
    return new Date(epochMs).toISOString()
      .replace(/[-:]/gu, '')
      .replace(/\.\d{3}Z$/u, 'Z');
  } catch {
    return null;
  }
}

function toCalendarDateRange(startText) {
  if (!isDateOnlyRecruitStart(startText)) return null;
  const [year, month, day] = startText.split('-').map(Number);
  const nextDate = new Date(Date.UTC(year, month - 1, day + 1));
  const compact = (value) => value.replaceAll('-', '');
  const nextText = [
    nextDate.getUTCFullYear(),
    String(nextDate.getUTCMonth() + 1).padStart(2, '0'),
    String(nextDate.getUTCDate()).padStart(2, '0'),
  ].join('-');
  return `${compact(startText)}/${compact(nextText)}`;
}

function buildCalendarUrl(state, now = Date.now()) {
  let dates;
  if (Number.isFinite(state?.startAt) && state.startAt > now) {
    const start = toCalendarUtc(state.startAt);
    const end = toCalendarUtc(state.startAt + CALENDAR_DURATION_MS);
    if (!start || !end) return null;
    dates = `${start}/${end}`;
  } else if (isRecruitStartUsable(state, now)) {
    dates = toCalendarDateRange(state.startText);
    if (!dates) return null;
  } else {
    return null;
  }

  let title = sanitizePlainText(`${state.game ?? 'イベント'} 募集`, 80) || 'Discord 募集';
  const details = sanitizePlainText('Discordの募集カードから追加しました。', 300);
  const build = () => {
    const params = new URLSearchParams({
      action: 'TEMPLATE',
      text: title,
      dates,
      details,
    });
    return `${CALENDAR_ORIGIN}?${params.toString()}`;
  };

  let url = build();
  while (url.length > MAX_DISCORD_BUTTON_URL_LENGTH && title.length > 1) {
    title = truncateUtf16(title, title.length - 1);
    url = build();
  }
  return url.length <= MAX_DISCORD_BUTTON_URL_LENGTH ? url : null;
}

function createCalendarButton(state) {
  const url = buildCalendarUrl(state);
  if (!url) return null;
  return new ButtonBuilder()
    .setLabel('カレンダーに追加')
    .setEmoji('📅')
    .setStyle(ButtonStyle.Link)
    .setURL(url);
}

async function fetchMessage(state) {
  if (!client) return null;
  const channel = await client.channels.fetch(state.channelId).catch(() => null);
  if (!channel) return null;
  return channel.messages.fetch(state.messageId).catch(() => null);
}

// ===== 表示 =====
function buildEmbed(state) {
  const joined = state.members.length;
  const slots = state.capacity
    ? `あと ${Math.max(0, state.capacity - joined)} 人`
    : '指定なし';
  const full = state.capacity && joined >= state.capacity;
  const total = joined + 1; // 主催者 + 参加者
  const fixedGame = findFixedGame(state.game);
  const displayGame = fixedGame?.name
    ?? (sanitizeDiscordMarkdownText(state.game, { maxLength: 100 }) || 'イベント');
  const displayTime = sanitizeDiscordMarkdownText(state.time, { maxLength: 100 }) || '日時未定';
  const dateOnly = !Number.isFinite(state.startAt) && isDateOnlyRecruitStart(state.startText);
  const dateOnlyText = dateOnly
    ? `${state.startText}${state.startTimeZone ? ` ${state.startTimeZone}` : ''}`
    : null;
  const dateOnlyDisplay = dateOnlyText && displayTime !== dateOnlyText
    ? `${displayTime}\n${dateOnlyText}`
    : dateOnlyText;

  const statusLine = state.closed ? '🔒 締め切り済み' : full ? '🟡 満員（締め切れます）' : '🟢 募集中';

  const fields = [
    { name: '状態', value: statusLine, inline: true },
    { name: '👑 主催者', value: `<@${state.hostId}>`, inline: true },
    {
      name: state.startAt ? '⏰ 開始' : dateOnly ? '📅 開始日' : '⏰ 時間',
      value: state.startAt
        ? `${displayTime}\n<t:${Math.floor(state.startAt / 1_000)}:F> (<t:${Math.floor(state.startAt / 1_000)}:R>)`
        : dateOnlyDisplay ?? displayTime,
      inline: true,
    },
    ...(Number.isInteger(state.reminderLeadMinutes)
      ? [{ name: '🔔 事前通知', value: `${state.reminderLeadMinutes}分前`, inline: true }]
      : []),
    { name: '📣 あと何人', value: slots, inline: true },
    { name: '合計', value: `${total} 人（主催者を含む）`, inline: true },
    ...mentionFields('参加メンバー（主催者を除く）', state.members, '（まだいません）'),
  ];

  // 補欠がいれば表示
  if (state.waitlist.length > 0) {
    fields.push(...mentionFields(`⏳ 補欠 (${state.waitlist.length})`, state.waitlist));
  }
  if (state.voiceChannelId) {
    fields.push({
      name: '🔊 対象VC',
      value: `<#${state.voiceChannelId}>\n全員集合で通知なし終了: ${state.autoCloseWhenVoiceReady ? 'ON' : 'OFF'}`,
      inline: false,
    });
  }

  // 自動締め切り予定があれば表示
  if (!state.closed && state.autoCloseEnabled && state.closeAt) {
    fields.push({
      name: '⌛ 自動締め切り',
      value: `<t:${Math.floor(state.closeAt / 1000)}:R>`,
      inline: true,
    });
  }

  const embed = new EmbedBuilder()
    .setColor(state.closed ? 0x808080 : full ? 0xf1c40f : 0x5865f2)
    .setTitle(`🎮 ${displayGame} 募集${full && !state.closed ? '（満員）' : ''}`)
    .addFields(fields)
    .setFooter({ text: '下のボタンで参加 / キャンセルできます（主催者は人数に含みません）' })
    .setTimestamp();

  const igdbThumbnail = fixedGame ? null : igdbCoverUrl(state.gameImageId);
  if (fixedGame) embed.setThumbnail(fixedGame.thumbnailUrl);
  else if (igdbThumbnail) embed.setThumbnail(igdbThumbnail);
  return embed;
}

function mentionFields(name, ids, emptyValue) {
  if (ids.length === 0) return [{ name, value: emptyValue ?? '（なし）' }];
  const chunks = [];
  let current = '';
  for (const id of ids.slice(0, MAX_WAITLIST_SIZE)) {
    const line = `・<@${id}>`;
    if (current && `${current}\n${line}`.length > 1_024) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) chunks.push(current);
  return chunks.map((value, index) => ({
    name: index === 0 ? name : `${name}（続き${index + 1}）`,
    value,
  }));
}

function buildButtons(state) {
  if (state.closed && state.supersededByMessageId) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('新しい募集を見る')
        .setEmoji('➡️')
        .setStyle(ButtonStyle.Link)
        .setURL(buildMessageUrl(state, state.supersededByMessageId)),
    );
    const calendarButton = createCalendarButton(state);
    if (calendarButton) row.addComponents(calendarButton);
    return [row];
  }
  if (state.closed) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('recruit_leave')
        .setLabel('やっぱやめる')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('recruit_addmore')
        .setLabel('追加募集する')
        .setEmoji('➕')
        .setStyle(ButtonStyle.Primary),
    );
    const calendarButton = createCalendarButton(state);
    if (calendarButton) row.addComponents(calendarButton);
    return [row];
  }

  const actionRows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('recruit_join')
        .setLabel('参加する')
        .setEmoji('✋')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('recruit_leave')
        .setLabel('やっぱやめる')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('recruit_close')
        .setLabel('集合して締切')
        .setEmoji('📣')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('recruit_close_silent')
        .setLabel('通知せず終了')
        .setEmoji('🔕')
        .setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('recruit_edit')
        .setLabel('編集')
        .setEmoji('✏️')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('recruit_transfer')
        .setLabel('主催を交代')
        .setEmoji('🔁')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
  const calendarButton = createCalendarButton(state);
  if (calendarButton) actionRows[1].addComponents(calendarButton);
  if (runtimeOptions.enableXShare && state.messageId) {
    actionRows[1].addComponents(
      new ButtonBuilder()
        .setLabel('Xで共有')
        .setEmoji('📣')
        .setStyle(ButtonStyle.Link)
        .setURL(buildXShareIntentUrl(state)),
    );
  }
  return actionRows;
}

// メッセージ全体（content/embeds/components）を組み立てる
function renderMessage(state, { notifyHere = false } = {}) {
  const shouldNotifyHere = notifyHere && runtimeOptions.mentionHere && !state.closed;
  return {
    content: state.closed
      ? state.supersededByMessageId
        ? '🔒 この募集は締め切られました。追加募集は新しいカードで受け付けています。'
        : '🔒 この募集は締め切られました。「追加募集する」で新しく募集できるよ。'
      : runtimeOptions.mentionHere
        ? '@here ゲーム募集が立ってるよ！'
        : '🎮 ゲーム募集が立ってるよ！',
    embeds: [buildEmbed(state)],
    components: buildButtons(state),
    allowedMentions: shouldNotifyHere ? { parse: ['everyone'] } : { parse: [] },
  };
}

// ===== コマンド実行 =====
export async function execute(interaction) {
  if (listActive(interaction.guildId).length >= MAX_ACTIVE_RECRUITS_PER_GUILD) {
    return interaction.reply({
      content: `このサーバーで同時に募集できるのは${MAX_ACTIVE_RECRUITS_PER_GUILD}件までです。`,
      ephemeral: true,
    });
  }
  const tplIndex = interaction.options.getString('テンプレ');
  const tpl = tplIndex != null ? TEMPLATES[Number(tplIndex)] : null;
  const presetName = interaction.options.getString('サーバーテンプレ');
  const shouldRepeat = interaction.options.getBoolean?.('前回を複製') ?? false;
  const historyMessageId = interaction.options.getString('履歴から');
  const selectedSourceCount = Number(tplIndex !== null)
    + Number(presetName !== null)
    + Number(shouldRepeat)
    + Number(historyMessageId !== null);
  if (selectedSourceCount > 1) {
    return interaction.reply({
      content: '固定テンプレ、サーバーテンプレ、前回の複製、履歴はどれか1つだけ選んでね。',
      ephemeral: true,
    });
  }

  let source = tpl;
  if (presetName !== null) {
    try {
      source = getRecruitPreset(interaction.guildId, presetName);
    } catch {
      source = null;
    }
    if (!source) {
      return interaction.reply({
        content: '指定したサーバーテンプレートは見つかりません。候補から選び直してね。',
        ephemeral: true,
      });
    }
  }
  if (shouldRepeat) {
    source = findLatestRecruitment(interaction.guildId, interaction.user.id);
    if (!source) {
      return interaction.reply({
        content: 'このサーバーで複製できる過去の募集がありません。',
        ephemeral: true,
      });
    }
  }
  if (historyMessageId !== null) {
    source = findScopedRecruitment(
      interaction.guildId,
      interaction.user.id,
      historyMessageId,
    );
    if (!source) {
      return interaction.reply({
        content: '指定した募集履歴は見つかりません。候補から選び直してね。',
        ephemeral: true,
      });
    }
  }
  const shouldCopyRecruitment = shouldRepeat || historyMessageId !== null;

  const requestedGame = interaction.options.getString('ゲーム');
  const rawGame = requestedGame ?? source?.game ?? null;
  if (!rawGame || rawGame.length > 100) {
    return interaction.reply({
      content: 'ゲーム名を100文字以内で入れるか、テンプレを選んでね。',
      ephemeral: true,
    });
  }
  const resolvedGame = await resolveGameSelection(rawGame, {
    source: requestedGame === null ? source : null,
  });
  if (!resolvedGame) {
    return interaction.reply({
      content: '選んだゲーム候補を確認できませんでした。ゲーム欄へ入力し直して候補から選んでね。',
      ephemeral: true,
    });
  }
  const game = resolvedGame.game;
  const now = Date.now();
  const startText = interaction.options.getString('開始日時');
  const timeZone = getRecruitTimeZone(interaction.guildId);
  let startAt = null;
  let startTimeZone = null;
  let storedStartText = null;
  if (startText !== null) {
    const parsedStart = parseRecruitStart(startText, timeZone, now);
    if (!parsedStart) {
      return interaction.reply({
        content: `開始日時は ${timeZone} の有効な日付または日時を「8/7」「8/7 21:00」「明日 21:00」のように指定してね。`,
        ephemeral: true,
      });
    }
    startAt = parsedStart.startAt;
    const parsedState = { ...parsedStart, startTimeZone: timeZone };
    if (!isRecruitStartUsable(parsedState, now, MIN_RECRUIT_START_LEAD_MS)) {
      return interaction.reply({
        content: Number.isFinite(startAt)
          ? '開始日時は現在から1分以上先を指定してね。'
          : '開始日は今日以降を指定してね。',
        ephemeral: true,
      });
    }
    startTimeZone = timeZone;
    storedStartText = parsedStart.startText;
  } else if (shouldCopyRecruitment) {
    const copiedStart = copyFutureStart(source, now);
    startAt = copiedStart.startAt;
    startTimeZone = copiedStart.startTimeZone;
    storedStartText = copiedStart.startText;
  }

  const reminderEnabled = getOptionSafely(interaction.options, 'getBoolean', '事前通知');
  const legacyReminderLead = getOptionSafely(interaction.options, 'getInteger', '事前通知');
  const customReminderLead = getOptionSafely(interaction.options, 'getInteger', '通知分');
  const requestedReminderLead = customReminderLead ?? legacyReminderLead;
  if (
    requestedReminderLead !== null
    && (
      !Number.isInteger(requestedReminderLead)
      || requestedReminderLead < 1
      || requestedReminderLead > MAX_REMINDER_LEAD_MINUTES
    )
  ) {
    return interaction.reply({
      content: `事前通知は1〜${MAX_REMINDER_LEAD_MINUTES}分で指定してね。`,
      ephemeral: true,
    });
  }
  if (reminderEnabled === false && customReminderLead !== null) {
    return interaction.reply({
      content: '通知分を指定する場合は、事前通知を「あり」にしてね。',
      ephemeral: true,
    });
  }
  const reminderWasExplicitlyEnabled = reminderEnabled === true
    || customReminderLead !== null
    || legacyReminderLead !== null;
  const reminderLeadMinutes = reminderWasExplicitlyEnabled
    ? requestedReminderLead ?? 30
    : reminderEnabled === false
      ? null
      : (shouldCopyRecruitment && startText === null ? copyFutureReminderLead(source, now) : null);
  if (reminderLeadMinutes !== null && !startAt) {
    return interaction.reply({
      content: storedStartText
        ? '事前通知を使う場合は、開始日に時刻も付けて指定してね。'
        : '事前通知を使う場合は、開始日時も指定してね。',
      ephemeral: true,
    });
  }

  const time = interaction.options.getString('時間')
    ?? (shouldCopyRecruitment ? copyTimeWithoutExpiredGeneratedStart(source, now) : source?.time)
    ?? (storedStartText ? `${storedStartText} ${timeZone}` : '今から');
  const capacity = interaction.options.getInteger('あと何人') ?? source?.capacity ?? null;
  if (time.length > 100 || (capacity !== null && (capacity < 1 || capacity > 50))) {
    return interaction.reply({
      content: '時間は100文字以内、あと何人は1〜50で指定してね。',
      ephemeral: true,
    });
  }

  const selectedVoiceChannel = interaction.options.getChannel?.('対象vc') ?? null;
  if (selectedVoiceChannel && selectedVoiceChannel.type !== ChannelType.GuildVoice) {
    return interaction.reply({
      content: '対象VCには通常のボイスチャンネルを選んでね。',
      ephemeral: true,
    });
  }
  if (
    selectedVoiceChannel
    && (
      selectedVoiceChannel.guildId !== interaction.guildId
      || !/^\d{17,20}$/.test(selectedVoiceChannel.id)
    )
  ) {
    return interaction.reply({
      content: '対象VCにはこのサーバーのボイスチャンネルを選んでね。',
      ephemeral: true,
    });
  }
  const requestedVoiceAutoClose = interaction.options.getBoolean?.('vc集合で自動終了') ?? false;
  if (requestedVoiceAutoClose && !selectedVoiceChannel) {
    return interaction.reply({
      content: 'VC集合で自動終了を使う場合は、対象VCも選んでね。',
      ephemeral: true,
    });
  }

  const requestedAutoClose = interaction.options.getBoolean?.('自動締切') ?? null;
  const deadline = interaction.options.getString('締切')?.trim() || null;
  const autoCloseEnabled = requestedAutoClose ?? getDefaultAutoCloseEnabled(interaction.guildId);
  if (!autoCloseEnabled && deadline) {
    return interaction.reply({
      content: '締切を指定する場合は「自動締切」をONにしてね。',
      ephemeral: true,
    });
  }
  const closeAt = autoCloseEnabled ? parseCloseAt(deadline, now) : null;
  if (autoCloseEnabled && !closeAt) {
    return interaction.reply({
      content: '自動締切をONにする場合は、締切を「30分後」「2時間後」「22時」のように指定してね。',
      ephemeral: true,
    });
  }

  const state = {
    messageId: null,
    channelId: interaction.channelId,
    guildId: interaction.guildId,
    game,
    time,
    capacity,
    hostId: interaction.user.id,
    members: [],
    waitlist: [],
    vcId: null,
    closed: false,
    closedReason: null,
    createdAt: now,
    autoCloseEnabled,
    closeAt,
    closeText: autoCloseEnabled ? deadline : null,
    startAt,
    startTimeZone,
    startText: storedStartText,
    reminderLeadMinutes,
    reminderSentAt: null,
    reminderLastAttemptAt: null,
    voiceChannelId: selectedVoiceChannel?.id ?? null,
    autoCloseWhenVoiceReady: requestedVoiceAutoClose,
    ...(resolvedGame.gameProvider ? {
      gameProvider: resolvedGame.gameProvider,
      gameExternalId: resolvedGame.gameExternalId,
      gameImageId: resolvedGame.gameImageId,
    } : {}),
  };

  const message = await interaction.reply({
    ...renderMessage(state, { notifyHere: true }),
    withResponse: true,
  });

  state.messageId = message.resource.message.id;
  recruitments.set(state.messageId, state);
  persist();
  if (runtimeOptions.enableXShare && typeof interaction.editReply === 'function') {
    await interaction.editReply(renderMessage(state)).catch(() => {});
  }
}

function findLatestRecruitment(guildId, hostId) {
  return [...recruitments.values()]
    .filter((state) => state.guildId === guildId && state.hostId === hostId)
    .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))[0] ?? null;
}

function findScopedRecruitment(guildId, hostId, messageId) {
  if (typeof messageId !== 'string' || messageId.length < 1 || messageId.length > 100) return null;
  const state = recruitments.get(messageId);
  return state?.guildId === guildId && state?.hostId === hostId ? state : null;
}

function historyFingerprint(state, reusableTime) {
  return JSON.stringify([
    state.game,
    reusableTime,
    state.capacity ?? null,
    state.voiceChannelId ?? null,
    state.autoCloseWhenVoiceReady === true,
  ]);
}

function historyChoiceName(state) {
  const game = sanitizeDiscordMarkdownText(state.game, { maxLength: 100 }) || 'イベント';
  const time = sanitizeDiscordMarkdownText(state.time, { maxLength: 100 }) || '日時未定';
  const capacity = Number.isInteger(state.capacity) ? `あと${state.capacity}人` : '人数指定なし';
  return truncateUtf16(`${game} ・ ${time} ・ ${capacity}`, 100);
}

function isValidHistoryState(state) {
  return typeof state?.messageId === 'string'
    && /^[A-Za-z0-9_-]{1,64}$/u.test(state.messageId)
    && typeof state.game === 'string'
    && typeof state.time === 'string';
}

function toHistoryEntry(state) {
  if (!isValidHistoryState(state)) return null;
  const reusableTime = copyTimeWithoutExpiredGeneratedStart(state) ?? '日時未定';
  const reusable = { ...state, time: reusableTime };
  return {
    messageId: state.messageId,
    game: state.game,
    time: reusableTime,
    capacity: state.capacity ?? null,
    startText: hasUsableFutureStart(state) ? state.startText ?? null : null,
    createdAt: state.createdAt ?? 0,
    choiceName: historyChoiceName(reusable),
  };
}

export function getRecruitmentHistoryEntry(guildId, hostId, messageId) {
  const state = findScopedRecruitment(guildId, hostId, messageId);
  return state ? toHistoryEntry(state) : null;
}

export function listRecruitmentHistory(guildId, hostId, { query = '', limit = 10 } = {}) {
  if (!guildId || !hostId) return [];
  const normalizedQuery = String(query).normalize('NFKC').toLocaleLowerCase('ja-JP');
  const fingerprints = new Set();
  const history = [];
  const sorted = [...recruitments.values()]
    .filter((state) => state.guildId === guildId && state.hostId === hostId)
    .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0));
  for (const state of sorted) {
    const entry = toHistoryEntry(state);
    if (!entry) continue;
    const fingerprint = historyFingerprint(state, entry.time);
    if (fingerprints.has(fingerprint)) continue;
    fingerprints.add(fingerprint);
    const name = entry.choiceName;
    if (!name.normalize('NFKC').toLocaleLowerCase('ja-JP').includes(normalizedQuery)) continue;
    history.push(entry);
    if (history.length >= Math.min(Math.max(Number(limit) || 10, 1), 10)) break;
  }
  return history;
}

export async function autocomplete(interaction) {
  if (!interaction.guildId) return interaction.respond([]);
  const focused = interaction.options.getFocused(true);
  if (focused.name === '履歴から') {
    const choices = listRecruitmentHistory(interaction.guildId, interaction.user?.id, {
      query: focused.value,
    }).map((state) => ({ name: state.choiceName, value: state.messageId }));
    return interaction.respond(choices);
  }
  if (focused.name === 'ゲーム') {
    const query = String(focused.value ?? '').normalize('NFKC').trim().slice(0, 100);
    if (!query) return interaction.respond([]);
    const fixedChoices = searchFixedGames(query, { limit: 10 })
      .map((game) => ({ name: truncateUtf16(game.name, 100), value: game.name }));
    let igdbGames = [];
    if (runtimeOptions.gameSearch && query.length >= 2) {
      try {
        igdbGames = await withFallbackTimeout(
          runtimeOptions.gameSearch.search(query),
          [],
          GAME_AUTOCOMPLETE_TIMEOUT_MS,
        );
      } catch {
        igdbGames = [];
      }
    }
    const seen = new Set(fixedChoices.map((choice) => choice.name.normalize('NFKC').toLowerCase()));
    const choices = [...fixedChoices];
    for (const game of igdbGames) {
      const name = truncateUtf16(game.name, 100);
      const key = name.normalize('NFKC').toLowerCase();
      if (!name || seen.has(key) || !Number.isSafeInteger(game.id) || game.id < 1) continue;
      seen.add(key);
      choices.push({ name, value: `igdb:${game.id}` });
      if (choices.length >= 25) break;
    }
    return interaction.respond(choices);
  }
  if (focused.name !== 'サーバーテンプレ') return interaction.respond([]);
  const query = String(focused.value).normalize('NFKC').toLocaleLowerCase('ja-JP');
  const choices = listRecruitPresets(interaction.guildId)
    .filter((preset) => preset.name.toLocaleLowerCase('ja-JP').includes(query))
    .slice(0, 25)
    .map((preset) => ({ name: preset.name, value: preset.name }));
  return interaction.respond(choices);
}

export async function refreshGuildMessages(guildId) {
  let refreshed = 0;
  for (const state of recruitments.values()) {
    if (state.guildId !== guildId) continue;
    const message = await fetchMessage(state);
    if (!message) continue;
    await message.edit(renderMessage(state));
    refreshed += 1;
  }
  return refreshed;
}

// ===== ボタン処理 =====
export async function handleButton(interaction) {
  const state = recruitments.get(interaction.message.id);
  if (!state) {
    return interaction.reply({
      content: 'この募集はもう有効じゃないみたい。新しく立て直してね。',
      ephemeral: true,
    });
  }
  if (!interaction.guildId || state.guildId !== interaction.guildId) {
    return interaction.reply({
      content: 'このサーバーからは別のサーバーの募集を操作できません。',
      ephemeral: true,
    });
  }

  const userId = interaction.user.id;

  switch (interaction.customId) {
    case 'recruit_join':
      return handleJoin(interaction, state, userId);
    case 'recruit_leave':
      return handleLeave(interaction, state, userId);
    case 'recruit_close':
      return handleCloseButton(interaction, state, userId);
    case 'recruit_close_silent':
      return handleSilentCloseButton(interaction, state, userId);
    case 'recruit_addmore':
      return handleAddMoreButton(interaction, state, userId);
    case 'recruit_edit':
      return handleEditButton(interaction, state, userId);
    case 'recruit_transfer':
      return handleTransferButton(interaction, state, userId);
    default:
      return;
  }
}

async function handleJoin(interaction, state, userId) {
  if (userId === state.hostId) {
    return interaction.reply({
      content: 'あなたは主催者なので、募集枠には含まれません🙆（すでに参加扱いです）',
      ephemeral: true,
    });
  }
  if (state.members.includes(userId)) {
    return interaction.reply({ content: 'すでに参加済みだよ！', ephemeral: true });
  }
  if (state.waitlist.includes(userId)) {
    return interaction.reply({ content: 'すでに補欠で待機中だよ⏳', ephemeral: true });
  }

  // 満員なら補欠に回す
  if (state.capacity && state.members.length >= state.capacity) {
    if (state.waitlist.length >= MAX_WAITLIST_SIZE) {
      return interaction.reply({
        content: `補欠は${MAX_WAITLIST_SIZE}人までです。`,
        ephemeral: true,
      });
    }
    state.waitlist.push(userId);
    persist();
    await updateMessage(interaction, state);
    return interaction.followUp({
      content: '満員だったので **補欠** で登録したよ⏳ 空きが出たら自動で繰り上げ＆通知します！',
      ephemeral: true,
    });
  }

  state.members.push(userId);
  await grantVoiceAccess(state, userId);
  persist();

  if (await closeWhenVoiceReady(state, interaction.guild, { refreshMessage: false })) {
    return updateMessage(interaction, state);
  }

  // 参加した結果ちょうど満員になったら自動締め切り
  if (state.capacity && state.members.length >= state.capacity) {
    return finalizeClose(interaction, state, '満員になったので自動で締め切りました🎉', 'full');
  }

  return updateMessage(interaction, state);
}

async function handleLeave(interaction, state, userId) {
  const wasMember = state.members.includes(userId);
  const wasClosedByFullCapacity = state.closed && state.closedReason === 'full';
  state.members = state.members.filter((id) => id !== userId);
  state.waitlist = state.waitlist.filter((id) => id !== userId);

  if (wasMember) await revokeVoiceAccess(state, userId);

  // 空きが出たので補欠を繰り上げる
  let promotedId = null;
  if (
    wasMember &&
    state.waitlist.length > 0 &&
    (!state.capacity || state.members.length < state.capacity)
  ) {
    promotedId = state.waitlist.shift();
    state.members.push(promotedId);
    await grantVoiceAccess(state, promotedId);
  }

  if (
    wasMember
    && wasClosedByFullCapacity
    && !promotedId
    && state.capacity
    && state.members.length < state.capacity
  ) {
    state.closed = false;
    state.closedReason = null;
  }

  persist();
  await closeWhenVoiceReady(state, interaction.guild, { refreshMessage: false });
  await updateMessage(interaction, state);

  if (promotedId) {
    await interaction.followUp({
      content: `⏳→✅ 補欠から <@${promotedId}> を繰り上げました！`,
    });
  }
}

async function handleCloseButton(interaction, state, userId) {
  if (userId !== state.hostId) {
    return interaction.reply({
      content: '締め切れるのは募集を立てた人だけだよ。',
      ephemeral: true,
    });
  }
  return finalizeClose(interaction, state, 'この募集は締め切られました。');
}

async function handleSilentCloseButton(interaction, state, userId) {
  if (userId !== state.hostId) {
    return interaction.reply({
      content: '募集を終了できるのは募集を立てた人だけだよ。',
      ephemeral: true,
    });
  }
  return finalizeClose(
    interaction,
    state,
    '通知せず募集を終了しました。',
    'manual',
    { notifyParticipants: false, createVoiceChannel: false, followUpPrefix: '🔕' },
  );
}

// 締め切り共通処理（手動・満員・時間切れ すべてここを通る）
async function applyClose(state, reason, { createVoiceChannel = true } = {}) {
  if (state.closed) return '';
  let notice = '';
  if (createVoiceChannel && runtimeOptions.createPrivateVoiceChannels && !state.vcId) {
    try {
      const vc = await createPrivateVoiceChannel(state);
      state.vcId = vc.id;
      notice = `\n🔊 参加者専用ボイスチャンネルを作ったよ → <#${vc.id}>（全員抜けたら自動で消えます）`;
    } catch (err) {
      console.error('専用VCの作成に失敗:', err);
      notice = '\n⚠️ 専用ボイスチャンネルの作成に失敗しました（Botの「チャンネルの管理」権限を確認してね）。';
    }
  } else if (createVoiceChannel && runtimeOptions.createPrivateVoiceChannels) {
    notice = `\n🔊 専用ボイスチャンネルはこちら → <#${state.vcId}>`;
  }
  state.closed = true;
  state.closedReason = reason;
  recordSession(state); // 統計に記録
  return notice;
}

function isVoiceReady(state, guild) {
  if (
    state.closed
    || state.autoCloseWhenVoiceReady !== true
    || !state.voiceChannelId
    || !guild
    || guild.id !== state.guildId
  ) {
    return false;
  }
  const requiredUserIds = [...new Set([state.hostId, ...state.members])];
  if (requiredUserIds.length < 2) return false;
  return requiredUserIds.every(
    (userId) => guild.voiceStates?.cache?.get(userId)?.channelId === state.voiceChannelId,
  );
}

async function closeWhenVoiceReady(
  state,
  suppliedGuild,
  { refreshMessage = true } = {},
) {
  if (!state.messageId || voiceReadyClosuresInFlight.has(state.messageId)) return false;
  const guild = suppliedGuild ?? client?.guilds?.cache?.get(state.guildId);
  if (!isVoiceReady(state, guild)) return false;

  voiceReadyClosuresInFlight.add(state.messageId);
  try {
    const current = recruitments.get(state.messageId);
    if (current !== state || !isVoiceReady(current, guild)) return false;
    await applyClose(current, 'voice-ready', { createVoiceChannel: false });
    persist();
    if (refreshMessage) {
      const message = await fetchMessage(current);
      if (message) await message.edit(renderMessage(current)).catch(() => {});
    }
    return true;
  } finally {
    voiceReadyClosuresInFlight.delete(state.messageId);
  }
}

async function closeVoiceReadyRecruitmentsForGuild(guild) {
  if (!guild?.id) return;
  for (const state of recruitments.values()) {
    if (state.guildId === guild.id) await closeWhenVoiceReady(state, guild);
  }
}

// 参加者全員にメンションして集合通知を送る
async function sendStartMention(state, headline) {
  try {
    const channel = await client.channels.fetch(state.channelId).catch(() => null);
    if (!channel) return;
    const mentions = [state.hostId, ...state.members].map((id) => `<@${id}>`).join(' ');
    const game = sanitizeDiscordMarkdownText(state.game, { maxLength: 100 }) || 'イベント';
    await channel.send({
      content: `📣 **${game}** ${headline}\n${mentions}`,
      allowedMentions: { users: [state.hostId, ...state.members] },
    });
  } catch (err) {
    console.error('集合通知の送信に失敗:', err);
  }
}

// ボタン操作からの締め切り（interaction.update を使う）
async function finalizeClose(
  interaction,
  state,
  headline,
  reason = 'manual',
  {
    notifyParticipants = true,
    createVoiceChannel = true,
    followUpPrefix = '🔒',
  } = {},
) {
  const notice = await applyClose(state, reason, { createVoiceChannel });
  persist();
  await interaction.update(renderMessage(state)).catch(async () => {
    const msg = await fetchMessage(state);
    if (msg) await msg.edit(renderMessage(state)).catch(() => {});
  });
  if (notifyParticipants) await sendStartMention(state, `集合！${notice}`);
  // ヘッドラインは ephemeral 補足で
  await interaction.followUp({
    content: `${followUpPrefix} ${headline}`,
    ephemeral: true,
  }).catch(() => {});
}

// スケジューラ等からの締め切り（interaction なし）
async function autoClose(state, headline) {
  const notice = await applyClose(state, 'timeout');
  persist();
  const msg = await fetchMessage(state);
  if (msg) await msg.edit(renderMessage(state)).catch(() => {});
  await sendStartMention(state, `${headline}${notice}`);
}

async function handleAddMoreButton(interaction, state, userId) {
  if (!isHostOrMember(state, userId)) {
    return interaction.reply({
      content: '追加募集できるのは主催者か参加メンバーだけだよ。',
      ephemeral: true,
    });
  }
  const modal = new ModalBuilder().setCustomId('recruit_addmore_modal').setTitle('追加募集');
  const input = new TextInputBuilder()
    .setCustomId('addCount')
    .setLabel('あと何人募集する？（自分は含めません）')
    .setPlaceholder('例: 2')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(3);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return interaction.showModal(modal);
}

function buildMessageUrl(state, messageId) {
  return `https://discord.com/channels/${state.guildId}/${state.channelId}/${messageId}`;
}

function createAdditionalRecruitment(previous, capacity, now = Date.now()) {
  const copiedStart = copyFutureStart(previous, now);
  const reminderLeadMinutes = copiedStart.startAt
    ? copyFutureReminderLead(previous, now)
    : null;
  return {
    messageId: null,
    channelId: previous.channelId,
    guildId: previous.guildId,
    game: previous.game,
    time: copyTimeWithoutExpiredGeneratedStart(previous, now),
    capacity,
    hostId: previous.hostId,
    members: [],
    waitlist: [],
    vcId: null,
    closed: false,
    closedReason: null,
    createdAt: now,
    autoCloseEnabled: false,
    closeAt: null,
    closeText: null,
    ...copiedStart,
    reminderLeadMinutes,
    reminderSentAt: null,
    reminderLastAttemptAt: null,
    voiceChannelId: previous.voiceChannelId ?? null,
    autoCloseWhenVoiceReady: previous.autoCloseWhenVoiceReady === true,
    sourceRecruitmentId: previous.messageId,
    ...(copyStoredGameSelection(previous) ?? {}),
  };
}

function formatRemainingDeadline(closeAt, now = Date.now()) {
  if (!Number.isFinite(closeAt) || closeAt <= now) return '';
  return `${Math.max(1, Math.ceil((closeAt - now) / 60_000))}分後`;
}

function getModalValue(interaction, customId, fallback = '') {
  try {
    const value = interaction.fields.getTextInputValue(customId);
    return typeof value === 'string' ? value : fallback;
  } catch {
    return fallback;
  }
}

function parseAutoCloseToggle(value) {
  const normalized = value.trim().normalize('NFKC').toLowerCase();
  if (['on', 'オン', 'true', '有効'].includes(normalized)) return true;
  if (['off', 'オフ', 'false', '無効'].includes(normalized)) return false;
  return null;
}

function parseAutoCloseDeadline(interaction, state) {
  const combined = getModalValue(interaction, 'autoCloseDeadline', null);
  if (combined !== null) {
    const [toggleText = '', ...deadlineParts] = combined.trim().normalize('NFKC').split(/\s+/u);
    const autoCloseEnabled = parseAutoCloseToggle(toggleText);
    return {
      autoCloseEnabled,
      deadline: autoCloseEnabled ? deadlineParts.join(' ').trim() : null,
      hasUnexpectedDeadline: autoCloseEnabled === false && deadlineParts.length > 0,
    };
  }
  const autoCloseRaw = getModalValue(interaction, 'autoClose', state.autoCloseEnabled ? 'ON' : 'OFF');
  const autoCloseEnabled = parseAutoCloseToggle(autoCloseRaw);
  return {
    autoCloseEnabled,
    deadline: autoCloseEnabled
      ? getModalValue(interaction, 'deadline', state.closeText ?? '').trim()
      : null,
    hasUnexpectedDeadline: false,
  };
}

function parseStartReminderValue(value) {
  const normalized = value.trim().normalize('NFKC');
  if (!normalized) return { startText: '', reminderLeadMinutes: null };
  const parts = normalized.split(/\s*\|\s*/u);
  if (parts.length > 2 || !parts[0] || parts[0].length > 32) return null;
  const reminderText = parts[1];
  if (reminderText !== undefined && !/^\d{1,5}$/u.test(reminderText)) return null;
  const reminderLeadMinutes = reminderText === undefined ? null : Number(reminderText);
  if (
    reminderLeadMinutes !== null
    && (
      !Number.isInteger(reminderLeadMinutes)
      || reminderLeadMinutes < 1
      || reminderLeadMinutes > MAX_REMINDER_LEAD_MINUTES
    )
  ) {
    return null;
  }
  return { startText: parts[0], reminderLeadMinutes };
}

async function handleEditButton(interaction, state, userId) {
  if (userId !== state.hostId) {
    return interaction.reply({ content: '編集できるのは主催者だけだよ。', ephemeral: true });
  }
  const modal = new ModalBuilder().setCustomId('recruit_edit_modal').setTitle('募集を編集');
  const timeZone = getRecruitTimeZone(state.guildId);
  const startInput = new TextInputBuilder()
    .setCustomId('start')
    .setLabel('開始日時 | 事前通知分（空欄で解除）')
    .setPlaceholder(`例: 8/7 21:00 | 30 (${timeZone})`)
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(40);
  if (state.startText) {
    startInput.setValue(
      `${state.startText.slice(0, 16)}${state.reminderLeadMinutes ? ` | ${state.reminderLeadMinutes}` : ''}`,
    );
  }

  const deadlineValue = state.autoCloseEnabled
    ? state.closeText ?? formatRemainingDeadline(state.closeAt)
    : '';
  const autoCloseDeadlineInput = new TextInputBuilder()
    .setCustomId('autoCloseDeadline')
    .setLabel('自動締切（OFF / ON 30分後）')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(103)
    .setValue(state.autoCloseEnabled ? `ON ${deadlineValue}` : 'OFF');

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('game')
        .setLabel('ゲーム名')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(100)
        .setValue(state.game),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('time')
        .setLabel('時間')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(100)
        .setValue(state.time),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('capacity')
        .setLabel('募集人数（自分を除く・空欄で無制限）')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(2)
        .setValue(state.capacity ? String(state.capacity) : ''),
    ),
    new ActionRowBuilder().addComponents(
      startInput,
    ),
    new ActionRowBuilder().addComponents(autoCloseDeadlineInput),
  );
  return interaction.showModal(modal);
}

async function handleTransferButton(interaction, state, userId) {
  if (userId !== state.hostId) {
    return interaction.reply({ content: '主催を交代できるのは主催者だけだよ。', ephemeral: true });
  }
  if (state.members.length === 0) {
    return interaction.reply({
      content: '参加メンバーがいないので交代できないよ。',
      ephemeral: true,
    });
  }
  // 先頭の参加者を新主催に。元主催は参加メンバーに加える。
  const newHost = state.members.shift();
  state.members.push(state.hostId);
  state.hostId = newHost;
  persist();
  await updateMessage(interaction, state);
  await interaction.followUp({ content: `🔁 主催を <@${newHost}> に交代しました！` });
}

// ===== モーダル処理 =====
export async function handleModal(interaction) {
  const state = recruitments.get(interaction.message?.id);
  if (!state) {
    return interaction.reply({
      content: 'この募集はもう有効じゃないみたい。新しく立て直してね。',
      ephemeral: true,
    });
  }
  if (!interaction.guildId || state.guildId !== interaction.guildId) {
    return interaction.reply({
      content: 'このサーバーからは別のサーバーの募集を操作できません。',
      ephemeral: true,
    });
  }

  if (interaction.customId === 'recruit_addmore_modal') {
    if (!isHostOrMember(state, interaction.user.id)) {
      return interaction.reply({
        content: '追加募集できるのは主催者か参加メンバーだけだよ。',
        ephemeral: true,
      });
    }
    if (!state.closed) {
      return interaction.reply({
        content: '追加募集は締め切り済みの募集から行ってね。',
        ephemeral: true,
      });
    }
    if (state.supersededByMessageId) {
      return interaction.reply({
        content: `追加募集はすでに作成済みです。\n${buildMessageUrl(state, state.supersededByMessageId)}`,
        ephemeral: true,
        allowedMentions: { parse: [] },
      });
    }
    if (state.reopening) {
      return interaction.reply({
        content: '追加募集を作成中です。少し待ってから新しいカードを確認してね。',
        ephemeral: true,
      });
    }
    const raw = interaction.fields.getTextInputValue('addCount').trim();
    const addCount = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isInteger(addCount) || addCount < 1 || addCount > 50) {
      return interaction.reply({ content: '人数は 1〜50 の数字で入力してね（例: 2）。', ephemeral: true });
    }
    if (listActive(state.guildId).length >= MAX_ACTIVE_RECRUITS_PER_GUILD) {
      return interaction.reply({
        content: `このサーバーで同時に募集できるのは${MAX_ACTIVE_RECRUITS_PER_GUILD}件までです。`,
        ephemeral: true,
      });
    }

    const newState = createAdditionalRecruitment(state, addCount);
    state.reopening = true;
    persist();

    let response;
    try {
      response = await interaction.reply({
        ...renderMessage(newState, { notifyHere: true }),
        withResponse: true,
      });
    } catch (error) {
      state.reopening = false;
      persist();
      throw error;
    }

    newState.messageId = response.resource.message.id;
    recruitments.set(newState.messageId, newState);
    state.supersededByMessageId = newState.messageId;
    state.reopening = false;
    persist();

    if (runtimeOptions.enableXShare && typeof interaction.editReply === 'function') {
      await interaction.editReply(renderMessage(newState)).catch(() => {});
    }
    const oldMessage = await fetchMessage(state);
    if (oldMessage) await oldMessage.edit(renderMessage(state)).catch(() => {});
    return undefined;
  }

  if (interaction.customId === 'recruit_edit_modal') {
    if (interaction.user.id !== state.hostId) {
      return interaction.reply({ content: '編集できるのは主催者だけだよ。', ephemeral: true });
    }
    const game = interaction.fields.getTextInputValue('game').trim();
    const time = interaction.fields.getTextInputValue('time').trim();
    const capRaw = interaction.fields.getTextInputValue('capacity').trim();

    if (!game || game.length > 100 || !time || time.length > 100) {
      return interaction.reply({
        content: 'ゲーム名と時間は1〜100文字で入力してね。',
        ephemeral: true,
      });
    }
    let capacity = null;
    if (capRaw === '') {
      capacity = null;
    } else {
      const cap = /^\d+$/.test(capRaw) ? Number(capRaw) : Number.NaN;
      if (!Number.isInteger(cap) || cap < 1 || cap > 50) {
        return interaction.reply({
          content: '募集人数は 1〜50 の数字で入力してね。',
          ephemeral: true,
        });
      }
      capacity = cap;
    }
    const autoClose = parseAutoCloseDeadline(interaction, state);
    if (autoClose.autoCloseEnabled === null || autoClose.hasUnexpectedDeadline) {
      return interaction.reply({
        content: '自動締切は OFF または「ON 30分後」のように入力してね。',
        ephemeral: true,
      });
    }
    const closeAt = autoClose.autoCloseEnabled ? parseCloseAt(autoClose.deadline) : null;
    if (autoClose.autoCloseEnabled && !closeAt) {
      return interaction.reply({
        content: '自動締切をONにする場合は、締切を「30分後」「2時間後」「22時」のように入力してね。',
        ephemeral: true,
      });
    }

    const startValue = getModalValue(interaction, 'start', null);
    let startAt = state.startAt ?? null;
    let startText = state.startText ?? null;
    let startTimeZone = state.startTimeZone ?? null;
    let reminderLeadMinutes = state.reminderLeadMinutes ?? null;
    let nextTime = time;
    if (startValue !== null) {
      const parsedStartReminder = parseStartReminderValue(startValue);
      if (!parsedStartReminder) {
        return interaction.reply({
          content: `開始は「2026-08-07」または「2026-08-07 21:00 | 30」の形式で入力してね（通知は1〜${MAX_REMINDER_LEAD_MINUTES}分）。`,
          ephemeral: true,
        });
      }
      const requestedStart = parsedStartReminder.startText;
      reminderLeadMinutes = parsedStartReminder.reminderLeadMinutes;
      const previousGeneratedTime = generatedStartTime(state);
      if (!requestedStart) {
        startAt = null;
        startText = null;
        startTimeZone = null;
        reminderLeadMinutes = null;
      } else if (
        requestedStart === state.startText
        && isRecruitStartUsable(state)
        && typeof state.startTimeZone === 'string'
      ) {
        startAt = state.startAt;
        startText = state.startText;
        startTimeZone = state.startTimeZone;
      } else {
        const guildTimeZone = getRecruitTimeZone(state.guildId);
        const parsedStart = parseRecruitStart(requestedStart, guildTimeZone);
        if (!parsedStart) {
          return interaction.reply({
            content: `開始日時は ${guildTimeZone} の有効な日付または日時を「8/7」「8/7 21:00」「明日 21:00」のように入力してね。`,
            ephemeral: true,
          });
        }
        startAt = parsedStart.startAt;
        const parsedState = { ...parsedStart, startTimeZone: guildTimeZone };
        if (!isRecruitStartUsable(parsedState, Date.now(), MIN_RECRUIT_START_LEAD_MS)) {
          return interaction.reply({
            content: Number.isFinite(startAt)
              ? '開始日時は現在から1分以上先を指定してね。'
              : '開始日は今日以降を指定してね。',
            ephemeral: true,
          });
        }
        startText = parsedStart.startText;
        startTimeZone = guildTimeZone;
      }
      if (reminderLeadMinutes !== null && !Number.isFinite(startAt)) {
        return interaction.reply({
          content: '事前通知を使う場合は、開始日に時刻も付けて入力してね。',
          ephemeral: true,
        });
      }
      if (previousGeneratedTime && time === previousGeneratedTime) {
        nextTime = startText ? `${startText} ${startTimeZone}` : '日時未定';
      }
    }

    const reminderScheduleChanged = startAt !== (state.startAt ?? null)
      || startText !== (state.startText ?? null)
      || reminderLeadMinutes !== (state.reminderLeadMinutes ?? null);

    const resolvedGame = await resolveGameSelection(game, {
      source: game === state.game ? state : null,
    });
    if (!resolvedGame) {
      return interaction.reply({
        content: 'ゲーム名を確認できませんでした。通常のゲーム名を入力してね。',
        ephemeral: true,
      });
    }
    state.game = resolvedGame.game;
    clearGameMetadata(state);
    if (resolvedGame.gameProvider) {
      state.gameProvider = resolvedGame.gameProvider;
      state.gameExternalId = resolvedGame.gameExternalId;
      state.gameImageId = resolvedGame.gameImageId;
    }
    state.time = nextTime;
    state.capacity = capacity;
    state.autoCloseEnabled = autoClose.autoCloseEnabled;
    state.closeAt = closeAt;
    state.closeText = autoClose.autoCloseEnabled ? autoClose.deadline : null;
    state.startAt = startAt;
    state.startText = startText;
    state.startTimeZone = startTimeZone;
    state.reminderLeadMinutes = reminderLeadMinutes;
    if (reminderScheduleChanged) {
      state.reminderSentAt = null;
      state.reminderLastAttemptAt = null;
    }
    persist();
    return updateMessage(interaction, state);
  }
}

// 通常更新（embed/buttons だけ貼り直す）
async function updateMessage(interaction, state) {
  await interaction.update(renderMessage(state)).catch(async () => {
    const msg = await fetchMessage(state);
    if (msg) await msg.edit(renderMessage(state)).catch(() => {});
  });
}

// ===== 専用VC =====
async function createPrivateVoiceChannel(state) {
  const guild = await client.guilds.fetch(state.guildId);
  const botId = client.user.id;
  const allowedIds = [...new Set([state.hostId, ...state.members])];
  const channel = await client.channels.fetch(state.channelId).catch(() => null);

  const overwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect],
    },
    {
      id: botId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.ManageChannels,
      ],
    },
    ...allowedIds.map((id) => ({
      id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
      ],
    })),
  ];

  const vc = await guild.channels.create({
    name: `🎮 ${state.game}`,
    type: ChannelType.GuildVoice,
    parent: channel?.parentId ?? undefined,
    permissionOverwrites: overwrites,
  });

  managedVoiceChannels.add(vc.id);
  return vc;
}

async function grantVoiceAccess(state, userId) {
  if (!runtimeOptions.createPrivateVoiceChannels || !state.vcId) return;
  try {
    const vc = await client.channels.fetch(state.vcId).catch(() => null);
    if (!vc) return;
    await vc.permissionOverwrites.edit(userId, { ViewChannel: true, Connect: true, Speak: true });
  } catch (err) {
    console.error('専用VCへのアクセス付与に失敗:', err);
  }
}

async function revokeVoiceAccess(state, userId) {
  if (!runtimeOptions.createPrivateVoiceChannels || !state.vcId) return;
  try {
    const vc = await client.channels.fetch(state.vcId).catch(() => null);
    if (!vc) return;
    await vc.permissionOverwrites.delete(userId).catch(() => {});
  } catch (err) {
    console.error('専用VCのアクセス削除に失敗:', err);
  }
}

// ===== VC自動削除・全員集合による募集終了 =====
export async function handleVoiceStateUpdate(oldState, newState) {
  const leftChannel = oldState.channel;
  if (
    leftChannel
    && oldState.channelId !== newState.channelId
    && managedVoiceChannels.has(leftChannel.id)
    && leftChannel.members.size === 0
  ) {
    try {
      await leftChannel.delete('募集の専用VCが空になったため自動削除');
    } catch (err) {
      console.error('専用VCの自動削除に失敗:', err);
    } finally {
      managedVoiceChannels.delete(leftChannel.id);
      for (const state of recruitments.values()) {
        if (state.vcId === leftChannel.id) state.vcId = null;
      }
      persist();
    }
  }

  const guild = newState.guild ?? oldState.guild;
  await closeVoiceReadyRecruitmentsForGuild(guild);
}

function isReminderDue(state, now) {
  if (
    state.closed
    || !Number.isFinite(state.startAt)
    || state.startAt <= now
    || !Number.isInteger(state.reminderLeadMinutes)
    || state.reminderLeadMinutes < 1
    || state.reminderLeadMinutes > MAX_REMINDER_LEAD_MINUTES
    || Number.isFinite(state.reminderSentAt)
    || reminderDeliveriesInFlight.has(state.messageId)
  ) {
    return false;
  }
  const reminderAt = state.startAt - state.reminderLeadMinutes * 60_000;
  if (now < reminderAt) return false;
  return !Number.isFinite(state.reminderLastAttemptAt)
    || now - state.reminderLastAttemptAt >= REMINDER_RETRY_INTERVAL_MS;
}

function captureReminderSchedule(state) {
  return Object.freeze({
    messageId: state.messageId,
    startAt: state.startAt,
    leadMinutes: state.reminderLeadMinutes,
    game: state.game,
  });
}

function hasSameReminderSchedule(state, schedule) {
  return state.messageId === schedule.messageId
    && state.startAt === schedule.startAt
    && state.reminderLeadMinutes === schedule.leadMinutes;
}

function isCapturedReminderReady(state, schedule, now) {
  return hasSameReminderSchedule(state, schedule)
    && !state.closed
    && !Number.isFinite(state.reminderSentAt)
    && schedule.startAt > now
    && now >= schedule.startAt - schedule.leadMinutes * 60_000;
}

function formatRemainingStartTime(startAt, now) {
  const remainingMs = startAt - now;
  if (remainingMs < 60_000) return '1分未満';
  return `${Math.ceil(remainingMs / 60_000)}分`;
}

async function sendRecruitReminder(state, now) {
  if (!isReminderDue(state, now)) return;
  const schedule = captureReminderSchedule(state);
  reminderDeliveriesInFlight.add(state.messageId);
  state.reminderLastAttemptAt = now;
  if (!persist()) {
    console.error('事前通知の試行状態を保存できなかったため送信を延期します');
    reminderDeliveriesInFlight.delete(state.messageId);
    return;
  }

  try {
    if (!client) return;
    const channel = await client.channels.fetch(state.channelId).catch(() => null);
    if (!channel || typeof channel.send !== 'function') return;
    const deliveryNow = Date.now();
    if (!isCapturedReminderReady(state, schedule, deliveryNow)) return;
    const game = sanitizeDiscordMarkdownText(schedule.game, { maxLength: 100 }) || 'イベント';
    const remaining = formatRemainingStartTime(schedule.startAt, deliveryNow);
    await channel.send({
      content: `⏰ **${game}** の開始まで${remaining}です。 <t:${Math.floor(schedule.startAt / 1_000)}:F>`,
      allowedMentions: { parse: [] },
    });
    if (isCapturedReminderReady(state, schedule, Date.now())) {
      state.reminderSentAt = Date.now();
      persist();
    }
  } catch (error) {
    console.error('事前通知の送信に失敗:', error);
  } finally {
    reminderDeliveriesInFlight.delete(state.messageId);
  }
}

// ===== スケジューラ（時間切れ自動締め切り・事前通知） =====
export async function tick(now = Date.now()) {
  for (const state of recruitments.values()) {
    if (state.closed) continue;
    if (await closeWhenVoiceReady(state)) continue;
    if (state.autoCloseEnabled && state.closeAt && now >= state.closeAt) {
      try {
        await autoClose(state, '時間になったので締め切りました⏰ 集合！');
      } catch (err) {
        console.error('自動締め切りに失敗:', err);
        // 失敗しても再ループしないよう一旦クローズ扱い
        state.closed = true;
        state.closedReason = 'timeout';
        persist();
      }
    }
    if (!state.closed) await sendRecruitReminder(state, now);
  }
}

// ===== 募集一覧（/募集一覧 から使用） =====
export function listActive(guildId) {
  return [...recruitments.values()].filter((s) => !s.closed && s.guildId === guildId);
}
