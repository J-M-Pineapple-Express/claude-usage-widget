// Adds or removes the Auto Continue StopFailure hook in Claude Code's user
// settings (~/.claude/settings.json). Pure Node so it can be tested without
// Electron.
//
// The entry is recognised by its command mentioning rate_limit_hook, which
// also catches older hand-added versions (e.g. a Python hook) so turning the
// feature on replaces them rather than running two hooks.

const fs = require('fs');
const path = require('path');

const HOOK_MARKER = 'rate_limit_hook';

function hookCommand(scriptPath) {
  return `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`;
}

function isOurs(group) {
  return Array.isArray(group && group.hooks) &&
    group.hooks.some(h => typeof h.command === 'string' && h.command.includes(HOOK_MARKER));
}

function readSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) return {};
  const text = fs.readFileSync(settingsPath, 'utf8');
  if (!text.trim()) return {};
  // Throws on malformed JSON on purpose: never rewrite a file we can't parse.
  return JSON.parse(text);
}

function writeSettings(settingsPath, settings) {
  const dir = path.dirname(settingsPath);
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(settingsPath)) {
    fs.copyFileSync(settingsPath, settingsPath + '.auto-continue-backup');
  }
  const tmp = settingsPath + '.auto-continue-tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, settingsPath);
}

// Returns { changed, installed }. Writes only when something differs, so
// calling it on every app start doesn't touch the file needlessly.
function syncHook(settingsPath, scriptPath, wantInstalled) {
  const settings = readSettings(settingsPath);
  const hooks = settings.hooks || {};
  const groups = Array.isArray(hooks.StopFailure) ? hooks.StopFailure : [];
  const ours = groups.filter(isOurs);
  const others = groups.filter(g => !isOurs(g));
  const command = hookCommand(scriptPath);

  const alreadyCorrect = wantInstalled
    ? ours.length === 1 && ours[0].matcher === 'rate_limit' &&
      ours[0].hooks.length === 1 && ours[0].hooks[0].command === command
    : ours.length === 0;
  if (alreadyCorrect) return { changed: false, installed: wantInstalled };

  const next = wantInstalled
    ? [...others, {
        matcher: 'rate_limit',
        hooks: [{ type: 'command', command, timeout: 20, statusMessage: 'Queuing auto-continue...' }],
      }]
    : others;

  const nextHooks = { ...hooks };
  if (next.length) nextHooks.StopFailure = next;
  else delete nextHooks.StopFailure;

  const nextSettings = { ...settings };
  if (Object.keys(nextHooks).length) nextSettings.hooks = nextHooks;
  else delete nextSettings.hooks;

  writeSettings(settingsPath, nextSettings);
  return { changed: true, installed: wantInstalled };
}

module.exports = { syncHook, hookCommand };
