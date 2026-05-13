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

window.usage.onUpdate(render);
window.usage.onError(showError);
window.usage.get().then((d) => d && render(d));

$('refresh').addEventListener('click', () => {
  $('status').textContent = 'Refreshing…';
  window.usage.refresh();
});
$('close').addEventListener('click', () => window.usage.close());
