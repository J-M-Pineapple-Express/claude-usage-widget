const { app, BrowserWindow, ipcMain, session, Menu, Tray, nativeImage, systemPreferences } = require('electron');
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
const USAGE_URL = 'https://claude.ai/settings/usage';
const LOGIN_URL = 'https://claude.ai/login';
const POLL_MS = 5 * 60 * 1000;

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
    height: 318,
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

const SCRAPE_JS = `(() => {
  const body = document.body ? document.body.innerText : '';
  function extractAfter(anchor, opts) {
    const idx = body.search(anchor);
    if (idx < 0) return null;
    const win = body.slice(idx, idx + (opts.window || 400));
    const pctMatch = win.match(/(\\d{1,3})\\s*%\\s*used/i);
    const resetMatch = win.match(/Resets?\\s+([^\\n]{1,60})/i);
    return {
      percent: pctMatch ? parseInt(pctMatch[1], 10) : null,
      reset: resetMatch ? resetMatch[1].trim() : null,
    };
  }
  const fiveHour = extractAfter(/Current session/i, { window: 200 });
  const weeklyIdx = body.search(/Weekly limits/i);
  let weekly = null;
  if (weeklyIdx >= 0) {
    const weeklyChunk = body.slice(weeklyIdx, weeklyIdx + 600);
    const allModelsIdx = weeklyChunk.search(/All models/i);
    if (allModelsIdx >= 0) {
      const slice = weeklyChunk.slice(allModelsIdx, allModelsIdx + 200);
      const pm = slice.match(/(\\d{1,3})\\s*%\\s*used/i);
      const rm = slice.match(/Resets?\\s+([^\\n]{1,60})/i);
      weekly = {
        percent: pm ? parseInt(pm[1], 10) : null,
        reset: rm ? rm[1].trim() : null,
      };
    }
  }
  let extra = null;
  // Anthropic renamed this section "Extra usage" -> "Usage credits" (2026-06).
  // Match either so old and new page versions both work.
  const extraIdx = body.search(/Usage credits|Extra usage/i);
  if (extraIdx >= 0) {
    const chunk = body.slice(extraIdx, extraIdx + 700);
    const spent = chunk.match(/\\$([\\d,]+(?:\\.\\d{2})?)\\s*spent/i);
    const reset = chunk.match(/Resets?\\s+([^\\n]{1,40})/i);
    // The amount and its label can now be separated by an "Adjust limit" /
    // "Buy usage credits" button. Allow intervening text, but no other "$" in
    // the gap, so each label binds to the dollar amount immediately before it.
    const limit = chunk.match(/\\$([\\d,]+(?:\\.\\d{2})?)[^$]{0,80}?Monthly spend limit/i);
    const balance = chunk.match(/\\$([\\d,]+(?:\\.\\d{2})?)[^$]{0,80}?Current balance/i);
    extra = {
      spent: spent ? spent[1] : null,
      limit: limit ? limit[1] : null,
      balance: balance ? balance[1] : null,
      reset: reset ? reset[1].trim() : null,
    };
  }
  return { fiveHour, weekly, extra, url: location.href, title: document.title };
})();`;

async function waitForText(win, pattern, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (win.isDestroyed()) return false;
    try {
      const found = await win.webContents.executeJavaScript(
        `!!document.body && /${pattern}/i.test(document.body.innerText)`
      );
      if (found) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

async function pollOnce() {
  let scraperWin = null;
  try {
    scraperWin = new BrowserWindow({
      show: false,
      width: 800,
      height: 600,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        session: widgetSession(),
      },
    });
    await scraperWin.loadURL(USAGE_URL);
    const ready = await waitForText(scraperWin, 'Current session|Weekly limits');
    if (!ready) {
      log('poll: timed out waiting for usage page to render');
      if (widgetWin && !widgetWin.isDestroyed()) {
        widgetWin.webContents.send('usage:error', 'Page did not render');
      }
      return;
    }
    const data = await scraperWin.webContents.executeJavaScript(SCRAPE_JS);
    const haveData = data && ((data.fiveHour && data.fiveHour.percent != null) || (data.weekly && data.weekly.percent != null));
    if (haveData) {
      lastData = { ...data, at: Date.now() };
      log(`poll ok: 5h=${data.fiveHour?.percent} weekly=${data.weekly?.percent}`);
      if (widgetWin && !widgetWin.isDestroyed()) widgetWin.webContents.send('usage:update', lastData);
    } else {
      log(`poll empty (data shape: 5h=${!!data?.fiveHour} wk=${!!data?.weekly} ex=${!!data?.extra})`);
      if (DEBUG && data) log(`DEBUG body: ${(data.bodyDump || '').slice(0, 800)}`);
      if (widgetWin && !widgetWin.isDestroyed()) widgetWin.webContents.send('usage:error', 'Could not read usage page');
    }
  } catch (e) {
    log(`poll error: ${e.stack || e.message}`);
    if (widgetWin && !widgetWin.isDestroyed()) widgetWin.webContents.send('usage:error', e.message);
  } finally {
    if (scraperWin && !scraperWin.isDestroyed()) {
      try { scraperWin.destroy(); } catch {}
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
