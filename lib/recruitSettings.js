import { load, save } from './store.js';

const STORE = 'recruit-settings';
const SAFE_GUILD_KEY = /^[A-Za-z0-9_-]{1,32}$/;
const SAFE_TIME_ZONE = /^(?:UTC|[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+){1,3})$/;
const SAFE_PRESET_NAME = /^[\p{L}\p{N} _ー・.-]{1,32}$/u;
const SAFE_PRESET_TEXT = /^[\p{L}\p{N}\p{P}\p{S}\p{Zs}]{1,100}$/u;

export const DEFAULT_AUTO_CLOSE_ENABLED = false;
export const DEFAULT_RECRUIT_TIME_ZONE = 'Asia/Tokyo';
export const MAX_RECRUIT_PRESETS = 20;

function requireGuildKey(guildId) {
  if (
    typeof guildId !== 'string'
    || !SAFE_GUILD_KEY.test(guildId)
    || ['__proto__', 'prototype', 'constructor'].includes(guildId)
  ) {
    throw new TypeError('DiscordサーバーIDの形式が不正です。');
  }
  return guildId;
}

function readSettings() {
  const settings = load(STORE, { guilds: {} });
  if (!settings || Array.isArray(settings) || typeof settings !== 'object') {
    throw new TypeError('募集設定データの形式が不正です。');
  }
  if (!settings.guilds || Array.isArray(settings.guilds) || typeof settings.guilds !== 'object') {
    throw new TypeError('募集設定のサーバーデータが不正です。');
  }
  return settings;
}

function normalizeTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !SAFE_TIME_ZONE.test(timeZone)) {
    throw new TypeError('タイムゾーンはIANA形式（例: Asia/Tokyo）で指定してください。');
  }
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone;
  } catch {
    throw new TypeError('タイムゾーンが見つかりません。');
  }
}

function normalizePresetText(value, label) {
  if (typeof value !== 'string') throw new TypeError(`${label}の形式が不正です。`);
  const normalized = value.normalize('NFKC').trim();
  if (!SAFE_PRESET_TEXT.test(normalized)) {
    throw new TypeError(`${label}は1〜100文字の表示可能な文字で指定してください。`);
  }
  return normalized;
}

function normalizePresetName(name) {
  if (typeof name !== 'string') throw new TypeError('テンプレート名の形式が不正です。');
  const normalized = name.normalize('NFKC').trim();
  if (
    !SAFE_PRESET_NAME.test(normalized)
    || ['__proto__', 'prototype', 'constructor'].includes(normalized)
  ) {
    throw new TypeError('テンプレート名は1〜32文字の文字・数字・空白・._-で指定してください。');
  }
  return normalized;
}

function normalizePreset(preset) {
  if (!preset || Array.isArray(preset) || typeof preset !== 'object') {
    throw new TypeError('募集テンプレートの形式が不正です。');
  }
  const capacity = preset.capacity ?? null;
  if (capacity !== null && (!Number.isInteger(capacity) || capacity < 1 || capacity > 50)) {
    throw new TypeError('募集人数は1〜50で指定してください。');
  }
  return {
    name: normalizePresetName(preset.name),
    game: normalizePresetText(preset.game, 'ゲーム名'),
    time: normalizePresetText(preset.time, '時間'),
    capacity,
  };
}

function presetsForGuild(settings, key) {
  const presets = guildSettingsForKey(settings, key).presets;
  if (!Array.isArray(presets)) return [];
  return presets.map(normalizePreset).slice(0, MAX_RECRUIT_PRESETS);
}

function guildSettingsForKey(settings, key) {
  const guildSettings = settings.guilds[key];
  if (guildSettings === undefined) return {};
  if (!guildSettings || Array.isArray(guildSettings) || typeof guildSettings !== 'object') {
    throw new TypeError('募集設定のサーバー設定が不正です。');
  }
  return guildSettings;
}

function saveGuildSettings(settings, key, guildSettings) {
  return save(STORE, {
    ...settings,
    schemaVersion: 2,
    guilds: {
      ...settings.guilds,
      [key]: guildSettings,
    },
  });
}

