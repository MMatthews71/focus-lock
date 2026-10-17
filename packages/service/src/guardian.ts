/**
 * Extension Guardian — enforces that supported browsers run the FocusLock
 * extension.
 *
 * The extension sends a heartbeat to the service every ~30s. The guardian
 * lists running browser processes and, for any watched browser that is running
 * WITHOUT a recent heartbeat, closes it — but only after a grace period, so the
 * user has time to install/enable the extension. As soon as a heartbeat arrives
 * the browser is considered protected and left alone.
 *
 * Two tiers of browser are watched:
 *  - PROTECTABLE (Chromium: Chrome/Brave/Edge/Opera) — the extension runs here,
 *    so a heartbeat protects them; no heartbeat means the extension is gone and
 *    the browser is closed.
 *  - UNSUPPORTED (Firefox, LibreWolf, Waterfox, Vivaldi, Arc, …) — no FocusLock
 *    extension exists for them, so they can never report in and are always
 *    closed while enforcement runs. This closes the "just use another browser"
 *    bypass; the only way to browse is a supported browser with the extension.
 *
 * Safety: the grace period (default 120s) is far longer than the heartbeat
 * interval (30s), so a browser that genuinely has the extension is never
 * closed — even right after the service restarts, its heartbeat lands well
 * within the grace window. A chromium-family heartbeat protects both
 * chrome.exe and brave.exe (their user agents are ambiguous), which errs on the
 * side of *not* closing a protected browser.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/** Which process names a heartbeat from a given browser family protects. */
const EXES_BY_FAMILY: Record<string, string[]> = {
  chrome: ['chrome.exe', 'brave.exe'], // UA-ambiguous chromium
  brave: ['brave.exe'],
  edge: ['msedge.exe'],
  opera: ['opera.exe'],
};

/**
 * Chromium browsers the FocusLock extension can run in. These are "protectable":
 * a heartbeat from the extension marks them safe. Without a heartbeat they are
 * closed (the extension is missing/removed).
 */
const PROTECTABLE_EXES = ['chrome.exe', 'brave.exe', 'msedge.exe', 'opera.exe'];

/**
 * Browsers with no FocusLock extension available. They can NEVER report a
 * heartbeat, so while enforcement is on they are always closed after the grace
 * period. This is what stops Firefox (and friends) being used to sidestep web
 * blocking entirely — the escape hatch a Chromium-only extension would leave.
 */
const UNSUPPORTED_EXES = [
  'firefox.exe', // also covers Tor Browser & Mullvad Browser (both run as firefox.exe)
  'librewolf.exe',
  'waterfox.exe',
  'floorp.exe',
  'zen.exe',
  'palemoon.exe',
  'mullvadbrowser.exe',
  'vivaldi.exe',
  'arc.exe',
];

/** Every browser process the guardian watches. */
const SUPPORTED_EXES = [...PROTECTABLE_EXES, ...UNSUPPORTED_EXES];

const EXE_LABEL: Record<string, string> = {
  'chrome.exe': 'Chrome',
  'brave.exe': 'Brave',
  'msedge.exe': 'Edge',
  'opera.exe': 'Opera',
  'firefox.exe': 'Firefox',
  'librewolf.exe': 'LibreWolf',
  'waterfox.exe': 'Waterfox',
  'floorp.exe': 'Floorp',
  'zen.exe': 'Zen',
  'palemoon.exe': 'Pale Moon',
  'mullvadbrowser.exe': 'Mullvad Browser',
  'vivaldi.exe': 'Vivaldi',
  'arc.exe': 'Arc',
};

export interface GuardianOptions {
  isEnabled: () => boolean;
  graceMs?: number;
  heartbeatTimeoutMs?: number;
  pollMs?: number;
  /** Injectable for tests; defaults to real process listing/killing. */
  listRunning?: () => Promise<Set<string>>;
  killExe?: (exe: string) => Promise<void>;
  log?: (message: string) => void;
}

export interface BrowserStatus {
  exe: string;
  label: string;
  protected: boolean;
  /** Seconds until this browser is closed, if it's unprotected. */
  secondsUntilClose?: number;
}

export class ExtensionGuardian {
  private lastProtected = new Map<string, number>();
  private unprotectedSince = new Map<string, number>();
  private lastStatus: BrowserStatus[] = [];
  private timer: NodeJS.Timeout | null = null;

  private readonly graceMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly pollMs: number;
  private readonly listRunning: () => Promise<Set<string>>;
  private readonly killExe: (exe: string) => Promise<void>;
  private readonly log: (message: string) => void;

