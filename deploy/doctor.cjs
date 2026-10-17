// FocusLock doctor — one-shot diagnostic (CommonJS, no dependencies).
//
// Run it (via focuslock-doctor.bat, or `node deploy/doctor.cjs [App.exe]`) when a
// blocked app didn't get a block screen. It checks, in order:
//   1. Is the background service running?
//   2. Does it hold any targets, and is the config trusted?
//   3. Is the app you name (default Terraria.exe) actually blocked by a rule?
//   4. Are the block-screen pieces (Electron + overlay) installed so a screen
//      can even be shown?
//   5. Which of your app rules are running right now?
// then tails the recent logs and prints a plain-English verdict.
//
// It only READS state and lists processes — it never changes rules or kills
// anything.

const http = require('http');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 47615;
const BASE = `http://127.0.0.1:${PORT}`;
const testApp = (process.argv[2] || 'Terraria.exe').trim();

const repoRoot = path.resolve(__dirname, '..');
const deployRoot = path.join(process.env.LOCALAPPDATA || '', 'FocusLock');
const BIN = process.platform === 'win32' ? 'electron.exe' : 'electron';

const ok = (m) => console.log('  [OK]  ' + m);
const bad = (m) => console.log('  [X]   ' + m);
const warn = (m) => console.log('  [!]   ' + m);
const info = (m) => console.log('        ' + m);

function request(method, pathname, body) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      BASE + pathname,
      {
        method,
        timeout: 3000,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(data);
          } catch {
            /* non-JSON */
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function listProcesses() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve([]);
    execFile('tasklist', ['/fo', 'csv', '/nh'], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      if (err) return resolve([]);
      const names = new Set();
      for (const line of String(stdout).split(/\r?\n/)) {
        const m = /^"([^"]+)"/.exec(line.trim());
        if (m) names.add(m[1]);
      }
      resolve([...names]);
    });
  });
}

const norm = (n) => n.trim().toLowerCase().replace(/\.exe$/, '');

/** True if a full block-screen asset set exists under `root` with the given layout. */
function assetsAt(electronPath, overlayMain) {
  return fs.existsSync(electronPath) && fs.existsSync(overlayMain);
}

function tail(file, n) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
    return lines.slice(-n);
  } catch {
    return null;
  }
}

