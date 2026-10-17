/**
 * App Guardian — enforces app/executable block rules.
 *
 * The browser extension enforces web rules; nothing on the OS enforces app
 * rules, so this does. Every ~1.5s it lists running processes. When a blocked
 * app starts (or a break on it runs out), it puts up the full-screen block
 * screen:
 *
 *  - If a daily break is available, the app is LEFT RUNNING behind the block
 *    screen while the user decides. Taking the break simply lets them carry on.
 *    The app is closed only if they choose not to take a break, if the block
 *    screen goes away without a choice, or if they don't decide in time. While
 *    the decision is pending, the app's windows are force-minimized each tick so
 *    a game in exclusive full-screen can't sit on top of the block screen — see
 *    {@link defaultSuppressWindows} for why stacking a window higher is not
 *    enough.
 *  - If no break is available there is nothing to decide, so it is closed at once.
 *
 * SAFETY — the single most important property of this module: it will ONLY ever
 * close a process that matches a user-defined app/executable target. It decides
 * via the engine's `evaluateSafely`, which returns a non-null `targetId` only
 * when a managed target governed the request. We additionally require that
 * targetId to be non-null before killing. So even if config integrity fails
 * (where the web check fails *closed* and blocks everything), this guardian
 * never starts killing unrelated processes like explorer.exe or the service
 * itself — its blast radius is limited to apps the user explicitly listed.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Decision } from '@focuslock/core';

const execFileP = promisify(execFile);

/** Every OS command gets a time limit, so one stuck call can't freeze enforcement. */
const COMMAND_TIMEOUT_MS = 8_000;

/** How long the user has to choose on the block screen before the app is closed. */
export const DECISION_TIMEOUT_MS = 2 * 60_000;
/** Time allowed for the block screen to start and check in for the first time. */
export const SCREEN_START_GRACE_MS = 15_000;
/** If the block screen hasn't checked in for this long, it's gone. */
export const SCREEN_STALE_MS = 8_000;

export interface AppGuardianOptions {
  /** Ask the engine whether a running process (by image name) is blocked. */
  evaluate: (processName: string) => Decision;
  /**
   * Called once per NEW block — used to record a stat and to show the
   * full-screen block screen.
   */
  onBlocked?: (processName: string, decision: Decision) => void;
  pollMs?: number;
  /** Injectable for tests; default lists/kills real processes. */
  listProcesses?: () => Promise<string[]>;
  killProcess?: (processName: string) => Promise<void>;
  /**
   * Force-minimize the windows of a running app (by image name). Used to drop a
   * blocked game out of exclusive full-screen while the block screen is up — see
   * {@link AppGuardian.tick}. Injectable for tests; default uses the OS.
   */
  suppressWindows?: (processName: string) => void;
  /** Injectable clock for tests. */
  now?: () => number;
  log?: (message: string) => void;
}

export interface BlockedApp {
  name: string;
  reason: string;
}

interface Pending {
  targetId: string;
  since: number;
}

export class AppGuardian {
  private timer: NodeJS.Timeout | null = null;
  private prevBlocked = new Set<string>();
  private lastStatus: BlockedApp[] = [];
  // Never let two ticks overlap, or the second would see the same launch as "new".
  private ticking = false;
  /** Apps left running behind the block screen while the user decides. */
  private pending = new Map<string, Pending>();
  /** Targets the user chose not to take a break for (close them). */
  private declined = new Set<string>();
  /** Last time the block screen checked in. */
  private screenSeenAt = 0;

