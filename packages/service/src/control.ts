/**
 * The standalone control page, served by the service itself at `/`.
 *
 * The user-facing way to add blocks, see what's blocked, and manage the 7-day
 * uninstall cooldown — WITHOUT the Electron desktop app. It is baked into the
 * service so it keeps working even if the original project folder is gone, and
 * it's served same-origin so it needs no CORS.
 *
 * NOTE: this is a JS template literal. The embedded script must not use
 * backticks or "${"; and "\n" inside a script string must be written "\\n".
 */
export const CONTROL_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>FocusLock</title>
<style>
  :root { color-scheme: dark; --bg:#0f1115; --card:#171a21; --line:#272b36; --fg:#e6e8ee; --mut:#8a90a0; --accent:#3b82f6; --amber:#f59e0b; --green:#34d399; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui, "Segoe UI", sans-serif; }
  .wrap { max-width:560px; margin:0 auto; padding:40px 20px; }
  h1 { font-size:20px; margin:0 0 4px; }
  h2 { font-size:15px; margin:0 0 14px; }
  .sub { color:var(--mut); margin:0 0 28px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:20px; margin-bottom:16px; }
  .dot { display:inline-block; width:10px; height:10px; border-radius:50%; margin-right:8px; vertical-align:middle; }
  .status { font-weight:600; }
  button { font:inherit; border:0; border-radius:10px; padding:10px 16px; cursor:pointer; }
  button:disabled { opacity:.6; cursor:default; }
  .primary { background:var(--accent); color:#fff; }
  .ghost { background:transparent; color:var(--mut); border:1px solid var(--line); }
  .amber { color:var(--amber); }
  .green { color:var(--green); }
  .row { display:flex; gap:10px; margin-top:16px; flex-wrap:wrap; }
  .muted { color:var(--mut); font-size:13px; }
  label.lbl { display:block; font-size:12px; color:var(--mut); text-transform:uppercase; letter-spacing:.05em; margin:12px 0 6px; }
  select, input { width:100%; font:inherit; color:var(--fg); background:#0f1115; border:1px solid var(--line); border-radius:10px; padding:10px 12px; }
  select:focus, input:focus { outline:2px solid var(--accent); outline-offset:1px; }
  #hint { margin:6px 0 0; }
  #msg { margin:12px 0 0; min-height:1.2em; }
  ul.blocks { list-style:none; margin:0; padding:0; }
  ul.blocks li { display:flex; justify-content:space-between; gap:12px; padding:9px 0; border-top:1px solid var(--line); }
  ul.blocks li:first-child { border-top:0; }
  ul.blocks .name { overflow-wrap:anywhere; }
  ul.blocks .meta { color:var(--mut); font-size:13px; white-space:nowrap; }
</style>
</head>
<body>
<div class="wrap">
  <h1>FocusLock</h1>
  <p class="sub">Protection control</p>

  <div class="card">
    <h2>Add a block</h2>
    <label class="lbl" for="kind">What to block</label>
    <select id="kind">
      <option value="domain">A website</option>
      <option value="keyword">Any website containing a word</option>
      <option value="app">An app or game</option>
    </select>
    <label class="lbl" for="value">Name</label>
    <input id="value" autocomplete="off" spellcheck="false" />
    <p class="muted" id="hint"></p>
    <label class="lbl" for="rule">Rule</label>
    <select id="rule">
      <option value="daily-break">Blocked &mdash; daily breaks can unlock it</option>
      <option value="permanent-block">Always blocked &mdash; no breaks</option>
    </select>
    <div class="row"><button class="primary" id="add">Add block</button></div>
    <p id="msg" class="muted"></p>
  </div>

  <div class="card">
    <h2>Blocked</h2>
    <ul class="blocks" id="list"><li class="muted">Loading&hellip;</li></ul>
  </div>

  <div class="card" id="card"><p class="muted">Checking the protection service&hellip;</p></div>
  <p class="muted" style="margin-top:8px">
    Blocks are permanent: they can't be removed or loosened. Removal of FocusLock itself uses a 7-day cooldown:
    start it, and FocusLock keeps blocking for the full 7 days before it can be removed. Cancel any time to stay protected.
  </p>
</div>
<script>
var KIND_INFO = {
  domain:  { placeholder: 'youtube.com', hint: 'Blocks the site and all its subdomains.' },
  keyword: { placeholder: 'movie', hint: 'Blocks any website whose address contains this word (at least 4 letters).' },
  app:     { placeholder: 'Terraria', hint: 'Use the process name from Task Manager \\u2192 Details, without .exe.' }
};
var KIND_TEXT = { domain: 'website', url: 'web address', keyword: 'word', app: 'app' };
var RULE_TEXT = { 'daily-break': 'breaks can unlock', 'permanent-block': 'always blocked', scheduled: 'scheduled', 'always-allowed': 'allowed' };

var kindSel = document.getElementById('kind');
var valueIn = document.getElementById('value');
var ruleSel = document.getElementById('rule');
var addBtn = document.getElementById('add');
var msgEl = document.getElementById('msg');

function showKind() {
  var info = KIND_INFO[kindSel.value];
  valueIn.placeholder = info.placeholder;
  document.getElementById('hint').textContent = info.hint;
}
kindSel.onchange = showKind;
showKind();

function say(text, cls) {
  msgEl.textContent = text;
  msgEl.className = cls || 'muted';
}

async function call(path, method) {
  var r = await fetch(path, { method: method || 'GET' });
  if (!r.ok) throw new Error(path + ' -> ' + r.status);
  return r.json();
}

async function loadList() {
  var ul = document.getElementById('list');
  try {
    var st = await call('/state');
    var items = st.managedTargets || [];
    ul.textContent = '';
    if (!items.length) {
      var empty = document.createElement('li');
      empty.className = 'muted';
      empty.textContent = 'Nothing blocked yet.';
      ul.appendChild(empty);
      return;
    }
    items.forEach(function (mt) {
      var li = document.createElement('li');
      var name = document.createElement('span');
      name.className = 'name';
      name.textContent = mt.target.label || mt.target.value;
      var meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = (KIND_TEXT[mt.target.kind] || mt.target.kind) + ' \\u00b7 ' + (RULE_TEXT[mt.rule.type] || mt.rule.type);
      li.appendChild(name);
      li.appendChild(meta);
      ul.appendChild(li);
    });
  } catch (e) {
    ul.innerHTML = '<li class="amber">The protection service is not responding.</li>';
  }
}

addBtn.onclick = async function () {
  var value = valueIn.value.trim();
  if (!value) { say('Type what to block first.', 'amber'); valueIn.focus(); return; }
  var ruleText = ruleSel.value === 'permanent-block' ? 'always blocked, no breaks' : 'blocked, daily breaks can unlock it';
  if (!confirm('Block "' + value + '" (' + ruleText + ')?\\n\\nThis is permanent: it can never be removed or loosened.')) return;
  addBtn.disabled = true;
  say('Adding\\u2026');
  try {
    var r = await fetch('/targets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: { kind: kindSel.value, value: value, label: value }, rule: { type: ruleSel.value } })
    });
    var j = await r.json().catch(function () { return {}; });
    if (r.ok) {
      valueIn.value = '';
      say('Blocked "' + (j.target ? j.target.value : value) + '".', 'green');
      loadList();
    } else {
      say(j.error || ('Could not add it (error ' + r.status + ').'), 'amber');
    }
  } catch (e) {
    say('The protection service is not responding.', 'amber');
  }
  addBtn.disabled = false;
};
valueIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') addBtn.click(); });

var card = document.getElementById('card');
function fmt(ms) {
  var m = Math.ceil(ms / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return [d ? d + 'd' : '', h ? h + 'h' : '', (mm || (!d && !h)) ? mm + 'm' : ''].filter(Boolean).join(' ');
}
function render(st) {
  if (!st) {
    card.innerHTML = '<p class="amber">The protection service is not responding. It should restart on its own within a minute.</p>';
    return;
  }
  if (!st.requested) {
    card.innerHTML =
      '<p><span class="dot" style="background:var(--green)"></span><span class="status green">Protection active</span></p>' +
      '<div class="row"><button class="ghost" id="start">Start 7-day removal</button></div>';
    document.getElementById('start').onclick = async function () { await call('/removal/request', 'POST'); refresh(); };
  } else if (!st.unlocked) {
    card.innerHTML =
      '<p><span class="dot" style="background:var(--amber)"></span><span class="status amber">Removal pending</span></p>' +
      '<p>Unlocks in <strong>' + fmt(st.remainingMs) + '</strong>. FocusLock stays fully active until then.</p>' +
      '<div class="row"><button class="primary" id="cancel">Cancel removal &mdash; keep me protected</button></div>';
    document.getElementById('cancel').onclick = async function () { await call('/removal/cancel', 'POST'); refresh(); };
  } else {
    card.innerHTML =
      '<p><span class="dot" style="background:var(--mut)"></span><span class="status">Cooldown elapsed</span></p>' +
      '<p>FocusLock can now be removed, using the steps in your setup notes.</p>' +
      '<div class="row"><button class="ghost" id="keep">Changed my mind &mdash; keep FocusLock</button></div>';
    document.getElementById('keep').onclick = async function () { await call('/removal/cancel', 'POST'); refresh(); };
  }
}
async function refresh() {
  try { render(await call('/removal')); } catch (e) { render(null); }
}
refresh();
loadList();
setInterval(refresh, 15000);
</script>
</body>
</html>`;
