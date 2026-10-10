// PodVet — standalone web edition. Pure Node/Express, no Electron runtime.
//
//   node index.js            # http://localhost:8080 (set WEB_PORT / PORT)
//
// The exact same React frontend (public/) and handler logic (handlers/*.js) as
// the desktop build. Handlers still call require('electron') for their tiny
// API surface (ipcMain.handle, app.getPath, ...) — but "electron" here is the
// local compat package at compat/electron-compat (npm file: dependency), a
// 100%-pure-Node stand-in that maps those calls onto this server's RPC/SSE
// plumbing. No Chromium process is ever launched.
const path = require('path');
const os = require('os');
const fs = require('fs');
const express = require('express');

const APP_VERSION = (() => {
  try { return require('./package.json').version || '0.0.0'; } catch { return '0.0.0'; }
})();

const WEB_PORT = Number(process.env.WEB_PORT || process.env.PORT || 8080);
const WEB_USER_DATA_DIR = path.resolve(
  process.env.WEB_USER_DATA_DIR ||
  path.join(os.homedir(), '.podvet'),
);
fs.mkdirSync(WEB_USER_DATA_DIR, { recursive: true });

// Same uploaded files the desktop app shows (clinic logo, form pages, pet
// reports) so branding/photo URLs resolve identically. Fall back to our own
// dir when the desktop install has never been run.
const DESKTOP_UPLOADS = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'PodVet (Pro)',
  'uploads',
);
const UPLOADS_DIR = fs.existsSync(DESKTOP_UPLOADS)
  ? DESKTOP_UPLOADS
  : path.join(WEB_USER_DATA_DIR, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Let server.js's /uploaded static point at the same dir the desktop exposes.
process.env.PODVET_UPLOADS_DIR = UPLOADS_DIR;

try { require('dotenv').config(); } catch (_) {}

// The electron-compat package (node_modules/electron -> compat/electron-compat).
const electron = require('electron');
const { __web } = electron;
const { rpcChannels, sseClients, sseSend, setDialogFilePath } = __web;

const { app, startServer } = require('./server');

// Point saasClient at ourselves so every /api/* call stays same-origin.
process.env.SAAS_API_BASE_URL = process.env.SAAS_API_BASE_URL_OVERRIDE ||
  `http://localhost:${WEB_PORT}`;

// A tiny electron-store-compatible JSON store (get/set/delete).
class JsonStore {
  constructor(file) {
    this.file = file;
    this.data = {};
    try { this.data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
  }
  get(key, def) {
    const has = Object.prototype.hasOwnProperty.call(this.data, key);
    return has ? this.data[key] : def;
  }
  set(key, value) {
    this.data[key] = value;
    this._flush();
  }
  delete(key) {
    delete this.data[key];
    this._flush();
  }
  _flush() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}
const store = new JsonStore(path.join(WEB_USER_DATA_DIR, 'web-store.json'));

// Rewrite desktop-persisted http://localhost:<port>/... URLs (clinic logo,
// uploaded docs, forms) so the web app is self-contained: they become
// origin-relative paths served by THIS server, regardless of which port the
// desktop originally used (4000 in the API era, 8080 in the web-server era).
{
  const localPort = /^https?:\/\/localhost:\d+\//i;
  function rewriteValue(value) {
    if (typeof value === 'string') return value.replace(localPort, '/');
    if (Array.isArray(value)) {
      if (value.length > 2000 && value.every((v) => typeof v === 'number')) return value;
      for (let i = 0; i < value.length; i++) value[i] = rewriteValue(value[i]);
      return value;
    }
    if (value && typeof value === 'object') {
      for (const k of Object.keys(value)) value[k] = rewriteValue(value[k]);
      return value;
    }
    return value;
  }
  const expressResponseJson = express.response.json;
  app.response.json = function (body) {
    if (body && typeof body === 'object') body = rewriteValue(body);
    return expressResponseJson.call(this, body);
  };
}

// ── Handlers — same setup list as the desktop's main.js ─────────────────────
const setupAuthHandlers = require('./handlers/authHandlers');
const setupEmployeesHandlers = require('./handlers/employeesHandlers');
const setupClinicUsersHandlers = require('./handlers/clinicUsersHandlers');
const setupFormsHandlers = require('./handlers/formsHandlers');
const setupBranchesHandlers = require('./handlers/branchesHandlers');
const setupSubscriptionHandlers = require('./handlers/subscriptionHandlers');
const setupPaymentSubmissionHandlers = require('./handlers/paymentSubmissionHandlers');
const setupClientsHandlers = require('./handlers/clientsHandlers');
const setupPetsHandlers = require('./handlers/petsHandlers');
const setupServicesHandlers = require('./handlers/servicesHandlers');
const setupClientBillingHandlers = require('./handlers/clientBillingHandlers');
const setupProductsHandlers = require('./handlers/productsHandlers');
const setupVendorsHandlers = require('./handlers/vendorsHandlers');
const setupBillingHandlers = require('./handlers/billingHandlers');
const setupSettingsHandlers = require('./handlers/settingsHandlers');
const setupPaymentsHandlers = require('./handlers/paymentsHandlers');
const setupAppointmentProductsHandlers = require('./handlers/appointmentProductsHandlers');
const setupAppointmentsHandlers = require('./handlers/appointmentsHandlers');
const setupReportsHandlers = require('./handlers/reportsHandlers');
const setupRemindersHandlers = require('./handlers/remindersHandlers');
const setupReminderNotifications = require('./handlers/reminderNotifications');
const setupExpensesHandlers = require('./handlers/expensesHandlers');
const setupRecordHandlers = require('./handlers/recordHandlers');
const setupDataManagementHandlers = require('./handlers/dataManagementHandlers');
const setupBoardingHandlers = require('./handlers/boardingHandlers');
const setupAiProductHandlers = require('./handlers/ai/productHandler');
const setupSoapTextHandlers = require('./handlers/ai/soapTextHandler');

setupAuthHandlers(store);
setupEmployeesHandlers();
setupClinicUsersHandlers();
setupFormsHandlers();
setupBranchesHandlers();
setupSubscriptionHandlers();
setupPaymentSubmissionHandlers();
setupClientsHandlers();
setupPetsHandlers();
setupRecordHandlers();
setupRemindersHandlers();
setupServicesHandlers();
setupProductsHandlers();
setupVendorsHandlers();
setupBillingHandlers(store);
setupAppointmentProductsHandlers();
setupAppointmentsHandlers(store);
setupPaymentsHandlers(store);
setupClientBillingHandlers(store);
setupSettingsHandlers(store);
setupExpensesHandlers(store);
setupReportsHandlers();
setupDataManagementHandlers();
setupBoardingHandlers(store);
setupAiProductHandlers();
setupSoapTextHandlers();

setupReminderNotifications(store, () => __web.createWindowFacade());

// Web edition: nothing to restart into, so the channel is a no-op stub. main.js
// (desktop) overwrites it with the real electron-updater install once this
// module has loaded, so only fill it in when nobody has claimed it yet.
if (!rpcChannels.has('restart-app-to-update')) {
  rpcChannels.set('restart-app-to-update', async () => ({ success: true }));
}

// ── Web routes (kept off /api/* so the catch-all in server.js never swallows)
const { generateWebPreload, serializeRpcResult } = require('./lib/web-preload');

// ── Authentication for the browser RPC surface ──────────────────────────────
//
// /_rpc/:channel used to look up the handler and run it, full stop. The
// handlers authorise against whatever session sits in the on-disk store, so an
// anonymous visitor who had never signed in could:
//
//   * read the clinic owner back from `resume-session`,
//   * fetch that owner's live access + refresh tokens from `__get-tokens`,
//   * call all 256 data channels - records, boarding, billing, payments,
//     patients, clients, employees, expenses, data export,
//   * and, through the `req.body.session` re-injection below, get a `user`
//     object of their own choosing written into the store as the session
//     user. That last one is self-promotion to admin.
//
// The browser already keeps its access token in localStorage, so it can prove
// who it is. The token is now checked against the real backend before any
// handler runs, and only the channels that genuinely have to work before
// sign-in are left open.

const crypto = require('crypto');

// The only four things a signed-out visitor is allowed to ask for.
const PRE_AUTH_CHANNELS = new Set([
  'login',
  'clinic-signup',
  'forgot-password',
  'reset-password',
]);

const TOKEN_VERIFY_TTL_MS = 60_000;
const MAX_VERIFIED_TOKENS = 500;
const verifiedTokens = new Map();

// The token currently loaded into the store, so a busy page does not rewrite
// web-store.json on every single RPC. JsonStore flushes to disk synchronously.
let activeSession = { accessToken: null, refreshToken: null, user: null };

function tokenFingerprint(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

async function verifyAccessToken(token) {
  if (!token) return { ok: false, reason: 'no token presented' };

  const key = tokenFingerprint(token);
  const hit = verifiedTokens.get(key);
  if (hit && hit.until > Date.now()) return hit.verdict;

  let verdict;
  try {
    const res = await fetch(`${process.env.SAAS_API_BASE_URL}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const data = await res.json();
      verdict = { ok: true, user: data.user || null, activeClinic: data.activeClinic || null };
    } else {
      verdict = { ok: false, reason: `token rejected (HTTP ${res.status})` };
    }
  } catch (err) {
    // The backend being briefly unreachable is not the same as being signed
    // out. Fail closed but say so, so the app can retry rather than dump a
    // clinic out of their own records because a socket blipped.
    return { ok: false, reason: 'auth service unreachable', transient: true };
  }

  if (verifiedTokens.size > MAX_VERIFIED_TOKENS) verifiedTokens.clear();
  verifiedTokens.set(key, { verdict, until: Date.now() + TOKEN_VERIFY_TTL_MS });
  return verdict;
}

// A clinic left open all day should not be logged out just because its access
// token aged out, and a valid refresh token is a legitimate credential - so an
// expired access token gets one chance to be exchanged rather than dropped.
async function refreshWithToken(refreshToken) {
  try {
    const res = await fetch(`${process.env.SAAS_API_BASE_URL}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.accessToken) return null;
    return data;
  } catch (_) {
    return null;
  }
}

app.post('/_rpc/:channel', async (req, res) => {
  const channel = req.params.channel;
  const handler = rpcChannels.get(channel);
  if (!handler) {
    return res.status(404).json({ ok: false, error: { message: `Unknown channel: ${channel}` } });
  }
  if (req.body && req.body.dialogFilePath) {
    setDialogFilePath(req.body.dialogFilePath);
  }

  const presented = (req.body && req.body.session && req.body.session.tokens) || null;
  let accessToken = presented && presented.accessToken;
  let refreshToken = presented && presented.refreshToken;
  // Set only when the pair was exchanged, so the browser can update the copy
  // it keeps in localStorage. Empty on every normal call.
  let rotated = null;

  // login / signup mint the session themselves - there is nothing to verify
  // yet, and blocking them would leave nobody able to sign in at all.
  if (!PRE_AUTH_CHANNELS.has(channel)) {
    let verdict = await verifyAccessToken(accessToken);

    if (!verdict.ok && !verdict.transient && refreshToken) {
      const fresh = await refreshWithToken(refreshToken);
      if (fresh) {
        accessToken = fresh.accessToken;
        refreshToken = fresh.refreshToken;
        rotated = { accessToken, refreshToken };
        verdict = await verifyAccessToken(accessToken);
      }
    }

    if (!verdict.ok) {
      if (verdict.transient) {
        return res.status(503).json({
          ok: false,
          error: { code: 'AUTH_UNAVAILABLE', message: 'Could not verify your session. Please try again.' },
        });
      }
      return res.status(401).json({
        ok: false,
        error: { code: 'UNAUTHORIZED', message: 'Please sign in to continue.' },
      });
    }

    // Only the token that was just verified goes into the store, and the
    // session user comes from the backend's answer about that token - never
    // from the request body, which is how a caller could appoint themselves.
    if (activeSession.accessToken !== accessToken) {
      store.set('saasTokens', { accessToken, refreshToken, encrypted: false });
      if (verdict.user) {
        store.set('saasSession', { user: verdict.user, activeClinic: verdict.activeClinic });
        store.set('user', setupAuthHandlers.toLocalUser(verdict));
      }
      activeSession = { accessToken, refreshToken, user: verdict.user };
    }
  }

  let args = (req.body && req.body.args) || [];
  try {
    const result = await handler({}, ...args);
    const payload = { ok: true, result: result === undefined ? null : serializeRpcResult(result) };
    if (rotated) payload.session = { tokens: rotated };
    res.json(payload);
  } catch (err) {
    res.json({ ok: false, error: { message: (err && err.message) || String(err) } });
  }
});

// The push stream carried the same identity signals as the RPC surface
// (session-expired, subscription-blocked, branding-changed, navigate-to) and
// accepted any caller, so it gets the same token check. EventSource cannot set
// an Authorization header, hence the query parameter - the token still only
// ever travels to this one origin, over the same TLS connection as the app.
app.get('/events', async (req, res) => {
  const verdict = await verifyAccessToken(req.query && req.query.t);
  if (!verdict.ok) {
    res.writeHead(verdict.transient ? 503 : 401, { 'Content-Type': 'text/plain' });
    res.end(verdict.transient ? 'auth service unavailable' : 'sign in required');
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  sseClients.add(res);
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { clearInterval(heartbeat); }
  }, 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

app.post('/web-upload', (req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    try {
      const rawName = (req.headers['x-filename'] || 'upload').replace(/[^\w.\- ]+/g, '');
      const fileName = `${Date.now()}-${rawName}`;
      const filePath = path.join(UPLOADS_DIR, fileName);
      fs.writeFileSync(filePath, Buffer.concat(chunks));
      res.json({ ok: true, path: filePath, fileName });
    } catch (err) {
      res.json({ ok: false, error: { message: err.message } });
    }
  });
});

app.get('/serve-file', (req, res) => {
  const p = String(req.query.path || '');
  const full = path.resolve(p);
  const allowedRoots = [
    path.resolve(WEB_USER_DATA_DIR),
    os.tmpdir(),
    path.join(os.homedir(), 'Documents'),
    path.join(os.homedir(), 'Downloads'),
    path.join(os.homedir(), 'Desktop'),
    DESKTOP_UPLOADS,
  ];
  const underAllowed = allowedRoots.some((root) => full === root || full.startsWith(root + path.sep));
  if (!underAllowed) {
    return res.status(403).json({ ok: false, error: { message: 'Refused to serve that path' } });
  }
  if (!fs.existsSync(full)) return res.status(404).json({ ok: false, error: { message: 'File not found' } });
  if (req.query.inline === '1' || req.query.inline === 'true') {
    res.setHeader('Content-Disposition', 'inline');
    return res.sendFile(full);
  }
  res.download(full);
});

// ── Frontend (static dist + generated preload + pickers) ────────────────────
const DIST_DIR = path.join(__dirname, 'public');
const webPreload = generateWebPreload();

const themePickerSource = fs.readFileSync(path.join(__dirname, 'theme-picker.js'), 'utf8');
const colorPickerSource = fs.readFileSync(path.join(__dirname, 'color-picker.js'), 'utf8');
const mobileUxSource = fs.readFileSync(path.join(__dirname, 'mobile-ux.js'), 'utf8');
const clinicBrandingSource = fs.readFileSync(path.join(__dirname, 'clinic-branding.js'), 'utf8');
const alertsClientSource = (() => {
  try { return fs.readFileSync(path.join(__dirname, 'alerts-client.js'), 'utf8'); }
  catch { return '/* alerts-client.js missing */'; }
})();

// The clinic app is served as-is at /app (and every SPA route, via the catch-all
// below). Its own screens decide auth: signed-out visitors get the app's real
// login page, which the backend also uses to sign platform staff in and hand
// them over to /super-admin. No injected guard, so the native login renders.
function buildWebIndexHtml() {
  const raw = fs.readFileSync(path.join(DIST_DIR, 'index.html'), 'utf8');
  // clinic-branding.js comes first and is deferred: deferred scripts and
  // module scripts run in document order, so it publishes window.__pvBrand
  // before the app bundle's first render reads it — that is what makes the very
  // first paint show the clinic's logo, name and colour instead of the
  // platform's.
  const inject = '\n    <script>window.__pvVersion=' + JSON.stringify(APP_VERSION) + ';</script>\n    <script src="/web-preload.js"></script>\n    <script src="/clinic-branding.js" defer></script>\n    <script src="/color-picker.js" defer></script>\n    <script src="/theme-picker.js" defer></script>\n    <script src="/mobile-ux.js" defer></script>\n    <script src="/referral-scan.js" defer></script>\n    <script src="/alerts-client.js" defer></script>\n  ';
  return raw.replace('<head>', '<head>\n    ' + inject);
}
const webIndexHtml = buildWebIndexHtml();
const landingHtml = fs.readFileSync(path.join(__dirname, 'landing.html'), 'utf8');

app.get('/web-preload.js', (req, res) => {
  res.type('application/javascript').send(webPreload.source);
});
app.get('/color-picker.js', (req, res) => {
  res.type('application/javascript').send(colorPickerSource);
});
app.get('/clinic-branding.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.type('application/javascript').send(clinicBrandingSource);
});
app.get('/alerts-client.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.type('application/javascript').send(alertsClientSource);
});
app.get('/theme-picker.js', (req, res) => {
  res.type('application/javascript').send(themePickerSource);
});
app.get('/mobile-ux.js', (req, res) => {
  res.type('application/javascript').send(mobileUxSource);
});
app.get('/color-picker.html', (req, res) => {
  res.type('text/html').send(fs.readFileSync(path.join(__dirname, 'color-picker.html'), 'utf8'));
});
app.get('/', (req, res) => {
  res.type('text/html').send(landingHtml);
});
app.get('/app', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.type('text/html').send(webIndexHtml);
});