  private readonly pollMs: number;
  private readonly listProcesses: () => Promise<string[]>;
  private readonly killProcess: (name: string) => Promise<void>;
  private readonly suppressWindows: (name: string) => void;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(private opts: AppGuardianOptions) {
    this.pollMs = opts.pollMs ?? 1_500;
    this.listProcesses = opts.listProcesses ?? defaultListProcesses;
    this.killProcess = opts.killProcess ?? defaultKillProcess;
    this.log = opts.log ?? (() => {});
    this.suppressWindows = opts.suppressWindows ?? ((name) => defaultSuppressWindows(name, this.log));
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.ticking) return;
      this.ticking = true;
      this.tick()
        .catch((err) => this.log(`app guardian tick error: ${String(err)}`))
        .finally(() => {
          this.ticking = false;
        });
    }, this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): BlockedApp[] {
    return this.lastStatus;
  }

  /** The block screen is open (called every couple of seconds while it's up). */
  blockScreenAlive(): void {
    this.screenSeenAt = this.now();
  }

  /** The user chose not to take a break for this target — close it. */
  decline(targetId: string): void {
    this.declined.add(targetId);
  }

  /** One monitoring pass. Exposed for tests. */
  async tick(): Promise<void> {
    const names = await this.listProcesses();
    const now = this.now();
    const nowBlocked = new Set<string>();
    const statuses: BlockedApp[] = [];

    for (const name of names) {
      const decision = this.opts.evaluate(name);
      // Kill ONLY when a managed target governed this process (targetId set)
      // AND it resolved to blocked. This is the safety gate that keeps the
      // guardian from ever touching unmanaged/system processes.
      if (decision.allowed || decision.targetId == null) continue;

      const key = name.toLowerCase();
      nowBlocked.add(key);
      statuses.push({ name, reason: decision.reason });

      if (!this.prevBlocked.has(key)) {
        // New block: show the block screen. If a break is available, leave the
        // app running while the user decides; otherwise close it right away.
        this.opts.onBlocked?.(name, decision);
        if (decision.breakAvailable) {
          this.declined.delete(decision.targetId);
          this.pending.set(key, { targetId: decision.targetId, since: now });
          this.log(`${name} is blocked — waiting for a choice on the block screen`);
          // Drop it out of exclusive full-screen immediately so the block screen
          // isn't left rendering behind the game (see the module header).
          this.suppressWindows(name);
          continue;
        }
        this.log(`closing ${name} — blocked (${decision.reason}), no break available`);
        await this.close(name);
        continue;
      }

      const p = this.pending.get(key);
      if (p) {
        const age = now - p.since;
        let why: string | null = null;
        if (this.declined.has(p.targetId)) why = 'no break taken';
        else if (age >= DECISION_TIMEOUT_MS) why = 'no choice made in time';
        else if (age >= SCREEN_START_GRACE_MS && now - this.screenSeenAt >= SCREEN_STALE_MS) {
          why = 'block screen closed without a choice';
        }
        if (!why) {
          // Still deciding — leave it running, but keep it minimized so a game
          // that re-grabs exclusive full-screen (e.g. the user alt-tabs back to
          // it) can't sit over the block screen.
          this.suppressWindows(name);
          continue;
        }
        this.pending.delete(key);
        this.declined.delete(p.targetId);
        this.log(`closing ${name} — ${why}`);
      }
      await this.close(name);
    }

    // Forget decisions for apps that are no longer blocked (a break was taken,
    // or the app exited), so the next launch starts fresh.
    for (const key of [...this.pending.keys()]) {
      if (!nowBlocked.has(key)) this.pending.delete(key);
    }

    this.prevBlocked = nowBlocked;
    this.lastStatus = statuses;
  }

  private async close(name: string): Promise<void> {
    await this.killProcess(name).catch((err) => this.log(`kill ${name} failed: ${String(err)}`));
  }
}

/** List the distinct image names of currently-running processes. */
async function defaultListProcesses(): Promise<string[]> {
  const names = new Set<string>();
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileP('tasklist', ['/fo', 'csv', '/nh'], {
        windowsHide: true,
        timeout: COMMAND_TIMEOUT_MS,
      });
      for (const line of stdout.split(/\r?\n/)) {
        // Each line: "Image Name","PID","Session","Session#","Mem Usage"
        const m = /^"([^"]+)"/.exec(line.trim());
        if (m && m[1]) names.add(m[1]);
      }
    } else {
      const { stdout } = await execFileP('ps', ['-A', '-o', 'comm='], { timeout: COMMAND_TIMEOUT_MS });
      for (const line of stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // Use the basename so "/Applications/Foo.app/.../Foo" -> "Foo".
        names.add(trimmed.split('/').pop() ?? trimmed);
      }
    }
  } catch {
    /* if we can't list processes, enforce nothing this cycle */
  }
  return [...names];
}

