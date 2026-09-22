// Auto Continue - StopFailure(rate_limit) hook, macOS.
//
// Runs under the widget's own Electron binary with ELECTRON_RUN_AS_NODE=1,
// so it needs nothing installed. Same job and queue format as the Windows
// PowerShell hook: record which app (and, for terminals, which tty) the
// stalled Claude session is in, plus any subagents the limit cut off. One
// queue entry per session.
//
// Always exits 0: a hook that errors on every rate limit is worse than one
// that silently skips queuing once.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const QUEUE_PATH = path.join(CLAUDE_DIR, 'auto-continue-queue.json');
const LOCK_PATH = path.join(CLAUDE_DIR, 'auto-continue-queue.lock');
const CONFIG_PATH = path.join(CLAUDE_DIR, 'auto-continue.json');

function enabled() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).enabled === true;
  } catch {
    return false;
  }
}

function readPayload() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

// Walk up from this hook until an ancestor's executable lives inside a .app
// bundle; the outermost bundle in that path is the app hosting the session
// (Terminal, iTerm, VS Code, the Claude desktop app, ...). Along the way,
// remember the first real tty: that's the Claude CLI's terminal, which lets
// the nudger pick the right Terminal/iTerm tab.
function findHost() {
  const out = execFileSync('/bin/ps', ['-A', '-o', 'pid=,ppid=,tty=,comm='], { encoding: 'utf8' });
  const procs = new Map();
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (m) procs.set(Number(m[1]), { ppid: Number(m[2]), tty: m[3], comm: m[4] });
  }
  let pid = process.ppid;
  let tty = null;
  for (let i = 0; i < 40 && pid > 1; i++) {
    const p = procs.get(pid);
    if (!p) break;
    if (!tty && p.tty && p.tty !== '??' && p.tty !== '-') tty = '/dev/' + p.tty;
    const bundle = p.comm.match(/^(.*?\.app)\//);
    if (bundle) return { appPath: bundle[1], tty };
    pid = p.ppid;
  }
  return { appPath: null, tty };
}

function withLock(fn) {
  const deadline = Date.now() + 8000;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(LOCK_PATH, 'wx'));
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(LOCK_PATH).mtimeMs > 30000) {
          fs.unlinkSync(LOCK_PATH);
          continue;
        }
      } catch {}
      if (Date.now() > deadline) throw new Error('auto-continue queue lock busy');
      const until = Date.now() + 50;
      while (Date.now() < until) {}
    }
  }
  try {
    return fn();
  } finally {
    try { fs.unlinkSync(LOCK_PATH); } catch {}
  }
}

function loadQueue() {
  try {
    const q = JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf8'));
    return Array.isArray(q) ? q : [];
  } catch {
    return [];
  }
}

function main() {
  if (!enabled()) return;
  const payload = readPayload();
  const sessionId = payload.session_id;
  const agentId = payload.agent_id;
  const host = findHost();

  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  withLock(() => {
    const queue = loadQueue();
    let entry = queue.find(e => e.session_id === sessionId && !e.nudged);
    if (!entry) {
      entry = {
        id: crypto.randomUUID(),
        session_id: sessionId,
        cwd: payload.cwd || null,
        transcript_path: payload.transcript_path || null,
        platform: 'darwin',
        app_path: host.appPath,
        tty: host.tty,
        window_title: host.appPath ? path.basename(host.appPath, '.app') : null,
        queued_at: Date.now() / 1000,
        failed_agents: [],
        nudged: false,
      };
      queue.push(entry);
    } else {
      if (!entry.app_path && host.appPath) {
        entry.app_path = host.appPath;
        entry.window_title = path.basename(host.appPath, '.app');
      }
      if (!entry.tty && host.tty) entry.tty = host.tty;
      if (!entry.cwd && payload.cwd) entry.cwd = payload.cwd;
      if (!entry.transcript_path && payload.transcript_path) entry.transcript_path = payload.transcript_path;
    }
    if (agentId) {
      entry.failed_agents = entry.failed_agents || [];
      if (!entry.failed_agents.some(a => a.agent_id === agentId)) {
        entry.failed_agents.push({ agent_id: agentId, agent_type: payload.agent_type || null });
      }
    }
    const tmp = QUEUE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(queue, null, 2));
    fs.renameSync(tmp, QUEUE_PATH);
  });
}

try {
  main();
} catch {
  // Swallow everything; see header.
}
process.exit(0);
