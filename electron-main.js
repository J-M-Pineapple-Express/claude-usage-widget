const { app, BrowserWindow, ipcMain, session, Menu, Tray, nativeImage, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');

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
const POLL_MS = 60 * 1000;

let widgetWin = null;
let loginWin = null;
let loginHandled = false;
let tray = null;
let pollTimer = null;
let lastData = null;

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
    height: 260,
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
  const extraIdx = body.search(/Extra usage/i);
  if (extraIdx >= 0) {
    const chunk = body.slice(extraIdx, extraIdx + 600);
    const spent = chunk.match(/\\$([\\d,]+(?:\\.\\d{2})?)\\s*spent/i);
    const reset = chunk.match(/Resets?\\s+([^\\n]{1,40})/i);
    const limit = chunk.match(/\\$([\\d,]+(?:\\.\\d{2})?)\\s*\\|?\\s*Monthly spend limit/i);
    const balance = chunk.match(/\\$([\\d,]+(?:\\.\\d{2})?)\\s*\\|?\\s*Current balance/i);
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

app.whenReady().then(async () => {
  log(`app ready — v${APP_VERSION}`);
  if (process.platform === 'darwin' && app.dock) app.dock.hide();
  createTray();
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
