// Scheduled Cowork tasks with the same "needs attention" dot Claude Desktop
// shows: a run that's unread or waiting on you.

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function until(iso) {
  const t = iso ? Date.parse(iso) : NaN;
  if (isNaN(t)) return null;
  const mins = Math.round((t - Date.now()) / 60000);
  if (mins <= 0) return 'any moment';
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `in ${hrs}h ${mins % 60}m`;
  return new Date(t).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function taskRow(t) {
  const row = el('div', 'sess' + (t.attention ? ' attention' : ''));
  row.title = t.openId ? 'Open the latest run on claude.ai' : 'No runs yet';
  const top = el('div', 'sess-top');
  const dot = el('span', 'dot ' + (t.attention ? 'attn' : 'idle'));
  dot.title = t.attention ? `${t.attention} run(s) unread or waiting on you` : 'Nothing new';
  top.append(dot, el('span', 'sess-name', t.name));
  if (t.waiting) top.append(el('span', 'pill attn', 'needs you'));
  else if (t.attention) top.append(el('span', 'pill attn', `${t.attention} new`));
  if (!t.enabled) top.append(el('span', 'pill off', 'paused'));

  const meta = el('div', 'sess-meta');
  const next = t.enabled ? until(t.nextRunAt) : null;
  if (next) meta.append(el('span', null, `next ${next}`));
  if (t.lastRunAt) meta.append(el('span', null, `last ran ${ago(t.lastRunAt)}`));
  meta.append(el('span', null, `${t.runs} run${t.runs === 1 ? '' : 's'}`));

  row.append(top, meta);
  if (t.openId) row.addEventListener('click', () => window.usage.openChat(t.openId));
  else row.classList.add('bg');
  return row;
}

function render(res) {
  const list = $('list');
  list.textContent = '';
  if (!res || !res.ok) {
    $('summary').textContent = `Couldn't load scheduled tasks${res && res.error ? ` (${res.error})` : ''}.`;
    return;
  }
  const tasks = res.tasks || [];
  const need = tasks.filter(t => t.attention).length;
  $('summary').textContent = tasks.length
    ? `${tasks.length} scheduled task${tasks.length === 1 ? '' : 's'}` + (need ? ` · ${need} need${need === 1 ? 's' : ''} attention` : ' · all caught up')
    : 'No scheduled tasks.';
  for (const t of tasks) list.append(taskRow(t));
}

function refresh() {
  window.usage.scheduled().then(render).catch(() => render(null));
}

refresh();
setInterval(refresh, 60000);
