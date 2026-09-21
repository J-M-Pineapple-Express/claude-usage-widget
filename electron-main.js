const { app, BrowserWindow, ipcMain, session, Menu, Tray, nativeImage, systemPreferences, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

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
    height: 418,
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
      { label: 'Sign out / switch account', click: async () => {
          if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
          await widgetSession().clearStorageData();
          if (widgetWin && !widgetWin.isDestroyed()) widgetWin.close();
          createLogin();
        } },
      { type: 'separator' },
      { label: 'Quit', click: () => { app.quit(); } },
    ]);
    tray.setContextMenu(menu);
    if (process.platform !== 'darwin') {
      tray.on('click', () => createWidget());
    }
  } catch (e) { log(`tray failed: ${e.message}`); }
}

ipcMain.handle('usage:get', () => lastData);
ipcMain.handle('context:get', () => lastContext);
ipcMain.handle('app:version', () => APP_VERSION);
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