/** Force-close every process with the given image name. */
async function defaultKillProcess(name: string): Promise<void> {
  if (process.platform === 'win32') {
    try {
      // /T also terminates child processes, so a game started by a launcher
      // (e.g. Steam → Terraria.exe) is taken down with its whole tree rather
      // than leaving the real window alive behind a dead stub.
      await execFileP('taskkill', ['/F', '/T', '/IM', name], { windowsHide: true, timeout: COMMAND_TIMEOUT_MS });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      const text = `${e?.stdout ?? ''}${e?.stderr ?? ''}` || String(err);
      // The image genuinely isn't running (it exited) — nothing to do.
      if (/not found/i.test(text)) return;
      // Anything else is a REAL failure and must NOT be swallowed. The important
      // case is taskkill reporting "could not be terminated" / "Access is
      // denied": the process is still running but refuses to die because it is
      // at a higher integrity level than this one (e.g. an elevated game while
      // the guardian runs unelevated). Surface it so it is visible in the log
      // and the guardian keeps retrying on the next tick instead of assuming
      // success. Running the service elevated is what lets these kills land.
      throw new Error(`taskkill could not terminate ${name}: ${text.trim()}`);
    }
  } else {
    // Match on the process/command name (strip a trailing .exe if one slipped in).
    await execFileP('pkill', ['-f', name.replace(/\.exe$/i, '')], { timeout: COMMAND_TIMEOUT_MS });
  }
}

/**
 * PowerShell that force-minimizes every main window of the processes with the
 * given image name. `SW_FORCEMINIMIZE` (11) minimizes even a window owned by a
 * busy/unresponsive thread — exactly the case for a game mid-frame — and does so
 * without activating it. The image name is passed via the environment, never
 * interpolated into the script, so a process name can't inject PowerShell.
 */
const SUPPRESS_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  '$n=$env:FL_IMG',
  'if([string]::IsNullOrEmpty($n)){exit 0}',
  "Add-Type -Name Win -Namespace FL -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(System.IntPtr h,int c);'",
  'foreach($p in Get-Process -Name $n -ErrorAction SilentlyContinue){',
  '  $h=$p.MainWindowHandle',
  '  if($h -ne [System.IntPtr]::Zero){[void][FL.Win]::ShowWindowAsync($h,11)}',
  '}',
  'exit 0',
].join('\n');

/**
 * Force-minimize a blocked app's windows so it cannot sit over the block screen.
 *
 * WHY THIS EXISTS: the block screen is an always-on-top kiosk window, which beats
 * ordinary windows but NOT a game in exclusive full-screen — that game owns the
 * display's scanout through its own swap chain, so the block screen ends up
 * rendering behind it and the user can carry on playing. Stacking a window higher
 * can't fix that; the game has to leave full-screen. Minimizing its main window
 * forces exactly that: Windows composites the desktop again and the topmost block
 * screen becomes visible. The guardian calls this each tick while a decision is
 * pending, so a game that re-grabs full-screen is bounced straight back down.
 *
 * Best-effort: failures are logged, never thrown, so one bad call can't disturb
 * the enforcement tick. No-op off Windows.
 */
function defaultSuppressWindows(name: string, log: (message: string) => void): void {
  if (process.platform !== 'win32') return;
  const image = name.replace(/\.exe$/i, '');
  execFileP('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SUPPRESS_SCRIPT], {
    windowsHide: true,
    timeout: COMMAND_TIMEOUT_MS,
    env: { ...process.env, FL_IMG: image },
  }).catch((err) => log(`minimize ${name} failed: ${String(err)}`));
}
