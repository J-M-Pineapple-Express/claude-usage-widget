// Auto Continue smoke test for macOS. Runs in CI on a real macOS runner
// against the packaged (unpacked-dir) app:
//   node test/mac-smoke.js "dist/mac-arm64/Claude Usage.app"
//
// Covers everything except the final keystroke paste, which needs an
// Accessibility grant that hosted runners can't give:
//   - the hook runs under the app's own binary (ELECTRON_RUN_AS_NODE)
//   - it finds the hosting .app bundle and the tty from a real process tree
//   - concurrent hooks merge into one entry without losing agents
//   - it does nothing when Auto Continue is off
//   - the command string written to settings.json runs as-is (spaces in path)
//   - the nudge script compiles as JavaScript for Automation

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { hookCommand, syncHook } = require('../autocontinue-settings');

const appBundle = path.resolve(process.argv[2] || 'dist/mac-arm64/Claude Usage.app');
const exe = path.join(appBundle, 'Contents/MacOS/Claude Usage');
const hooksDir = path.join(appBundle, 'Contents/Resources/app.asar.unpacked/hooks');

const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ac-home-'));
const claudeDir = path.join(home, '.claude');
fs.mkdirSync(claudeDir);
const queuePath = path.join(claudeDir, 'auto-continue-queue.json');
const env = { ...process.env, HOME: home };

// A copy of bash inside a .app bundle stands in for Terminal/iTerm: the hook
// should walk up to it and report this bundle as the host app.
const fakeApp = path.join(home, 'FakeTerminal.app');
const fakeShell = path.join(fakeApp, 'Contents/MacOS/fakesh');
fs.mkdirSync(path.dirname(fakeShell), { recursive: true });
fs.copyFileSync('/bin/bash', fakeShell);
fs.chmodSync(fakeShell, 0o755);

const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const readQueue = () => (fs.existsSync(queuePath) ? JSON.parse(fs.readFileSync(queuePath, 'utf8')) : []);
const clearQueue = () => fs.writeFileSync(queuePath, '[]');
const setEnabled = (on) =>
  fs.writeFileSync(path.join(claudeDir, 'auto-continue.json'), JSON.stringify({ enabled: on }));

let n = 0;
function hookShellLine(command, payload, { withTty = false } = {}) {
  const payloadFile = path.join(home, `payload-${n++}.json`);
  fs.writeFileSync(payloadFile, JSON.stringify(payload));
  // Trailing "; true" stops bash from exec'ing the hook in place of itself,
  // which would remove the fake terminal from the hook's process ancestry.
  const inner = `${command} < ${shq(payloadFile)}; true`;
  const viaApp = `${shq(fakeShell)} -c ${shq(inner)}`;
  // `script` gives the fake terminal a real pty, like a Terminal tab has.
  return withTty ? `script -q /dev/null ${viaApp}` : viaApp;
}

function runAsync(line) {
  return new Promise((resolve, reject) => {
    const p = spawn('/bin/sh', ['-c', line], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}: ${err}`))));
  });
}

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(['PASS', name]);
  } catch (e) {
    results.push(['FAIL', name, e.message]);
  }
}

(async () => {
  const command = hookCommand('darwin', hooksDir, exe);
  console.log('hook command:', command);

  await test('packaged app has the unpacked hook scripts', () => {
    assert.ok(fs.existsSync(exe), `missing ${exe}`);
    for (const f of ['rate_limit_hook_mac.js', 'nudge_mac.js']) {
      assert.ok(fs.existsSync(path.join(hooksDir, f)), `missing ${f}`);
    }
  });

  await test('hook finds the host app bundle and the tty', async () => {
    setEnabled(true);
    clearQueue();
    await runAsync(hookShellLine(command, { session_id: 's1', cwd: '/Users/x/My Project', transcript_path: '/tmp/t.jsonl' }, { withTty: true }));
    const q = readQueue();
    assert.strictEqual(q.length, 1, `expected 1 entry, got ${q.length}`);
    const e = q[0];
    console.log('entry:', JSON.stringify(e));
    assert.strictEqual(e.platform, 'darwin');
    assert.strictEqual(e.session_id, 's1');
    assert.strictEqual(e.cwd, '/Users/x/My Project');
    assert.ok(e.app_path && e.app_path.endsWith('/FakeTerminal.app'), `app_path was ${e.app_path}`);
    assert.ok(/^\/dev\/ttys\d+$/.test(e.tty || ''), `tty was ${e.tty}`);
  });

  await test('concurrent main + 10 agent hooks merge into one entry', async () => {
    clearQueue();
    const lines = [hookShellLine(command, { session_id: 's2', cwd: '/Users/x/p' })];
    for (let i = 1; i <= 10; i++) {
      lines.push(hookShellLine(command, { session_id: 's2', agent_id: `agent-${i}`, agent_type: 'general-purpose' }));
    }
    await Promise.all(lines.map(runAsync));
    const q = readQueue();
    assert.strictEqual(q.length, 1, `expected 1 entry, got ${q.length}`);
    assert.strictEqual(q[0].failed_agents.length, 10, `expected 10 agents, got ${q[0].failed_agents.length}`);
    assert.strictEqual(q[0].cwd, '/Users/x/p');
    assert.ok(!fs.existsSync(path.join(claudeDir, 'auto-continue-queue.lock')), 'lock file left behind');
  });

  await test('hook does nothing when Auto Continue is off', async () => {
    setEnabled(false);
    clearQueue();
    await runAsync(hookShellLine(command, { session_id: 's3' }));
    assert.strictEqual(readQueue().length, 0);
  });

  await test('command written to settings.json runs as-is', async () => {
    setEnabled(true);
    clearQueue();
    const settingsPath = path.join(claudeDir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] } }, null, 2));
    syncHook(settingsPath, command, true);
    const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.strictEqual(saved.model, 'opus', 'other settings changed');
    assert.ok(saved.hooks.Stop, 'other hooks removed');
    const stored = saved.hooks.StopFailure[0].hooks[0].command;
    assert.strictEqual(saved.hooks.StopFailure[0].matcher, 'rate_limit');
    await runAsync(hookShellLine(stored, { session_id: 's4' }));
    assert.strictEqual(readQueue().length, 1);
    syncHook(settingsPath, command, false);
    assert.ok(!('StopFailure' in JSON.parse(fs.readFileSync(settingsPath, 'utf8')).hooks), 'uninstall left StopFailure');
  });

  await test('nudge script compiles as JavaScript for Automation', () => {
    execSync(`osacompile -l JavaScript -o ${shq(path.join(home, 'nudge.scpt'))} ${shq(path.join(hooksDir, 'nudge_mac.js'))}`, { stdio: 'pipe' });
  });

  for (const [status, name, err] of results) console.log(`${status}  ${name}${err ? `\n      ${err}` : ''}`);
  const failed = results.filter((r) => r[0] === 'FAIL').length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
