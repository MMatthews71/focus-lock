/**
 * The Weekly Pass.
 *
 * Once per reset-week the user may unlock a single target for a long stretch
 * (default 4 hours) — e.g. to watch a full movie — on top of their daily
 * breaks. Rules, mirroring the daily-break model:
 *  - Exactly ONE pass is available per reset-week; it does not roll over.
 *  - A pass is EXCLUSIVE: it unlocks one target, and only one can be active.
 *  - Spending is a deliberate commitment: it is not refunded if ended early.
 *
 * All functions are pure: they take state + `now` and return new state.
 */

import type { WeeklyPassState, EpochMs, Settings } from './types.js';
import { resetDayKey } from './time.js';

export const WEEKLY_PASS_DURATION_MS = 4 * 60 * 60 * 1000; // 4 hours

/**
 * A stable key identifying the current "reset week" — the 7-day block the
 * current reset-day falls in, aligned to the same daily reset boundary. When
 * this key changes, a new week has begun and the pass becomes available again.
 */
export function resetWeekKey(
  now: EpochMs,
  timezoneOffsetMinutes: number,
  resetTime: string,
): string {
  const dayKey = resetDayKey(now, timezoneOffsetMinutes, resetTime); // "d20731"
  const dayIndex = Number(dayKey.slice(1));
  return `w${Math.floor(dayIndex / 7)}`;
}

/** A fresh, unused weekly-pass pool. */
export function createWeeklyPassState(durationMs = WEEKLY_PASS_DURATION_MS): WeeklyPassState {
  return { durationMs, lastUsedWeekKey: null, active: null };
}

/** Clear an expired active pass. Always call before reading `active`. */
export function reconcileWeeklyPass(
  state: WeeklyPassState,
  now: EpochMs,
  _settings: Settings,
): WeeklyPassState {
  if (state.active && now >= state.active.endsAt) {
    return { ...state, active: null };
  }
  return state;
}

/** True if a fresh weekly pass can be started right now. */
export function canStartWeeklyPass(
  state: WeeklyPassState,
  now: EpochMs,
  settings: Settings,
): boolean {
  const s = reconcileWeeklyPass(state, now, settings);
  if (s.active !== null) return false;
  const week = resetWeekKey(now, settings.timezoneOffsetMinutes, settings.resetTime);
  return s.lastUsedWeekKey !== week;
}

export type StartWeeklyPassResult =
  | { ok: true; state: WeeklyPassState }
  | { ok: false; reason: 'already-used-this-week' | 'pass-already-active'; state: WeeklyPassState };

/** Spend this week's pass to unlock `targetId` for `durationMs`. Fails closed. */
export function startWeeklyPass(
  state: WeeklyPassState,
  targetId: string,
  now: EpochMs,
  settings: Settings,
): StartWeeklyPassResult {
  const s = reconcileWeeklyPass(state, now, settings);
  if (s.active) {
    return { ok: false, reason: 'pass-already-active', state: s };
  }
  const week = resetWeekKey(now, settings.timezoneOffsetMinutes, settings.resetTime);
  if (s.lastUsedWeekKey === week) {
    return { ok: false, reason: 'already-used-this-week', state: s };
  }
  return {
    ok: true,
    state: {
      ...s,
      lastUsedWeekKey: week,
      active: { targetId, startedAt: now, endsAt: now + s.durationMs },
    },
  };
}

/** True if an active, unexpired weekly pass currently unlocks `targetId`. */
export function isTargetUnlockedByWeeklyPass(
  state: WeeklyPassState,
  targetId: string,
  now: EpochMs,
): boolean {
  const a = state.active;
  return a !== null && a.targetId === targetId && now < a.endsAt;
}
