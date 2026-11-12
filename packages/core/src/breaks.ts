/**
 * The Break Token system.
 *
 * Rules (from the product spec):
 *  - The user gets a small number of break tokens per day (default 2).
 *  - Each break lasts a fixed duration (default 30 minutes).
 *  - Tokens are GLOBAL / SHARED across all daily-break targets, not per app.
 *  - A break is GLOBAL: while it is active it unlocks EVERY daily-break target,
 *    not just the one it was started from. Only one break can be active at a
 *    time (starting a break spends one shared token).
 *  - Tokens refill at the daily reset boundary. Unused tokens do NOT roll over.
 *
 * All functions here are pure: they take the current state + `now` and return
 * a new state. Nothing mutates in place.
 */

import type { BreakState, EpochMs, Settings } from './types.js';
import { resetDayKey } from './time.js';

export const DEFAULT_TOKENS_PER_DAY = 2;
export const DEFAULT_BREAK_DURATION_MS = 30 * 60 * 1000; // 30 minutes

/** A fresh break pool with full tokens for the current reset day. */
export function createBreakState(
  now: EpochMs,
  settings: Settings,
  tokensPerDay = DEFAULT_TOKENS_PER_DAY,
  breakDurationMs = DEFAULT_BREAK_DURATION_MS,
): BreakState {
  return {
    tokensPerDay,
    breakDurationMs,
    tokensRemaining: tokensPerDay,
    activeBreak: null,
    lastResetKey: resetDayKey(now, settings.timezoneOffsetMinutes, settings.resetTime),
  };
}

/**
 * Bring a break pool up to date for the current instant. This performs two
 * time-driven transitions that the rest of the engine relies on:
 *  1. Daily refill — if the reset boundary has passed since tokens were last
 *     granted, tokens refill to `tokensPerDay` and any leftover is discarded
 *     (no rollover).
 *  2. Break expiry — if the active break's timer has elapsed, it is cleared,
 *     re-blocking its target.
 *
 * Always call this before reading `tokensRemaining` or `activeBreak`.
 */
export function reconcileBreaks(
  state: BreakState,
  now: EpochMs,
  settings: Settings,
): BreakState {
  let next = state;

  const currentKey = resetDayKey(now, settings.timezoneOffsetMinutes, settings.resetTime);
  if (currentKey !== state.lastResetKey) {
    next = {
      ...next,
      tokensRemaining: next.tokensPerDay,
      lastResetKey: currentKey,
      // A break in progress across the reset boundary is ended by the reset.
      activeBreak: null,
    };
  }

  if (next.activeBreak && now >= next.activeBreak.endsAt) {
    next = { ...next, activeBreak: null };
  }

  return next;
}

/** True if a fresh break can be started right now (a token is free and no break is active). */
export function canStartBreak(state: BreakState, now: EpochMs, settings: Settings): boolean {
  const s = reconcileBreaks(state, now, settings);
  return s.activeBreak === null && s.tokensRemaining > 0;
}

export type StartBreakResult =
  | { ok: true; state: BreakState }
  | { ok: false; reason: 'no-tokens' | 'break-already-active'; state: BreakState };

/**
 * Spend one token to start an exclusive break unlocking `targetId`.
 * Fails closed: if no token is free or a break is already running, the pool is
 * returned unchanged with a reason.
 */
export function startBreak(
  state: BreakState,
  targetId: string,
  now: EpochMs,
  settings: Settings,
): StartBreakResult {
  const s = reconcileBreaks(state, now, settings);
  if (s.activeBreak) {
    return { ok: false, reason: 'break-already-active', state: s };
  }
  if (s.tokensRemaining <= 0) {
    return { ok: false, reason: 'no-tokens', state: s };
  }
  return {
    ok: true,
    state: {
      ...s,
      tokensRemaining: s.tokensRemaining - 1,
      activeBreak: {
        targetId,
        startedAt: now,
        endsAt: now + s.breakDurationMs,
      },
    },
  };
}

/**
 * End the active break early (re-blocking its target). The spent token is NOT
 * refunded — spending is a deliberate, irreversible commitment.
 */
export function endBreakEarly(state: BreakState, now: EpochMs, settings: Settings): BreakState {
  const s = reconcileBreaks(state, now, settings);
  if (!s.activeBreak) return s;
  return { ...s, activeBreak: null };
}

/**
 * True while any active, unexpired break is running.
 *
 * A break is GLOBAL: spending one token unlocks EVERY daily-break target for the
 * break's duration, not just the one it was started from. `targetId` is accepted
 * for call-site compatibility (and the active break still records which target it
 * was started from, for display/logging) but does not affect the result.
 */
export function isTargetUnlockedByBreak(
  state: BreakState,
  _targetId: string,
  now: EpochMs,
): boolean {
  const active = state.activeBreak;
  return active !== null && now < active.endsAt;
}
