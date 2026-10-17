import { describe, it, expect } from 'vitest';
import { evaluate, evaluateSafely, dailyBreakTargets } from '../src/engine.js';
import { createInitialState } from '../src/defaults.js';
import { startBreak } from '../src/breaks.js';
import type { EngineState, ManagedTarget, Rule } from '../src/types.js';

const T0 = Date.UTC(2024, 0, 1, 12, 0, 0); // Monday noon UTC
const HOUR = 3_600_000;

function stateWith(managed: ManagedTarget[]): EngineState {
  const s = createInitialState(T0);
  return { ...s, managedTargets: managed };
}

const target = (id: string, kind: ManagedTarget['target']['kind'], value: string, rule: Rule): ManagedTarget => ({
  target: { id, kind, value, label: id },
  rule,
});

const web = (value: string) => ({ kind: 'web' as const, value });
const app = (value: string) => ({ kind: 'app' as const, value });

describe('evaluate — basic rule types', () => {
  it('allows anything with no matching rule', () => {
    const d = evaluate(stateWith([]), web('https://example.com'), T0);
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe('allowed-no-rule');
  });

  it('always-allowed is allowed', () => {
    const s = stateWith([target('vscode', 'app', 'Code', { type: 'always-allowed' })]);
    expect(evaluate(s, app('Code'), T0).allowed).toBe(true);
  });

  it('permanent-block is always blocked and never offers a break', () => {
    const s = stateWith([target('tiktok', 'domain', 'tiktok.com', { type: 'permanent-block' })]);
    const d = evaluate(s, web('https://tiktok.com'), T0);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('permanent-block');
    expect(d.breakAvailable).toBe(false);
  });
});

describe('evaluate — scheduled access', () => {
  const schedule: Rule = { type: 'scheduled', windows: [{ start: '19:00', end: '21:00' }] };

  it('blocks outside the window and reports when it next opens', () => {
    const s = stateWith([target('discord', 'app', 'Discord', schedule)]);
    const d = evaluate(s, app('Discord'), T0); // noon
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('blocked-by-schedule');
    expect(d.msUntilNextWindow).toBe(7 * HOUR); // noon -> 7pm
  });

  it('allows inside the window', () => {
    const s = stateWith([target('discord', 'app', 'Discord', schedule)]);
    const at8pm = Date.UTC(2024, 0, 1, 20, 0, 0);
    const d = evaluate(s, app('Discord'), at8pm);
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe('allowed-by-schedule');
  });
});

describe('evaluate — daily breaks', () => {
  it('blocks a daily-break target until a break is spent, then allows it', () => {
    let s = stateWith([target('yt', 'domain', 'youtube.com', { type: 'daily-break' })]);

    const blocked = evaluate(s, web('https://youtube.com'), T0);
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe('blocked-break-available');
    expect(blocked.breakAvailable).toBe(true); // a token is available to spend
    expect(blocked.breaksRemaining).toBe(2);

    const started = startBreak(s.breaks, 'yt', T0, s.settings);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    s = { ...s, breaks: started.state };

    const allowed = evaluate(s, web('https://youtube.com'), T0 + HOUR / 2 - 1);
    expect(allowed.allowed).toBe(true);
    expect(allowed.reason).toBe('allowed-by-active-break');
    expect(allowed.breaksRemaining).toBe(1);
  });

  it('global: a break started on YouTube also unlocks other daily-break targets', () => {
    let s = stateWith([
      target('yt', 'domain', 'youtube.com', { type: 'daily-break' }),
      target('reddit', 'domain', 'reddit.com', { type: 'daily-break' }),
    ]);
    const started = startBreak(s.breaks, 'yt', T0, s.settings);
    if (!started.ok) return;
    s = { ...s, breaks: started.state };

    expect(evaluate(s, web('https://youtube.com'), T0).allowed).toBe(true);
    const reddit = evaluate(s, web('https://reddit.com'), T0);
    expect(reddit.allowed).toBe(true);
    expect(reddit.reason).toBe('allowed-by-active-break');
  });

  it('re-blocks after the break expires', () => {
    let s = stateWith([target('yt', 'domain', 'youtube.com', { type: 'daily-break' })]);
    const started = startBreak(s.breaks, 'yt', T0, s.settings);
    if (!started.ok) return;
    s = { ...s, breaks: started.state };
    const afterExpiry = T0 + 30 * 60_000 + 1;
    const d = evaluate(s, web('https://youtube.com'), afterExpiry);
    expect(d.allowed).toBe(false);
    expect(d.breaksRemaining).toBe(1); // one left to spend
  });
});

describe('evaluate — focus sessions override everything', () => {
  it('blocks even an always-allowed target while a covering session runs', () => {
    const base = stateWith([target('code', 'app', 'Code', { type: 'always-allowed' })]);
    const s: EngineState = {
      ...base,
      activeSession: {
        id: 'deep-work',
        name: 'Deep Work',
        startedAt: T0,
        endsAt: T0 + 2 * HOUR,
        locked: true,
        targetIds: [], // empty = cover everything
      },
    };
    const d = evaluate(s, app('Code'), T0 + HOUR);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('blocked-by-focus-session');
    expect(d.msUntilSessionEnds).toBe(HOUR);
  });

  it('stops blocking once the session ends', () => {
    const base = stateWith([target('code', 'app', 'Code', { type: 'always-allowed' })]);
    const s: EngineState = {
      ...base,
      activeSession: { id: 's', name: 's', startedAt: T0, endsAt: T0 + HOUR, locked: false, targetIds: [] },
    };
    expect(evaluate(s, app('Code'), T0 + 2 * HOUR).allowed).toBe(true);
  });
});

describe('evaluate — modes', () => {
  it('allow-list mode blocks everything not explicitly overridden', () => {
    const base = stateWith([
      target('code', 'app', 'Code', { type: 'always-allowed' }),
      target('yt', 'domain', 'youtube.com', { type: 'daily-break' }),
    ]);
    const s: EngineState = {
      ...base,
      activeModeId: 'work',
      modes: [
        {
          id: 'work',
          name: 'Work',
          defaultPolicy: 'block',
          overrides: { code: { type: 'always-allowed' } },
        },
      ],
    };
    expect(evaluate(s, app('Code'), T0).allowed).toBe(true); // overridden -> allowed
    const yt = evaluate(s, web('https://youtube.com'), T0);
    expect(yt.allowed).toBe(false);
    expect(yt.reason).toBe('blocked-by-mode');
  });

  it('dailyBreakTargets reflects the active mode', () => {
    const base = stateWith([
      target('yt', 'domain', 'youtube.com', { type: 'daily-break' }),
      target('reddit', 'domain', 'reddit.com', { type: 'daily-break' }),
    ]);
    expect(dailyBreakTargets(base)).toHaveLength(2);
    const workMode: EngineState = {
      ...base,
      activeModeId: 'work',
      modes: [{ id: 'work', name: 'Work', defaultPolicy: 'block', overrides: {} }],
    };
    // Under allow-list Work mode both become permanent-block, so none remain.
    expect(dailyBreakTargets(workMode)).toHaveLength(0);
  });
});

describe('evaluateSafely — fail closed', () => {
  it('blocks when evaluation throws', () => {
    // Force a throw by corrupting settings (parseHhMm will reject).
    const s = stateWith([target('yt', 'domain', 'youtube.com', { type: 'daily-break' })]);
    const corrupt: EngineState = { ...s, settings: { ...s.settings, resetTime: 'broken' } };
    const d = evaluateSafely(corrupt, web('https://youtube.com'), T0);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('blocked-fail-closed');
  });
});
