const { app, BrowserWindow, ipcMain, session, Menu, Tray, nativeImage, systemPreferences, net, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { syncHook, hookCommand } = require('./autocontinue-settings');

const DEBUG = process.env.CLAUDE_USAGE_DEBUG === '1';
const APP_VERSION = require('./package.json').version;

const userData = app.getPath('userData');
const logFile = path.join(userData, 'startup.log');
const MAX_LOG_BYTES = 1_000_000;

function log(msg) {
  try {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > MAX_LOG_BYTES) {
      fs.writeFileSync(logFile, line);
    } else {
      fs.appendFileSync(logFile, line);
    }
  } catch {}
}

process.on('uncaughtException', (e) => log(`UNCAUGHT: ${e.stack || e.message}`));
process.on('unhandledRejection', (r) => log(`UNHANDLED: ${r?.stack || r}`));

const PARTITION = 'persist:claude-usage';
const LOGIN_URL = 'https://claude.ai/login';
// A JSON GET, not a hidden browser scraping a page, so per-minute polling is cheap again.
const POLL_MS = 60 * 1000;

const CONTEXT_POLL_MS = 15 * 1000;  // context changes fast during active CC use

let widgetWin = null;
let loginWin = null;
let loginHandled = false;
let tray = null;
let trayMenu = null;
let pollTimer = null;
let ctxTimer = null;
let lastData = null;
let lastContext = null;

function widgetSession() {
  return session.fromPartition(PARTITION, { cache: true });
}

async function hasAuth() {
  const cookies = await widgetSession().cookies.get({ url: 'https://claude.ai' });
  return cookies.some(c => c.name === 'sessionKey' || c.name === 'sessionKeyLC');
}

function createWidget() {
  if (widgetWin && !widgetWin.isDestroyed()) {
    if (widgetWin.isMinimized()) widgetWin.restore();
    widgetWin.show();
    widgetWin.focus();
    return;
  }
  widgetWin = new BrowserWindow({
    width: 300,
    height: 428,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    skipTaskbar: false,
    title: 'Claude Usage',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      session: widgetSession(),
    },
  });
  widgetWin.setAlwaysOnTop(true, 'floating');
  widgetWin.loadFile(path.join(__dirname, 'public', 'index.html'));
  widgetWin.on('closed', () => { widgetWin = null; });
}

function createLogin() {
  loginHandled = false;
  loginWin = new BrowserWindow({
    width: 520,
    height: 720,
    title: 'Sign in to Claude',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      session: widgetSession(),
    },
  });
  loginWin.loadURL(LOGIN_URL);
  const onNav = async (_e, url) => {
    if (loginHandled) return;
    log(`login nav: ${url}`);
    if (!/claude\.ai/.test(url)) return;
    if (/\/(login|auth|signin|sign-in|magic-link)/i.test(url)) return;
    const ok = await hasAuth();
    if (ok && !loginHandled) {
      loginHandled = true;
      log('login cookies captured — closing login window');
      try { loginWin && loginWin.close(); } catch {}
      loginWin = null;
      createWidget();
      startPolling();
    }
  };
  loginWin.webContents.on('did-navigate', onNav);
  loginWin.webContents.on('did-navigate-in-page', onNav);
  loginWin.webContents.on('did-finish-load', () => {
    if (loginWin && !loginWin.isDestroyed()) onNav(null, loginWin.webContents.getURL());
  });
  loginWin.on('closed', () => {
    loginWin = null;
    if (!widgetWin) app.quit();
  });
}

// ── Usage API ──────────────────────────────────────────────
// The settings page is backed by a JSON endpoint, and reading it directly beats
// scraping innerText: nothing breaks when Anthropic edits a label, resets come
// back as real timestamps, and a 401 tells us plainly that the session expired.

const API_BASE = 'https://claude.ai/api';
const orgCacheFile = path.join(userData, 'org.json');
let orgId = null;
let reauthPrompted = false;

function readOrgCache() {
  try {
    const v = JSON.parse(fs.readFileSync(orgCacheFile, 'utf8'));
    if (v && typeof v.orgId === 'string') return v.orgId;
  } catch {}
  return null;
}

