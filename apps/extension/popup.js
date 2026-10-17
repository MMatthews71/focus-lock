/** Popup: shows whether the FocusLock service is running and its live status. */
chrome.runtime.sendMessage({ type: 'health' }, (health) => {
  const dot = document.getElementById('dot');
  const statusText = document.getElementById('status-text');
  const running = Boolean(health && health.running);

  dot.classList.toggle('ok', running && health.integrityOk !== false);
  dot.classList.toggle('bad', !running || health.integrityOk === false);
  statusText.textContent = running ? 'Protection active' : 'Service not reachable';

  document.getElementById('targets').textContent = running ? String(health.protectedTargets ?? '—') : '—';
  document.getElementById('breaks').textContent = running ? String(health.breaksRemaining ?? '—') : '—';
  document.getElementById('integrity').textContent = !running
    ? '—'
    : health.integrityOk === false
      ? 'Failed (safe mode)'
      : 'OK';
});
