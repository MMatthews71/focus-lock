/**
 * Pure time helpers for wall-clock reasoning.
 *
 * The engine never reads the ambient clock or timezone. Callers provide `now`
 * (epoch ms) and a `timezoneOffsetMinutes`, and these helpers translate to the
 * user's local wall clock. This makes daily-reset and schedule logic fully
 * deterministic and testable across timezones and DST-free of surprises.
 */

import type { EpochMs, TimeWindow } from './types.js';

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

/** Parse "HH:MM" into minutes since local midnight. Throws on bad input. */
export function parseHhMm(value: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) throw new Error(`Invalid HH:MM time: "${value}"`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    throw new Error(`Time out of range: "${value}"`);
  }
  return hours * 60 + minutes;
}

/** The user's local wall-clock, derived purely from `now` + offset. */
export interface LocalClock {
  /** Whole days since epoch in local time (a stable per-day integer). */
  localDayIndex: number;
  /** Minutes since local midnight, 0..1439. */
  minutesOfDay: number;
  /** Weekday, 0 = Sunday … 6 = Saturday. */
  weekday: number;
}

/** Convert an epoch timestamp into the user's local wall-clock components. */
export function toLocalClock(now: EpochMs, timezoneOffsetMinutes: number): LocalClock {
  const localMs = now + timezoneOffsetMinutes * MS_PER_MINUTE;
  const localDayIndex = Math.floor(localMs / MS_PER_DAY);
  const minutesOfDay = Math.floor((localMs - localDayIndex * MS_PER_DAY) / MS_PER_MINUTE);
  // Epoch day 0 (1970-01-01) was a Thursday => weekday 4.
  const weekday = (((localDayIndex % 7) + 4) % 7 + 7) % 7;
  return { localDayIndex, minutesOfDay, weekday };
}

/**
 * A stable key identifying the current "reset day". The reset boundary is at
 * `resetTime` local (e.g. 05:00), so 04:59 belongs to the *previous* key.
 * When this key changes, a new day has begun and break tokens should refill.
 */
export function resetDayKey(
  now: EpochMs,
  timezoneOffsetMinutes: number,
  resetTime: string,
): string {
  const resetMinutes = parseHhMm(resetTime);
  const { localDayIndex, minutesOfDay } = toLocalClock(now, timezoneOffsetMinutes);
  const dayForReset = minutesOfDay >= resetMinutes ? localDayIndex : localDayIndex - 1;
  return `d${dayForReset}`;
}

/** ms from `now` until the next `resetTime` boundary. Always > 0. */
export function msUntilNextReset(
  now: EpochMs,
  timezoneOffsetMinutes: number,
  resetTime: string,
): EpochMs {
  const resetMinutes = parseHhMm(resetTime);
  const { minutesOfDay } = toLocalClock(now, timezoneOffsetMinutes);
  let minutesUntil = resetMinutes - minutesOfDay;
  if (minutesUntil <= 0) minutesUntil += 24 * 60;
  // Re-align to the exact second by accounting for the sub-minute remainder.
  const localMs = now + timezoneOffsetMinutes * MS_PER_MINUTE;
  const subMinuteMs = ((localMs % MS_PER_MINUTE) + MS_PER_MINUTE) % MS_PER_MINUTE;
  return minutesUntil * MS_PER_MINUTE - subMinuteMs;
}

/** Whether a single time window is open at the given local clock. */
export function isWindowOpen(window: TimeWindow, clock: LocalClock): boolean {
  const start = parseHhMm(window.start);
  const end = parseHhMm(window.end);
  const { minutesOfDay, weekday } = clock;

  if (start === end) return false; // zero-length window is never open

  const wraps = end < start; // e.g. 22:00 -> 02:00
  const openToday = wraps
    ? minutesOfDay >= start || minutesOfDay < end
    : minutesOfDay >= start && minutesOfDay < end;

  if (!openToday) return false;
  if (!window.days || window.days.length === 0) return true;

  // For a wrapping window active before `end`, the "owning" weekday is
  // yesterday's (the window started the previous evening).
  const owningWeekday = wraps && minutesOfDay < end ? (weekday + 6) % 7 : weekday;
  return window.days.includes(owningWeekday);
}

/** True if any of the windows is currently open. */
export function anyWindowOpen(windows: TimeWindow[], clock: LocalClock): boolean {
  return windows.some((w) => isWindowOpen(w, clock));
}

/**
 * ms until the next moment any window opens. Returns 0 if a window is open now.
 * Scans minute-by-minute up to 8 days ahead; returns `undefined` if no window
 * will ever open (e.g. empty list).
 */
export function msUntilNextWindowOpen(
  windows: TimeWindow[],
  now: EpochMs,
  timezoneOffsetMinutes: number,
): EpochMs | undefined {
  if (windows.length === 0) return undefined;
  const clockNow = toLocalClock(now, timezoneOffsetMinutes);
  if (anyWindowOpen(windows, clockNow)) return 0;

  const localMs = now + timezoneOffsetMinutes * MS_PER_MINUTE;
  const subMinuteMs = ((localMs % MS_PER_MINUTE) + MS_PER_MINUTE) % MS_PER_MINUTE;
  const maxMinutes = 8 * 24 * 60;
  for (let m = 1; m <= maxMinutes; m++) {
    const probe = now + m * MS_PER_MINUTE - subMinuteMs;
    if (anyWindowOpen(windows, toLocalClock(probe, timezoneOffsetMinutes))) {
      return m * MS_PER_MINUTE - subMinuteMs;
    }
  }
  return undefined;
}