function writeOrgCache(id) {
  try { fs.writeFileSync(orgCacheFile, JSON.stringify({ orgId: id })); } catch {}
}

class HttpError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

// Electron's net module sends the partition's cookies, so the session the user
// signed into already authenticates the call — there's no token to manage.
function apiGet(url) {
  return new Promise((resolve, reject) => {
    const req = net.request({ method: 'GET', url, session: widgetSession(), useSessionCookies: true });
    req.setHeader('accept', 'application/json');
    req.setHeader('anthropic-client-platform', 'web_claude_ai');
    let body = '';
    req.on('response', (res) => {
      res.on('data', (c) => { body += c.toString(); });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); }
          catch { reject(new Error(`bad JSON from ${url}`)); }
        } else {
          reject(new HttpError(res.statusCode, body.slice(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Org id, cheapest source first: disk cache, then the lastActiveOrg cookie the
// web client already sets, then the organizations list as a last resort.
async function resolveOrgId() {
  if (orgId) return orgId;
  const cached = readOrgCache();
  if (cached) { orgId = cached; return orgId; }
  try {
    const jar = await widgetSession().cookies.get({ url: 'https://claude.ai', name: 'lastActiveOrg' });
    const v = jar[0] && decodeURIComponent(jar[0].value || '');
    if (v && UUID_RE.test(v)) {
      orgId = v;
      writeOrgCache(orgId);
      log('org id resolved from lastActiveOrg cookie');
      return orgId;
    }
  } catch {}
  const orgs = await apiGet(`${API_BASE}/organizations`);
  const first = Array.isArray(orgs) ? orgs.find(o => o && o.uuid) : null;
  if (!first) throw new Error('no organization found on this account');
  orgId = first.uuid;
  writeOrgCache(orgId);
  log('org id resolved from /organizations');
  return orgId;
}

// The API returns money as minor units plus an exponent ({amount_minor: 8031,
// exponent: 2} is $80.31). Anything missing stays null so the UI shows a dash.
function money(m, currencyFallback) {
  if (!m || m.amount_minor == null) return null;
  const exp = m.exponent == null ? 2 : m.exponent;
  return {
    amount: m.amount_minor / Math.pow(10, exp),
    currency: m.currency || currencyFallback || 'USD',
  };
}

function normalize(usage, prepaid) {
  const fh = usage.five_hour || {};
  const wk = usage.seven_day || {};
  const spend = usage.spend || {};
  const bd = usage.seven_day_breakdown || {};

  let balance = null;
  if (prepaid) {
    const credits = prepaid.balance && prepaid.balance.credits;
    balance = money(credits, prepaid.currency);
    if (!balance && typeof prepaid.amount === 'number') {
      balance = { amount: prepaid.amount, currency: prepaid.currency || 'USD' };
    }
  }

  return {
    fiveHour: { percent: fh.utilization ?? null, resetsAt: fh.resets_at || null },
    weekly: { percent: wk.utilization ?? null, resetsAt: wk.resets_at || null },
    spend: {
      enabled: !!spend.enabled,
      percent: spend.percent ?? null,
      used: money(spend.used),
      limit: money(spend.limit),
    },
    balance,
    // Which products ate the weekly allowance: Claude Code / Chats / Cowork / Other.
    breakdown: Array.isArray(bd.rows)
      ? bd.rows.map(r => ({ key: r.key, name: r.display_name, percent: r.percent }))
      : [],
    at: Date.now(),
  };
}

// ── Auto Continue ──────────────────────────────────────────
// A StopFailure(rate_limit) Claude Code hook (hooks/rate_limit_hook.py)
// writes queue entries here whenever a session gets rate-limited. Once
// this poller's own usage fetch shows BOTH windows below 100% again —
// the only reliable "you're not immediately going to hit the wall again"
// signal, regardless of which window actually caused the block — every
// pending entry gets nudged: focused and sent a message saying to
// continue where it left off.

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const AUTO_CONTINUE_QUEUE_PATH = path.join(CLAUDE_DIR, 'auto-continue-queue.json');
const AUTO_CONTINUE_LOCK_PATH = path.join(CLAUDE_DIR, 'auto-continue-queue.lock');
const AUTO_CONTINUE_CONFIG_PATH = path.join(CLAUDE_DIR, 'auto-continue.json');
const CLAUDE_SETTINGS_PATH = path.join(CLAUDE_DIR, 'settings.json');
// In a packaged build the scripts are unpacked next to app.asar (see
// asarUnpack in package.json); PowerShell can't run files inside the archive.
const HOOKS_DIR = path.join(__dirname, 'hooks').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const AUTO_CONTINUE_NUDGE_SCRIPT = path.join(HOOKS_DIR, 'nudge_window.ps1');
const AUTO_CONTINUE_NUDGE_SCRIPT_MAC = path.join(HOOKS_DIR, 'nudge_mac.js');
const AUTO_CONTINUE_BASE_MESSAGE = 'I had hit my token limit previously, please continue where we left off.';

// enabled is the master switch. It defaults off because turning it on edits
// the user's Claude Code settings (registers the hook). resume_agents also
// defaults off: auto-resuming a batch of interrupted agents can spend most
// of a fresh usage window before the user is back.
function loadAutoContinueConfig() {
    const cfg = { enabled: false, resume_agents: false };
    try {
        if (fs.existsSync(AUTO_CONTINUE_CONFIG_PATH)) {
            Object.assign(cfg, JSON.parse(fs.readFileSync(AUTO_CONTINUE_CONFIG_PATH, 'utf8')));
        }
    } catch (e) {
        log(`auto-continue: config read failed: ${e.message}`);
    }
    return cfg;
}

function saveAutoContinueConfig(cfg) {
    try {
        fs.writeFileSync(AUTO_CONTINUE_CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
    } catch (e) {
        log(`auto-continue: config write failed: ${e.message}`);
    }
}

const AUTO_CONTINUE_SUPPORTED = process.platform === 'win32' || process.platform === 'darwin';

let autoContinueError = null;

function autoContinueState() {
    const cfg = loadAutoContinueConfig();
    return {
        supported: AUTO_CONTINUE_SUPPORTED,
        enabled: !!cfg.enabled,
        resume_agents: !!cfg.resume_agents,
        error: autoContinueError,
    };
}

// Registers or removes the StopFailure hook in ~/.claude/settings.json.
// Returns false (and records why) if the settings file can't be updated,
// e.g. it isn't valid JSON; in that case the feature stays in its old state.
function syncAutoContinueHook(install) {
    try {
        const command = hookCommand(process.platform, HOOKS_DIR, process.execPath);
        const r = syncHook(CLAUDE_SETTINGS_PATH, command, install);
        if (r.changed) log(`auto-continue: hook ${install ? 'installed' : 'removed'} in ${CLAUDE_SETTINGS_PATH}`);
        autoContinueError = null;
        return true;
    } catch (e) {
        log(`auto-continue: could not update Claude settings: ${e.message}`);
        autoContinueError = "Couldn't update ~/.claude/settings.json";
        return false;
    }
}

// Single write path for both settings, so the tray checkboxes and the
// widget sliders can't drift apart.
function updateAutoContinue(patch) {
    const clean = {};
    if ('enabled' in patch) clean.enabled = !!patch.enabled;
    if ('resume_agents' in patch) clean.resume_agents = !!patch.resume_agents;
    if ('enabled' in clean && AUTO_CONTINUE_SUPPORTED && !syncAutoContinueHook(clean.enabled)) {
        delete clean.enabled;
    }
    if (clean.enabled === true && !ensureMacPermissions()) {
        autoContinueError = 'Allow Claude Usage in System Settings > Privacy & Security > Accessibility';
    }
    saveAutoContinueConfig({ ...loadAutoContinueConfig(), ...clean });
    log(`auto-continue: settings updated ${JSON.stringify(clean)}`);

    // Turning Auto Continue off drops anything already queued; otherwise
    // re-enabling later would fire a nudge for a limit hit hours ago.
    if (clean.enabled === false) {
        try {
            withQueueLock(() => fs.writeFileSync(AUTO_CONTINUE_QUEUE_PATH, '[]'));
        } catch (e) {
            log(`auto-continue: queue clear failed: ${e.message}`);
        }
    }

    const state = autoContinueState();
    if (trayMenu) {
        const en = trayMenu.getMenuItemById('auto-continue-enabled');
        const ra = trayMenu.getMenuItemById('auto-continue-resume');
        if (en) en.checked = state.enabled;
        if (ra) { ra.checked = state.resume_agents; ra.enabled = state.enabled; }
    }
    if (widgetWin && !widgetWin.isDestroyed()) widgetWin.webContents.send('autocontinue:update', state);
    return state;
}

function buildNudgeMessage(entry, cfg) {
    const agents = (entry.failed_agents || []).map(a => a.agent_id).filter(Boolean);
    if (!agents.length) return AUTO_CONTINUE_BASE_MESSAGE;
    const list = agents.join(', ');
    if (cfg.resume_agents) {
        return `${AUTO_CONTINUE_BASE_MESSAGE} These agents were also stopped by the limit: ${list}. ` +
            'Resume each of them before anything else: wake idle teammates with SendMessage so they keep ' +
            'their context, and relaunch any that are gone using their original prompts.';
    }
    return `${AUTO_CONTINUE_BASE_MESSAGE} These agents were also stopped by the limit: ${list}. ` +
        "Don't resume them unless I ask.";
}

// Same lock file the hook uses. Held only around read-merge-write, never
// while a nudge is running, so hooks firing mid-nudge wait milliseconds.
function withQueueLock(fn) {
    const deadline = Date.now() + 5000;
    for (;;) {
        try {
            fs.closeSync(fs.openSync(AUTO_CONTINUE_LOCK_PATH, 'wx'));
            break;
        } catch (e) {
            if (e.code !== 'EEXIST') throw e;
            try {
                if (Date.now() - fs.statSync(AUTO_CONTINUE_LOCK_PATH).mtimeMs > 30000) {
                    fs.unlinkSync(AUTO_CONTINUE_LOCK_PATH);
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
        try { fs.unlinkSync(AUTO_CONTINUE_LOCK_PATH); } catch {}
    }
}

function loadAutoContinueQueue() {
    try {
        if (fs.existsSync(AUTO_CONTINUE_QUEUE_PATH)) {
            return JSON.parse(fs.readFileSync(AUTO_CONTINUE_QUEUE_PATH, 'utf8'));
        }
    } catch (e) {
        log(`auto-continue: queue read failed: ${e.message}`);
    }
    return [];
}

// Apply this poll's outcomes to the *current* file contents by entry id,
// so entries or failed agents a hook added during the nudge survive.
function applyQueueOutcomes(dropIds, attemptsById) {
    try {
        withQueueLock(() => {
            const fresh = loadAutoContinueQueue()
                .filter(e => !dropIds.has(e.id))
                .map(e => (attemptsById.has(e.id) ? { ...e, attempts: attemptsById.get(e.id) } : e));
            const tmp = AUTO_CONTINUE_QUEUE_PATH + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(fresh, null, 2));
            fs.renameSync(tmp, AUTO_CONTINUE_QUEUE_PATH);
        });
    } catch (e) {
        log(`auto-continue: queue write failed: ${e.message}`);
    }
}

// Retrying forever would mean a permanently-closed window's entry sits in
// the queue and gets retried every poll indefinitely. Cap it — after this
// many failed attempts (roughly this many minutes, since polls are ~60s
// apart), drop the entry and log why.
const MAX_NUDGE_ATTEMPTS = 30;

function nudgeWindow(entry, message) {
    return process.platform === 'darwin' ? nudgeMac(entry, message) : nudgeWin(entry, message);
}

function macScreenLocked() {
    return new Promise((resolve) => {
        execFile('/usr/sbin/ioreg', ['-n', 'Root', '-d1'], (err, stdout) => {
            resolve(!err && /"CGSSessionScreenIsLocked"\s*=\s*Yes/.test(stdout || ''));
        });
    });
}

// macOS: the message goes on the clipboard here (Electron can save and
// restore images too, not just text), then nudge_mac.js brings the app
// forward, picks the tab or window, and pastes.
async function nudgeMac(entry, message) {
    if (!entry.app_path) {
        log(`auto-continue: entry ${entry.id} has no app path, dropping`);
        return true;
    }
    if (await macScreenLocked()) {
        log(`auto-continue: screen locked, will retry ${entry.id}`);
        return false;
    }
    const prevImage = clipboard.readImage();
    const prevText = clipboard.readText();
    clipboard.writeText(message);
    const folder = entry.cwd ? path.basename(entry.cwd) : '';
    const ok = await new Promise((resolve) => {
        execFile('/usr/bin/osascript', ['-l', 'JavaScript', AUTO_CONTINUE_NUDGE_SCRIPT_MAC, entry.app_path, entry.tty || '', folder],
            { timeout: 20000 }, (err, stdout, stderr) => {
                if (err) {
                    log(`auto-continue: nudge attempt failed for ${entry.id} (${entry.window_title || 'unknown app'}): ${stderr || err.message}`);
                    resolve(false);
                } else {
                    log(`auto-continue: nudged ${entry.id} (${entry.window_title || 'unknown app'})`);
                    resolve(true);
                }
            });
    });
    if (!prevImage.isEmpty()) clipboard.writeImage(prevImage);
    else clipboard.writeText(prevText);
    return ok;
}

// macOS won't let an app send keystrokes to other apps without Accessibility
// access. Ask when the user switches the feature on, while they're here,
// rather than failing silently at reset time.
function ensureMacPermissions() {
    if (process.platform !== 'darwin') return true;
    const trusted = systemPreferences.isTrustedAccessibilityClient(true);
    // Touch System Events once so the Automation consent prompt appears now.
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', "Application('System Events').processes.length"], () => {});
    return trusted;
}

function nudgeWin(entry, message) {
    return new Promise((resolve) => {
        if (!entry.hwnd) {
            log(`auto-continue: entry ${entry.id} has no window handle, dropping`);
            resolve(true); // nothing to retry — treat as done so it gets dropped
            return;
        }
        execFile('powershell.exe', [
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', AUTO_CONTINUE_NUDGE_SCRIPT,
            '-Hwnd', String(entry.hwnd), '-Message', message,
        ], (err, stdout, stderr) => {
            if (err) {
                // Common cause: screen locked/screensaver active when the
                // reset landed — Windows blocks foreground/input injection
                // system-wide in that state. Leave the entry queued so the
                // next poll (~60s) retries once the screen is unlocked.
                log(`auto-continue: nudge attempt failed for ${entry.id} (${entry.window_title || 'unknown window'}): ${stderr || err.message}`);
                resolve(false);
            } else {
                log(`auto-continue: nudged ${entry.id} (${entry.window_title || 'unknown window'})`);
                resolve(true);
            }
        });
    });
}

// `usage` is this poll's normalized data — reuses the same fetch pollOnce()
// already made, no extra API calls just for this check.
async function checkAutoContinueQueue(usage) {
    if (!usage) return;
    const fiveHourClear = usage.fiveHour.percent == null || usage.fiveHour.percent < 100;
    const weeklyClear = usage.weekly.percent == null || usage.weekly.percent < 100;
    if (!fiveHourClear || !weeklyClear) return;

    const cfg = loadAutoContinueConfig();
    if (!cfg.enabled) return;

    let queue;
    try {
        queue = withQueueLock(loadAutoContinueQueue);
    } catch (e) {
        log(`auto-continue: queue read failed: ${e.message}`);
        return;
    }
    if (!queue.length) return;

    const dropIds = new Set();
    const attemptsById = new Map();
    for (const entry of queue) {
        // Guard against nudging on a stale/cached percent read racing the
        // rate-limit stop itself — require a little daylight between when
        // it was queued and now.
        if (Date.now() / 1000 - entry.queued_at < 30) continue;
        const attempts = (entry.attempts || 0) + 1;
        const succeeded = await nudgeWindow(entry, buildNudgeMessage(entry, cfg));
        if (succeeded) {
            dropIds.add(entry.id);
        } else if (attempts >= MAX_NUDGE_ATTEMPTS) {
            log(`auto-continue: giving up on ${entry.id} (${entry.window_title || 'unknown window'}) after ${attempts} failed attempts`);
            dropIds.add(entry.id);
        } else {
            attemptsById.set(entry.id, attempts);
        }
    }
    if (dropIds.size || attemptsById.size) applyQueueOutcomes(dropIds, attemptsById);
}

function handleSignedOut(status) {
  log(`poll: session expired (HTTP ${status})`);
  // A stale org id 403s the same way, so clear it before re-authenticating.
  orgId = null;
  try { fs.unlinkSync(orgCacheFile); } catch {}
  if (widgetWin && !widgetWin.isDestroyed()) widgetWin.webContents.send('usage:signedout');
  // Earlier versions just reported an error forever and left the only recovery
  // buried in the tray menu. Reopen the sign-in window once instead.
  if (!reauthPrompted && !loginWin) {
    reauthPrompted = true;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    createLogin();
  }
}

async function pollOnce() {
  try {
    const id = await resolveOrgId();
    const usage = await apiGet(`${API_BASE}/organizations/${id}/usage`);
    // Prepaid balance is a separate call and entirely optional — never let it
    // take down the numbers that actually matter.
    let prepaid = null;
    try {
      prepaid = await apiGet(`${API_BASE}/organizations/${id}/prepaid/credits`);
    } catch (e) {
      if (DEBUG) log(`prepaid fetch skipped: ${e.message}`);
    }
    lastData = normalize(usage, prepaid);
    reauthPrompted = false;
    log(`poll ok: 5h=${lastData.fiveHour.percent} weekly=${lastData.weekly.percent}`);
    if (widgetWin && !widgetWin.isDestroyed()) widgetWin.webContents.send('usage:update', lastData);
    checkAutoContinueQueue(lastData);
  } catch (e) {
    if (e instanceof HttpError && (e.status === 401 || e.status === 403)) {
      handleSignedOut(e.status);
      return;
    }
    // Transient network trouble (DNS blip, laptop asleep, wifi handover) is not
    // worth spelling out as "net::ERR_NAME_NOT_RESOLVED" in a 300px widget. The
    // next poll is 60s away and the last good numbers stay on screen.
    const offline = /^net::/.test(e.message || '');
    log(`poll ${offline ? 'offline' : 'error'}: ${offline ? e.message : (e.stack || e.message)}`);
    if (widgetWin && !widgetWin.isDestroyed()) {
      widgetWin.webContents.send('usage:error', offline ? 'Offline — retrying' : e.message);
    }
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollOnce();
  pollTimer = setInterval(pollOnce, POLL_MS);
}

// ── Claude Code context monitor ────────────────────────────
// Reads the most-recently-active Claude Code transcript on disk and reports how
// full its context window is, so the widget can warn before auto-compaction.
// Auth-independent (it's local files, not claude.ai), so it runs even before login.

function newestTranscript() {
  const root = path.join(os.homedir(), '.claude', 'projects');
  let best = null;
  let bestM = 0;
  let dirs;
  try { dirs = fs.readdirSync(root); } catch { return null; }
  for (const dir of dirs) {
    const full = path.join(root, dir);
    let files;
    try {
      if (!fs.statSync(full).isDirectory()) continue;
      files = fs.readdirSync(full);
    } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = path.join(full, f);
      try {
        const s = fs.statSync(fp);
        if (s.mtimeMs > bestM) { bestM = s.mtimeMs; best = { path: fp, dir, mtime: s.mtimeMs }; }
      } catch {}
    }
  }
  return best;
}

// Read only the tail of the transcript and find the last entry carrying usage.
function lastUsageInTail(file) {
  let fd;
  try {
    const size = fs.statSync(file).size;
    const readLen = Math.min(size, 262144); // 256KB tail is plenty for the last turn
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, size - readLen);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const o = JSON.parse(line);
        const u = o && o.message && o.message.usage;
        if (u) return u;
      } catch {} // partial first line / non-JSON rows are skipped
    }
  } catch (e) {
    log(`context tail read error: ${e.message}`);
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
  return null;
}

function readClaudeContext() {
  try {
    const t = newestTranscript();
    if (!t) return null;
    const u = lastUsageInTail(t.path);
    if (!u) return null;
    const tokens =
      (u.input_tokens || 0) +
      (u.cache_creation_input_tokens || 0) +
      (u.cache_read_input_tokens || 0);
    if (!tokens) return null;
    // Project label = trailing segment of the encoded "C--Users-...-projects-main" dir.
    const project = t.dir.split('-').filter(Boolean).pop() || '?';
    return { tokens, project, at: t.mtime };
  } catch (e) {
    log(`context read error: ${e.message}`);
    return null;
  }
}

function pushContext() {
  lastContext = readClaudeContext();
  if (widgetWin && !widgetWin.isDestroyed()) {
    widgetWin.webContents.send('context:update', lastContext);
  }
}

function startContextPolling() {
  if (ctxTimer) clearInterval(ctxTimer);
  pushContext();
  ctxTimer = setInterval(pushContext, CONTEXT_POLL_MS);
}

function createTray() {
  try {
    const iconName = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png';
    const iconPath = path.join(__dirname, 'public', iconName);
    const icon = nativeImage.createFromPath(iconPath);
    if (process.platform === 'darwin') icon.setTemplateImage(true);
    tray = new Tray(icon);
    tray.setToolTip(`Claude Usage v${APP_VERSION}`);
    const menu = Menu.buildFromTemplate([
      { label: `Claude Usage v${APP_VERSION}`, enabled: false },
      { type: 'separator' },
      { label: 'Show widget', click: () => createWidget() },
      { label: 'Refresh now', click: () => pollOnce() },
      ...(AUTO_CONTINUE_SUPPORTED ? [
        { type: 'separator' },
        {
          id: 'auto-continue-enabled',
          label: 'Auto Continue',
          type: 'checkbox',
          checked: autoContinueState().enabled,
          click: (item) => updateAutoContinue({ enabled: item.checked }),
        },
        {
          id: 'auto-continue-resume',
          label: '    Resume interrupted agents',
          type: 'checkbox',
          checked: autoContinueState().resume_agents,
          enabled: autoContinueState().enabled,
          click: (item) => updateAutoContinue({ resume_agents: item.checked }),
        },
        { type: 'separator' },
      ] : []),
      { label: 'Sign out / switch account', click: async () => {
          if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
          await widgetSession().clearStorageData();
          if (widgetWin && !widgetWin.isDestroyed()) widgetWin.close();
          createLogin();
        } },
      { type: 'separator' },
      { label: 'Quit', click: () => { app.quit(); } },
    ]);
    trayMenu = menu;
    tray.setContextMenu(menu);
    if (process.platform !== 'darwin') {
      tray.on('click', () => createWidget());
    }
  } catch (e) { log(`tray failed: ${e.message}`); }
}

ipcMain.handle('usage:get', () => lastData);
ipcMain.handle('context:get', () => lastContext);
ipcMain.handle('app:version', () => APP_VERSION);
ipcMain.handle('autocontinue:get', () => autoContinueState());
ipcMain.handle('autocontinue:set', (_e, patch) => updateAutoContinue(patch || {}));
ipcMain.handle('theme:accentColor', () => {
  if (process.platform !== 'win32') return null;
  try {
    const rgba = systemPreferences.getAccentColor(); // 8-char RGBA hex, e.g. 'cce0ffff'
    return '#' + rgba.slice(0, 6);
  } catch { return null; }
});
ipcMain.on('widget:close', () => app.quit());
ipcMain.on('widget:refresh', () => pollOnce());
ipcMain.on('widget:hide', () => {
  if (widgetWin && !widgetWin.isDestroyed()) widgetWin.hide();
});

app.whenReady().then(async () => {
  log(`app ready — v${APP_VERSION}`);
  if (process.platform === 'darwin' && app.dock) app.dock.hide();
  // Keep the registered hook matching the setting and pointing at this
  // install's script (an update or reinstall can move it). No-op if correct.
  if (AUTO_CONTINUE_SUPPORTED) syncAutoContinueHook(loadAutoContinueConfig().enabled);
  createTray();
  startContextPolling(); // local file read — independent of claude.ai auth
  const authed = await hasAuth();
  if (authed) {
    createWidget();
    startPolling();
  } else {
    createLogin();
  }
});

app.on('window-all-closed', (e) => {
  if (tray && !tray.isDestroyed && !tray.isDestroyed()) {
    e.preventDefault();
    return;
  }
  if (process.platform !== 'darwin') app.quit();
});
