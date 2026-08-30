import { requireSecret } from './env.js';

const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const IGDB_GAMES_URL = 'https://api.igdb.com/v4/games';
const IGDB_IMAGE_ORIGIN = 'https://images.igdb.com/igdb/image/upload';
const GAME_FIELDS = 'name,cover.image_id,alternative_names.name,game_localizations.name';
const REQUEST_INTERVAL_MS = 250;
const REQUEST_TIMEOUT_MS = 2_000;
const CACHE_TTL_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 250;
const MAX_SEARCH_RESULTS = 10;
const MAX_PENDING_REQUESTS = 8;
const IMAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/u;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{2,100}$/u;

function normalizeSearchInput(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .trim()
    .slice(0, 100);
}

function normalizeExactName(value) {
  return normalizeSearchInput(value)
    .toLocaleLowerCase('ja-JP')
    .replace(/\s+/gu, ' ');
}

function escapeApicalypseString(value) {
  return value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"');
}

function safeAliasNames(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => normalizeSearchInput(item?.name))
    .filter((name) => name.length > 0);
}

function normalizeGame(item) {
  if (
    !Number.isSafeInteger(item?.id)
    || item.id < 1
    || typeof item.name !== 'string'
  ) {
    return null;
  }
  const name = normalizeSearchInput(item.name);
  if (!name) return null;
  const imageId = typeof item.cover?.image_id === 'string'
    && IMAGE_ID_PATTERN.test(item.cover.image_id)
    ? item.cover.image_id
    : null;
  const aliases = [...new Set([
    ...safeAliasNames(item.alternative_names),
    ...safeAliasNames(item.game_localizations),
  ])].filter((alias) => alias !== name);
  return Object.freeze({ id: item.id, name, imageId, aliases: Object.freeze(aliases) });
}

function normalizeGames(payload) {
  if (!Array.isArray(payload)) return [];
  return payload.map(normalizeGame).filter(Boolean).slice(0, MAX_SEARCH_RESULTS);
}

async function responseJson(response, failureMessage) {
  if (!response?.ok) {
    throw new Error(`${failureMessage} (HTTP ${response?.status ?? 'unknown'})`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`${failureMessage} (応答形式が不正です)`);
  }
}

export function parseIgdbChoiceValue(value) {
  const match = /^igdb:([1-9]\d{0,15})$/u.exec(String(value ?? ''));
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : null;
}

export function igdbCoverUrl(imageId) {
  if (typeof imageId !== 'string' || !IMAGE_ID_PATTERN.test(imageId)) return null;
  return `${IGDB_IMAGE_ORIGIN}/t_cover_big/${imageId}.jpg`;
}

