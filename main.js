'use strict';

// PodVet desktop entry point (Electron).
//
// The app is the same Express server the web edition runs (index.js), just
// served into a BrowserWindow instead of a browser tab. The renderer talks to
// the server over the injected /web-preload.js transport (HTTP /_rpc + SSE
// /events), so the main process only has to bridge the small electron surface
// the handlers expect (rpcChannels, sse fan-out, dialog paths) onto the real
// ipcMain/BrowserWindow — see injectWebBridge() below.
//
// MySQL ships with the installer (resources/mysql) and is bootstrapped into
// the per-user data dir before the server starts, so the finished install
// works completely offline with no external database.
const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');

const bundledMysql = require('./lib/bundledMysql');

const isDev = process.argv.includes('--dev') || process.env.NODE_ENV === 'development';

let mainWindow = null;
let splashWindow = null;
let stoppingMysql = false;

// ---------------------------------------------------------------------------
// Logging — a packaged Windows app has no console, so mirror everything we
// care about into <userData>/main.log for support/debugging.
// ---------------------------------------------------------------------------
let logDir = null;
function log(...args) {
  const line = args.map((a) => (typeof a === 'string' ? a : require('util').inspect(a, { depth: 4 }))).join(' ');
  console.log(line);
  try {
    if (!logDir) logDir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, 'main.log'), `${new Date().toISOString()} ${line}\n`);
  } catch (_) { /* logging must never break startup */ }
}
process.on('uncaughtException', (err) => log('uncaughtException:', err));
process.on('unhandledRejection', (err) => log('unhandledRejection:', err));

// ---------------------------------------------------------------------------
// Single instance
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

if (process.platform === 'win32') {
  app.setAppUserModelId('com.podvet.desktop');
}

// ---------------------------------------------------------------------------
// The electron <-> web bridge.
//
// index.js reads electron.__web (rpcChannels/sseClients/sseSend/…) and the
// handlers register with ipcMain.handle — but the renderer calls them over
// HTTP /_rpc, which looks them up in rpcChannels. So we register into both,
// and we route anything that pushes to a window (saasClient's session-expired
// broadcasts, reminder notifications) through the SSE fan-out the renderer
// actually listens on.
// ---------------------------------------------------------------------------
function injectWebBridge() {
  const rpcChannels = new Map();
  const sseClients = new Set();

  function sseSend(channel, payload) {
    const data = JSON.stringify(payload === undefined ? {} : payload);
    for (const res of sseClients) {
      try { res.write(`event: ${channel}\ndata: ${data}\n\n`); } catch (_) { /* client went away */ }
    }
  }

  let dialogFilePath = null;

  function createWindowFacade() {
    return {
      webContents: {
        send(channel, ...args) {
          sseSend(channel, args.length === 0 ? undefined : args.length === 1 ? args[0] : args);
        },
        once() {},
        on() {},
        print(_opts, cb) { if (typeof cb === 'function') cb(true, ''); },
      },
      loadURL: async () => {},
      loadFile: async () => {},
      close() {},
      hide() {},
      show() {},
      focus() {},
      restore() {},
      isMinimized: () => false,
      on() {},
      once() {},
    };
  }

  const electron = require('electron');

  electron.__web = {
    rpcChannels,
    sseClients,
    sseSend,
    setDialogFilePath(p) { dialogFilePath = p || null; },
    getDialogFilePath: () => dialogFilePath,
    createWindowFacade,
    userDataDir: app.getPath('userData'),
  };

  // Dual-register RPC handlers: real ipcMain (harmless) + the HTTP registry.
  const origHandle = electron.ipcMain.handle.bind(electron.ipcMain);
  electron.ipcMain.handle = (channel, fn) => {
    rpcChannels.set(channel, fn);
    try { return origHandle(channel, fn); } catch (_) { return undefined; }
  };
  const origRemoveHandler = electron.ipcMain.removeHandler.bind(electron.ipcMain);
  electron.ipcMain.removeHandler = (channel) => {
    rpcChannels.delete(channel);
    try { origRemoveHandler(channel); } catch (_) { /* not registered */ }
  };

  // The web preload turns open-file-dialog / scan-products-csv /
  // pick-logo-file-select into an upload first and stores the resulting path
  // here; when the handler then asks for a "picked" file, hand that back.
  // Anything else falls through to a real native picker (an upgrade over the
  // web build, which has no OS dialog at all).
  const origOpenDialog = electron.dialog.showOpenDialog.bind(electron.dialog);
  const origSaveDialog = electron.dialog.showSaveDialog.bind(electron.dialog);
  electron.dialog.showOpenDialog = async (a, b) => {
    if (dialogFilePath) {
      const picked = dialogFilePath;
      dialogFilePath = null;
      return { canceled: false, filePaths: [picked] };
    }
    const opts = b || a || {};
    try {
      return mainWindow && !mainWindow.isDestroyed()
        ? await origOpenDialog(mainWindow, opts)
        : await origOpenDialog(opts);
    } catch (err) {
      log('showOpenDialog failed:', err);
      return { canceled: true, filePaths: [] };
    }
  };
  electron.dialog.showSaveDialog = async (a, b) => {
    const opts = b || a || {};
    try {
      return mainWindow && !mainWindow.isDestroyed()
        ? await origSaveDialog(mainWindow, opts)
        : await origSaveDialog(opts);
    } catch (err) {
      log('showSaveDialog failed:', err);
      return { canceled: true };
    }
  };

  return { sseSend, createWindowFacade, rpcChannels };
}

