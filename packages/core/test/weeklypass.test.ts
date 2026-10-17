import { describe, it, expect } from 'vitest';
import {
  createWeeklyPassState,
  startWeeklyPass,
  canStartWeeklyPass,
  isTargetUnlockedByWeeklyPass,
  reconcileWeeklyPass,
  resetWeekKey,
  WEEKLY_PASS_DURATION_MS,
  evaluate,
  createInitialState,
  type EngineState,
  type Settings,
} from '../src/index.js';

const SETTINGS: Settings = { resetTime: '05:00', timezoneOffsetMinutes: 0 };
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// A Monday noon well after the 05:00 reset.
const T0 = Date.UTC(2024, 0, 1, 12, 0, 0);

describe('weekly pass — pure model', () => {
  it('defaults to 4 hours and unused', () => {
    const s = createWeeklyPassState();
    expect(s.durationMs).toBe(WEEKLY_PASS_DURATION_MS);
    expect(WEEKLY_PASS_DURATION_MS).toBe(4 * HOUR);
    expect(s.lastUsedWeekKey).toBeNull();
    expect(s.active).toBeNull();
    expect(canStartWeeklyPass(s, T0, SETTINGS)).toBe(true);
  });

  it('starting a pass unlocks the target for 4 hours', () => {
    const started = startWeeklyPass(createWeeklyPassState(), 'movie', T0, SETTINGS);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(isTargetUnlockedByWeeklyPass(started.state, 'movie', T0 + 3 * HOUR)).toBe(true);
    // ...but not a different target, and not after it expires.
    expect(isTargetUnlockedByWeeklyPass(started.state, 'other', T0 + 1 * HOUR)).toBe(false);
    expect(isTargetUnlockedByWeeklyPass(started.state, 'movie', T0 + 4 * HOUR)).toBe(false);
  });

  it('only one pass per week; available again next week', () => {
    const started = startWeeklyPass(createWeeklyPassState(), 'movie', T0, SETTINGS);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    // Same week, pass expired: cannot start another.
    const expired = reconcileWeeklyPass(started.state, T0 + 5 * HOUR, SETTINGS);
    expect(expired.active).toBeNull();
    expect(canStartWeeklyPass(expired, T0 + 5 * HOUR, SETTINGS)).toBe(false);
    const again = startWeeklyPass(expired, 'movie', T0 + 2 * DAY, SETTINGS);
    expect(again.ok).toBe(false);
    // Next week: available again.
    expect(canStartWeeklyPass(expired, T0 + 7 * DAY, SETTINGS)).toBe(true);
  });

  it('is exclusive — cannot start a second pass while one is active', () => {
    const started = startWeeklyPass(createWeeklyPassState(), 'movie', T0, SETTINGS);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const second = startWeeklyPass(started.state, 'movie', T0 + 1 * HOUR, SETTINGS);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('pass-already-active');
  });

  it('resetWeekKey is stable within a day and always differs 7 days later', () => {
    const k0 = resetWeekKey(T0, 0, '05:00');
    expect(resetWeekKey(T0 + 3 * HOUR, 0, '05:00')).toBe(k0); // same day → same week
    expect(resetWeekKey(T0 + 7 * DAY, 0, '05:00')).not.toBe(k0); // 7 days → next week
    expect(resetWeekKey(T0 + 14 * DAY, 0, '05:00')).not.toBe(k0);
  });
});

describe('weekly pass — engine integration', () => {
  function stateWithMovie(): EngineState {
    const s = createInitialState(T0, SETTINGS);
    return {
      ...s,
      managedTargets: [
        {
          target: { id: 'movie', kind: 'keyword', value: '123movie', label: '123movie' },
          rule: { type: 'daily-break' },
        },
      ],
    };
  }
  const web = (url: string) => ({ kind: 'web' as const, value: url });

  it('offers a weekly pass on a blocked daily-break site', () => {
    const d = evaluate(stateWithMovie(), web('https://123movies.com'), T0);
    expect(d.allowed).toBe(false);
    expect(d.weeklyPassAvailable).toBe(true);
  });

  it('never offers the weekly pass for an app (e.g. a game)', () => {
    const s = createInitialState(T0, SETTINGS);
    const withGame: EngineState = {
      ...s,
      managedTargets: [
        { target: { id: 'game', kind: 'app', value: 'Terraria', label: 'Terraria' }, rule: { type: 'daily-break' } },
      ],
    };
    const d = evaluate(withGame, { kind: 'app', value: 'Terraria.exe' }, T0);
    expect(d.allowed).toBe(false);
    expect(d.breakAvailable).toBe(true); // the 30-minute break is still offered
    expect(d.weeklyPassAvailable).toBe(false);
  });

  it('once the pass is active, the site is allowed for 4 hours', () => {
    let s = stateWithMovie();
    const started = startWeeklyPass(s.weeklyPass, 'movie', T0, SETTINGS);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    s = { ...s, weeklyPass: started.state };
    const during = evaluate(s, web('https://123movies.com'), T0 + 3 * HOUR);
    expect(during.allowed).toBe(true);
    expect(during.reason).toBe('allowed-by-weekly-pass');
    const after = evaluate(s, web('https://123movies.com'), T0 + 4 * HOUR + 1);
    expect(after.allowed).toBe(false);
    expect(after.weeklyPassAvailable).toBe(false); // already used this week
  });
});
