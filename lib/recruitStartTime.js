const FULL_START_TEXT = /^(20[2-9]\d|2100)[/-](\d{1,2})[/-](\d{1,2})[ T](\d{1,2}):(\d{2})$/;
const FULL_DATE_TEXT = /^(20[2-9]\d|2100)[/-](\d{1,2})[/-](\d{1,2})$/;
const YEARLESS_START_TEXT = /^(\d{1,2})(?:\/|月)(\d{1,2})(?:日)?\s+(\d{1,2}):(\d{2})$/;
const YEARLESS_DATE_TEXT = /^(\d{1,2})(?:\/|月)(\d{1,2})(?:日)?$/;
const RELATIVE_START_TEXT = /^(今日|明日)\s+(\d{1,2}):(\d{2})$/;
const RELATIVE_DATE_TEXT = /^(今日|明日)$/;
const CANONICAL_DATE_TEXT = /^(20[2-9]\d|2100)-(\d{2})-(\d{2})$/;

function localPartsAt(epochMs, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(epochMs))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

function sameLocalMinute(left, right) {
  return left.year === right.year
    && left.month === right.month
    && left.day === right.day
    && left.hour === right.hour
    && left.minute === right.minute;
}

function validTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function resolveLocalDateTime(desired, timeZone) {
  if (
    !Number.isInteger(desired.hour)
    || desired.hour < 0
    || desired.hour > 23
    || !Number.isInteger(desired.minute)
    || desired.minute < 0
    || desired.minute > 59
  ) {
    return null;
  }
  const naiveUtc = Date.UTC(
    desired.year,
    desired.month - 1,
    desired.day,
    desired.hour,
    desired.minute,
  );
  const calendarCheck = new Date(naiveUtc);
  if (
    calendarCheck.getUTCFullYear() !== desired.year
    || calendarCheck.getUTCMonth() + 1 !== desired.month
    || calendarCheck.getUTCDate() !== desired.day
  ) {
    return null;
  }

  // Transition日の前後からoffset候補を集める。候補が0件ならDST gap、2件なら重複時刻。
  const offsets = new Set();
  for (const distance of [-2, -1, 0, 1, 2]) {
    const probe = naiveUtc + distance * 24 * 60 * 60 * 1_000;
    const local = localPartsAt(probe, timeZone);
    const representedAsUtc = Date.UTC(
      local.year,
      local.month - 1,
      local.day,
      local.hour,
      local.minute,
      local.second,
    );
    offsets.add(representedAsUtc - probe);
  }

  const matches = new Set();
  for (const offset of offsets) {
    const candidate = naiveUtc - offset;
    if (sameLocalMinute(localPartsAt(candidate, timeZone), desired)) matches.add(candidate);
  }
  return matches.size === 1 ? [...matches][0] : null;
}

function canonicalStartText({ year, month, day, hour, minute }) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}`;
}

function canonicalDateText({ year, month, day }) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}`;
}

function isValidCalendarDate({ year, month, day }) {
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCFullYear() === year
    && check.getUTCMonth() + 1 === month
    && check.getUTCDate() === day;
}

function dateAfterDays(localNow, days) {
  const date = new Date(Date.UTC(localNow.year, localNow.month - 1, localNow.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function desiredFromInput(input, timeZone, now) {
  const normalized = input.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  const full = FULL_START_TEXT.exec(normalized);
  if (full) {
    return {
      desired: {
        year: Number(full[1]),
        month: Number(full[2]),
        day: Number(full[3]),
        hour: Number(full[4]),
        minute: Number(full[5]),
      },
      yearless: false,
      dateOnly: false,
    };
  }

  const fullDate = FULL_DATE_TEXT.exec(normalized);
  if (fullDate) {
    return {
      desired: {
        year: Number(fullDate[1]),
        month: Number(fullDate[2]),
        day: Number(fullDate[3]),
      },
      yearless: false,
      dateOnly: true,
    };
  }

  const localNow = localPartsAt(now, timeZone);
  const relative = RELATIVE_START_TEXT.exec(normalized);
  if (relative) {
    const date = dateAfterDays(localNow, relative[1] === '明日' ? 1 : 0);
    return {
      desired: {
        ...date,
        hour: Number(relative[2]),
        minute: Number(relative[3]),
      },
      yearless: false,
      dateOnly: false,
    };
  }

  const relativeDate = RELATIVE_DATE_TEXT.exec(normalized);
  if (relativeDate) {
    return {
      desired: dateAfterDays(localNow, relativeDate[1] === '明日' ? 1 : 0),
      yearless: false,
      dateOnly: true,
    };
  }

  const yearless = YEARLESS_START_TEXT.exec(normalized);
  if (yearless) {
    return {
      desired: {
        year: localNow.year,
        month: Number(yearless[1]),
        day: Number(yearless[2]),
        hour: Number(yearless[3]),
        minute: Number(yearless[4]),
      },
      yearless: true,
      dateOnly: false,
    };
  }

  const yearlessDate = YEARLESS_DATE_TEXT.exec(normalized);
  if (!yearlessDate) return null;
  return {
    desired: {
      year: localNow.year,
      month: Number(yearlessDate[1]),
      day: Number(yearlessDate[2]),
    },
    yearless: true,
    dateOnly: true,
  };
}

export function parseRecruitStart(input, timeZone, now = Date.now()) {
  if (
    typeof input !== 'string'
    || typeof timeZone !== 'string'
    || !Number.isFinite(now)
    || !validTimeZone(timeZone)
  ) {
    return null;
  }
  const parsed = desiredFromInput(input, timeZone, now);
  if (!parsed) return null;

  let desired = parsed.desired;
  const localNow = localPartsAt(now, timeZone);
  const yearlessDateAlreadyPassed = desired.month < localNow.month
    || (desired.month === localNow.month && desired.day < localNow.day);
  if (parsed.yearless && yearlessDateAlreadyPassed) {
    desired = { ...desired, year: desired.year + 1 };
  }

  if (parsed.dateOnly) {
    if (!isValidCalendarDate(desired)) return null;
    return { startAt: null, startText: canonicalDateText(desired) };
  }

  const startAt = resolveLocalDateTime(desired, timeZone);
  if (!Number.isFinite(startAt)) return null;
  return { startAt, startText: canonicalStartText(desired) };
}

export function parseRecruitStartAt(input, timeZone, now = Date.now()) {
  return parseRecruitStart(input, timeZone, now)?.startAt ?? null;
}

export function isDateOnlyRecruitStart(startText) {
  if (typeof startText !== 'string') return false;
  const match = CANONICAL_DATE_TEXT.exec(startText);
  if (!match) return false;
  return isValidCalendarDate({
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  });
}

export function isRecruitStartUsable(state, now = Date.now(), minimumLeadMs = 0) {
  if (!state || !Number.isFinite(now) || !Number.isFinite(minimumLeadMs) || minimumLeadMs < 0) {
    return false;
  }
  if (Number.isFinite(state.startAt)) return state.startAt >= now + minimumLeadMs;
  if (!isDateOnlyRecruitStart(state.startText) || !validTimeZone(state.startTimeZone)) return false;
  const localNow = localPartsAt(now, state.startTimeZone);
  return state.startText >= canonicalDateText(localNow);
}