// The one login page is the clinic app's own login screen, available at /app.
app.get('/login', (req, res) => res.redirect('/app'));

// ── Public markdown & brochure pages (served without file extension) ─
const PUBLIC_PAGES = path.join(__dirname, 'public');
const staticPageCache = {};
const STATIC_PAGE_ROUTES = ['about', 'contact', 'faq', 'privacy', 'terms', 'blog', 'demo', 'docs', 'help'];
for (const page of STATIC_PAGE_ROUTES) {
  staticPageCache[page] = fs.readFileSync(path.join(PUBLIC_PAGES, `${page}.html`), 'utf8');
  app.get(`/${page}`, (req, res) => {
    res.type('text/html').send(staticPageCache[page]);
  });
}
app.get('/blog/:slug', (req, res) => {
  try {
    const slug = req.params.slug.replace(/\.html$/, '');
    const html = fs.readFileSync(path.join(PUBLIC_PAGES, 'blog', `${slug}.html`), 'utf8');
    return res.type('text/html').send(html);
  } catch {
    return res.redirect('/blog');
  }
});
app.get('/features/:slug', (req, res) => {
  try {
    const slug = req.params.slug.replace(/\.html$/, '');
    if (!/^[a-z-]+$/.test(slug)) return res.redirect('/demo');
    const html = fs.readFileSync(path.join(PUBLIC_PAGES, 'features', `${slug}.html`), 'utf8');
    return res.type('text/html').send(html);
  } catch {
    return res.redirect('/demo');
  }
});
// Audience pages (solo practitioners, midsized clinics, hospitals…) mirror the
// /features/:slug handling; the generated pages live in public/solutions.
app.get('/solutions/:slug', (req, res) => {
  try {
    const slug = req.params.slug.replace(/\.html$/, '');
    if (!/^[a-z-]+$/.test(slug)) return res.redirect('/demo');
    const html = fs.readFileSync(path.join(PUBLIC_PAGES, 'solutions', `${slug}.html`), 'utf8');
    return res.type('text/html').send(html);
  } catch {
    return res.redirect('/demo');
  }
});

