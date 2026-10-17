// FocusLock supervisor (CommonJS — the deploy folder's package.json sets
// type:module, so this must be .cjs).
//
// Launched by the elevated "FocusLock Guardian" scheduled task and runs for the
// whole session. Every 20s it checks the protection service and, if it is down,
// starts it again. Because the task runs with HIGHEST privileges, the service
// this spawns inherits that elevation and can force-close blocked apps even when
// they run elevated.
//
// Single-instance: a PID lock stops extra supervisors piling up (the task fires
// every minute as a backstop, so most runs find this one already alive and exit).

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// The supervisor is deployed into the install root (…\AppData\Local\FocusLock),
// so derive every path from here rather than hard-coding a user profile.
const ROOT = __dirname;
const SVC = path.join(ROOT, 'service', 'index.js');
const LOG = path.join(ROOT, 'supervisor.log');
const PIDF = path.join(ROOT, 'supervisor.pid');
const HBF = path.join(ROOT, 'supervisor.hb');
const SVC_LOG = path.join(ROOT, 'service.log');

// A supervisor is considered hung if it hasn't written its heartbeat within this
// window. Ticks run every 20s, so this allows ~4 missed beats before takeover.
const STALE_MS = 90 * 1000;

function log(m) {
  try { fs.appendFileSync(LOG, new Date().toISOString() + '  ' + m + '\n'); } catch { /* ignore */ }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

/** Heartbeat the supervisor updates every tick, so a hung one is detectable.
 * Async + fire-and-forget: a synchronous write here must never be able to stall
 * supervisor startup (which would stop it from ever starting the service). */
function beat() {
  try { fs.writeFile(HBF, String(Date.now()), () => {}); } catch (e) { /* ignore */ }
}
function lastBeat() {
  try { return parseInt(fs.readFileSync(HBF, 'utf8'), 10) || 0; } catch (e) { return 0; }
}

/** Force-kill a supervisor that is alive but no longer ticking. */
function killHung(pid) {
  try { process.kill(pid, 'SIGKILL'); } catch (e) { /* ignore */ }
  // On Windows process.kill may not reach an elevated sibling; taskkill is the
  // backstop (this supervisor is itself elevated, so it has the rights).
  // MUST be non-blocking: a synchronous execSync here could hang this new
  // supervisor before it ever ticks, so a wedged old one would block its own
  // replacement forever — the exact failure this takeover logic exists to fix.
  try {
    spawn('taskkill', ['/F', '/PID', String(pid)], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch (e) { /* already gone */ }
}

// --- single instance / takeover --------------------------------------------
// The elevated task fires this launcher every minute as a backstop. Most runs
// find a HEALTHY supervisor (fresh heartbeat) and exit SILENTLY. But if the
// running supervisor is alive yet wedged (no heartbeat for STALE_MS), we kill it
// and take over — otherwise a single hung process would block protection forever.
log('startup: entering single-instance check (pid ' + process.pid + ')');
try {
  const old = parseInt(fs.readFileSync(PIDF, 'utf8'), 10);
  if (old && old !== process.pid && isAlive(old)) {
    const beatAt = lastBeat();
    if (Date.now() - beatAt < STALE_MS) {
      log('startup: healthy supervisor already running (pid ' + old + ') — exiting');
      process.exit(0); // a healthy supervisor is already running
    }
    log('taking over from wedged supervisor (pid ' + old + ', last beat ' +
      (beatAt ? new Date(beatAt).toISOString() : 'never') + ')');
    killHung(old);
  }
} catch (e) { /* no pid file yet */ }
try { fs.writeFileSync(PIDF, String(process.pid)); } catch (e) { /* ignore */ }
log('startup: wrote pid file');
beat();
log('startup: past first beat');

// --- health check ----------------------------------------------------------
function isUp() {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:47615/health', { timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Open the service log for appending, rotating it once it passes ~5 MB. */
function openServiceLog() {
  try {
    if (fs.existsSync(SVC_LOG) && fs.statSync(SVC_LOG).size > 5 * 1024 * 1024) {
      fs.renameSync(SVC_LOG, SVC_LOG + '.old');
    }
    return fs.openSync(SVC_LOG, 'a');
  } catch (e) {
    return 'ignore';
  }
}

async function tick() {
  try {
    beat(); // prove this supervisor is still alive and ticking
    if (await isUp()) return;
    // Re-check once before starting another copy, so a slow reply doesn't
    // cause a second service to fight the first for the port.
    await sleep(3000);
    if (await isUp()) return;
    if (!fs.existsSync(SVC)) { log('service file missing: ' + SVC); return; }
    const out = openServiceLog();
    const child = spawn(process.execPath, [SVC], { cwd: ROOT, detached: true, stdio: ['ignore', out, out], windowsHide: true });
    child.on('exit', (code) => log('service exited (code ' + code + ')'));
    child.unref();
    if (typeof out === 'number') fs.closeSync(out);
    log('service was down — started it');
  } catch (err) {
    log('tick error: ' + (err && err.message ? err.message : String(err)));
  }
}

log('supervisor up (pid ' + process.pid + ')');
tick();
setInterval(tick, 20000);
