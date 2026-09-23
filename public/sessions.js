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

// "where I left off" expands in place, accordion style. Rows are rebuilt on
// every refresh, so which ones are open and their recaps live out here.
const expanded = new Set();
const recaps = new Map(); // sessionId -> recap (or null once loaded with none)
let lastData = null;
const RECAP_MAX_PROMPT = 500;

function loadRecap(id) {
  return window.usage.recap(id).then((r) => {
    recaps.set(id, r || null);
    if (expanded.has(id)) render(lastData);
  }).catch(() => {});
}

function recapPanel(id) {
  const box = el('div', 'sess-recap');
  box.addEventListener('click', (e) => e.stopPropagation()); // don't toggle the pin
  if (!recaps.has(id)) { box.append(el('div', 'dim', 'Loading…')); return box; }
  const r = recaps.get(id);
  if (r && r.recap && r.recap.text) {
    box.append(el('div', 'recap-label', `Where you left off · ${ago(toMs(r.recap.at))}`), el('div', 'recap-text', r.recap.text));
  } else {
    box.append(el('div', 'recap-text empty',
      'No recap yet. Claude Code writes one when you come back to a session after being away (recaps can be turned on or off in /config).'));
  }
  if (r && r.lastPrompt && r.lastPrompt.text) {
    const t = r.lastPrompt.text;
    box.append(el('div', 'recap-label', `Last thing you asked · ${ago(toMs(r.lastPrompt.at))}`),
      el('div', 'recap-text prompt', t.length > RECAP_MAX_PROMPT ? t.slice(0, RECAP_MAX_PROMPT - 1) + '…' : t));
  }
  const pop = el('button', 'link', 'open in a window ↗');
  pop.title = 'Pin this session to the widget and open its recap in its own window';
  pop.addEventListener('click', () => window.usage.pinSession(id).then(() => window.usage.openRecap()));
  box.append(pop);
  return box;
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
  const open = expanded.has(s.sessionId);
  const recap = el('button', 'link', `where I left off ${open ? '▴' : '▾'}`);
  recap.setAttribute('aria-expanded', String(open));
  recap.title = open ? 'Hide the recap' : 'Show the recap here';
  recap.addEventListener('click', (e) => {
    e.stopPropagation();
    if (expanded.has(s.sessionId)) expanded.delete(s.sessionId);
    else { expanded.add(s.sessionId); loadRecap(s.sessionId); }
    render(lastData);
  });
  stats.append(recap);

  row.append(top, meta, stats);
  if (open) row.append(recapPanel(s.sessionId));
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
  meta.append(el('span', null, s.host));
  if (s.prompts != null) meta.append(el('span', null, `${s.prompts} messages`));
  if (s.lastActive) meta.append(el('span', null, `${s.prompts != null ? 'last reply' : 'active'} ${ago(s.lastActive)}`));

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
  lastData = data;
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

  const desk = $('desktop');
  desk.textContent = '';
  const dRows = data.desktop || [];
  $('desk-section').hidden = !dRows.length;
  for (const s of dRows) {
    const row = backgroundRow({ ...s, prompts: null });
    // Desktop rows expand to the recap like running sessions do.
    const open = expanded.has(s.sessionId);
    const link = el('button', 'link', `where I left off ${open ? '▴' : '▾'}`);
    link.addEventListener('click', (e) => {
      e.stopPropagation();
      if (expanded.has(s.sessionId)) expanded.delete(s.sessionId);
      else { expanded.add(s.sessionId); loadRecap(s.sessionId); }
      render(lastData);
    });
    row.querySelector('.sess-stats').append(link);
    if (open) row.append(recapPanel(s.sessionId));
    desk.append(row);
  }

  const chatBox = $('chats');
  chatBox.textContent = '';
  const cRows = data.chats || [];
  $('chat-section').hidden = !cRows.length;
  for (const c of cRows) {
    const row = el('div', 'sess');
    row.title = 'Open on claude.ai';
    const top = el('div', 'sess-top');
    const dot = el('span', 'dot ' + (c.busy ? 'busy' : 'idle'));
    top.append(dot, el('span', 'sess-name', c.name), el('span', 'sess-project', c.desktop ? 'Claude Desktop' : 'claude.ai'));
    if (c.needsInput) top.append(el('span', 'pill on', 'needs you'));
    const meta = el('div', 'sess-meta');
    meta.append(el('span', null, `active ${ago(c.lastActive)}`));
    if (c.model) meta.append(el('span', null, c.model));
    if (c.project) meta.append(el('span', null, `project ${c.project}`));
    row.append(top, meta);
    row.addEventListener('click', () => window.usage.openChat(c.sessionId));
    chatBox.append(row);
  }

  const bg = $('background');
  bg.textContent = '';
  const rows = data.background || [];
  $('bg-section').hidden = !rows.length;
  for (const s of rows) bg.append(backgroundRow(s));
}

function refresh() {
  window.usage.sessions().then((d) => {
    // Keep open recaps current; forget ones for sessions that ended.
    const live = new Set([...(d.sessions || []), ...(d.desktop || [])].map(s => s.sessionId));
    for (const id of [...expanded]) {
      if (!live.has(id)) { expanded.delete(id); recaps.delete(id); } else loadRecap(id);
    }
    render(d);
  }).catch(() => {});
}

refresh();
setInterval(refresh, 5000);
