/**
 * Block screen logic — mirrors the website block page (block.js). The blocked
 * app is still running underneath: taking a break lets it carry on; choosing
 * not to closes it.
 */

const params = new URLSearchParams(location.search);
const targetId = params.get('targetId');
const breakAvailable = params.get('breakAvailable') === 'true';
const weeklyPassAvailable = params.get('weeklyPassAvailable') === 'true';
const breaksRemaining = Number(params.get('breaksRemaining') ?? '0');
const msUntilReset = Number(params.get('msUntilReset') ?? '0');
const canTakeBreak = breakAvailable && !!targetId && breaksRemaining > 0;
const canTakePass = weeklyPassAvailable && !!targetId;

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const totalMinutes = Math.round(ms / 60000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}
setText('reset', formatDuration(msUntilReset));
setText('breaks', String(breaksRemaining));

const breakBtn = document.getElementById('break-btn');
const passBtn = document.getElementById('weekly-pass-btn');
const closeBtn = document.getElementById('close-btn');

/** Spend a break/pass; on success the app keeps running and this screen closes. */
function wire(btn, busyText, failText, action, ask) {
  btn.addEventListener('click', async () => {
    if (ask && !confirm(ask)) return;
    btn.disabled = true;
    closeBtn.disabled = true;
    btn.textContent = busyText;
    const res = await action();
    if (res && res.ok) {
      window.close();
    } else {
      btn.disabled = false;
      closeBtn.disabled = false;
      btn.textContent = failText;
    }
  });
}

if (breakBtn && canTakeBreak) {
  breakBtn.hidden = false;
  wire(breakBtn, 'Starting break…', 'Could not start break — try again', () => window.focuslock.startBreak());
}
if (passBtn && canTakePass) {
  passBtn.hidden = false;
  wire(
    passBtn,
    'Starting 4-hour pass…',
    'Could not start pass — try again',
    () => window.focuslock.startPass(),
    'Use your one weekly pass to unlock this for 4 hours? You get only one per week.',
  );
}

// With a break on offer, the app is still open — saying no closes it.
closeBtn.textContent = canTakeBreak || canTakePass ? 'No break — close the game' : 'Close';
closeBtn.addEventListener('click', () => window.focuslock.close());
