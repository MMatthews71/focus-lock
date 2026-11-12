import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppGuardian, DECISION_TIMEOUT_MS, SCREEN_START_GRACE_MS } from '../src/appguard.js';
import { ProtectionService } from '../src/service.js';
import { Store } from '../src/store.js';

let dir: string;
let store: Store;
let service: ProtectionService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'focuslock-appguard-'));
  store = new Store(dir, join(dir, 'config.key'));
  service = new ProtectionService(store, Date.UTC(2024, 0, 1, 12, 0, 0));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** An app guardian wired to a real service but fake process listing/killing. */
function makeGuardian(running: string[]) {
  const killed: string[] = [];
  const blocked: string[] = [];
  const minimized: string[] = [];
  const guardian = new AppGuardian({
    evaluate: (name) => service.evaluateApp(name),
    onBlocked: (name) => blocked.push(name),
    listProcesses: async () => running,
    killProcess: async (name) => {
      killed.push(name);
    },
    suppressWindows: (name) => minimized.push(name),
  });
  return { guardian, killed, blocked, minimized };
}

describe('AppGuardian', () => {
  it('closes a running app the user has permanently blocked', async () => {
    service.addTarget({ kind: 'app', value: 'Terraria', label: 'Terraria' }, { type: 'permanent-block' });
    const { guardian, killed } = makeGuardian(['Terraria.exe', 'explorer.exe', 'node.exe']);
    await guardian.tick();
    expect(killed).toEqual(['Terraria.exe']); // matched by name, .exe-insensitive
  });

  it('NEVER closes an unmanaged / system process', async () => {
    // No targets at all.
    const { guardian, killed } = makeGuardian(['explorer.exe', 'svchost.exe', 'node.exe', 'winlogon.exe']);
    await guardian.tick();
    expect(killed).toEqual([]);
  });

  it('does not close an app that is always-allowed', async () => {
    service.addTarget({ kind: 'app', value: 'Terraria', label: 'Terraria' }, { type: 'always-allowed' });
    const { guardian, killed } = makeGuardian(['Terraria.exe']);
    await guardian.tick();
    expect(killed).toEqual([]);
  });

  it('does not close a blocked app while a break for it is active', async () => {
    const t = service.addTarget({ kind: 'app', value: 'Terraria', label: 'Terraria' }, { type: 'daily-break' });
    const now = Date.now();
    const start = service.startBreak(t.target.id, now);
    expect(start.ok).toBe(true);
    const { guardian, killed } = makeGuardian(['Terraria.exe']);
    await guardian.tick();
    expect(killed).toEqual([]);
  });

  it('records a blocked attempt once per new block, not every tick', async () => {
    service.addTarget({ kind: 'app', value: 'Terraria', label: 'Terraria' }, { type: 'permanent-block' });
    const { guardian, killed, blocked } = makeGuardian(['Terraria.exe']);
    await guardian.tick();
    await guardian.tick(); // still running (fake) -> should NOT record again
    expect(blocked).toEqual(['Terraria.exe']); // recorded once
    expect(killed.length).toBe(2); // but kill attempted each tick while it persists
  });

  it('surfaces currently-blocked apps via status()', async () => {
    service.addTarget({ kind: 'app', value: 'Terraria', label: 'Terraria' }, { type: 'permanent-block' });
    const { guardian } = makeGuardian(['Terraria.exe']);
    await guardian.tick();
    expect(guardian.status()).toEqual([{ name: 'Terraria.exe', reason: 'permanent-block' }]);
  });
});

