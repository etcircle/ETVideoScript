// Timezone helpers that work identically in the browser and in node tests
// (where TZ is usually UTC). Everything is keyed to an IANA zone name.

const fmtCache = new Map();
function formatter(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Local calendar fields for an instant in `tz`. month is 1-12. */
export function localParts(date, tz) {
  const parts = {};
  for (const p of formatter(tz).formatToParts(date)) parts[p.type] = p.value;
  const y = Number(parts.year);
  const m = Number(parts.month);
  const d = Number(parts.day);
  return {
    year: y,
    month: m,
    day: d,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: WEEKDAYS[parts.weekday],
    dateKey: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
  };
}

/** UTC offset in minutes of `tz` at the given instant. */
export function tzOffsetMinutes(date, tz) {
  const p = localParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((asUtc - date.valueOf()) / 60000);
}

/** The instant of local midnight for a calendar day (month 1-12) in `tz`. */
export function zonedMidnight(year, month, day, tz) {
  let guess = new Date(Date.UTC(year, month - 1, day, 0, 0));
  // Two passes handle DST transitions that happen on the day itself.
  for (let i = 0; i < 2; i++) {
    const off = tzOffsetMinutes(guess, tz);
    guess = new Date(Date.UTC(year, month - 1, day, 0, 0) - off * 60000);
  }
  return guess;
}

export function midnightForDateKey(dateKey, tz) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return zonedMidnight(y, m, d, tz);
}

/** Day-of-year 1..366 for local calendar fields. */
export function dayOfYear(year, month, day) {
  const start = Date.UTC(year, 0, 1);
  const t = Date.UTC(year, month - 1, day);
  return Math.round((t - start) / 86400000) + 1;
}
