/**
 * The Rule Engine — the single source of truth for every blocking decision.
 *
 * Everything funnels through {@link evaluate}. Given the current state, the
 * current time, and a concrete access request, it answers the one question the
 * whole product exists to answer: "Can this load / run?" — and, when the answer
 * is no, exactly *why* and *what the user can do about it*.
 *
 * Design commitments (straight from the product spec):
 *  - Deterministic: no ambient clock, no I/O. `now` is passed in.
 *  - Fail closed: if evaluation cannot be completed safely, protected targets
 *    stay blocked. See {@link evaluateSafely}.
 *  - Predictable: precedence between focus sessions, modes, schedules and
 *    breaks is fixed and documented below.
 */

import type {
  Decision,
  EngineState,
  FocusSession,
  ManagedTarget,
  Rule,
} from './types.js';
import type { AccessRequest } from './match.js';
import { findMatchingTarget } from './match.js';
import { reconcileBreaks, isTargetUnlockedByBreak } from './breaks.js';
import {
  reconcileWeeklyPass,
  isTargetUnlockedByWeeklyPass,
  canStartWeeklyPass,
} from './weeklypass.js';
import { resolveEffectiveRule } from './modes.js';
import {
  anyWindowOpen,
  msUntilNextReset,
  msUntilNextWindowOpen,
  toLocalClock,
} from './time.js';

/**
 * Precedence, highest first:
 *  1. Active (locked or unlocked) Focus Session covering the target  -> BLOCK
 *  2. The target's effective rule (base rule as reshaped by the active mode):
 *       - always-allowed   -> ALLOW
 *       - scheduled        -> ALLOW inside a window, else BLOCK
 *       - permanent-block  -> BLOCK (breaks never apply)
 *       - daily-break      -> ALLOW only while an exclusive break unlocks it
 *  3. No matching target -> ALLOW (FocusLock only governs what you configure).
 */
