'use strict';

// PodVet desktop entry point (Electron).
//
// The desktop shell is a thin, auto-updating wrapper around the live web app.
// It loads the hosted application (https://podvet.biztrack.uk) directly, so
// every website change reaches installed copies the moment it is deployed —
// there is no second desktop build to ship and no local database to sync.
// All data lives in the single VPS database, managed from one place.
//
// The shell itself (Chromium/Electron, menus, install plumbing) still updates
// through electron-updater: it downloads a new installer in the background and
// prompts the user to restart, then applies it on quit.
const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// Where the live app lives. Overridable for local testing. The desktop opens
// the application itself (login/app screens), not the marketing landing page.
const REMOTE_APP_URL = process.env.PODVET_REMOTE_URL || 'https://podvet.biztrack.uk/app';

const isDev = process.argv.includes('--dev') || process.env.NODE_ENV === 'development';

let mainWindow = null;
let splashWindow = null;

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
// Splash screen (shown until the hosted app loads)
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
// Main window
// ---------------------------------------------------------------------------
function remoteOrigin() {
  try { return new URL(REMOTE_APP_URL).origin; } catch { return 'https://podvet.biztrack.uk'; }
}

function createWindow() {
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
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Same-origin popups (PDF/print/report windows the app opens) stay inside
    // Electron; anything else goes to the user's default browser.
    let sameOrigin = false;
    try { sameOrigin = new URL(url).origin === remoteOrigin(); } catch (_) { /* not a URL */ }
    if (sameOrigin) return { action: 'allow' };
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    try {
      if (new URL(navigationUrl).origin === remoteOrigin()) return;
    } catch (_) { /* fall through */ }
    event.preventDefault();
    shell.openExternal(navigationUrl).catch(() => {});
  });

  mainWindow.webContents.on('did-finish-load', () => log('renderer loaded'));
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    log('renderer load failed:', code, desc, url);
    if (isMainFrame) showOffline();
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log('renderer gone:', details && details.reason);
    setTimeout(() => { if (mainWindow && !mainWindow.isDestroyed()) loadRemote(); }, 500);
  });

  mainWindow.once('ready-to-show', () => {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
    splashWindow = null;
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools();
  });

  mainWindow.on('close', (e) => { if (!app.isQuitting) log('main window close requested'); });
  mainWindow.on('closed', () => { log('main window closed'); mainWindow = null; });

  loadRemote();
}

function loadRemote() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.loadURL(REMOTE_APP_URL).catch((err) => {
    log('loadURL failed:', err);
    showOffline();
  });
}

function showOffline() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;background:#0f172a;color:#e2e8f0;font:15px/1.6 "Segoe UI",system-ui,sans-serif;
      display:flex;align-items:center;justify-content:center;-webkit-user-select:none;user-select:none}
    .card{max-width:440px;padding:44px 40px;text-align:center}
    h1{margin:0;font-size:24px}h1 span{color:#92caed}
    p{color:#94a3b8}
    button{margin-top:8px;padding:10px 22px;border:0;border-radius:10px;background:#92caed;color:#0f172a;
      font:600 14px inherit;cursor:pointer}
  </style></head><body><div class="card">
    <h1>Pod<span>Vet</span></h1>
    <p>We couldn't reach the PodVet server. Check your internet connection and try again.</p>
    <button onclick="location.href='${REMOTE_APP_URL}'">Retry</button>
  </div></body></html>`;
  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => {});
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
// build.publish). The installed shell pulls them back down here: check at
// startup and then every few hours, download in the background, and prompt the
// user to restart once the installer is on disk.
// ---------------------------------------------------------------------------
const UPDATE_FEED_URL = 'https://podvet.biztrack.uk/updates/';
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let autoUpdater = null;
let updateDownloaded = false;
let installingUpdate = false;

function emitUpdateEvent(payload) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-event', payload);
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
    // The window now loads the hosted app, so the in-page toast cannot reach
    // the Electron shell. Ask natively instead: the update installs on the next
    // quit regardless, so "Later" is always safe.
    promptInstallUpdate(info && info.version);
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

// The renderer's "Restart Now" button lands here in the old bundled-server
// build. The window now loads the hosted app, so this is only reachable if
// something invokes the RPC directly — installed updates otherwise apply via
// promptInstallUpdate() below.
async function restartAppToUpdate() {
  if (installingUpdate) return { success: true };
  if (!autoUpdater || !updateDownloaded) {
    return { success: false, message: 'No update has been downloaded yet.' };
  }
  installingUpdate = true;
  log('installing the downloaded update…');
  app.isQuitting = true;
  try {
    autoUpdater.quitAndInstall(false, true);
  } catch (err) {
    log('quitAndInstall failed:', err);
    installingUpdate = false;
    app.isQuitting = false;
    return { success: false, message: String((err && err.message) || err) };
  }
  return { success: true };
}

// Native restart prompt for the downloaded shell update.
function promptInstallUpdate(version) {
  if (installingUpdate) return;
  const detail = version
    ? `PodVet ${version} has been downloaded. Restart now to finish updating — or keep working and it will update automatically next time you close the app.`
    : 'A PodVet update has been downloaded. Restart now to finish updating — or keep working and it will update automatically next time you close the app.';
  const options = {
    type: 'info',
    title: 'PodVet update ready',
    message: 'Restart to update PodVet',
    detail,
    buttons: ['Restart Now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
  const show = mainWindow && !mainWindow.isDestroyed()
    ? dialog.showMessageBox(mainWindow, options)
    : dialog.showMessageBox(options);
  show.then(({ response }) => {
    if (response === 0) restartAppToUpdate();
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
app.whenReady().then(async () => {
  try {
    createSplash();

    const userData = app.getPath('userData');
    fs.mkdirSync(userData, { recursive: true });
    log(`PodVet ${app.getVersion()} starting (userData=${userData})`);
    log(`loading hosted app: ${REMOTE_APP_URL}`);

    setSplash('Loading PodVet…');
    buildMenu();
    createWindow();
    setupAutoUpdater();
  } catch (err) {
    failStartup(err);
  }
});

app.on('window-all-closed', () => {
  log('all windows closed');
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  app.isQuitting = true;
});
