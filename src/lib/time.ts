// Time zone and business-day helpers, built on Intl so there is no date library.
// Days are plain {y, m, d} values (m is 1-12) in a named IANA time zone.

export interface Ymd {
  y: number;
  m: number;
  d: number;
}

interface LocalParts extends Ymd {
  hour: number;
  minute: number;
  weekday: number; // 0 = Sunday
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatters.set(tz, f);
  }
  return f;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function localParts(at: Date, tz: string): LocalParts {
  const parts = Object.fromEntries(formatter(tz).formatToParts(at).map((p) => [p.type, p.value]));
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: WEEKDAYS.indexOf(parts.weekday),
  };
}

function offsetMs(at: Date, tz: string): number {
  const p = localParts(at, tz);
  const seconds = at.getUTCSeconds();
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hour, p.minute, seconds);
  return asUtc - (at.getTime() - at.getUTCMilliseconds());
}

/** The instant when the wall clock in `tz` reads the given local time. */
export function zonedTimeToUtc(day: Ymd, hour: number, minute: number, tz: string): Date {
  const guess = Date.UTC(day.y, day.m - 1, day.d, hour, minute);
  let result = guess - offsetMs(new Date(guess), tz);
  // A second pass settles instants that cross a daylight saving change.
  result = guess - offsetMs(new Date(result), tz);
  return new Date(result);
}

export function localDay(at: Date, tz: string): Ymd {
  const { y, m, d } = localParts(at, tz);
  return { y, m, d };
}

export function ymdToString({ y, m, d }: Ymd): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function parseYmd(s: string): Ymd {
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  return { y, m, d };
}