export function evaluate(
  state: EngineState,
  request: AccessRequest,
  now: number,
): Decision {
  const breaks = reconcileBreaks(state.breaks, now, state.settings);
  const weeklyPass = reconcileWeeklyPass(state.weeklyPass, now, state.settings);
  const { timezoneOffsetMinutes, resetTime } = state.settings;
  const msUntilReset = msUntilNextReset(now, timezoneOffsetMinutes, resetTime);
  const breaksRemaining = breaks.tokensRemaining;

  const match = findMatchingTarget(request, state.managedTargets);

  // (3) Nothing governs this request.
  if (!match) {
    return {
      targetId: null,
      allowed: true,
      reason: 'allowed-no-rule',
      breakAvailable: false,
      breaksRemaining,
      msUntilReset,
      effectiveRule: { type: 'always-allowed' },
    };
  }

  const targetId = match.target.id;
  const activeMode = state.modes.find((m) => m.id === state.activeModeId) ?? null;
  const effectiveRule = resolveEffectiveRule(match.rule, targetId, activeMode);
  const blockedByMode =
    activeMode !== null &&
    !activeMode.overrides[targetId] &&
    activeMode.defaultPolicy === 'block';

  // (1) Focus sessions override everything else while active.
  const session = activeSessionCovering(state.activeSession, targetId, now);
  if (session) {
    return decision({
      targetId,
      allowed: false,
      reason: 'blocked-by-focus-session',
      breakAvailable: false,
      breaksRemaining,
      msUntilReset,
      effectiveRule,
      msUntilSessionEnds: Math.max(0, session.endsAt - now),
    });
  }

  // (2) The effective rule decides.
  switch (effectiveRule.type) {
    case 'always-allowed':
      return decision({
        targetId,
        allowed: true,
        reason: 'allowed-by-mode',
        breakAvailable: false,
        breaksRemaining,
        msUntilReset,
        effectiveRule,
      });

    case 'permanent-block':
      return decision({
        targetId,
        allowed: false,
        reason: blockedByMode ? 'blocked-by-mode' : 'permanent-block',
        breakAvailable: false,
        breaksRemaining,
        msUntilReset,
        effectiveRule,
      });

    case 'scheduled': {
      const clock = toLocalClock(now, timezoneOffsetMinutes);
      if (anyWindowOpen(effectiveRule.windows, clock)) {
        return decision({
          targetId,
          allowed: true,
          reason: 'allowed-by-schedule',
          breakAvailable: false,
          breaksRemaining,
          msUntilReset,
          effectiveRule,
        });
      }
      const msUntilNextWindow = msUntilNextWindowOpen(
        effectiveRule.windows,
        now,
        timezoneOffsetMinutes,
      );
      return decision({
        targetId,
        allowed: false,
        reason: 'blocked-by-schedule',
        breakAvailable: false,
        breaksRemaining,
        msUntilReset,
        effectiveRule,
        ...(msUntilNextWindow !== undefined ? { msUntilNextWindow } : {}),
      });
    }

    case 'daily-break': {
      if (isTargetUnlockedByBreak(breaks, targetId, now)) {
        return decision({
          targetId,
          allowed: true,
          reason: 'allowed-by-active-break',
          breakAvailable: false,
          breaksRemaining,
          msUntilReset,
          effectiveRule,
          msUntilBreakEnds: Math.max(0, (breaks.activeBreak?.endsAt ?? now) - now),
        });
      }
      // A weekly long-pass (e.g. a 4-hour movie pass) also unlocks it.
      if (isTargetUnlockedByWeeklyPass(weeklyPass, targetId, now)) {
        return decision({
          targetId,
          allowed: true,
          reason: 'allowed-by-weekly-pass',
          breakAvailable: false,
          breaksRemaining,
          msUntilReset,
          effectiveRule,
          msUntilPassEnds: Math.max(0, (weeklyPass.active?.endsAt ?? now) - now),
        });
      }
      // Blocked, and no break is active (an active break unlocks every target
      // above). A break is available to start if a token is free.
      const canUnlock = breaksRemaining > 0;
      // The weekly long-pass is for websites (e.g. a movie site), never apps/games.
      const weeklyPassAvailable =
        request.kind === 'web' && canStartWeeklyPass(weeklyPass, now, state.settings);
      return decision({
        targetId,
        allowed: false,
        reason: canUnlock ? 'blocked-break-available' : 'blocked-no-break-remaining',
        breakAvailable: canUnlock,
        weeklyPassAvailable,
        breaksRemaining,
        msUntilReset,
        effectiveRule,
      });
    }
  }
}

/**
 * Fail-closed wrapper. If `evaluate` throws for any reason (corrupt state,
 * unexpected input), a *matched-or-unknown* request is treated as blocked
 * rather than silently allowed. This upholds the "fail closed rather than fail
 * open" principle even in the face of bugs.
 */
export function evaluateSafely(
  state: EngineState,
  request: AccessRequest,
  now: number,
): Decision {
  try {
    return evaluate(state, request, now);
  } catch {
    return {
      targetId: null,
      allowed: false,
      reason: 'blocked-fail-closed',
      breakAvailable: false,
      breaksRemaining: 0,
      msUntilReset: 0,
      effectiveRule: { type: 'permanent-block' },
    };
  }
}

function activeSessionCovering(
  session: FocusSession | null,
  targetId: string,
  now: number,
): FocusSession | null {
  if (!session) return null;
  if (now >= session.endsAt) return null;
  const coversEverything = session.targetIds.length === 0;
  if (coversEverything || session.targetIds.includes(targetId)) return session;
  return null;
}

/** Small helper so every return path has a consistent shape. */
function decision(d: Decision): Decision {
  return d;
}

/** Convenience: list every managed target whose effective rule is `daily-break`. */
export function dailyBreakTargets(state: EngineState): ManagedTarget[] {
  const activeMode = state.modes.find((m) => m.id === state.activeModeId) ?? null;
  return state.managedTargets.filter((mt) => {
    const rule: Rule = resolveEffectiveRule(mt.rule, mt.target.id, activeMode);
    return rule.type === 'daily-break';
  });
}
