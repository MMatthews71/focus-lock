/**
 * Block screen logic — mirrors the website block page (block.js). The blocked
 * app is still running underneath: taking a break lets it carry on; choosing
 * not to closes it.
 *
 * A break (or the weekly pass) is gated behind a short guided meditation: the
 * user plays the meditation first, and only when the audio finishes do the
 * break buttons unlock. The service also enforces the full duration, so the
 * screen cannot shortcut it.
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

const choices = document.getElementById('choices');
const meditation = document.getElementById('meditation');
const audio = document.getElementById('med-audio');
const progress = document.getElementById('med-progress');
const progressWrap = progress?.closest('.progress');

const meditateBtn = document.getElementById('meditate-btn');
const breakBtn = document.getElementById('break-btn');
const passBtn = document.getElementById('weekly-pass-btn');
const closeBtn = document.getElementById('close-btn');

/** Reveal the unlock buttons once the meditation is done. */
function unlockBreakButtons() {
  meditation.hidden = true;
  choices.hidden = false;
  if (meditateBtn) meditateBtn.hidden = true;
  if (breakBtn && canTakeBreak) breakBtn.hidden = false;
  if (passBtn && canTakePass) passBtn.hidden = false;
}

/** Play the guided meditation; when it finishes, unlock the break buttons. */
function playMeditation() {
  choices.hidden = true;
  meditation.hidden = false;

  // Start the service's meditation timer.
  window.focuslock.startMeditation();

  const onTime = () => {
    const dur = audio.duration;
    if (!Number.isFinite(dur) || dur <= 0) return;
    const pct = Math.min(100, (audio.currentTime / dur) * 100);
    progress.style.width = `${pct}%`;
    if (progressWrap) progressWrap.setAttribute('aria-valuenow', String(Math.round(pct)));
  };
  const onEnded = () => {
    cleanup();
    unlockBreakButtons();
  };
  const onError = () => {
    cleanup();
    meditation.hidden = true;
    choices.hidden = false;
    if (meditateBtn) {
      meditateBtn.hidden = false;
      meditateBtn.textContent = 'Could not play meditation — try again';
    }
  };
  function cleanup() {
    audio.removeEventListener('timeupdate', onTime);
    audio.removeEventListener('ended', onEnded);
    audio.removeEventListener('error', onError);
  }

  audio.addEventListener('timeupdate', onTime);
  audio.addEventListener('ended', onEnded);
  audio.addEventListener('error', onError);

  const p = audio.play();
  if (p && typeof p.catch === 'function') p.catch(onError);
}

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

// The meditation gateway is offered whenever a break or pass could be spent.
if (meditateBtn && (canTakeBreak || canTakePass)) {
  meditateBtn.hidden = false;
  meditateBtn.addEventListener('click', playMeditation);
}

if (breakBtn && canTakeBreak) {
  wire(breakBtn, 'Starting break…', 'Could not start break — try again', () => window.focuslock.startBreak());
}
if (passBtn && canTakePass) {
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
