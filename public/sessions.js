// Every running interactive Claude Code session (terminals, VS Code, the
// desktop app), from Claude Code's own ~/.claude/sessions files. Click a row
// to pin it to the widget's context bar.

const CTX_WINDOWS = [200000, 500000, 1000000];
let ctxWindow = parseInt(localStorage.getItem('ctxWindow') || '1000000', 10);
if (!CTX_WINDOWS.includes(ctxWindow)) ctxWindow = 1000000;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function fmtK(n) {
  return n >= 1000 ? Math.round(n / 1000) + 'K' : String(n);
}
function fmtBytes(b) {
  if (b >= 1024 * 1024) return (b / (1024 * 1024)).toFixed(1) + 'MB';
  if (b >= 1024) return Math.round(b / 1024) + 'KB';
  return b + 'B';
}
function ctxColor(pct) {
  return pct < 40 ? '#3fb950' : pct < 70 ? '#d29922' : '#f85149';
}
function sizeColor(b) {
  const mb = b / (1024 * 1024);
  return mb < 12 ? '#3fb950' : mb < 15 ? '#d29922' : '#f85149';
}

function sessionRow(s) {
  const row = el('div', 'sess' + (s.showing ? ' showing' : ''));
  row.title = s.pinned ? 'Pinned to the widget. Click to unpin.' : 'Click to show this session in the widget';

  const top = el('div', 'sess-top');
  const dot = el('span', 'dot ' + (s.status === 'busy' ? 'busy' : 'idle'));
  dot.title = s.status === 'busy' ? 'Working' : 'Idle';
  const name = el('span', 'sess-name', s.name || 'Unnamed session');
  const project = el('span', 'sess-project', s.project);
  top.append(dot, name, project);
  if (s.pinned) top.append(el('span', 'pill on', 'pinned'));
  else if (s.showing) top.append(el('span', 'pill off', 'in widget'));

  const meta = el('div', 'sess-meta');
  meta.append(el('span', null, s.host));
  if (s.lastActive) meta.append(el('span', null, `active ${ago(s.lastActive)}`));

  const stats = el('div', 'sess-stats');
  if (s.tokens != null) {
    const pct = (s.tokens / (ctxWindow * 0.8)) * 100;
    const c = el('span', null, `context ${Math.round(pct)}%`);
    c.style.color = ctxColor(pct);
    stats.append(c, el('span', 'dim', `${fmtK(s.tokens)} tokens`));
  }
  if (s.bytes != null) {
    const b = el('span', null, `jsonl ${fmtBytes(s.bytes)}`);
    b.style.color = sizeColor(s.bytes);
    stats.append(b);
  }
  const recap = el('button', 'link', 'where I left off');
  recap.addEventListener('click', (e) => {
    e.stopPropagation();
    window.usage.pinSession(s.sessionId).then(() => window.usage.openRecap());
  });
  stats.append(recap);

  row.append(top, meta, stats);
  row.addEventListener('click', () => {
    window.usage.pinSession(s.pinned ? null : s.sessionId).then(render);
  });
  return row;
}

// A bot or script's session: one short `claude -p` run per message, so it's
// only "running" mid-reply. Shown for reference; it can't be pinned.
function backgroundRow(s) {
  const row = el('div', 'sess bg');
  const top = el('div', 'sess-top');
  const dot = el('span', 'dot ' + (s.status === 'busy' ? 'busy' : 'idle'));
  dot.title = s.status === 'busy' ? 'Replying now' : 'Waiting for its next message';
  top.append(dot, el('span', 'sess-name', s.name || s.project), el('span', 'sess-project', s.name ? s.project : ''));

  const meta = el('div', 'sess-meta');
  meta.append(el('span', null, s.host), el('span', null, `${s.prompts} messages`));
  if (s.lastActive) meta.append(el('span', null, `last reply ${ago(s.lastActive)}`));

  const stats = el('div', 'sess-stats');
  if (s.tokens != null) {
    const pct = (s.tokens / (ctxWindow * 0.8)) * 100;
    const c = el('span', null, `context ${Math.round(pct)}%`);
    c.style.color = ctxColor(pct);
    stats.append(c, el('span', 'dim', `${fmtK(s.tokens)} tokens`));
  }
  if (s.bytes != null) {
    const b = el('span', null, `jsonl ${fmtBytes(s.bytes)}`);
    b.style.color = sizeColor(s.bytes);
    stats.append(b);
  }
  row.append(top, meta, stats);
  return row;
}

function render(data) {
  if (!data) return;
  const follow = $('follow');
  follow.textContent = '';
  if (data.pinned) {
    follow.append('The widget is pinned to one session. ');
    const btn = el('button', 'link', 'Follow latest');
    btn.addEventListener('click', () => window.usage.pinSession(null).then(render));
    follow.append(btn);
  } else {
    follow.textContent = 'The widget follows whichever session was active most recently.';
  }

  const list = $('list');
  list.textContent = '';
  if (!data.sessions.length) {
    list.append(el('div', 'block empty', 'No Claude Code sessions running right now.'));
  }
  for (const s of data.sessions) list.append(sessionRow(s));

  const bg = $('background');
  bg.textContent = '';
  const rows = data.background || [];
  $('bg-section').hidden = !rows.length;
  for (const s of rows) bg.append(backgroundRow(s));
}

function refresh() {
  window.usage.sessions().then(render).catch(() => {});
}

refresh();
setInterval(refresh, 5000);
