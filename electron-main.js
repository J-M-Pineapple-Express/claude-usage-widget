const { app, BrowserWindow, ipcMain, session, Menu, Tray, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const userData = app.getPath('userData');
const logFile = path.join(userData, 'startup.log');
function log(msg) {
  try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}
process.on('uncaughtException', (e) => log(`UNCAUGHT: ${e.stack || e.message}`));
process.on('unhandledRejection', (r) => log(`UNHANDLED: ${r?.stack || r}`));

const PARTITION = 'persist:claude-usage';
const USAGE_URL = 'https://claude.ai/settings/usage';
const LOGIN_URL = 'https://claude.ai/login';
const POLL_MS = 60 * 1000;

let widgetWin = null;
let loginWin = null;
let scraperWin = null;
let tray = null;
let pollTimer = null;
let lastData = null;

function widgetSession() {
  return session.fromPartition(PARTITION, { cache: true });
}

async function hasAuth() {
  const cookies = await widgetSession().cookies.get({ url: 'https://claude.ai' });
  const names = cookies.map(c => c.name);
  log(`cookies on claude.ai: ${names.join(', ')}`);
  return cookies.some(c => /session|auth|__Secure|lastActiveOrg/i.test(c.name));
}

function createWidget() {
  widgetWin = new BrowserWindow({
    width: 300,
    height: 260,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
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
    log(`login nav: ${url}`);
    if (!/claude\.ai/.test(url)) return;
    if (/\/(login|auth|signin|sign-in|magic-link)/i.test(url)) return;
    const ok = await hasAuth();
    log(`hasAuth=${ok} on ${url}`);
    if (ok) {
      log('login cookies captured — closing login window');
      try { loginWin && loginWin.close(); } catch {}
      loginWin = null;
      createWidget();
      startPolling();
    }
  };
  loginWin.webContents.on('did-navigate', onNav);
  loginWin.webContents.on('did-navigate-in-page', onNav);
  loginWin.webContents.on('did-finish-load', () => onNav(null, loginWin.webContents.getURL()));
  loginWin.on('closed', () => {
    loginWin = null;
    if (!widgetWin) app.quit();
  });
}

function ensureScraper() {
  if (scraperWin && !scraperWin.isDestroyed()) return scraperWin;
  scraperWin = new BrowserWindow({
    show: false,
    width: 1200,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'scraper-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      session: widgetSession(),
      offscreen: false,
    },
  });
  scraperWin.on('closed', () => { scraperWin = null; });
  return scraperWin;
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
  // 5-hour = block right after "Current session"
  const fiveHour = extractAfter(/Current session/i, { window: 200 });
  // Weekly all-models = block right after "All models" (under "Weekly limits")
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
  // Extra usage section
  let extra = null;
  const extraIdx = body.search(/Extra usage/i);
  if (extraIdx >= 0) {
    const chunk = body.slice(extraIdx, extraIdx + 600);
    const spent = chunk.match(/\\$([\\d,]+\\.\\d{2})\\s*spent/i);
    const reset = chunk.match(/Resets?\\s+([^\\n]{1,40})/i);
    const limit = chunk.match(/\\$([\\d,]+(?:\\.\\d{2})?)\\s*\\|?\\s*Monthly spend limit/i);
    const balance = chunk.match(/\\$([\\d,]+\\.\\d{2})\\s*\\|?\\s*Current balance/i);
    extra = {
      spent: spent ? spent[1] : null,
      limit: limit ? limit[1] : null,
      balance: balance ? balance[1] : null,
      reset: reset ? reset[1].trim() : null,
    };
  }
  return {
    fiveHour, weekly, extra,
    url: location.href,
    title: document.title,
    bodyDump: body.slice(0, 1500),
  };
})();`;

async function pollOnce() {
  try {
    const win = ensureScraper();
    await win.loadURL(USAGE_URL);
    await new Promise(r => setTimeout(r, 4000));
    const data = await win.webContents.executeJavaScript(SCRAPE_JS);
    log(`scrape url=${data && data.url} title=${data && data.title}`);
    if (data && data.bodyDump) log(`body dump: ${data.bodyDump.replace(/\n/g, ' | ')}`);
    const haveData = data && ((data.fiveHour && data.fiveHour.percent != null) || (data.weekly && data.weekly.percent != null));
    if (haveData) {
      lastData = { ...data, at: Date.now() };
      log(`poll ok: 5h=${data.fiveHour?.percent} weekly=${data.weekly?.percent}`);
      if (widgetWin && !widgetWin.isDestroyed()) widgetWin.webContents.send('usage:update', lastData);
    } else {
      log(`poll empty: ${JSON.stringify(data)}`);
      if (widgetWin && !widgetWin.isDestroyed()) widgetWin.webContents.send('usage:error', 'Could not read usage page');
    }
  } catch (e) {
    log(`poll error: ${e.stack || e.message}`);
    if (widgetWin && !widgetWin.isDestroyed()) widgetWin.webContents.send('usage:error', e.message);
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollOnce();
  pollTimer = setInterval(pollOnce, POLL_MS);
}

function createTray() {
  try {
    const icon = nativeImage.createEmpty();
    tray = new Tray(icon);
    tray.setToolTip('Claude Usage');
    const menu = Menu.buildFromTemplate([
      { label: 'Show widget', click: () => { if (widgetWin) widgetWin.show(); else createWidget(); } },
      { label: 'Refresh now', click: () => pollOnce() },
      { label: 'Sign out / switch account', click: async () => {
          await widgetSession().clearStorageData();
          if (widgetWin) widgetWin.close();
          createLogin();
        } },
      { type: 'separator' },
      { label: 'Quit', click: () => { app.quit(); } },
    ]);
    tray.setContextMenu(menu);
  } catch (e) { log(`tray failed: ${e.message}`); }
}

ipcMain.handle('usage:get', () => lastData);
ipcMain.on('widget:close', () => app.quit());
ipcMain.on('widget:refresh', () => pollOnce());

app.whenReady().then(async () => {
  log('app ready');
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
  e.preventDefault();
});