async function main() {
  console.log('\n  FocusLock doctor');
  console.log('  ================\n');

  // 1. Service up?
  const health = await request('GET', '/health');
  if (!health || health.status !== 200) {
    bad('The background service is NOT running on 127.0.0.1:' + PORT + '.');
    info('Nothing is watching your apps, so no block screen can ever appear.');
    info('Fix: double-click FocusLock.vbs, or run install-elevated.bat for the');
    info('always-on elevated guardian, then run this doctor again.');
    console.log('');
    return;
  }
  ok('Service is running (version ' + (health.body.version || '?') + ').');
  if (health.body.integrityOk === false) {
    bad('Config integrity FAILED — the service is in fail-closed safe mode.');
  }
  const targetCount = health.body.protectedTargets || 0;
  if (targetCount === 0) warn('No targets are configured yet — nothing is blocked.');
  else ok(targetCount + ' target(s) configured.');

  // 2. App targets from full state.
  const state = await request('GET', '/state');
  const appTargets = ((state && state.body && state.body.managedTargets) || []).filter(
    (m) => m.target.kind === 'app' || m.target.kind === 'executable',
  );
  console.log('');
  if (appTargets.length === 0) {
    warn('You have no APP rules at all (only website/keyword rules, perhaps).');
    info('A game like ' + testApp + ' is only blocked if you add it as an "App".');
  } else {
    console.log('  App rules:');
    for (const m of appTargets) info('- ' + m.target.value + '  (' + m.rule.type + ')');
  }

  // 3. Is the named app actually blocked, and WILL a break be offered?
  console.log('');
  const check = await request('POST', '/check', { kind: 'app', value: testApp });
  if (check && check.body) {
    const d = check.body;
    if (d.allowed) {
      bad(testApp + ' is NOT blocked (reason: ' + d.reason + ').');
      if (d.reason === 'allowed-no-rule') {
        info('=> ' + testApp + ' was never added, or was added as the wrong kind.');
        info('   Add it in the desktop app as an App. Make sure the name matches the');
        info('   real process name (see the running list below — modded Terraria is');
        info('   "tModLoader.exe", not "Terraria.exe").');
      }
    } else {
      ok(testApp + ' IS blocked (reason: ' + d.reason + ', breakAvailable: ' + d.breakAvailable + ', breaksLeft: ' + d.breaksRemaining + ').');
      // Explain whether a "take a break" option can appear at all.
      if (d.breakAvailable) {
        ok('A break IS available — you SHOULD see the break screen with a break button.');
        info('If no screen appears, the block-screen assets are missing or failing to');
        info('launch — see the asset check and overlay.log below.');
      } else if (d.reason === 'permanent-block') {
        warn('This is a PERMANENT block — by design there is no break option, ever.');
        info('The app is simply closed. If you want breaks instead, change the rule to');
        info('"Daily breaks" in the desktop app. (FocusLock never lets you un-block a');
        info('target, but you can switch between blocking rule types.)');
      } else if (d.reason === 'blocked-by-mode') {
        warn('Blocked by the active Mode (not the target\'s own rule) — no break is offered.');
        info('Switch the Mode off (or to one that allows breaks) in the desktop app.');
      } else if (d.reason === 'blocked-by-focus-session') {
        warn('Blocked by an active Focus Session — breaks are disabled until it ends.');
        info('A locked session cannot be ended early; that is the commitment device.');
      } else if (d.reason === 'blocked-by-schedule') {
        warn('Blocked by schedule — it is outside the allowed time window; no break applies.');
      } else if (d.reason === 'blocked-no-break-remaining') {
        warn('It is a Daily-break rule, but you have used ALL your break tokens today.');
        info('The break option only appears when a token is free. Tokens refill at your');
        info('reset time (default 05:00). Breaks left right now: ' + d.breaksRemaining + '.');
      } else if (d.reason === 'blocked-fail-closed') {
        warn('Service is in fail-closed safe mode (config integrity failed) — everything');
        info('is blocked and no breaks are offered until a trusted config is restored.');
      }
    }
  } else {
    warn('Could not run the /check call.');
  }

  // 4. Block-screen assets installed?
  console.log('');
  const deployAssets = assetsAt(
    path.join(deployRoot, 'electron', BIN),
    path.join(deployRoot, 'overlay', 'main.cjs'),
  );
  const repoAssets = assetsAt(
    path.join(repoRoot, 'node_modules', 'electron', 'dist', BIN),
    path.join(repoRoot, 'apps', 'overlay', 'main.cjs'),
  );
  if (deployAssets || repoAssets) {
    ok('Block-screen assets found (' + (deployAssets ? 'installed layout' : 'repo/dev layout') + ').');
  } else {
    bad('Block-screen assets are MISSING (Electron runtime and/or overlay).');
    info('A blocked app would be closed with no screen. Re-run install-elevated.bat');
    info('(it now deploys Electron), or run setup.bat to download Electron first.');
  }

  // 5. Which app rules are running right now?
  const running = await listProcesses();
  if (running.length && appTargets.length) {
    const runningBlocked = appTargets.filter((m) => running.some((p) => norm(p) === norm(m.target.value)));
    console.log('');
    if (runningBlocked.length) ok('Blocked apps running now: ' + runningBlocked.map((m) => m.target.value).join(', '));
    else info('None of your app rules are running right now.');
  }
  if (running.length && !running.some((p) => norm(p) === norm(testApp))) {
    info(testApp + ' does not appear to be running — open it, then re-run the doctor.');
  }

  // 6. Recent logs.
  for (const [label, file] of [
    ['service.log', path.join(deployRoot, 'service.log')],
    ['overlay.log', path.join(deployRoot, 'overlay.log')],
  ]) {
    const lines = tail(file, 12);
    if (lines && lines.length) {
      console.log('\n  Last ' + lines.length + ' lines of ' + label + ':');
      for (const l of lines) info(l);
    }
  }

  console.log('\n  Done. If anything above is marked [X] or [!], that is the thing to fix.\n');
}

main();
