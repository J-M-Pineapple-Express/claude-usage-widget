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

// Usage resets from Anthropic (claude.ai's "Resets" section). Hidden unless
// the account is eligible; click opens claude.ai, where a reset is used.
function renderResets(r) {
  const row = $('resets-row');
  const val = $('resets-val');
  if (!r) { row.classList.add('hidden'); return; }
  row.classList.remove('hidden');
  const day = (iso) => iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : null;
  val.classList.toggle('good', r.left > 0);
  val.classList.toggle('dim', r.left === 0);
  if (r.left > 0) {
    const until = day(r.endsAt);
    val.textContent = `${r.left} available` + (until ? ` · until ${until}` : '');
  } else {
    val.textContent = r.grants.length ? 'used' : 'none right now';
  }
  val.title = (r.grants.length
    ? r.grants.map(g => `${g.label}: ${g.left} of ${g.total} left` + (g.endsAt ? `, ends ${day(g.endsAt)}` : '') + (g.paused ? ' (paused)' : '')).join('\n')
    : 'A reset refills your 5-hour and weekly limits when you choose to use it.')
    + '\nClick to open claude.ai usage.';
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

  renderResets(data.resets);
  renderBreakdown(data.breakdown);
  lastBreakdown = data.breakdown || [];
  updateSummaries();

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

// ── hover details ──────────────────────────────────────────
// Hovering the session line or the sessions link shows what clicking would
// open (the recap window, the sessions window) as a tooltip. Clicking still
// opens the full window.
const HOVER_MAX_CHARS = 600;
const clip = (s, n = HOVER_MAX_CHARS) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
function agoText(ms) {
  if (!ms) return '';
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}
const toMs = (t) => (typeof t === 'number' ? t : Date.parse(t) || null);

function recapTooltip(r) {
  if (!r) return 'No active Claude Code session';
  const lines = [`${r.session || 'Unnamed session'} · ${r.project}`, ''];
  if (r.recap && r.recap.text) {
    lines.push(`Where you left off (${agoText(toMs(r.recap.at))}):`, clip(r.recap.text));
  } else {
    lines.push('No recap yet (Claude Code writes one when you come back after being away).');
  }
  if (r.lastPrompt && r.lastPrompt.text) {
    lines.push('', `Last thing you asked (${agoText(toMs(r.lastPrompt.at))}):`, clip(r.lastPrompt.text, 300));
  }
  lines.push('', 'Click to open in a window');
  return lines.join('\n');
}

function sessionsTooltip(d) {
  if (!d) return 'Click to see all running Claude Code sessions';
  const pct = (t) => (t != null ? ` · context ${Math.round((t / (ctxWindow * 0.8)) * 100)}%` : '');
  const size = (b) => (b != null ? ` · jsonl ${fmtBytes(b)}` : '');
  const lines = [];
  const running = d.sessions || [];
  lines.push(running.length ? `Running sessions (${running.length}):` : 'No Claude Code sessions running.');
  for (const s of running) {
    const flag = s.pinned ? ' [pinned]' : s.showing ? ' [in widget]' : '';
    lines.push(`${s.status === 'busy' ? '●' : '○'} ${s.name || 'Unnamed session'} · ${s.project}${flag}`);
    lines.push(`   ${s.host}${pct(s.tokens)}${size(s.bytes)}${s.lastActive ? ` · active ${agoText(s.lastActive)}` : ''}`);
  }
  const bg = d.background || [];
  if (bg.length) {
    lines.push('', `Bots & scripts (${bg.length}):`);
    for (const s of bg) {
      lines.push(`${s.status === 'busy' ? '●' : '○'} ${s.name || s.project} · ${s.prompts} messages`);
      lines.push(`   last reply ${agoText(s.lastActive)}${pct(s.tokens)}${size(s.bytes)}`);
    }
  }
  lines.push('', 'Click to open in a window (and pin a session)');
  return lines.join('\n');
}

let hoverFetchedAt = 0;
function refreshHoverInfo(force) {
  if (!force && Date.now() - hoverFetchedAt < 10000) return;
  hoverFetchedAt = Date.now();
  window.usage.recap().then((r) => { $('ctx-where-text').title = recapTooltip(r); }).catch(() => {});
  window.usage.sessions().then((d) => { $('ctx-sessions').title = sessionsTooltip(d); }).catch(() => {});
}

function renderContext(c) {
  lastCtx = c;
  if (!c || !c.tokens) {
    $('bar-ctx').style.width = '0%';
    $('pct-ctx').textContent = '—';
    $('ctx-detail').textContent = 'no active Claude Code session';
    $('ctx-where').classList.add('hidden');
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
  $('ctx-where').classList.remove('hidden');
  $('ctx-where-text').textContent = where;
  refreshHoverInfo();
  // The link doubles as the pin indicator, since a long project/session
  // name can push anything appended to the text out of view.
  const others = (c.runningSessions || 0) - 1;
  $('ctx-sessions').textContent = c.pinned ? 'pinned' : others > 0 ? `+${others} more` : 'sessions';
  updateSummaries();
}

$('ctx-where-text').addEventListener('click', () => window.usage.openRecap());
// ── collapsible sections ───────────────────────────────────
// Folded sections are remembered per section; a folded header shows a
// one-line summary so the numbers are still there at a glance.
const FOLDED_KEY = 'foldedSections';
let folded = [];
try { folded = JSON.parse(localStorage.getItem(FOLDED_KEY) || '[]'); } catch {}
if (!Array.isArray(folded)) folded = [];

for (const sec of document.querySelectorAll('.sec')) {
  const name = sec.dataset.sec;
  const head = sec.querySelector('.sec-head');
  const apply = (isFolded) => {
    sec.classList.toggle('collapsed', isFolded);
    head.setAttribute('aria-expanded', String(!isFolded));
    head.title = isFolded ? 'Show' : 'Hide';
  };
  apply(folded.includes(name));
  head.addEventListener('click', () => {
    const isFolded = !sec.classList.contains('collapsed');
    folded = isFolded ? [...new Set([...folded, name])] : folded.filter(n => n !== name);
    try { localStorage.setItem(FOLDED_KEY, JSON.stringify(folded)); } catch {}
    apply(isFolded);
  });
}

let lastBreakdown = [];
function updateSummaries() {
  const txt = (id) => ($(id).textContent || '').trim();
  $('sum-ctx').textContent = txt('pct-ctx') === '—' ? '' : txt('pct-ctx');
  $('sum-limits').textContent = `5h ${txt('pct-5h')} · wk ${txt('pct-wk')}`;
  const resets = $('resets-val');
  $('sum-extra').textContent = resets.classList.contains('good')
    ? `reset: ${txt('resets-val')}`
    : `spend ${txt('extra-spent')} · bal ${txt('extra-balance')}`;
  $('sum-ac').textContent = !$('ac-enabled').checked ? 'off'
    : $('ac-agents').checked ? 'on · resumes agents' : 'on';
  const top = lastBreakdown.slice().sort((a, b) => (b.percent || 0) - (a.percent || 0))[0];
  $('sum-breakdown').textContent = top ? `${top.name || top.key} ${Math.round(top.percent || 0)}%` : '';
}

// Size the window to the card. Rows come and go (Resets, Auto Continue, the
// breakdown), and a fixed height either clips them or leaves a scroll bar.
let fittedHeight = 0;
function fitWindow() {
  const h = Math.ceil($('card').getBoundingClientRect().height);
  if (h <= 0 || Math.abs(h - fittedHeight) <= 1) return; // only real changes
  fittedHeight = h;
  window.usage.fitHeight(h);
}
new ResizeObserver(fitWindow).observe($('card'));

$('ctx-sessions').addEventListener('click', () => window.usage.openSessions());
// Pointing at either one refreshes its details if they're older than 10s.
$('ctx-where-text').addEventListener('mouseenter', () => refreshHoverInfo());
$('ctx-sessions').addEventListener('mouseenter', () => refreshHoverInfo());
$('resets-val').addEventListener('click', () => window.usage.openUsagePage());
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
  updateSummaries();
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