export function getDefaultAutoCloseEnabled(guildId) {
  const key = requireGuildKey(guildId);
  const settings = readSettings();
  const value = guildSettingsForKey(settings, key).autoCloseDefault;
  return typeof value === 'boolean' ? value : DEFAULT_AUTO_CLOSE_ENABLED;
}

export function setDefaultAutoCloseEnabled(guildId, enabled) {
  const key = requireGuildKey(guildId);
  if (typeof enabled !== 'boolean') throw new TypeError('自動締切設定は真偽値で指定してください。');
  const settings = readSettings();
  return saveGuildSettings(settings, key, {
    ...guildSettingsForKey(settings, key),
    autoCloseDefault: enabled,
  });
}

export function getRecruitTimeZone(guildId) {
  const key = requireGuildKey(guildId);
  const settings = readSettings();
  const value = guildSettingsForKey(settings, key).timeZone;
  if (typeof value !== 'string') return DEFAULT_RECRUIT_TIME_ZONE;
  try {
    return normalizeTimeZone(value);
  } catch {
    return DEFAULT_RECRUIT_TIME_ZONE;
  }
}

export function setRecruitTimeZone(guildId, timeZone) {
  const key = requireGuildKey(guildId);
  const normalized = normalizeTimeZone(timeZone);
  const settings = readSettings();
  return saveGuildSettings(settings, key, {
    ...guildSettingsForKey(settings, key),
    timeZone: normalized,
  });
}

export function listRecruitPresets(guildId) {
  const key = requireGuildKey(guildId);
  return presetsForGuild(readSettings(), key).map((preset) => ({ ...preset }));
}

export function getRecruitPreset(guildId, name) {
  const normalizedName = normalizePresetName(name);
  return listRecruitPresets(guildId).find((preset) => preset.name === normalizedName) ?? null;
}

export function setRecruitPreset(guildId, preset) {
  const key = requireGuildKey(guildId);
  const normalized = normalizePreset(preset);
  const settings = readSettings();
  const presets = presetsForGuild(settings, key);
  const index = presets.findIndex((candidate) => candidate.name === normalized.name);
  if (index === -1 && presets.length >= MAX_RECRUIT_PRESETS) {
    throw new RangeError(`募集テンプレートは${MAX_RECRUIT_PRESETS}件までです。`);
  }
  const nextPresets = index === -1
    ? [...presets, normalized]
    : presets.map((candidate, candidateIndex) => (
      candidateIndex === index ? normalized : candidate
    ));
  return saveGuildSettings(settings, key, {
    ...guildSettingsForKey(settings, key),
    presets: nextPresets,
  });
}

export function deleteRecruitPreset(guildId, name) {
  const key = requireGuildKey(guildId);
  const normalizedName = normalizePresetName(name);
  const settings = readSettings();
  const presets = presetsForGuild(settings, key);
  const nextPresets = presets.filter((preset) => preset.name !== normalizedName);
  if (nextPresets.length === presets.length) return false;
  const saved = saveGuildSettings(settings, key, {
    ...guildSettingsForKey(settings, key),
    presets: nextPresets,
  });
  return saved ? true : null;
}

export function updateRecruitSettings(guildId, updates) {
  const key = requireGuildKey(guildId);
  if (!updates || Array.isArray(updates) || typeof updates !== 'object') {
    throw new TypeError('募集設定の更新形式が不正です。');
  }
  const settings = readSettings();
  const current = guildSettingsForKey(settings, key);
  const next = { ...current };
  if (updates.autoCloseDefault !== undefined) {
    if (typeof updates.autoCloseDefault !== 'boolean') {
      throw new TypeError('自動締切設定は真偽値で指定してください。');
    }
    next.autoCloseDefault = updates.autoCloseDefault;
  }
  if (updates.timeZone !== undefined) next.timeZone = normalizeTimeZone(updates.timeZone);
  return saveGuildSettings(settings, key, next);
}