// ---------------------------------------------------------------------------
// Splash screen (shown while MySQL bootstraps / server starts)
// ---------------------------------------------------------------------------
const SPLASH_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:#0f172a;color:#e2e8f0;font:15px/1.5 "Segoe UI",system-ui,sans-serif;
    display:flex;align-items:center;justify-content:center;-webkit-user-select:none;user-select:none}
  .card{width:420px;padding:44px 40px;text-align:center}
  h1{margin:0;font-size:28px;letter-spacing:.5px;font-weight:600}
  h1 span{color:#92caed}
  .sub{margin-top:6px;color:#64748b;font-size:13px}
  .ring{width:44px;height:44px;margin:30px auto 8px;border:3px solid #1e293b;border-top-color:#92caed;
    border-radius:50%;animation:spin 1s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  #status{min-height:22px;color:#94a3b8;font-size:13px}
  #err{display:none;color:#fca5a5;font-size:12px;white-space:pre-wrap;text-align:left;margin-top:14px}
</style></head>
<body><div class="card">
  <h1>Pod<span>Vet</span></h1>
  <div class="sub">Veterinary Management System</div>
  <div class="ring"></div>
  <div id="status">Starting…</div>
  <div id="err"></div>
</div>
<script>
  window.setStatus = function (msg) { document.getElementById('status').textContent = msg; };
  window.setError = function (msg) {
    var e = document.getElementById('err'); e.style.display = 'block'; e.textContent = msg;
    document.querySelector('.ring').style.animation = 'none';
    document.querySelector('.ring').style.borderTopColor = '#ef4444';
  };
</script></body></html>`;

function createSplash() {
  splashWindow = new BrowserWindow({
    width: 520,
    height: 360,
    frame: false,
    resizable: false,
    center: true,
    backgroundColor: '#0f172a',
    show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  splashWindow.on('closed', () => { splashWindow = null; });
  splashWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(SPLASH_HTML)}`);
}

function setSplash(message) {
  log('startup:', message);
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents
      .executeJavaScript(`window.setStatus(${JSON.stringify(message)})`)
      .catch(() => { /* splash gone */ });
  }
}

function failStartup(err) {
  const text = err && err.stack ? err.stack : String(err);
  log('STARTUP FAILED:', text);
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.executeJavaScript(`window.setError(${JSON.stringify(String(err && err.message || err))})`).catch(() => {});
  }
  setTimeout(() => {
    dialog.showErrorBox('PodVet failed to start', `${err && err.message ? err.message : err}\n\nDetails were written to:\n${logDir || 'the logs folder'}`);
    app.quit();
  }, 400);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function findFreePort(start, end) {
  return new Promise((resolve) => {
    let port = start;
    const attempt = () => {
      if (port > end) return resolve(0);
      const server = net.createServer();
      server.once('error', () => { port += 1; attempt(); });
      server.once('listening', () => server.close(() => resolve(port)));
      server.listen(port, '127.0.0.1');
    };
    attempt();
  });
}

function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(); });
      socket.once('error', () => {
        if (Date.now() > deadline) reject(new Error(`The application server did not come up on port ${port}.`));
        else setTimeout(attempt, 400);
      });
    };
    attempt();
  });
}

