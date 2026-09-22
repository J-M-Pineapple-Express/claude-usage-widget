// "Where you left off" for the session the widget's context bar is measuring.
// The recap is Claude Code's own "while you were away" summary, if it has
// written one; recaps can be turned off in Claude Code's /config, in which
// case this falls back to the last prompt typed in the session.

const MAX_PROMPT_CHARS = 700;

function render(r) {
  if (!r) {
    $('name').textContent = 'No active Claude Code session';
    $('project').textContent = '';
    $('recap').textContent = '';
    $('recap').classList.add('empty');
    $('prompt-wrap').style.display = 'none';
    return;
  }

  $('name').textContent = r.session || 'Unnamed session';
  $('project').textContent = r.project + (r.sessionIsAuto ? ' · name set by Claude Code' : '');
  document.title = `Where you left off · ${r.session || r.project}`;

  if (r.recap && r.recap.text) {
    $('recap').textContent = r.recap.text;
    $('recap').classList.remove('empty');
    $('recap-when').textContent = when(toMs(r.recap.at));
  } else {
    $('recap').textContent =
      'No recap yet. Claude Code writes one when you come back to a session after being away ' +
      '(recaps can be turned on or off in /config).';
    $('recap').classList.add('empty');
    $('recap-when').textContent = '';
  }

  if (r.lastPrompt && r.lastPrompt.text) {
    const text = r.lastPrompt.text;
    $('prompt').textContent = text.length > MAX_PROMPT_CHARS ? text.slice(0, MAX_PROMPT_CHARS - 1) + '…' : text;
    $('prompt-when').textContent = when(toMs(r.lastPrompt.at));
    $('prompt-wrap').style.display = '';
  } else {
    $('prompt-wrap').style.display = 'none';
  }

  $('path').textContent = r.transcript;
}

function refresh() {
  window.usage.recap().then(render).catch(() => {});
}

refresh();
setInterval(refresh, 15000);
