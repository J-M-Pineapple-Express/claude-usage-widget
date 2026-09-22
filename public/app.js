const $ = (id) => document.getElementById(id);

// ── formatting ─────────────────────────────────────────────
// The API hands back real ISO timestamps now, so the widget decides how to
// phrase them instead of reusing whatever string the settings page rendered.

function fmtMoney(m) {
  if (!m || m.amount == null) return null;
  const neg = m.amount < 0;
  const abs = Math.abs(m.amount);
  // Whole dollars read better without the trailing zeros ($100, not $100.00).
  const body = Number.isInteger(abs) ? String(abs) : abs.toFixed(2);
  return (neg ? '-$' : '$') + body;
}

function fmtReset(iso) {
  if (!iso) return null;
  const t = new Date(iso);
  if (isNaN(t)) return null;
  const mins = Math.round((t - Date.now()) / 60000);
  if (mins <= 0) return 'any moment';
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  // Past a day out, a weekday and clock time is more useful than "in 79h".
  if (hrs >= 24) {
    const day = t.toLocaleDateString(undefined, { weekday: 'short' });
    const time = t.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return `${day} ${time}`;
  }
  const rem = mins % 60;
  return rem ? `in ${hrs}h ${rem}m` : `in ${hrs}h`;
}

function setBar(barId, pctId, percent) {
  if (percent == null) return;
  $(barId).style.width = Math.min(100, percent) + '%';
  $(pctId).textContent = Math.round(percent) + '%';
}

// ── render ─────────────────────────────────────────────────

function renderBreakdown(rows) {
  const wrap = $('breakdown-wrap');
  if (!rows || !rows.length) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  const host = $('breakdown');
  host.textContent = '';
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'row bd-row';

    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = r.name || r.key;

    const bar = document.createElement('div');
    bar.className = 'bar';
    const fill = document.createElement('div');
    fill.className = 'fill';
    fill.style.width = Math.min(100, r.percent || 0) + '%';
    bar.appendChild(fill);

    const pct = document.createElement('div');
    pct.className = 'pct';
    pct.textContent = Math.round(r.percent || 0) + '%';

    row.append(label, bar, pct);
    host.appendChild(row);
  }
}

function render(data) {
  if (!data) return;
  const fh = data.fiveHour || {};
  const wk = data.weekly || {};

  setBar('bar-5h', 'pct-5h', fh.percent);
  const r5 = fmtReset(fh.resetsAt);
  if (r5) $('reset-5h').textContent = 'resets ' + r5;

  setBar('bar-wk', 'pct-wk', wk.percent);
  const rw = fmtReset(wk.resetsAt);
  if (rw) $('reset-wk').textContent = 'resets ' + rw;

  const spend = data.spend || {};
  if (!spend.enabled) {
    $('extra-spent').textContent = 'off';
  } else {
    const used = fmtMoney(spend.used);
    const limit = fmtMoney(spend.limit);
    $('extra-spent').textContent = used ? (limit ? `${used} / ${limit}` : used) : '—';
  }
  $('extra-balance').textContent = fmtMoney(data.balance) || '—';

  renderBreakdown(data.breakdown);

  const t = new Date(data.at || Date.now());
  $('status').classList.remove('err');
  $('status').textContent = 'Updated ' + t.toLocaleTimeString();
}

function showError(msg) {
  $('status').classList.add('err');
  $('status').textContent = msg || 'Error reading usage';
}

// The main process reopens the sign-in window on its own; this just explains
// why the numbers stopped, instead of showing a generic failure.
function showSignedOut() {
  $('status').classList.add('err');
  $('status').textContent = 'Session expired — signing in…';
}

// ── Claude Code context monitor ────────────────────────────
// Auto-compact fires near the top of the window, so we measure against ~80% of it.
// The window can't be read from the transcript, so it's user-selectable.
const CTX_WINDOWS = [200000, 500000, 1000000];
// Default to the 1M window — that's what both owners run. Click the detail line
// to drop to 200K/500K if you're on a standard window.
let ctxWindow = parseInt(localStorage.getItem('ctxWindow') || '1000000', 10);
if (!CTX_WINDOWS.includes(ctxWindow)) ctxWindow = 1000000;
let lastCtx = null;