// ---------------------------------------------------------------------------
// Main window
// ---------------------------------------------------------------------------
function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1180,
    minHeight: 760,
    show: false,
    backgroundColor: '#0f172a',
    title: 'PodVet',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // No preload file: the server injects lib/web-preload.js into the HTML,
      // which is the same transport the web edition uses.
    },
  });

  // Anything that pushes to a real window (saasClient broadcasts, notifications)
  // must also reach the renderer over SSE — that's the channel it listens on.
  const origSend = mainWindow.webContents.send.bind(mainWindow.webContents);
  mainWindow.webContents.send = (channel, ...args) => {
    try { origSend(channel, ...args); } catch (_) { /* no real listeners */ }
    try {
      bridge.sseSend(channel, args.length === 0 ? undefined : args.length === 1 ? args[0] : args);
    } catch (e) { log('sseSend failed:', e); }
  };

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`http://127.0.0.1:${port}`) || url.startsWith(`http://localhost:${port}`)) {
      return { action: 'allow' };
    }
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    try {
      const target = new URL(navigationUrl);
      const own = new URL(`http://127.0.0.1:${port}`);
      if (target.origin === own.origin) return;
    } catch (_) { /* fall through */ }
    event.preventDefault();
    shell.openExternal(navigationUrl).catch(() => {});
  });

  mainWindow.webContents.on('did-finish-load', () => log('renderer loaded'));
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => log('renderer load failed:', code, desc));

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log('renderer gone:', details && details.reason);
    setTimeout(() => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload(); }, 500);
  });

  mainWindow.once('ready-to-show', () => {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
    splashWindow = null;
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools();
  });

  mainWindow.on('close', (e) => { if (!app.isQuitting) log('main window close requested'); });
  mainWindow.on('closed', () => { log('main window closed'); mainWindow = null; });

  mainWindow.loadURL(`http://127.0.0.1:${port}/`).catch((err) => {
    log('loadURL failed:', err);
    failStartup(err);
  });
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Reload',
          accelerator: 'F5',
          click: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload(); },
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About PodVet',
          click: () => {
            const options = {
              type: 'info',
              title: 'About PodVet',
              message: 'PodVet',
              detail: `Version: ${app.getVersion()}\n\nVeterinary Management System\nCopyright © 2026 PodVet`,
            };
            if (mainWindow && !mainWindow.isDestroyed()) dialog.showMessageBox(mainWindow, options);
            else dialog.showMessageBox(options);
          },
        },
        { type: 'separator' },
        { label: 'Visit Website', click: () => { shell.openExternal('https://podvet.com').catch(() => {}); } },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// Auto-update
//
// electron-builder writes latest.yml + the installer into dist/; scripts/
// release.ps1 pushes them onto the website's /updates feed (package.json
// build.publish). The installed copy pulls them back down here: check at
// startup and then every few hours, download in the background, and tell the
// renderer over the 'update-event' channel its update toast already listens
// on ('available' while downloading, 'ready' once the installer is on disk).
// ---------------------------------------------------------------------------
const UPDATE_FEED_URL = 'https://podvet.biztrack.uk/updates/';
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let autoUpdater = null;
let updateDownloaded = false;
let installingUpdate = false;

function emitUpdateEvent(payload) {
  try {
    // The window's send() is patched in createWindow() to fan out over SSE
    // as well, which is the transport this renderer actually listens on.
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-event', payload);
    else if (bridge) bridge.sseSend('update-event', payload);
  } catch (err) {
    log('update-event delivery failed:', err);
  }
}

function setupAutoUpdater() {
  if (!app.isPackaged || isDev) return;

  try {
    autoUpdater = require('electron-updater').autoUpdater;
  } catch (err) {
    log('auto-updater unavailable:', err && err.message || err);
    return;
  }

  try {
    autoUpdater.setFeedURL({ provider: 'generic', url: UPDATE_FEED_URL });
  } catch (err) {
    log('setFeedURL failed:', err && err.message || err);
  }
  autoUpdater.autoDownload = true;
  // Dismissing the "Restart Now" toast still installs the update on the next
  // quit, so nobody has to click anything to stay current.
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (...a) => log('updater:', ...a),
    warn: (...a) => log('updater:', ...a),
    error: (...a) => log('updater:', ...a),
    debug: () => {},
  };

  autoUpdater.on('update-available', (info) => {
    log(`updater: v${info && info.version} is available`);
    emitUpdateEvent({ status: 'available', version: info && info.version });
  });
  autoUpdater.on('update-not-available', () => log('updater: already on the latest version'));
  autoUpdater.on('download-progress', (p) => log(`updater: downloading ${Math.round((p && p.percent) || 0)}%`));
  autoUpdater.on('update-downloaded', (info) => {
    updateDownloaded = true;
    log(`updater: v${info && info.version} downloaded, waiting for restart`);
    emitUpdateEvent({ status: 'ready', version: info && info.version });
  });
  autoUpdater.on('error', (err) => log('updater error:', (err && err.stack) || err));

  const check = () => {
    log('updater: checking for updates');
    autoUpdater.checkForUpdates().catch((err) => log('updater: check failed:', (err && err.message) || err));
  };
  // Start a little late: the app shell (and its toast) has to be mounted
  // before a 'ready' event has anywhere to go.
  setTimeout(check, 20000);
  setInterval(check, UPDATE_CHECK_INTERVAL_MS);
}

