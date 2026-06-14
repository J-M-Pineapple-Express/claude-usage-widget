const $ = (id) => document.getElementById(id);

function render(data) {
  if (!data) return;
  const fh = data.fiveHour || {};
  const wk = data.weekly || {};
  if (fh.percent != null) {
    $('bar-5h').style.width = Math.min(100, fh.percent) + '%';
    $('pct-5h').textContent = Math.round(fh.percent) + '%';
  }
  if (fh.reset) $('reset-5h').textContent = 'resets ' + fh.reset;
  if (wk.percent != null) {
    $('bar-wk').style.width = Math.min(100, wk.percent) + '%';
    $('pct-wk').textContent = Math.round(wk.percent) + '%';
  }
  if (wk.reset) $('reset-wk').textContent = 'resets ' + wk.reset;
  const ex = data.extra || {};
  if (ex.spent != null) {
    $('extra-spent').textContent = '$' + ex.spent + (ex.limit ? ' / $' + ex.limit : '');
  }
  if (ex.balance != null) {
    $('extra-balance').textContent = '$' + ex.balance;
  }
  const t = new Date(data.at || Date.now());
  $('status').classList.remove('err');
  $('status').textContent = 'Updated ' + t.toLocaleTimeString();
}

function showError(msg) {
  $('status').classList.add('err');
  $('status').textContent = msg || 'Error reading usage';
}

// ── Claude Code context monitor ────────────────────────────
// Auto-compact fires near the top of the window, so we measure against ~80% of it.
// The window can't be read from the transcript, so it's user-selectable.
const CTX_WINDOWS = [200000, 500000, 1000000];
let ctxWindow = parseInt(localStorage.getItem('ctxWindow') || '200000', 10);
if (!CTX_WINDOWS.includes(ctxWindow)) ctxWindow = 200000;
let lastCtx = null;

function ctxColor(pct) {
  return pct < 40 ? '#3fb950' : pct < 70 ? '#d29922' : '#f85149';
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
    return;
  }
  const budget = Math.round(ctxWindow * 0.8);
  const pct = (c.tokens / budget) * 100;
  $('bar-ctx').style.width = Math.min(100, pct) + '%';
  $('bar-ctx').style.background = ctxColor(pct);
  $('pct-ctx').textContent = Math.round(pct) + '%';
  const stale = Date.now() - (c.at || 0) > 10 * 60 * 1000;
  const win = ctxWindow >= 1000000 ? '1M' : fmtK(ctxWindow);
  $('ctx-detail').textContent =
    `${fmtK(c.tokens)} / ${fmtK(budget)} (${win} window) · ${c.project}` +
    (stale ? ' · idle' : '');
}

window.usage.onUpdate(render);
window.usage.onContext(renderContext);
window.usage.onError(showError);
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
$('close').addEventListener('click', () => window.usage.close());

window.usage.accentColor().then((color) => {
  if (color) $('card').style.borderColor = color;
});
