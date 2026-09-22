// Auto Continue activity: the last check the widget ran, anything queued to
// send (with the exact message that will be pasted), and recent sends.

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function row(k, v, vClass) {
  const r = el('div', 'row');
  r.append(el('span', 'k', k), el('span', 'v' + (vClass ? ' ' + vClass : ''), v));
  return r;
}

function item(windowName, time, message, extra) {
  const it = el('div', 'item');
  const head = el('div', 'head');
  head.append(el('span', 'w', windowName), el('span', 't', time));
  it.append(head);
  if (extra) it.append(extra);
  it.append(el('div', 'block', message));
  return it;
}

function pct(p) {
  return p == null ? '—' : `${Math.round(p)}%`;
}

function renderCheck(a) {
  const box = $('check');
  box.textContent = '';
  box.style.whiteSpace = 'normal';
  const c = a.lastCheck;
  if (!c) {
    box.append(el('span', 'empty', 'No check yet. The first one runs after the next usage refresh.'));
    return;
  }
  box.append(row('When', when(c.at)));
  box.append(row('5-hour / weekly', `${pct(c.fiveHour)} / ${pct(c.weekly)}`));
  let status;
  let cls;
  if (!c.enabled) { status = 'Auto Continue is off'; cls = 'warn'; }
  else if (!c.limitsClear) { status = 'Still limited, waiting for the reset'; cls = 'warn'; }
  else if (a.pending.length) { status = 'Limits clear, sending'; cls = 'ok'; }
  else { status = 'Limits clear, nothing waiting'; cls = 'ok'; }
  box.append(row('Status', status, cls));
}

function renderPending(a) {
  const host = $('pending');
  host.textContent = '';
  if (!a.pending.length) {
    host.append(el('div', 'block empty', 'Nothing queued. A session lands here when it stops on a usage limit.'));
    return;
  }
  for (const p of a.pending) {
    let extra = null;
    if (p.attempts) {
      extra = el('div', 'when warn', `Tried ${p.attempts} time${p.attempts === 1 ? '' : 's'}; the screen may be locked.`);
    }
    host.append(item(p.window, p.queuedAt ? `limit hit ${ago(p.queuedAt)}` : '', p.message, extra));
  }
}

function renderHistory(a) {
  const host = $('history');
  host.textContent = '';
  if (!a.history.length) {
    host.append(el('div', 'block empty', 'Nothing sent yet.'));
    return;
  }
  for (const h of a.history.slice(0, 8)) {
    const labels = {
      sent: ['Sent', 'ok'],
      retrying: ['Couldn’t reach the window, retrying', 'warn'],
      'gave up': ['Gave up after repeated tries', 'bad'],
      'no window': ['Dropped: couldn’t tell which window it was in', 'bad'],
    };
    const [label, cls] = labels[h.result] || [h.result, 'warn'];
    host.append(item(h.window, when(h.at), h.message, el('div', 'when ' + cls, label)));
  }
}

function render(a) {
  if (!a) return;
  const state = $('state');
  state.textContent = a.enabled ? 'on' : 'off';
  state.className = 'pill ' + (a.enabled ? 'on' : 'off');
  $('agents-mode').textContent = a.resume_agents
    ? 'Resume agents is on: interrupted agents get resumed too.'
    : 'Resume agents is off: interrupted agents are listed, not resumed.';
  renderCheck(a);
  renderPending(a);
  renderHistory(a);
}

function refresh() {
  window.usage.autoContinue.activity().then(render).catch(() => {});
}

refresh();
setInterval(refresh, 5000);
