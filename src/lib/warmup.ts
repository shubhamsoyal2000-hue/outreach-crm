import { businessDaysBetween, isBusinessDay, parseYmd, ymdToString, type Ymd } from "./time";
import type { Inbox, Settings } from "./types";

/**
 * How many cold emails this inbox may send on `day` (a day in the team's
 * default time zone). Starts at ramp_start_per_day on the inbox's cold start
 * date and grows by ramp_step_per_business_day each business day, up to the
 * inbox's max_daily. Zero before the start date, on weekends and holidays,
 * and whenever the inbox is not active.
 */
export function dailyCap(
  inbox: Pick<Inbox, "status" | "cold_start_date" | "max_daily">,
  day: Ymd,
  settings: Pick<Settings, "ramp_start_per_day" | "ramp_step_per_business_day">,
): number {
  if (inbox.status !== "active" || !inbox.cold_start_date) return 0;
  if (!isBusinessDay(day)) return 0;
  const start = parseYmd(inbox.cold_start_date);
  if (ymdToString(day) < ymdToString(start)) return 0;
  const elapsed = businessDaysBetween(start, day);
  const ramped = settings.ramp_start_per_day + elapsed * settings.ramp_step_per_business_day;
  return Math.max(0, Math.min(inbox.max_daily, ramped));
}

/**
 * Minutes to wait before this inbox's next send, so the day's remaining
 * sends spread across the remaining window instead of going out in a burst.
 */
export function nextGapMinutes(remainingWindowMinutes: number, remainingSends: number, rng: () => number): number {
  const even = remainingWindowMinutes / Math.max(1, remainingSends);
  const base = Math.min(30, Math.max(4, even));
  const jitter = 0.6 + rng() * 0.8;
  return Math.max(3, Math.round(base * jitter));
}