function ctxColor(pct) {
  return pct < 40 ? '#3fb950' : pct < 70 ? '#d29922' : '#f85149';
}

// Transcript size, formatted and colored the same way as the Claude Code
// status line: green under 12MB, yellow under 15MB, red beyond.
function fmtBytes(b) {
  if (b >= 1024 * 1024) return (b / (1024 * 1024)).toFixed(1) + 'MB';
  if (b >= 1024) return Math.round(b / 1024) + 'KB';
  return b + 'B';
}
function sizeColor(b) {
  const mb = b / (1024 * 1024);
  return mb < 12 ? '#3fb950' : mb < 15 ? '#d29922' : '#f85149';
}

function fmtK(n) {
  return n >= 1000 ? Math.round(n / 1000) + 'K' : n + '';
}

function renderContext(c) {
  lastCtx = c;
  if (!c || !c.tokens) {
    $('bar-ctx').style.width = '0%';
    $('pct-ctx').textContent = '—';
    $('ctx-detail').textContent = 'no active Claude Code session';
    $('ctx-where').textContent = '';
    return;
  }
  const budget = Math.round(ctxWindow * 0.8);
  const pct = (c.tokens / budget) * 100;
  $('bar-ctx').style.width = Math.min(100, pct) + '%';
  $('bar-ctx').style.background = ctxColor(pct);
  $('pct-ctx').textContent = Math.round(pct) + '%';
  const stale = Date.now() - (c.at || 0) > 10 * 60 * 1000;
  const win = ctxWindow >= 1000000 ? '1M' : fmtK(ctxWindow);
  const detail = $('ctx-detail');
  detail.textContent = `${fmtK(c.tokens)} / ${fmtK(budget)} (${win} window)`;
  if (c.bytes != null) {
    detail.append(' · ');
    const size = document.createElement('span');
    size.textContent = `jsonl ${fmtBytes(c.bytes)}`;
    size.style.color = sizeColor(c.bytes);
    detail.append(size);
  }
  const where = (c.session ? `${c.project} · ${c.session}` : c.project) + (stale ? ' · idle' : '');
  $('ctx-where').textContent = where;
  $('ctx-where').title = `${where}\nClick to see where you left off`;
}

$('ctx-where').addEventListener('click', () => window.usage.openRecap());
$('ac-activity').addEventListener('click', () => window.usage.autoContinue.openActivity());

window.usage.onUpdate(render);
window.usage.onContext(renderContext);
window.usage.onError(showError);
window.usage.onSignedOut(showSignedOut);
window.usage.get().then((d) => d && render(d));
window.usage.context().then((c) => renderContext(c));
window.usage.version().then((v) => { if (v) $('version').textContent = 'v' + v; });

// Click the context detail line to cycle the assumed window size.
$('ctx-detail').addEventListener('click', () => {
  const i = CTX_WINDOWS.indexOf(ctxWindow);
  ctxWindow = CTX_WINDOWS[(i + 1) % CTX_WINDOWS.length];
  localStorage.setItem('ctxWindow', String(ctxWindow));
  renderContext(lastCtx);
});

$('refresh').addEventListener('click', () => {
  $('status').textContent = 'Refreshing…';
  window.usage.refresh();
});
$('hide').addEventListener('click', () => window.usage.hide());
$('close').addEventListener('click', () => window.usage.close());

// Auto Continue sliders. Same settings as the tray checkboxes; either side
// updates the other through the main process.
function renderAutoContinue(state) {
  if (!state || !state.supported) return;
  $('ac-wrap').classList.remove('hidden');
  $('ac-enabled').checked = !!state.enabled;
  $('ac-agents').checked = !!state.resume_agents;
  $('ac-agents-row').classList.toggle('off', !state.enabled);
  if (state.error) showError(state.error);
}
window.usage.autoContinue.get().then(renderAutoContinue);
window.usage.autoContinue.onChange(renderAutoContinue);
$('ac-enabled').addEventListener('change', (e) => {
  window.usage.autoContinue.set({ enabled: e.target.checked }).then(renderAutoContinue);
});
$('ac-agents').addEventListener('change', (e) => {
  window.usage.autoContinue.set({ resume_agents: e.target.checked }).then(renderAutoContinue);
});

window.usage.accentColor().then((color) => {
  if (color) $('card').style.borderColor = color;
});
