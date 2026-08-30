// 参加履歴・統計の記録と集計。
// 締め切られた募集を1セッションとして data/stats.json に追記し、
// 集計はそのログから都度計算する（シンプルで後から指標を足しやすい）。
import { load, save } from './store.js';

const FILE = 'stats';
export const MAX_SESSIONS_PER_GUILD = 2_000;

// 1セッション分を記録する。state は締め切り済みの募集。
export function recordSession(state) {
  const db = load(FILE, { sessions: [] });
  db.sessions.push({
    guildId: state.guildId,
    game: state.game,
    hostId: state.hostId,
    // 主催者＋参加者を「一緒に遊んだ人」として残す
    members: [state.hostId, ...state.members],
    closedAt: Date.now(),
  });
  const retainedPerGuild = new Map();
  db.sessions = db.sessions
    .toReversed()
    .filter((session) => {
      const bucket = session.guildId ?? '__legacy__';
      const retained = retainedPerGuild.get(bucket) ?? 0;
      if (retained >= MAX_SESSIONS_PER_GUILD) return false;
      retainedPerGuild.set(bucket, retained + 1);
      return true;
    })
    .toReversed();
  save(FILE, db);
}

// 今月（過去30日）の統計を集計する
export function summarize(userId, guildId, sinceDays = 30) {
  const db = load(FILE, { sessions: [] });
  const since = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
  const legacyGuildId = process.env.GUILD_ID;
  const recent = db.sessions.filter((session) => {
    if (session.closedAt < since) return false;
    if (session.guildId) return session.guildId === guildId;
    return Boolean(legacyGuildId) && guildId === legacyGuildId;
  });

  let joinCount = 0;
  const games = new Map(); // game -> 回数
  const withUsers = new Map(); // userId -> 一緒に遊んだ回数

  for (const s of recent) {
    if (!s.members.includes(userId)) continue;
    joinCount += 1;
    games.set(s.game, (games.get(s.game) ?? 0) + 1);
    for (const m of s.members) {
      if (m === userId) continue;
      withUsers.set(m, (withUsers.get(m) ?? 0) + 1);
    }
  }

  const topGames = [...games.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const topMates = [...withUsers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

  return { joinCount, topGames, topMates, sinceDays };
}