// The renderer's "Restart Now" button lands here. NSIS cannot replace the
// bundled MySQL binaries under resources/mysql while mysqld is alive, so the
// database is shut down before the updater spawns the installer, and the
// before-quit hook skips its own stop (stoppingMysql is already set).
async function restartAppToUpdate() {
  if (installingUpdate) return { success: true };
  if (!autoUpdater || !updateDownloaded) {
    return { success: false, message: 'No update has been downloaded yet.' };
  }
  installingUpdate = true;
  log('installing the downloaded update…');
  app.isQuitting = true;
  stoppingMysql = true;
  try {
    await bundledMysql.stop();
  } catch (err) {
    log('database stop before update failed:', err);
  }
  try {
    autoUpdater.quitAndInstall(false, true);
  } catch (err) {
    log('quitAndInstall failed:', err);
    installingUpdate = false;
    stoppingMysql = false;
    app.isQuitting = false;
    return { success: false, message: String((err && err.message) || err) };
  }
  return { success: true };
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
let bridge = null;

app.whenReady().then(async () => {
  try {
    createSplash();

    const userData = app.getPath('userData');
    fs.mkdirSync(userData, { recursive: true });
    log(`PodVet ${app.getVersion()} starting (userData=${userData})`);

    // Environment must be in place BEFORE require('./index'): dotenv will not
    // override values that are already set, and index.js/server.js read them
    // at module load.
    process.env.WEB_USER_DATA_DIR = userData;
    const port = await findFreePort(8080, 8179);
    if (!port) throw new Error('No free HTTP port available for PodVet (8080-8179 all busy).');
    process.env.WEB_PORT = String(port);
    delete process.env.SAAS_API_BASE_URL;
    delete process.env.SAAS_API_BASE_URL_OVERRIDE;

    bridge = injectWebBridge();

    setSplash('Starting database…');
    const db = await bundledMysql.start({
      userDataDir: userData,
      schemaFile: path.join(__dirname, 'db', 'schema.sql'),
      log: setSplash,
    });
    process.env.DB_HOST = db.host;
    process.env.DB_PORT = String(db.port);
    process.env.DB_USER = db.user;
    process.env.DB_PASSWORD = db.password;
    process.env.DB_NAME = 'podvet';
    log(`database ready on 127.0.0.1:${db.port}`);

    setSplash('Starting application server…');
    require('./index'); // starts the Express server (auto-start branch)

    // index.js registers a no-op stub for this channel because the web edition
    // has no installer to launch — the real handler only wins because it is
    // installed after the server module has loaded.
    bridge.rpcChannels.set('restart-app-to-update', restartAppToUpdate);

    await waitForPort(port, 60000);
    setSplash('Loading PodVet…');

    buildMenu();
    createWindow(port);
    setupAutoUpdater();
    log(`ready on http://127.0.0.1:${port}`);
  } catch (err) {
    failStartup(err);
  }
});

app.on('window-all-closed', () => {
  log('all windows closed');
  if (process.platform !== 'darwin') app.quit();
});

// Shut the bundled MySQL down cleanly on quit (no InnoDB recovery next time).
app.on('before-quit', (event) => {
  if (stoppingMysql) return;
  app.isQuitting = true;
  stoppingMysql = true;
  event.preventDefault();
  log('stopping database…');
  Promise.resolve()
    .then(() => bundledMysql.stop())
    .catch((err) => log('database stop failed:', err))
    .finally(() => {
      log('shutdown complete');
      app.quit();
    });
});
