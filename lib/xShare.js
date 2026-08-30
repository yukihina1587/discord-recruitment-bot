import { load, save } from './store.js';

const STORE = 'x-share-settings';
const DISCORD_ID = /^\d{17,20}$/;
const PLACEHOLDER = /\{[^{}]+\}/g;
const ALLOWED_PLACEHOLDERS = new Set(['{ゲーム}', '{人数}', '{時間}', '{募集URL}']);
const X_INTENT_BASE = 'https://x.com/intent/tweet';
const MAX_DISCORD_BUTTON_URL_LENGTH = 512;
const MAX_X_TEXT_LENGTH = 240;

export const MAX_X_SHARE_TEMPLATE_LENGTH = 180;
export const DEFAULT_X_SHARE_TEMPLATE = [
  '🎮 {ゲーム} 募集',
  '⏰ {時間}',
  '👥 人数：{人数}',
  '{募集URL}',
].join('\n');

function requireDiscordId(value, name) {
  const id = String(value ?? '').trim();
  if (!DISCORD_ID.test(id)) {
    throw new TypeError(`${name}には17〜20桁のDiscord IDが必要です`);
  }
  return id;
}

function readSettings() {
  const data = load(STORE, { guilds: {} });
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new TypeError('X共有設定の形式が不正です');
  }
  const guilds = data.guilds ?? {};
  if (!guilds || typeof guilds !== 'object' || Array.isArray(guilds)) {
    throw new TypeError('X共有設定のサーバーデータが不正です');
  }
  return guilds;
}

export function validateXShareTemplate(value) {
  const template = String(value ?? '')
    .replace(/\\n/gu, '\n')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (!template) throw new TypeError('募集文を入力してください');
  if (template.length > MAX_X_SHARE_TEMPLATE_LENGTH) {
    throw new TypeError(`募集文は${MAX_X_SHARE_TEMPLATE_LENGTH}文字以内にしてください`);
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(template)) {
    throw new TypeError('募集文に制御文字は使用できません');
  }
  const placeholders = template.match(PLACEHOLDER) ?? [];
  const unknown = placeholders.find((placeholder) => !ALLOWED_PLACEHOLDERS.has(placeholder));
  if (unknown) throw new TypeError(`使用できない置換項目です: ${unknown}`);
  if (!template.includes('{ゲーム}')) {
    throw new TypeError('募集文には{ゲーム}を含めてください');
  }
  return template;
}

export function getXShareTemplate(guildId) {
  const id = requireDiscordId(guildId, 'guildId');
  const configured = readSettings()[id];
  return configured === undefined
    ? DEFAULT_X_SHARE_TEMPLATE
    : validateXShareTemplate(configured);
}

export function setXShareTemplate(guildId, template) {
  const id = requireDiscordId(guildId, 'guildId');
  const normalized = validateXShareTemplate(template);
  const guilds = readSettings();
  return save(STORE, { guilds: { ...guilds, [id]: normalized } });
}

export function resetXShareTemplate(guildId) {
  const id = requireDiscordId(guildId, 'guildId');
  const guilds = readSettings();
  const remaining = Object.fromEntries(
    Object.entries(guilds).filter(([guildIdKey]) => guildIdKey !== id),
  );
  return save(STORE, { guilds: remaining });
}

function cleanReplacement(value, fallback) {
  const text = String(value ?? fallback)
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return text || fallback;
}

function renderTemplate(template, { game, time, capacity }) {
  const replacements = new Map([
    ['{ゲーム}', cleanReplacement(game, 'ゲーム')],
    ['{時間}', cleanReplacement(time, '時間未定')],
    ['{人数}', capacity == null ? '指定なし' : String(capacity)],
    // The URL is supplied through X's dedicated `url` parameter so X can shorten it safely.
    ['{募集URL}', ''],
  ]);
  return validateXShareTemplate(template)
    .replace(PLACEHOLDER, (placeholder) => replacements.get(placeholder))
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function getOpenSlots(capacity, members) {
  if (capacity == null) return null;
  const joined = Array.isArray(members) ? members.length : 0;
  return Math.max(0, capacity - joined);
}

function createIntentUrl(text, messageUrl) {
  const intent = new URL(X_INTENT_BASE);
  if (text) intent.searchParams.set('text', text);
  if (messageUrl) intent.searchParams.set('url', messageUrl);
  return intent.toString();
}

function truncateValue(value, maximum) {
  const characters = [...value];
  if (characters.length <= maximum) return value;
  return `${characters.slice(0, Math.max(1, maximum - 1)).join('')}…`;
}

function buildCompactText({ game, time, capacity }, messageUrl) {
  const safeGame = cleanReplacement(game, 'ゲーム');
  const safeTime = cleanReplacement(time, '時間未定');
  const capacityLine = capacity == null ? '人数指定なし' : `${capacity}人募集`;
  let gameLength = Math.min([...safeGame].length, 24);
  let timeLength = Math.min([...safeTime].length, 18);

  while (gameLength >= 1 && timeLength >= 1) {
    const candidate = [
      `🎮 ${truncateValue(safeGame, gameLength)} 募集`,
      `⏰ ${truncateValue(safeTime, timeLength)}`,
      `👥 ${capacityLine}`,
    ].join('\n');
    if (
      [...candidate].length <= MAX_X_TEXT_LENGTH
      && createIntentUrl(candidate, messageUrl).length <= MAX_DISCORD_BUTTON_URL_LENGTH
    ) {
      return candidate;
    }
    if (gameLength >= timeLength && gameLength > 1) gameLength -= 1;
    else if (timeLength > 1) timeLength -= 1;
    else gameLength -= 1;
  }
  throw new RangeError('X共有文をDiscordの上限内に収められません');
}

export function buildXShareIntentUrl({
  template,
  guildId,
  channelId,
  messageId,
  game,
  time,
  capacity,
  members,
}) {
  const safeGuildId = requireDiscordId(guildId, 'guildId');
  const safeChannelId = requireDiscordId(channelId, 'channelId');
  const safeMessageId = requireDiscordId(messageId, 'messageId');
  const messageUrl = [
    'https://discord.com/channels',
    safeGuildId,
    safeChannelId,
    safeMessageId,
  ].join('/');
  const configuredTemplate = template ?? getXShareTemplate(safeGuildId);
  const sharedMessageUrl = configuredTemplate.includes('{募集URL}') ? messageUrl : null;
  const openSlots = getOpenSlots(capacity, members);
  const rendered = renderTemplate(configuredTemplate, { game, time, capacity: openSlots });
  const fitted = (
    [...rendered].length <= MAX_X_TEXT_LENGTH
    && createIntentUrl(rendered, sharedMessageUrl).length <= MAX_DISCORD_BUTTON_URL_LENGTH
  )
    ? rendered
    : buildCompactText({ game, time, capacity: openSlots }, sharedMessageUrl);
  const intent = createIntentUrl(fitted, sharedMessageUrl);

  if (intent.length > MAX_DISCORD_BUTTON_URL_LENGTH) {
    throw new RangeError('X共有URLをDiscordの上限内に収められません');
  }
  return intent;
}