  constructor(private opts: GuardianOptions) {
    this.graceMs = opts.graceMs ?? 120_000;
    this.heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? 90_000;
    this.pollMs = opts.pollMs ?? 10_000;
    this.listRunning = opts.listRunning ?? defaultListRunning;
    this.killExe = opts.killExe ?? defaultKillExe;
    this.log = opts.log ?? (() => {});
  }

  /** Record that a browser family's extension is alive. */
  heartbeat(family: string): void {
    const exes = EXES_BY_FAMILY[family] ?? EXES_BY_FAMILY.chrome!;
    const now = Date.now();
    for (const exe of exes) this.lastProtected.set(exe, now);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.log(`guardian tick error: ${String(err)}`));
    }, this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): BrowserStatus[] {
    return this.lastStatus;
  }

  /** One monitoring pass. Exposed for tests. */
  async tick(): Promise<void> {
    const running = await this.listRunning();
    const now = Date.now();
    const enabled = this.opts.isEnabled();
    const statuses: BrowserStatus[] = [];

    for (const exe of SUPPORTED_EXES) {
      if (!running.has(exe)) {
        this.unprotectedSince.delete(exe);
        continue;
      }
      const isProtected = now - (this.lastProtected.get(exe) ?? 0) <= this.heartbeatTimeoutMs;
      const status: BrowserStatus = { exe, label: EXE_LABEL[exe] ?? exe, protected: isProtected };

      if (isProtected) {
        this.unprotectedSince.delete(exe);
      } else {
        if (!this.unprotectedSince.has(exe)) this.unprotectedSince.set(exe, now);
        const elapsed = now - (this.unprotectedSince.get(exe) ?? now);
        status.secondsUntilClose = Math.max(0, Math.ceil((this.graceMs - elapsed) / 1000));

        if (enabled && elapsed >= this.graceMs) {
          this.log(`closing ${exe} — running without the FocusLock extension`);
          await this.killExe(exe).catch((err) => this.log(`kill ${exe} failed: ${String(err)}`));
          // Restart the grace window so a reopened browser gets time to install.
          this.unprotectedSince.set(exe, now);
          status.secondsUntilClose = Math.ceil(this.graceMs / 1000);
        }
      }
      statuses.push(status);
    }

    this.lastStatus = statuses;
  }
}

/** List which supported browser executables are currently running. */
async function defaultListRunning(): Promise<Set<string>> {
  const found = new Set<string>();
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileP('tasklist', ['/fo', 'csv', '/nh'], { windowsHide: true });
      const lower = stdout.toLowerCase();
      for (const exe of SUPPORTED_EXES) if (lower.includes(`"${exe}"`)) found.add(exe);
    } else {
      // Best effort on macOS/Linux by matching process command names.
      const { stdout } = await execFileP('ps', ['-A', '-o', 'comm=']);
      const lower = stdout.toLowerCase();
      if (lower.includes('google chrome') || lower.includes('/chrome')) found.add('chrome.exe');
      if (lower.includes('brave')) found.add('brave.exe');
      if (lower.includes('microsoft edge') || lower.includes('msedge')) found.add('msedge.exe');
      if (lower.includes('opera')) found.add('opera.exe');
      if (lower.includes('firefox')) found.add('firefox.exe');
      if (lower.includes('librewolf')) found.add('librewolf.exe');
      if (lower.includes('waterfox')) found.add('waterfox.exe');
      if (lower.includes('vivaldi')) found.add('vivaldi.exe');
      if (lower.includes('arc')) found.add('arc.exe');
    }
  } catch {
    /* if we can't list processes, enforce nothing this cycle */
  }
  return found;
}

/** Close every process with the given executable name. */
async function defaultKillExe(exe: string): Promise<void> {
  if (process.platform === 'win32') {
    await execFileP('taskkill', ['/F', '/IM', exe], { windowsHide: true });
  } else {
    const names: Record<string, string> = {
      'chrome.exe': 'Google Chrome',
      'brave.exe': 'Brave Browser',
      'msedge.exe': 'Microsoft Edge',
      'opera.exe': 'Opera',
      'firefox.exe': 'firefox',
      'librewolf.exe': 'librewolf',
      'waterfox.exe': 'waterfox',
      'vivaldi.exe': 'Vivaldi',
      'arc.exe': 'Arc',
    };
    await execFileP('pkill', ['-f', names[exe] ?? exe.replace(/\.exe$/i, '')]);
  }
}