// ── Platform Super Admin (separate app + separate /api/super-admin namespace) ─
const SUPER_ADMIN_DIR = path.join(__dirname, 'public', 'super-admin');
const superAdminHtml = fs.readFileSync(path.join(SUPER_ADMIN_DIR, 'index.html'), 'utf8');
app.get('/super-admin', (req, res) => {
  res.type('text/html').send(superAdminHtml);
});
app.use('/super-admin', express.static(SUPER_ADMIN_DIR));
app.get('/super-admin/{*splat}', (req, res) => {
  res.type('text/html').send(superAdminHtml);
});

// ── Customer Portal (separate SPA, same origin) ─────────────────────────────
// Registered before the generic static/catch-all so /portal/* is not answered
// with the clinic app's index.html.
const PORTAL_DIR = path.join(__dirname, 'public', 'portal');
const portalHtml = (() => {
  try { return fs.readFileSync(path.join(PORTAL_DIR, 'index.html'), 'utf8'); }
  catch { return '<!doctype html><title>Portal</title><h1>Portal not built</h1>'; }
})();
app.use('/portal', express.static(PORTAL_DIR));
app.get('/portal/{*splat}', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.type('text/html').send(portalHtml);
});

app.use('/assets', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.static(DIST_DIR));
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/') && !req.path.startsWith('/_rpc/')) {
    res.setHeader('Cache-Control', 'no-store');
    return res.type('text/html').send(webIndexHtml);
  }
  next();
});

if (!process.versions.electron) {
  startServer(WEB_PORT).then(() => {
    console.log(`PodVet running at http://localhost:${WEB_PORT}`);
    console.log(`  data dir: ${WEB_USER_DATA_DIR}`);
    console.log(`  login with any account on the embedded backend (e.g. admin / admin123)`);
  });
} else {
  // When run under Electron, start server but don't log to console in same way
  startServer(WEB_PORT).catch(err => {
    console.error('Server start failed:', err);
  });
}