export function createIgdbGameSearch({
  clientId,
  clientSecret,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  if (typeof clientId !== 'string' || !clientId.trim()) {
    throw new Error('IGDB_CLIENT_IDが設定されていません');
  }
  if (typeof clientSecret !== 'string' || !clientSecret.trim()) {
    throw new Error('IGDB_CLIENT_SECRETが設定されていません');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImplが必要です');

  const safeClientId = clientId.trim();
  const safeClientSecret = clientSecret.trim();
  let token = null;
  let tokenExpiresAt = 0;
  let tokenRequest = null;
  let nextRequestAt = 0;
  let pendingRequests = 0;
  let requestQueue = Promise.resolve();
  const cache = new Map();
  const inFlightSearches = new Map();

  function fetchWithTimeout(url, options) {
    const signal = typeof globalThis.AbortSignal?.timeout === 'function'
      ? globalThis.AbortSignal.timeout(requestTimeoutMs)
      : undefined;
    return fetchImpl(url, { ...options, signal });
  }

  async function obtainToken() {
    if (token && tokenExpiresAt > now() + 60_000) return token;
    if (tokenRequest) return tokenRequest;
    tokenRequest = (async () => {
      const body = new URLSearchParams({
        client_id: safeClientId,
        client_secret: safeClientSecret,
        grant_type: 'client_credentials',
      });
      const response = await fetchWithTimeout(TWITCH_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      const payload = await responseJson(response, 'IGDB認証に失敗しました');
      if (
        typeof payload?.access_token !== 'string'
        || !payload.access_token
        || !Number.isFinite(payload.expires_in)
        || payload.expires_in <= 0
      ) {
        throw new Error('IGDB認証に失敗しました (応答形式が不正です)');
      }
      token = payload.access_token;
      tokenExpiresAt = now() + payload.expires_in * 1_000;
      return token;
    })().finally(() => {
      tokenRequest = null;
    });
    return tokenRequest;
  }

  function scheduleRequest(task) {
    if (pendingRequests >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new Error('IGDBゲーム検索が混雑しています'));
    }
    pendingRequests += 1;
    const run = requestQueue.then(async () => {
      const delay = Math.max(0, nextRequestAt - now());
      if (delay > 0) await sleep(delay);
      nextRequestAt = Math.max(nextRequestAt, now()) + REQUEST_INTERVAL_MS;
      return task();
    });
    requestQueue = run.catch(() => {});
    return run.finally(() => {
      pendingRequests -= 1;
    });
  }

  async function queryGames(body) {
    return scheduleRequest(async () => {
      const accessToken = await obtainToken();
      const response = await fetchWithTimeout(IGDB_GAMES_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Client-ID': safeClientId,
          Authorization: `Bearer ${accessToken}`,
        },
        body,
      });
      if (response?.status === 401) {
        token = null;
        tokenExpiresAt = 0;
      }
      return normalizeGames(await responseJson(response, 'IGDBゲーム検索に失敗しました'));
    });
  }

  function remember(key, games) {
    cache.delete(key);
    cache.set(key, { games, expiresAt: now() + CACHE_TTL_MS });
    while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
    return games;
  }

  async function search(value) {
    const query = normalizeSearchInput(value);
    if (query.length < 2) return [];
    const key = normalizeExactName(query);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return cached.games;
    if (cached) cache.delete(key);
    if (inFlightSearches.has(key)) return inFlightSearches.get(key);
    const body = `fields ${GAME_FIELDS}; search "${escapeApicalypseString(query)}"; where version_parent = null; limit ${MAX_SEARCH_RESULTS};`;
    const request = queryGames(body)
      .then((games) => remember(key, games))
      .finally(() => inFlightSearches.delete(key));
    inFlightSearches.set(key, request);
    return request;
  }

  async function getById(id) {
    if (!Number.isSafeInteger(id) || id < 1) return null;
    const games = await queryGames(`fields ${GAME_FIELDS}; where id = ${id}; limit 1;`);
    return games.find((game) => game.id === id) ?? null;
  }

  async function findExact(value) {
    const expected = normalizeExactName(value);
    if (!expected) return null;
    const games = await search(value);
    return games.find((game) => [game.name, ...game.aliases]
      .some((name) => normalizeExactName(name) === expected)) ?? null;
  }

  return Object.freeze({ search, getById, findExact });
}

export function createIgdbGameSearchFromEnv(env = process.env, dependencies = {}) {
  const clientId = env.IGDB_CLIENT_ID?.trim();
  const directSecret = env.IGDB_CLIENT_SECRET?.trim();
  const secretFile = env.IGDB_CLIENT_SECRET_FILE?.trim();
  const hasSecret = Boolean(directSecret || secretFile);
  if (!clientId && !hasSecret) return null;
  // composeではoptional integration用のmount先だけを常時指定できる。
  // Client IDがない間はfile pathだけでは有効化済みとみなさない。
  if (!clientId && !directSecret && secretFile) return null;
  if (!clientId) throw new Error('IGDB_CLIENT_IDが設定されていません');
  if (!CLIENT_ID_PATTERN.test(clientId)) throw new Error('IGDB_CLIENT_IDの形式が不正です');
  const clientSecret = requireSecret('IGDB_CLIENT_SECRET', env);
  return createIgdbGameSearch({ clientId, clientSecret, ...dependencies });
}
