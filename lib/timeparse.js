// 募集の「時間」テキストから自動締め切り時刻を推測するヘルパー。
// 例: "21時", "21:30", "21時30分", "今から30分後" などをざっくり解釈する。
// 解釈できなければ null を返す（その場合は時刻による自動締め切りはしない）。

// 文字列から締め切り時刻( epoch ms)を推測する
export function parseCloseAt(text, now = Date.now()) {
  if (!text) return null;
  const t = text.trim();

  // 「N分後」「N分後に」
  const afterMin = t.match(/(\d{1,3})\s*分後/);
  if (afterMin) {
    return now + Number(afterMin[1]) * 60 * 1000;
  }

  // 「N時間後」
  const afterHour = t.match(/(\d{1,2})\s*時間後/);
  if (afterHour) {
    return now + Number(afterHour[1]) * 60 * 60 * 1000;
  }

  // 「21時」「21時30分」「21:30」「9時」など
  const hm = t.match(/(\d{1,2})\s*(?:時|:|：)\s*(\d{1,2})?\s*分?/);
  if (hm) {
    const hour = Number(hm[1]);
    const minute = hm[2] ? Number(hm[2]) : 0;
    if (hour <= 23 && minute <= 59) {
      const d = new Date(now);
      d.setHours(hour, minute, 0, 0);
      let ts = d.getTime();
      // すでに過ぎていれば翌日扱い
      if (ts <= now) ts += 24 * 60 * 60 * 1000;
      return ts;
    }
  }

  return null;
}