function addDays(day: Ymd, n: number): Ymd {
  const t = new Date(Date.UTC(day.y, day.m - 1, day.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function weekdayOf(day: Ymd): number {
  return new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay();
}

function nthWeekday(y: number, m: number, weekday: number, n: number): number {
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
}

function lastWeekday(y: number, m: number, weekday: number): number {
  const lastDate = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lastDow = new Date(Date.UTC(y, m - 1, lastDate)).getUTCDay();
  return lastDate - ((lastDow - weekday + 7) % 7);
}

/** Fixed-date holidays move to Friday or Monday when they fall on a weekend. */
function observed(y: number, m: number, d: number): string {
  const dow = weekdayOf({ y, m, d });
  const shifted = dow === 6 ? addDays({ y, m, d }, -1) : dow === 0 ? addDays({ y, m, d }, 1) : { y, m, d };
  return ymdToString(shifted);
}

const holidayCache = new Map<number, Set<string>>();

/** US federal holidays plus the quiet days around Thanksgiving and Christmas. */
export function usHolidays(y: number): Set<string> {
  let set = holidayCache.get(y);
  if (set) return set;
  set = new Set([
    observed(y, 1, 1),
    ymdToString({ y, m: 1, d: nthWeekday(y, 1, 1, 3) }), // Martin Luther King Jr. Day
    ymdToString({ y, m: 2, d: nthWeekday(y, 2, 1, 3) }), // Presidents' Day
    ymdToString({ y, m: 5, d: lastWeekday(y, 5, 1) }), // Memorial Day
    observed(y, 6, 19),
    observed(y, 7, 4),
    ymdToString({ y, m: 9, d: nthWeekday(y, 9, 1, 1) }), // Labor Day
    ymdToString({ y, m: 10, d: nthWeekday(y, 10, 1, 2) }), // Columbus Day
    observed(y, 11, 11),
    ymdToString({ y, m: 11, d: nthWeekday(y, 11, 4, 4) }), // Thanksgiving
    ymdToString({ y, m: 11, d: nthWeekday(y, 11, 4, 4) + 1 }), // Day after Thanksgiving
    observed(y, 12, 24),
    observed(y, 12, 25),
    observed(y + 1, 1, 1), // New Year's Day observed on Dec 31
  ]);
  holidayCache.set(y, set);
  return set;
}

export function isBusinessDay(day: Ymd): boolean {
  const dow = weekdayOf(day);
  if (dow === 0 || dow === 6) return false;
  return !usHolidays(day.y).has(ymdToString(day));
}

export function nextBusinessDay(day: Ymd): Ymd {
  let next = addDays(day, 1);
  while (!isBusinessDay(next)) next = addDays(next, 1);
  return next;
}

export function addBusinessDays(day: Ymd, n: number): Ymd {
  let result = day;
  for (let i = 0; i < n; i++) result = nextBusinessDay(result);
  return result;
}

/** Business days from `from` to `to`, counting `to` but not `from`. */
export function businessDaysBetween(from: Ymd, to: Ymd): number {
  const fromStr = ymdToString(from);
  const toStr = ymdToString(to);
  if (toStr <= fromStr) return 0;
  let count = 0;
  let cur = from;
  while (ymdToString(cur) < toStr) {
    cur = addDays(cur, 1);
    if (isBusinessDay(cur)) count++;
  }
  return count;
}

export interface Window {
  startHour: number;
  endHour: number;
}

export function isWithinWindow(at: Date, tz: string, w: Window): boolean {
  const p = localParts(at, tz);
  if (!isBusinessDay(p)) return false;
  return p.hour >= w.startHour && p.hour < w.endHour;
}

/** `at` itself if it is inside a sending window, else the start of the next one. */
export function nextWindowStart(at: Date, tz: string, w: Window): Date {
  if (isWithinWindow(at, tz, w)) return at;
  const p = localParts(at, tz);
  const today: Ymd = { y: p.y, m: p.m, d: p.d };
  if (isBusinessDay(today) && p.hour < w.startHour) return zonedTimeToUtc(today, w.startHour, 0, tz);
  return zonedTimeToUtc(nextBusinessDay(today), w.startHour, 0, tz);
}

/** A random moment inside the window on `day`, in the recipient's time zone. */
export function randomTimeInWindow(day: Ymd, tz: string, w: Window, rng: () => number): Date {
  const minutes = (w.endHour - w.startHour) * 60;
  // Leave the last 30 minutes free so a late slot still fits before the window closes.
  const offset = Math.floor(rng() * Math.max(1, minutes - 30));
  return zonedTimeToUtc(day, w.startHour + Math.floor(offset / 60), offset % 60, tz);
}

const STATE_TZ: Record<string, string> = {
  CT: "America/New_York", DE: "America/New_York", DC: "America/New_York", FL: "America/New_York",
  GA: "America/New_York", ME: "America/New_York", MD: "America/New_York", MA: "America/New_York",
  MI: "America/Detroit", NH: "America/New_York", NJ: "America/New_York", NY: "America/New_York",
  NC: "America/New_York", OH: "America/New_York", PA: "America/New_York", RI: "America/New_York",
  SC: "America/New_York", VT: "America/New_York", VA: "America/New_York", WV: "America/New_York",
  IN: "America/Indiana/Indianapolis", KY: "America/New_York",
  AL: "America/Chicago", AR: "America/Chicago", IL: "America/Chicago", IA: "America/Chicago",
  KS: "America/Chicago", LA: "America/Chicago", MN: "America/Chicago", MS: "America/Chicago",
  MO: "America/Chicago", NE: "America/Chicago", ND: "America/Chicago", OK: "America/Chicago",
  SD: "America/Chicago", TN: "America/Chicago", TX: "America/Chicago", WI: "America/Chicago",
  AZ: "America/Phoenix", CO: "America/Denver", ID: "America/Boise", MT: "America/Denver",
  NM: "America/Denver", UT: "America/Denver", WY: "America/Denver",
  CA: "America/Los_Angeles", NV: "America/Los_Angeles", OR: "America/Los_Angeles", WA: "America/Los_Angeles",
  AK: "America/Anchorage", HI: "Pacific/Honolulu", PR: "America/Puerto_Rico",
};

export function timezoneForState(state: string | null | undefined): string | null {
  if (!state) return null;
  return STATE_TZ[state.trim().toUpperCase()] ?? null;
}