describe('AppGuardian — block screen', () => {
  /** A guardian with a controllable clock; `running` can be changed between ticks. */
  function makeScreen(initial: string[]) {
    const killed: string[] = [];
    const shown: { name: string; breakAvailable: boolean }[] = [];
    const minimized: string[] = [];
    const clock = { t: Date.UTC(2024, 0, 1, 12, 0, 0) };
    const proc = { running: initial };
    const guardian = new AppGuardian({
      evaluate: (name) => service.evaluateApp(name, clock.t),
      onBlocked: (name, decision) => shown.push({ name, breakAvailable: decision.breakAvailable }),
      listProcesses: async () => proc.running,
      killProcess: async (name) => {
        killed.push(name);
      },
      suppressWindows: (name) => minimized.push(name),
      now: () => clock.t,
    });
    return { guardian, killed, shown, minimized, clock, proc };
  }
  const addTerraria = (rule: 'daily-break' | 'permanent-block' = 'daily-break') =>
    service.addTarget({ kind: 'app', value: 'Terraria', label: 'Terraria' }, { type: rule });

  it('shows the block screen at once and leaves the game running while the user decides', async () => {
    addTerraria();
    const { guardian, killed, shown, clock } = makeScreen(['Terraria.exe']);
    await guardian.tick();
    expect(shown).toEqual([{ name: 'Terraria.exe', breakAvailable: true }]);
    expect(killed).toEqual([]);
    // The screen is up and checking in; a few seconds later it is still undecided.
    for (let i = 0; i < 5; i++) {
      clock.t += 2_000;
      guardian.blockScreenAlive();
      await guardian.tick();
    }
    expect(killed).toEqual([]);
    expect(shown.length).toBe(1); // shown once per launch, not every tick
  });

  it('minimizes the game while the user is deciding, so it cannot sit over the block screen', async () => {
    addTerraria();
    const { guardian, minimized, clock } = makeScreen(['Terraria.exe']);
    await guardian.tick();
    // Minimized at once on the first block, then again on every pending tick.
    expect(minimized).toEqual(['Terraria.exe']);
    for (let i = 0; i < 3; i++) {
      clock.t += 2_000;
      guardian.blockScreenAlive();
      await guardian.tick();
    }
    expect(minimized).toEqual(['Terraria.exe', 'Terraria.exe', 'Terraria.exe', 'Terraria.exe']);
  });

  it('stops minimizing the game once the break is taken', async () => {
    const t = addTerraria();
    const { guardian, minimized, clock } = makeScreen(['Terraria.exe']);
    await guardian.tick();
    expect(minimized).toEqual(['Terraria.exe']); // minimized while deciding
    clock.t += 3_000;
    expect(service.startBreak(t.target.id, clock.t).ok).toBe(true);
    for (let i = 0; i < 5; i++) {
      clock.t += 2_000;
      await guardian.tick();
    }
    // Break is active -> the app is allowed -> no longer minimized each tick.
    expect(minimized).toEqual(['Terraria.exe']);
  });

  it('does not minimize an app that is closed straight away (no break available)', async () => {
    addTerraria('permanent-block');
    const { guardian, minimized, killed } = makeScreen(['Terraria.exe']);
    await guardian.tick();
    expect(killed).toEqual(['Terraria.exe']);
    expect(minimized).toEqual([]); // it's being closed, not left up to decide on
  });

  it('closes the game once the user chooses not to take a break', async () => {
    const t = addTerraria();
    const { guardian, killed, clock } = makeScreen(['Terraria.exe']);
    await guardian.tick();
    clock.t += 3_000;
    guardian.blockScreenAlive();
    guardian.decline(t.target.id);
    await guardian.tick();
    expect(killed).toEqual(['Terraria.exe']);
  });

  it('never closes the game when the user takes the break', async () => {
    const t = addTerraria();
    const { guardian, killed, clock } = makeScreen(['Terraria.exe']);
    await guardian.tick();
    clock.t += 3_000;
    expect(service.startBreak(t.target.id, clock.t).ok).toBe(true);
    for (let i = 0; i < 10; i++) {
      clock.t += 2_000;
      await guardian.tick();
    }
    expect(killed).toEqual([]);
  });

  it('closes the game straight away when no break is available', async () => {
    addTerraria('permanent-block');
    const { guardian, killed, shown } = makeScreen(['Terraria.exe']);
    await guardian.tick();
    expect(shown).toEqual([{ name: 'Terraria.exe', breakAvailable: false }]);
    expect(killed).toEqual(['Terraria.exe']);
  });

  it('closes the game if no choice is made in time', async () => {
    addTerraria();
    const { guardian, killed, clock } = makeScreen(['Terraria.exe']);
    await guardian.tick();
    clock.t += DECISION_TIMEOUT_MS - 1_000;
    guardian.blockScreenAlive();
    await guardian.tick();
    expect(killed).toEqual([]);
    clock.t += 2_000;
    guardian.blockScreenAlive();
    await guardian.tick();
    expect(killed).toEqual(['Terraria.exe']);
  });

  it('closes the game if the block screen never shows up or goes away', async () => {
    addTerraria();
    const { guardian, killed, clock } = makeScreen(['Terraria.exe']);
    await guardian.tick();
    clock.t += SCREEN_START_GRACE_MS - 1_000; // still starting up — wait
    await guardian.tick();
    expect(killed).toEqual([]);
    clock.t += 2_000; // past the grace period and it never checked in
    await guardian.tick();
    expect(killed).toEqual(['Terraria.exe']);
  });

  it('starts fresh on the next launch after a "no"', async () => {
    const t = addTerraria();
    const { guardian, killed, shown, clock, proc } = makeScreen(['Terraria.exe']);
    await guardian.tick();
    guardian.decline(t.target.id);
    clock.t += 2_000;
    await guardian.tick();
    expect(killed).toEqual(['Terraria.exe']);
    proc.running = []; // game closed
    clock.t += 2_000;
    await guardian.tick();
    proc.running = ['Terraria.exe']; // launched again
    clock.t += 2_000;
    await guardian.tick();
    expect(shown.length).toBe(2); // block screen shown again
    expect(killed.length).toBe(1); // and the game is left running while they decide
  });
});
