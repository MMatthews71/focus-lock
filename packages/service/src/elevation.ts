/**
 * Is THIS service process elevated (running as administrator / root)?
 *
 * It matters because the app guardian can only force-close a blocked app that is
 * at the same or a lower integrity level. An unelevated service can SEE an
 * elevated game (e.g. Terraria launched via Steam-run-as-admin) but `taskkill`
 * is denied, so the game never closes. Surfacing this in /health lets the doctor
 * explain a "can't close the app" failure instead of leaving it a mystery.
 *
 * The check runs once and is cached — a process's elevation never changes during
 * its lifetime.
 */

import { execFileSync } from 'node:child_process';

let cached: boolean | undefined;

export function isServiceElevated(): boolean {
  if (cached !== undefined) return cached;
  cached = detect();
  return cached;
}

function detect(): boolean {
  try {
    if (process.platform === 'win32') {
      // `net session` enumerates sessions and requires administrator rights; a
      // non-elevated shell gets "Access is denied" (a non-zero exit, which
      // throws here). It touches nothing and is the classic elevation probe.
      execFileSync('net', ['session'], { stdio: 'ignore', windowsHide: true, timeout: 5000 });
      return true;
    }
    // POSIX: root is uid 0.
    return typeof process.getuid === 'function' && process.getuid() === 0;
  } catch {
    return false;
  }
}
