const FIXED_GAMES = [
  {
    name: 'Dead by Daylight',
    steamAppId: 381210,
    aliases: ['dbd', 'dead by daylight', 'デッドバイデイライト', 'デドバ'],
    thumbnailUrl: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/381210/header.jpg?t=1784216454',
  },
  {
    name: 'R.E.P.O.',
    steamAppId: 3241660,
    aliases: ['repo', 'r.e.p.o.', 'r e p o', 'レポ'],
    thumbnailUrl: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3241660/a12c92856b71315da885924ea5e1d5290c8025b8/header_alt_assets_2.jpg?t=1778158882',
  },
  {
    name: 'Phasmophobia',
    steamAppId: 739630,
    aliases: ['phasmophobia', 'phasmo', 'ファズモフォビア', 'ファズモ'],
    thumbnailUrl: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/739630/c7db4897b9905cfc91da2a46383f716338a48bdd/header_alt_assets_11.jpg?t=1784637253',
  },
].map((game) => Object.freeze({
  ...game,
  aliases: Object.freeze([...game.aliases]),
}));

function normalizeGameName(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[\p{P}\p{S}\s]+/gu, '');
}

function normalizeGameSearch(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('ja-JP')
    .trim();
}

const GAMES_BY_ALIAS = new Map();
for (const game of FIXED_GAMES) {
  for (const alias of [game.name, ...game.aliases]) {
    GAMES_BY_ALIAS.set(normalizeGameName(alias), game);
  }
}

export function findFixedGame(value) {
  const normalized = normalizeGameName(value);
  return normalized ? GAMES_BY_ALIAS.get(normalized) ?? null : null;
}

export function searchFixedGames(value, { limit = 10 } = {}) {
  const query = normalizeGameSearch(value);
  if (!query) return [];
  return FIXED_GAMES
    .filter((game) => [game.name, ...game.aliases]
      .some((name) => normalizeGameSearch(name).includes(query)))
    .slice(0, Math.min(Math.max(Number(limit) || 10, 1), 25));
}
