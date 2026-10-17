import { describe, it, expect } from 'vitest';
import {
  createBreakState,
  reconcileBreaks,
  startBreak,
  endBreakEarly,
  canStartBreak,
  isTargetUnlockedByBreak,
  startMeditation,
  isMeditationSatisfied,
  clearMeditation,
  DEFAULT_BREAK_DURATION_MS,
  DEFAULT_MEDITATION_REQUIRED_MS,
} from '../src/breaks.js';
import type { Settings } from '../src/types.js';

const settings: Settings = { resetTime: '05:00', timezoneOffsetMinutes: 0 };
const T0 = Date.UTC(2024, 0, 1, 12, 0, 0); // Monday noon
const MIN = 60_000;

describe('break token pool', () => {
  it('starts with a full pool of 2 tokens', () => {
    const s = createBreakState(T0, settings);
    expect(s.tokensRemaining).toBe(2);
    expect(s.activeBreak).toBeNull();
  });

  it('spends a token and starts a 30-minute exclusive break', () => {
    const s = createBreakState(T0, settings);
    const r = startBreak(s, 'youtube', T0, settings);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.tokensRemaining).toBe(1);
    expect(r.state.activeBreak?.targetId).toBe('youtube');
    expect(r.state.activeBreak?.endsAt).toBe(T0 + DEFAULT_BREAK_DURATION_MS);
  });

  it('is exclusive — cannot start a second break while one is active', () => {
    const s = createBreakState(T0, settings);
    const first = startBreak(s, 'youtube', T0, settings);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = startBreak(first.state, 'reddit', T0 + MIN, settings);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('break-already-active');
  });

  it('unlocks EVERY target while active, not just the one it was started from', () => {
    const s = createBreakState(T0, settings);
    const r = startBreak(s, 'youtube', T0, settings);
    if (!r.ok) return;
    expect(isTargetUnlockedByBreak(r.state, 'youtube', T0 + MIN)).toBe(true);
    expect(isTargetUnlockedByBreak(r.state, 'reddit', T0 + MIN)).toBe(true);
    expect(isTargetUnlockedByBreak(r.state, 'terraria', T0 + MIN)).toBe(true);
  });

  it('expires the break after 30 minutes, re-blocking the target', () => {
    const s = createBreakState(T0, settings);
    const r = startBreak(s, 'youtube', T0, settings);
    if (!r.ok) return;
    const afterExpiry = T0 + DEFAULT_BREAK_DURATION_MS + 1;
    expect(isTargetUnlockedByBreak(r.state, 'youtube', afterExpiry)).toBe(false);
    const reconciled = reconcileBreaks(r.state, afterExpiry, settings);
    expect(reconciled.activeBreak).toBeNull();
    // Token was still consumed — no refund.
    expect(reconciled.tokensRemaining).toBe(1);
  });

  it('runs out after 2 breaks and blocks everything using daily breaks', () => {
    let s = createBreakState(T0, settings);
    const first = startBreak(s, 'reddit', T0, settings);
    if (!first.ok) return;
    s = reconcileBreaks(first.state, T0 + DEFAULT_BREAK_DURATION_MS + 1, settings);
    const second = startBreak(s, 'steam', T0 + DEFAULT_BREAK_DURATION_MS + 2, settings);
    if (!second.ok) return;
    s = reconcileBreaks(second.state, T0 + 2 * DEFAULT_BREAK_DURATION_MS + 3, settings);
    expect(s.tokensRemaining).toBe(0);
    expect(canStartBreak(s, T0 + 2 * DEFAULT_BREAK_DURATION_MS + 3, settings)).toBe(false);
  });

  it('does not refund a token when a break is ended early', () => {
    const s = createBreakState(T0, settings);
    const r = startBreak(s, 'youtube', T0, settings);
    if (!r.ok) return;
    const ended = endBreakEarly(r.state, T0 + 5 * MIN, settings);
    expect(ended.activeBreak).toBeNull();
    expect(ended.tokensRemaining).toBe(1);
  });

  it('refills tokens at the next daily reset with no rollover', () => {
    const s = createBreakState(T0, settings);
    const r = startBreak(s, 'youtube', T0, settings);
    if (!r.ok) return;
    expect(r.state.tokensRemaining).toBe(1);
    // Advance past the next 05:00 reset.
    const nextMorning = Date.UTC(2024, 0, 2, 6, 0, 0);
    const reconciled = reconcileBreaks(r.state, nextMorning, settings);
    expect(reconciled.tokensRemaining).toBe(2); // refilled, not 3 — no rollover
    expect(reconciled.activeBreak).toBeNull();
  });
});

describe('meditation gate', () => {
  const REQ = DEFAULT_MEDITATION_REQUIRED_MS;

  it('is not satisfied before a meditation has started', () => {
    const s = createBreakState(T0, settings);
    expect(s.pendingMeditation).toBeNull();
    expect(isMeditationSatisfied(s, 'youtube', T0)).toBe(false);
  });

  it('is not satisfied until the full required duration has elapsed', () => {
    let s = createBreakState(T0, settings);
    s = startMeditation(s, 'youtube', T0);
    expect(isMeditationSatisfied(s, 'youtube', T0)).toBe(false);
    expect(isMeditationSatisfied(s, 'youtube', T0 + REQ - 1)).toBe(false);
    expect(isMeditationSatisfied(s, 'youtube', T0 + REQ)).toBe(true);
  });

  it('only unlocks the target the meditation was started for', () => {
    let s = createBreakState(T0, settings);
    s = startMeditation(s, 'youtube', T0);
    expect(isMeditationSatisfied(s, 'youtube', T0 + REQ)).toBe(true);
    expect(isMeditationSatisfied(s, 'reddit', T0 + REQ)).toBe(false);
  });

  it('starting a new meditation replaces the pending one (exclusive)', () => {
    let s = createBreakState(T0, settings);
    s = startMeditation(s, 'youtube', T0);
    s = startMeditation(s, 'reddit', T0 + 10_000);
    expect(s.pendingMeditation?.targetId).toBe('reddit');
    expect(isMeditationSatisfied(s, 'youtube', T0 + REQ)).toBe(false);
    expect(isMeditationSatisfied(s, 'reddit', T0 + 10_000 + REQ)).toBe(true);
  });

  it('clears a half-finished meditation at the daily reset', () => {
    let s = createBreakState(T0, settings);
    s = startMeditation(s, 'youtube', T0);
    const nextMorning = Date.UTC(2024, 0, 2, 6, 0, 0);
    const reconciled = reconcileBreaks(s, nextMorning, settings);
    expect(reconciled.pendingMeditation).toBeNull();
  });

  it('clearMeditation forgets the pending meditation', () => {
    let s = createBreakState(T0, settings);
    s = startMeditation(s, 'youtube', T0);
    s = clearMeditation(s);
    expect(s.pendingMeditation).toBeNull();
    expect(isMeditationSatisfied(s, 'youtube', T0 + REQ)).toBe(false);
  });

  it('defaults a missing required duration (migrated old state) to the standard length', () => {
    const legacy = { ...createBreakState(T0, settings) } as Record<string, unknown>;
    delete legacy.meditationRequiredMs;
    legacy.pendingMeditation = { targetId: 'youtube', startedAt: T0 };
    const s = legacy as unknown as ReturnType<typeof createBreakState>;
    expect(isMeditationSatisfied(s, 'youtube', T0 + REQ - 1)).toBe(false);
    expect(isMeditationSatisfied(s, 'youtube', T0 + REQ)).toBe(true);
  });
});
