const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { AsyncLocalStorage } = require('async_hooks');
const { ensureSuperAdminSchema, bootstrapSuperAdmin, registerSuperAdmin, authenticatePlatformAdmin } = require('./lib/superAdmin');
const { registerSuperAdminExt } = require('./lib/superAdminExt');
const { sendMail } = require('./lib/mailer');
const registerPortalApi = require('./lib/portalApi');

// SSE fan-out lives in the electron-compat shim (shared with the web server via
// its __web export). Wrapped so the module still loads under a real Electron
// runtime / a unit test that never pulled the compat in.
let sseSend = () => {};
try { const __w = require('electron').__web; if (__w && typeof __w.sseSend === 'function') sseSend = __w.sseSend; } catch (_) { /* no compat */ }

// Subscription policy: every new clinic gets ONE free month, then pays
// MONTHLY_PRICE per month. A valid referral code is optional at signup and
// grants REFERRAL_DISCOUNT (50% of MONTHLY_PRICE) against the clinic's first
// invoice. Redemption no longer rewards the referring clinic with extra trial
// days -- the discount is the only benefit.
const TRIAL_DAYS = 30;
const MONTHLY_PRICE = 3000;
const REFERRAL_DISCOUNT = 1500;
const PLAN_CURRENCY = 'PKR';
const SUBSCRIPTION_DAY_MS = 86400000;

const app = express();
app.set('query parser', 'extended');
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Local upload area for images (form pages, clinic logo) that avoids any
// external cloud dependency â€” the renderer reaches them via /uploaded/*.
let uploadsDir = process.env.PODVET_UPLOADS_DIR;
if (!uploadsDir) {
  try {
    const { app: electronApp } = require('electron');
    uploadsDir = path.join(electronApp.getPath('userData'), 'uploads');
  } catch {
    uploadsDir = path.join(process.env.APPDATA || require('os').homedir(), 'PodVet (Pro)', 'uploads');
  }
}
uploadsDir = path.resolve(uploadsDir);
app.use('/uploaded', express.static(uploadsDir));

// ── Desktop auto-update feed ────────────────────────────────────────────────
// An installed PodVet polls /updates/latest.yml and downloads the installer
// that file points at, both from this directory. scripts/release.ps1 (and the
// Release GitHub workflow) publish a new build with:
//
//   POST /updates/publish?file=<name>&t=<UPDATES_PUBLISH_TOKEN>   (raw bytes)
//
// The token only exists where setup-server.sh writes it into .env, so a
// desktop install - which never sets UPDATES_PUBLISH_TOKEN - exposes no
// upload path at all, and without a token the route answers 404.
const UPDATES_DIR = path.join(__dirname, 'updates');
const UPDATES_TOKEN = process.env.UPDATES_PUBLISH_TOKEN || '';
try { fs.mkdirSync(UPDATES_DIR, { recursive: true }); } catch (_) { /* read-only install */ }

// Registered before the static mount: serve-static only lets non-GET through
// when it falls through, and the feed itself must fall through so a missing
// file can answer 404 below instead of the SPA shell.
app.post('/updates/publish', (req, res) => {
  const fail = (status, message) => res.status(status).json({ ok: false, error: message });
  if (!UPDATES_TOKEN) return fail(404, 'Publishing is not enabled on this server.');
  const presented = Buffer.from(String(req.query.t || ''));
  const expected = Buffer.from(UPDATES_TOKEN);
  if (presented.length !== expected.length || !crypto.timingSafeEqual(presented, expected)) {
    return fail(403, 'Bad publish token.');
  }
  const name = path.basename(String(req.query.file || ''));
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.(?:yml|exe|blockmap)$/.test(name)) {
    return fail(400, 'Unsupported file name.');
  }

  // Stream straight to disk: the installer is ~130 MB, too much to buffer.
  const tmp = path.join(UPDATES_DIR, `${name}.uploading`);
  const out = fs.createWriteStream(tmp);
  let bytes = 0;
  let settled = false;
  const cleanup = () => { try { fs.rmSync(tmp, { force: true }); } catch (_) { /* already gone */ } };
  const done = (status, body) => { if (!settled) { settled = true; res.status(status).json(body); } };

  req.on('data', (chunk) => { bytes += chunk.length; });
  req.on('error', () => { out.destroy(); cleanup(); done(499, { ok: false, error: 'Upload interrupted.' }); });
  out.on('error', (err) => { console.error('[updates] publish write failed:', err.message); cleanup(); done(500, { ok: false, error: 'Could not store the file.' }); });
  out.on('finish', () => {
    if (bytes === 0) { cleanup(); return done(400, { ok: false, error: 'Empty body.' }); }
    try {
      fs.renameSync(tmp, path.join(UPDATES_DIR, name));
    } catch (err) {
      console.error('[updates] publish rename failed:', err.message);
      cleanup();
      return done(500, { ok: false, error: 'Could not store the file.' });
    }
    console.log(`[updates] published ${name} (${bytes} bytes)`);
    done(200, { ok: true, file: name, size: bytes });
  });
  req.pipe(out);
});

app.use('/updates', express.static(UPDATES_DIR, {
  setHeaders(res, filePath) {
    // latest.yml is what decides "is there a newer version" - a proxy must
    // never answer that question from its own cache.
    if (filePath.endsWith('.yml')) res.setHeader('Cache-Control', 'no-cache');
  },
}));
// Anything else under /updates is a missing feed file. Without this it falls
// through to the SPA catch-all, which answers 200 with index.html - YAML that
// is actually an HTML page.
app.use('/updates', (req, res) => {
  res.status(404).type('text/plain').send('Not found');
});

// Writes a `data:image/...;base64,...` payload into the uploads folder and
// returns the public /uploaded/<file> URL for it. The signup form hands the
// clinic's logo to POST /api/clinics as a data URL (it has no local filesystem
// to write into), so the logo is materialised here at clinic-creation time
// instead of being discarded — previously a new clinic always came up with a
// NULL logo_url and fell back to the platform logo everywhere.
// The real image extension matters: generate_invoice.js's addLogo() derives the
// format jsPDF needs from the file extension, so a generic .bin would silently
// break the logo on every generated document.
function saveDataUrlImage(dataUrl, prefix) {
  const m = /^data:image\/(png|jpe?g|webp|gif);base64,([\s\S]+)$/i.exec(String(dataUrl || ''));
  if (!m) return null;
  const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  const name = `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
  fs.writeFileSync(path.join(uploadsDir, name), Buffer.from(m[2], 'base64'));
  return `/uploaded/${name}`;
}

// If MySQL isn't reachable yet (startup retry, or env vars missing), return a
// readable 503 instead of crashing the process with `null.query`.
app.use((req, res, next) => {
  if (req.path.startsWith('/api/') && !_plat) {
    return res.status(503).json({
      error: {
        message: 'Database is not connected yet. Check DB_HOST/DB_USER/DB_PASSWORD and the MySQL server.',
        code: 'DB_NOT_READY',
      },
    });
  }
  next();
});

// DEBUG: log any request that results in a 5xx so the exact failing
// params/body can be inspected in the electron log.
app.use((req, res, next) => {
  const origJson = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 500) {
      console.error(`[5xx] ${req.method} ${req.originalUrl} params=${JSON.stringify(req.params)} body=${JSON.stringify(req.body)}`);
      console.error(`[5xx] response: ${JSON.stringify(body)}`);
    }
    return origJson(body);
  };
  next();
});

const clinicStore = new AsyncLocalStorage();
let _plat = null;
let _platPromise = null;
const clinicConns = new Map();
// PodVet runs its own databases: the platform DB name (platform DB) and the
// clinic DB prefix can be overridden so a PodVet deployment never touches an
// Existing PodVet install's `podvet` / `clinic_*` databases on a shared MySQL.
const DB_NAME = process.env.DB_NAME || 'podvet';
// setup-server.sh / .env write DB_PREFIX (e.g. podvet_clinic_) and grant the
// DB user privileges on `<DB_PREFIX>%` only. server.js must read the SAME
// variable â€” defaulting to 'clinic_' made clinic creation try `clinic_<id>`,
// which the user has no grant for, so every signup 500'd with access denied.
const CLINIC_PREFIX = process.env.CLINIC_PREFIX || process.env.DB_PREFIX || 'podvet_clinic_';
const DB_OPTS = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  multipleStatements: true,
};

const CLOSED_RE = /closed state|ECONNRESET|EPIPE|socket hang up|Connection lost|PROTOCOL_CONNECTION_LOST|keepalive|handshake timeout/i;

// Platform connection (`podvet`) with lazy connect + auto-reconnect. Hosted
// MySQL (Aiven/Railway/...) closes idle connections; mysql2 doesn't heal a
// dead single connection, so we replace it on the next call.
async function ensurePlat() {
  if (_plat) return _plat;
  if (_platPromise) return _platPromise;
  _platPromise = (async () => {
    const conn = await mysql.createConnection({ ...DB_OPTS, database: DB_NAME });
    _plat = conn;
    try { await ensurePlatformSchema(); } catch (e) { console.error('ensurePlatformSchema failed:', e.message); }
    console.log('Connected to MySQL');
    return conn;
  })().finally(() => { _platPromise = null; });
  return _platPromise;
}

async function openClinicConn(clinicId) {
  const conn = await mysql.createConnection({ ...DB_OPTS, database: `${CLINIC_PREFIX}${clinicId}` });
  conn.on('error', () => {});
  // First connection to this clinic DB is also the natural moment to make sure
  // it has no seed duplicates and the full clinic_settings column set. Runs
  // once per process, before the connection is handed back, so a request can
  // never read or write a half-repaired table.
  await dedupeClinicSeedRows(conn, clinicId);
  try { await ensureClinicSettingsColumns(conn); }
  catch (e) { console.error('ensureClinicSettingsColumns (clinic) failed:', e.message); }
  try { await ensureFeatureSchema(conn); }
  catch (e) { console.error('ensureFeatureSchema (clinic) failed:', e.message); }
  return conn;
}

// Wrap a raw connection so a closed/stale one is transparently replaced and
// the call retried once (hosted MySQL drops idle connections).
function healConn(holder, open) {
  return new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return undefined;
      return async (...args) => {
        let conn = holder.c;
        if (!conn) { conn = await open(); holder.c = conn; }
        try { return await conn[prop](...args); }
        catch (e) {
          if (!CLOSED_RE.test(String((e && e.message) || e))) throw e;
          try { conn.destroy && conn.destroy(); } catch (_) {}
          conn = await open(); holder.c = conn;
          return await conn[prop](...args);
        }
      };
    },
  });
}

const platConn = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'then') return undefined; // not a thenable
    return async (...args) => {
      const conn = _plat || await ensurePlat();
      try { return await conn[prop](...args); }
      catch (e) {
        if (!CLOSED_RE.test(String((e && e.message) || e))) throw e;
        _plat = null;
        const fresh = await ensurePlat();
        return await fresh[prop](...args);
      }
    };
  },
});

function getClinicConn(clinicId) {
  clinicId = Number(clinicId) || 1;
  if (clinicId === 1) return Promise.resolve(platConn);
  let entry = clinicConns.get(clinicId);
  if (!entry) {
    entry = { c: null, proxy: null };
    entry.proxy = healConn(entry, () => openClinicConn(clinicId));
    clinicConns.set(clinicId, entry);
  }
  return Promise.resolve(entry.proxy);
}

// Super admin deleting a clinic drops its per-clinic database, so any pooled
// connection held for it has to be closed and evicted. A stale entry left in
// clinicConns would be handed out again on the next request and fail with
// ER_NO_DB, and it would also keep the dropped schema pinned open.
async function closeClinicConn(clinicId) {
  clinicId = Number(clinicId) || 1;
  const entry = clinicConns.get(clinicId);
  if (!entry) return;
  clinicConns.delete(clinicId);
  const c = entry.c;
  entry.c = null;
  if (c) { try { await c.end(); } catch (_) {} }
}

// `db` routes every query to the current request's clinic database (from the
// JWT set by authMiddleware). Whole-account tables (users / clinics) always
// run against the platform DB (`podvet`) explicitly via platConn.
const db = new Proxy({}, {
  get(_t, prop) {
    return (...args) => {
      const clinicId = clinicStore.getStore();
      return (clinicId ? getClinicConn(clinicId) : Promise.resolve(platConn)).then(c => c[prop](...args));
    };
  },
});

// -- Seeded-table duplicate collapse -----------------------------------------
//
// db/schema.sql seeds expense_categories / branches / services, and
// setup-server.sh re-imports it on EVERY deploy. Those three seeds used to be
// bare INSERT ... VALUES with no unique key to collide against, so each deploy
// appended another copy of every default row. After 30 deploys clinic 1 --
// which reads the platform DB directly, see getClinicConn -- had 164 expense
// categories instead of 6, 304 services instead of 10 and 30 "Main Branch"
// rows instead of 1, all of which surface as repeated entries in the
// Add-Expense category dropdown and the branch/service pickers.
//
// This collapses whatever duplicates already exist and then adds the unique key
// that stops them coming back, so it is a no-op on a clean install and safe to
// run on every startup. The key is only added once the table is actually clean,
// because MySQL rejects the ALTER otherwise.
//
// The grouping is done in JS rather than SQL on purpose: the obvious
// "DELETE t FROM t JOIN (SELECT ... FROM t)" form is a self-referencing
// subquery, which MySQL and MariaDB disagree about (ER_UPDATE_TABLE_USED), and
// a fixed backup column list cannot be right for all three tables (expense
// _categories has no `category`, branches has no `description`). Both problems
// are avoided by reading the rows, grouping them here, and then issuing plain
// id-based statements.
//
// Every removed row is copied into <table>_dedupe_backup first, so a bad
// collapse is recoverable with a plain SELECT.
const DEDUPE_PLANS = [
  {
    table: 'expense_categories',
    keyCols: ['name'],
    index: 'uq_expense_categories_name',
    // expenses.category_id is the one real FK into this table and it carries
    // ON DELETE SET NULL, so deleting the duplicate rows before repointing
    // would silently blank the category off every expense.
    children: [{ table: 'expenses', col: 'category_id' }],
  },
  {
    table: 'branches',
    keyCols: ['branch_name'],
    index: 'uq_branches_branch_name',
    // branch_id is a plain int in these tables (no FK constraint), so they have
    // to be repointed explicitly or the collapsed branch would leave them
    // referencing a row that no longer exists.
    children: [
      { table: 'appointments', col: 'branch_id' },
      { table: 'forms', col: 'branch_id' },
      { table: 'boarding_stays', col: 'branch_id' },
      { table: 'cage_types', col: 'branch_id' },
    ],
  },
  {
    table: 'services',
    // Composite key, not name alone: the same service name may legitimately
    // exist under two categories, so "Consultation/General" and
    // "Consultation/Medical" are not duplicates of each other.
    keyCols: ['name', 'category'],
    index: 'uq_services_name_category',
    children: [],
  },
];

// MySQL has no bound-parameter limit, but very long IN lists blow past
// max_allowed_packet, so every id list goes out in chunks.
const ID_CHUNK = 200;
const chunks = (arr, size = ID_CHUNK) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

async function tableExists(conn, table) {
  const [[r]] = await conn.query(
    `SELECT COUNT(*) AS n FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [table],
  );
  return r.n > 0;
}

async function columnNames(conn, table) {
  const [rows] = await conn.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`, [table],
  );
  return rows.map((r) => r.COLUMN_NAME);
}

async function dedupeSeedRows(conn, label) {
  const log = (msg) => console.log(`[dedupe:${label}] ${msg}`);

  for (const plan of DEDUPE_PLANS) {
    try {
      const { table, keyCols, index } = plan;
      if (!(await tableExists(conn, table))) continue;

      const cols = await columnNames(conn, table);
      const missing = keyCols.filter((c) => !cols.includes(c));
      if (missing.length) {
        log(`${table}: no ${missing.map((c) => `\`${c}\``).join('/')} column, skipped`);
        continue;
      }

      // Group in JS. The key is case/whitespace-insensitive so "Rent", "rent"
      // and " Rent " collapse together. The unique key added below is on the
      // raw column, so it is only the case-insensitive half of that guarantee;
      // the whitespace half is enforced by the API guard, which trims the name
      // before it ever reaches an INSERT. Legacy padded rows are still folded
      // in here, which is why the grouping trims at all.
      const [rows] = await conn.query(
        `SELECT id, ${keyCols.map((c) => `\`${c}\``).join(', ')} FROM \`${table}\` ORDER BY id`,
      );
      const groups = new Map();
      for (const r of rows) {
        const k = keyCols.map((c) => String(r[c] ?? '').trim().toLowerCase()).join('\u0000');
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r.id);
      }
      // The survivor of each group is the lowest id: the row the very first
      // deploy inserted, and so the one any pre-existing edit was most likely
      // made against. Every other id in the group is a redundant later copy.
      const collapsible = [...groups.values()].filter((ids) => ids.length > 1);

      if (!collapsible.length) {
        log(`${table}: clean (${rows.length} row(s))`);
      } else {
        // Backup first: this is the only way back if the keep-rule turns out to
        // have picked the wrong row. The backup table mirrors the source, plus
        // provenance, so it works for all three shapes.
        const backup = `${table}_dedupe_backup`;
        if (!(await tableExists(conn, backup))) {
          await conn.query(`CREATE TABLE \`${backup}\` LIKE \`${table}\``);
          await conn.query(
            `ALTER TABLE \`${backup}\`
               ADD COLUMN removed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
               ADD COLUMN src_db VARCHAR(64)`,
          );
        }
        const dupIds = collapsible.flatMap((ids) => ids.slice(1));
        for (const ids of chunks(dupIds)) {
          await conn.query(
            `INSERT INTO \`${backup}\` (src_db, ${cols.map((c) => `\`${c}\``).join(', ')})
               SELECT DATABASE(), ${cols.map((c) => `\`${c}\``).join(', ')}
               FROM \`${table}\` WHERE id IN (${ids.map(() => '?').join(',')})`,
            ids,
          );
        }

        for (const child of plan.children) {
          if (!(await tableExists(conn, child.table))) continue;
          const childCols = await columnNames(conn, child.table);
          if (!childCols.includes(child.col)) continue;
          let moved = 0;
          for (const ids of collapsible) {
            const [survivor, ...dups] = ids;
            for (const part of chunks(dups)) {
              const [r] = await conn.query(
                `UPDATE \`${child.table}\` SET \`${child.col}\` = ?
                   WHERE \`${child.col}\` IN (${part.map(() => '?').join(',')})`,
                [survivor, ...part],
              );
              moved += r.affectedRows || 0;
            }
          }
          if (moved) log(`${child.table}.${child.col}: repointed ${moved} row(s) at the surviving ${table}`);
        }

        let removed = 0;
        for (const ids of chunks(dupIds)) {
          const [r] = await conn.query(
            `DELETE FROM \`${table}\` WHERE id IN (${ids.map(() => '?').join(',')})`, ids,
          );
          removed += r.affectedRows || 0;
        }
        log(`${table}: removed ${removed} duplicate row(s) across ${collapsible.length} group(s)`);
      }

      const [idx] = await conn.query(
        `SELECT COUNT(*) AS n FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
        [table, index],
      );
      if (!idx[0].n) {
        const [[left]] = await conn.query(
          `SELECT COUNT(*) AS n FROM (
             SELECT 1 FROM \`${table}\` GROUP BY ${keyCols.map((c) => `LOWER(TRIM(COALESCE(\`${c}\`, '')))`).join(', ')}
             HAVING COUNT(*) > 1) d`,
        );
        if (left.n) {
          log(`${table}: duplicates remain, skipping ${index}`);
        } else {
          await conn.query(
            `ALTER TABLE \`${table}\` ADD UNIQUE KEY \`${index}\` (${keyCols.map((c) => `\`${c}\``).join(', ')})`,
          );
          log(`${table}: added ${index}`);
        }
      }
    } catch (err) {
      // A repair must never take the API down: log it and keep serving.
      console.error(`[dedupe:${label}] ${plan.table} failed:`, err.message);
    }
  }
}

// Clinic databases are created by cloning table definitions only
// (createClinicDatabase), so they start empty and were never hit by the
// schema.sql re-import. They carry the same three tables and the same unique
// keys though, so running the identical repair keeps the guarantee uniform
// instead of "protected on the platform DB, unprotected on clinic DBs".
async function dedupeClinicSeedRows(conn, clinicId) {
  try {
    await dedupeSeedRows(conn, `clinic${clinicId}`);
  } catch (e) {
    console.error('dedupeClinicSeedRows failed:', e.message);
  }
}

// Idempotent migration for clinic_settings. PATCH /api/clinics/me is the single
// writer for every clinic-wide setting (clinic name, brand colour, logo,
// address, phone, invoice grouping, bank details and the POS-slip toggles), but
// the shipped schema only ever declared the first five of those columns. Any
// save that included one of the others built an UPDATE naming a column MySQL
// did not know -> ER_BAD_FIELD_ERROR -> HTTP 500, and the Settings screen
// reported it as "Failed to save some branding settings" (both of its
// parallel PATCHes send at least one of the missing columns, so it failed
// every single time, not just for some clinics).
//
// schema.sql is fixed too, but its CREATE TABLE IF NOT EXISTS is a no-op
// against an already-deployed table -- same reason ensureSoapNoteColumns
// exists -- so every already-created database is repaired here on startup.
const CLINIC_SETTINGS_COLS = [
  ['group_products_on_invoice', 'TINYINT(1) NOT NULL DEFAULT 0'],
  ['bank_name', 'VARCHAR(255) DEFAULT NULL'],
  ['bank_account_number', 'VARCHAR(100) DEFAULT NULL'],
  ['pos_show_logo', 'TINYINT(1) NOT NULL DEFAULT 1'],
  ['pos_show_clinic_phone', 'TINYINT(1) NOT NULL DEFAULT 0'],
  ['pos_show_client_phone', 'TINYINT(1) NOT NULL DEFAULT 0'],
  ['pos_show_vet_name', 'TINYINT(1) NOT NULL DEFAULT 0'],
  ['pos_show_address', 'TINYINT(1) NOT NULL DEFAULT 0'],
  ['pos_show_bank_details', 'TINYINT(1) NOT NULL DEFAULT 0'],
  ['pos_header_show_clinic_name', 'TINYINT(1) NOT NULL DEFAULT 1'],
  // White-label: the masthead tagline and the vendor footer on documents. NULL
  // means "print nothing" -- see the column comments in db/schema.sql.
  ['tagline', 'VARCHAR(255) DEFAULT NULL'],
  ['powered_by', 'VARCHAR(255) DEFAULT NULL'],
];

// `conn` must already be connected to the target database; TABLE_SCHEMA is
// read as DATABASE() so the same call works for the platform connection (which
// doubles as clinic 1's database) and for a per-clinic connection.
async function ensureClinicSettingsColumns(conn) {
  const [[tbl]] = await conn.query(
    'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',
    ['clinic_settings']);
  if (!tbl.n) return;
  for (const [name, ddl] of CLINIC_SETTINGS_COLS) {
    const [[has]] = await conn.query(
      'SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?',
      ['clinic_settings', name]);
    if (!has.n) {
      try { await conn.query(`ALTER TABLE clinic_settings ADD COLUMN \`${name}\` ${ddl}`); }
      catch (err) { console.error('ensureClinicSettingsColumns skip', name, err.message); }
    }
  }
}

// Columns and tables added after a clinic database already existed. Clinic
// databases are cloned from the platform DB at creation (createClinicDatabase),
// so running these on the platform connection gives every NEW clinic the same
// shape; openClinicConn runs them on first touch to repair the ones that
// predate the feature.
async function ensureFeatureSchema(conn) {
  // Employees keep their social profiles as a JSON array of {platform, url}.
  const [[empCols]] = await conn.query(
    'SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?',
    ['employees', 'social_links']);
  if (!empCols.n) {
    try { await conn.query('ALTER TABLE employees ADD COLUMN social_links TEXT DEFAULT NULL'); }
    catch (err) { console.error('ensureFeatureSchema employees.social_links skip', err.message); }
  }
  // Customer-portal appointment requests start life as PENDING and only become
  // CONFIRMED once the clinic approves them. Older databases shipped a 3-value
  // enum, so widen it in place; the guard keeps this a no-op once applied.
  try {
    const [[apCol]] = await conn.query(
      "SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='appointments' AND COLUMN_NAME='status'");
    if (apCol && !/PENDING/i.test(String(apCol.t || ''))) {
      await conn.query("ALTER TABLE appointments MODIFY COLUMN status ENUM('PENDING','CONFIRMED','CANCELLED','COMPLETED') DEFAULT 'CONFIRMED'");
    }
  } catch (err) { console.error('ensureFeatureSchema appointments.status enum skip', err.message); }
  // Vendor purchases (stock bought from a vendor) — two tables, so the items
  // can be listed/reversed without re-parsing a notes blob.
  try {
    await conn.query(`CREATE TABLE IF NOT EXISTS vendor_purchases (
      id INT AUTO_INCREMENT PRIMARY KEY,
      vendor_id INT NOT NULL,
      purchase_date DATE NOT NULL,
      payment_status VARCHAR(20) DEFAULT 'paid',
      total_amount DECIMAL(12,2) DEFAULT 0,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      KEY idx_vendor_purchases_vendor (vendor_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await conn.query(`CREATE TABLE IF NOT EXISTS vendor_purchase_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      purchase_id INT NOT NULL,
      product_id INT DEFAULT NULL,
      item_name VARCHAR(255) NOT NULL,
      quantity INT NOT NULL DEFAULT 1,
      unit_price DECIMAL(12,2) DEFAULT 0,
      line_total DECIMAL(12,2) DEFAULT 0,
      KEY idx_vendor_purchase_items_purchase (purchase_id),
      FOREIGN KEY (purchase_id) REFERENCES vendor_purchases(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  } catch (err) { console.error('ensureFeatureSchema vendor purchases failed:', err.message); }
  // Vendor detail fields — added after launch, so ALTER existing installs one
  // column at a time (same guard as employees.social_links above).
  const vendorCols = [
    ['email', 'VARCHAR(255)'],
    ['address', 'VARCHAR(500)'],
    ['city', 'VARCHAR(100)'],
    ['website', 'VARCHAR(255)'],
    ['category', 'VARCHAR(100)'],
    // Manually-entered per-vendor settlement figures (Sales Period, Vendor
    // Share, Clinic Profit, Settled, Remaining, Settlement Status). Null keeps
    // the auto-computed consignment/settlement value as the fallback.
    ['manual_sales', 'DECIMAL(12,2)'],
    ['manual_vendor_share', 'DECIMAL(12,2)'],
    ['manual_clinic_profit', 'DECIMAL(12,2)'],
    ['manual_settled', 'DECIMAL(12,2)'],
    ['manual_remaining', 'DECIMAL(12,2)'],
    ['manual_settlement_status', 'VARCHAR(20)'],
  ];
  for (const [colName, colType] of vendorCols) {
    try {
      const [[c]] = await conn.query(
        'SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?',
        ['vendors', colName]);
      if (!c.n) await conn.query(`ALTER TABLE vendors ADD COLUMN ${colName} ${colType} DEFAULT NULL`);
    } catch (err) { console.error(`ensureFeatureSchema vendors.${colName} skip`, err.message); }
  }
  // ── Notification centre ─────────────────────────────────────────────────
  // One row per alert. STAFF rows are the clinic's own bell (recipient_client_id
  // NULL, broadcast to every staff member); CLIENT rows target exactly one
  // customer for the self-service portal. `event_key` makes the writes
  // idempotent: a retried booking/payment/reminder produces at most one alert
  // (NULL keys are exempt — MySQL allows many NULLs in a UNIQUE index — so
  // ad-hoc alerts without a natural key are never collapsed).
  try {
    await conn.query(`CREATE TABLE IF NOT EXISTS notifications (
      id INT AUTO_INCREMENT PRIMARY KEY,
      recipient_audience ENUM('STAFF','CLIENT') NOT NULL DEFAULT 'STAFF',
      recipient_user_id INT DEFAULT NULL,
      recipient_client_id INT DEFAULT NULL,
      title VARCHAR(255) NOT NULL,
      message TEXT,
      category VARCHAR(50) NOT NULL DEFAULT 'general',
      priority ENUM('low','normal','high','urgent') NOT NULL DEFAULT 'normal',
      related_entity_type VARCHAR(50) DEFAULT NULL,
      related_entity_id INT DEFAULT NULL,
      action_url VARCHAR(500) DEFAULT NULL,
      is_read TINYINT(1) NOT NULL DEFAULT 0,
      read_at DATETIME DEFAULT NULL,
      event_key VARCHAR(191) DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      KEY idx_notifications_audience (recipient_audience, is_read),
      KEY idx_notifications_client (recipient_client_id, is_read),
      KEY idx_notifications_created (created_at),
      UNIQUE KEY uq_notifications_event (event_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  } catch (err) { console.error('ensureFeatureSchema notifications failed:', err.message); }
  // Self-service customer accounts for the /portal. One per (clinic) email,
  // linked to the client record whose pets/appointments/bills it may read.
  try {
    await conn.query(`CREATE TABLE IF NOT EXISTS client_accounts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      client_id INT NOT NULL,
      email VARCHAR(255) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      full_name VARCHAR(255) DEFAULT NULL,
      phone VARCHAR(50) DEFAULT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      notification_prefs TEXT DEFAULT NULL,
      last_login_at DATETIME DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_client_accounts_email (email),
      KEY idx_client_accounts_client (client_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  } catch (err) { console.error('ensureFeatureSchema client_accounts failed:', err.message); }
}

async function ensurePlatformSchema() {
  // Soap-note columns must be added FIRST and independently: the ALTER block
  // below throws on pre-existing index names (uclinics/referrals/employees),
  // which would abort this whole function before reaching the column migration.
  try { await ensureSoapNoteColumns(); } catch (e) { console.error('ensureSoapNoteColumns failed:', e.message); }
  // Feature columns/tables (employees.social_links, vendor purchases) must also
  // exist on the platform DB before createClinicDatabase clones it.
  try { await ensureFeatureSchema(platConn); } catch (e) { console.error('ensureFeatureSchema failed:', e.message); }
  // Same treatment for clinic_settings, and it has to run on the platform DB
  // anyway: createClinicDatabase clones each table with SHOW CREATE TABLE, so
  // repairing clinic 1's table here is what gives every newly created clinic
  // database the columns too.
  try { await ensureClinicSettingsColumns(platConn); } catch (e) { console.error('ensureClinicSettingsColumns failed:', e.message); }
  // Collapse seed duplicates before anything can read them, and add the unique
  // keys that stop new ones. Wrapped per-table already; this outer guard keeps
  // one unexpected failure from skipping the rest of the platform schema.
  try { await dedupeSeedRows(platConn, DB_NAME); } catch (e) { console.error('dedupeSeedRows failed:', e.message); }
  await platConn.query(`CREATE TABLE IF NOT EXISTS clinics (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    clinic_name VARCHAR(255) NOT NULL,
    slug VARCHAR(100) DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  const [cols] = await platConn.query(`SELECT COUNT(*) AS n FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA='${DB_NAME}' AND TABLE_NAME='users' AND COLUMN_NAME='clinic_id'`);
  if (!cols[0].n) await platConn.query('ALTER TABLE users ADD COLUMN clinic_id INT DEFAULT 1');
  const [cc] = await platConn.query('SELECT COUNT(*) AS n FROM clinics WHERE id=1');
  if (!cc[0].n) await platConn.query('INSERT INTO clinics (id, clinic_name, slug) VALUES (1, "PodVet Clinic", "podvet")');
  await platConn.query('UPDATE users SET clinic_id=1 WHERE clinic_id IS NULL');
  // Referral cards: a clinic shares a card carrying a code; the receiving
  // clinic enters it as an optional field on the signup form. A valid code
  // stores REFERRAL_DISCOUNT against the new clinic for its first invoice.
  await platConn.query(`CREATE TABLE IF NOT EXISTS referrals (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    code VARCHAR(60) NOT NULL,
    referrer_clinic_id INT DEFAULT NULL,
    referrer_clinic_name VARCHAR(255) DEFAULT 'PodVet Clinic',
    offer VARCHAR(255) DEFAULT '50% discount on Grooming for both clinics',
    status ENUM('active','redeemed','expired') DEFAULT 'active',
    referred_clinic_id INT DEFAULT NULL,
    redeemed_by VARCHAR(255) DEFAULT NULL,
    discount_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    redeemed_at TIMESTAMP NULL DEFAULT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  // Idempotent: this ALTER throws on the second startup ("Duplicate key name
  // 'uq_referral_code'"), which used to abort the rest of this function and
  // silently skip the migrations below.
  const [refIdx] = await platConn.query(`SELECT COUNT(*) AS n FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA='${DB_NAME}' AND TABLE_NAME='referrals' AND INDEX_NAME='uq_referral_code'`);
  if (!refIdx[0].n) await platConn.query('ALTER TABLE referrals ADD UNIQUE INDEX uq_referral_code (code)');
  // Staff invitations. The "Add User" modal in Employees > Users no longer sets a
  // username/password itself - it mails an invitation and the invitee picks
  // their own credentials on the accept page. /api/invitations used to be four
  // stubs that answered {success:true} without touching a database, so an
  // invite was never recorded, never listed, and the handler's toLegacyInvitation
  // call threw on the missing row ("Cannot read properties of undefined").
  // One live invitation per email per clinic: re-inviting someone who is
  // already pending just refreshes the existing row instead of erroring on a
  // duplicate, which is what a clinic admin expects when they hit resend.
  await platConn.query(`CREATE TABLE IF NOT EXISTS invitations (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    clinic_id INT NOT NULL DEFAULT 1,
    email VARCHAR(255) NOT NULL,
    role ENUM('OWNER','ADMIN','USER') NOT NULL DEFAULT 'USER',
    designation VARCHAR(120) DEFAULT NULL,
    branch_id INT DEFAULT NULL,
    invited_by INT DEFAULT NULL,
    token VARCHAR(80) NOT NULL,
    status ENUM('pending','accepted','revoked') NOT NULL DEFAULT 'pending',
    expires_at DATETIME NOT NULL,
    accepted_at DATETIME NULL DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_invitation (clinic_id, email)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  // Idempotent column migrations for pre-existing databases.
  for (const [table, column, ddl] of [
    ['referrals', 'discount_amount', 'ALTER TABLE referrals ADD COLUMN discount_amount DECIMAL(10,2) NOT NULL DEFAULT 0 AFTER redeemed_by'],
    ['clinics', 'referral_discount', 'ALTER TABLE clinics ADD COLUMN referral_discount DECIMAL(10,2) NOT NULL DEFAULT 0'],
    ['clinics', 'referral_discount_applied', 'ALTER TABLE clinics ADD COLUMN referral_discount_applied TINYINT(1) NOT NULL DEFAULT 0'],
  ]) {
    const [has] = await platConn.query(`SELECT COUNT(*) AS n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA='${DB_NAME}' AND TABLE_NAME=? AND COLUMN_NAME=?`, [table, column]);
    if (!has[0].n) await platConn.query(ddl);
  }
  const [refCount] = await platConn.query('SELECT COUNT(*) AS n FROM referrals');
  if (!refCount[0].n) {
    await platConn.query(`INSERT INTO referrals (code, referrer_clinic_name, offer) VALUES
      ('DR-AHMED-REF', 'Ahmed Vet Clinic', '50% discount on Grooming for both clinics'),
      ('REF-POD20', 'City Pet Hospital', '50% discount on First Vaccination for both clinics'),
      ('REF-POD25', 'Happy Tails Veterinary', '50% discount on Consultation for both clinics')`);
  }
  // Platform (Super Admin) tables live in the same DB but are a separate trust
  // boundary â€” own credentials, roles, plans, audit trail. Must run before the
  // clinics UPDATE below, which uses columns this call adds.
  await ensureSuperAdminSchema(platConn, DB_NAME);
  await platConn.query("UPDATE clinics SET status='active', plan='pro', subscription_start=COALESCE(subscription_start, CURDATE()), registration_date=COALESCE(registration_date, DATE(created_at)) WHERE id=1");
  await bootstrapSuperAdmin(platConn, bcrypt);
}

// Idempotent migration for soap_notes: the SoapModal saves many more fields
// than the original table had, so add any missing columns on every startup
// (also covers the clinic-1 database on the VPS where schema.sql's
// CREATE TABLE IF NOT EXISTS won't alter an already-existing table).
async function ensureSoapNoteColumns() {
  const SOAP_COLS = [
    ['temperature_input_unit', "VARCHAR(10) DEFAULT 'C'"],
    ['weight_input_unit', "VARCHAR(10) DEFAULT 'kg'"],
    ['bcs', 'INT DEFAULT NULL'],
    ['mucous_membrane', 'VARCHAR(50) DEFAULT NULL'],
    ['crt', 'DECIMAL(3,1) DEFAULT NULL'],
    ['crt_under_2', 'TINYINT(1) DEFAULT NULL'],
    ['pulse_quality', 'VARCHAR(50) DEFAULT NULL'],
    ['hydration_status', 'VARCHAR(50) DEFAULT NULL'],
    ['mentation', 'VARCHAR(50) DEFAULT NULL'],
    ['visit_type', 'VARCHAR(50) DEFAULT NULL'],
    ['condition_status', 'VARCHAR(50) DEFAULT NULL'],
    ['is_pregnant', 'TINYINT(1) DEFAULT 0'],
    ['has_anemia', 'TINYINT(1) DEFAULT 0'],
    ['vaccination_given', 'TINYINT(1) DEFAULT 0'],
    ['deworming_given', 'TINYINT(1) DEFAULT 0'],
    ['diarrhea_type', 'VARCHAR(50) DEFAULT NULL'],
    ['vomit_type', 'VARCHAR(50) DEFAULT NULL'],
    ['ddx', 'TEXT'],
    ['prognosis', 'TEXT'],
    ['next_visit_days', 'INT DEFAULT NULL'],
    ['doctor_notes', 'TEXT'],
    ['exam_eyes_normal', 'TINYINT(1) DEFAULT 1'],
    ['exam_eyes_note', 'TEXT'],
    ['exam_eyes_discharge_type', 'VARCHAR(50) DEFAULT NULL'],
    ['exam_eyes_color', 'VARCHAR(50) DEFAULT NULL'],
    ['exam_eyes_cornea', 'VARCHAR(50) DEFAULT NULL'],
    ['exam_eyes_pupils', 'VARCHAR(50) DEFAULT NULL'],
    ['exam_ears_normal', 'TINYINT(1) DEFAULT 1'],
    ['exam_ears_note', 'TEXT'],
    ['exam_ears_discharge_type', 'VARCHAR(50) DEFAULT NULL'],
    ['exam_ears_odor', 'VARCHAR(50) DEFAULT NULL'],
    ['exam_ears_appearance', 'VARCHAR(50) DEFAULT NULL'],
    ['exam_ears_pain', 'TINYINT(1) DEFAULT NULL'],
    ['exam_oral_normal', 'TINYINT(1) DEFAULT 1'],
    ['exam_oral_note', 'TEXT'],
    ['exam_skin_normal', 'TINYINT(1) DEFAULT 1'],
    ['exam_skin_note', 'TEXT'],
    ['exam_lymph_normal', 'TINYINT(1) DEFAULT 1'],
    ['exam_lymph_note', 'TEXT'],
    ['exam_cardio_normal', 'TINYINT(1) DEFAULT 1'],
    ['exam_cardio_note', 'TEXT'],
    ['exam_resp_normal', 'TINYINT(1) DEFAULT 1'],
    ['exam_resp_note', 'TEXT'],
    ['exam_gi_normal', 'TINYINT(1) DEFAULT 1'],
    ['exam_gi_note', 'TEXT'],
    ['exam_musculo_normal', 'TINYINT(1) DEFAULT 1'],
    ['exam_musculo_note', 'TEXT'],
    ['exam_neuro_normal', 'TINYINT(1) DEFAULT 1'],
    ['exam_neuro_note', 'TEXT'],
    ['exam_uro_normal', 'TINYINT(1) DEFAULT 1'],
    ['exam_uro_note', 'TEXT'],
    ['tests_advised', 'TEXT'],
    ['updated_at', 'TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'],
  ];
  const [[tbl]] = await platConn.query(
    'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?',
    [DB_NAME, 'soap_notes']);
  if (!tbl.n) return;
  for (const [name, ddl] of SOAP_COLS) {
    const [[e]] = await platConn.query(
      'SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND COLUMN_NAME=?',
      [DB_NAME, 'soap_notes', name]);
    if (!e.n) {
      try { await platConn.query(`ALTER TABLE soap_notes ADD COLUMN \`${name}\` ${ddl}`); }
      catch (err) { console.error('ensureSoapNoteColumns skip', name, err.message); }
    }
  }
}

// `branding` carries whatever the signup form collected (logo URL, address,
// phone, colour, tagline, powered-by). It is written into the fresh clinic's
// single clinic_settings row so a brand-new clinic opens already branded
// instead of showing the platform's logo/name until someone visits Settings.
async function createClinicDatabase(clinicId, clinicName, branding = {}) {
  const admin = await mysql.createConnection({ ...DB_OPTS });
  try {
    await admin.query(`CREATE DATABASE IF NOT EXISTS \`${CLINIC_PREFIX}${clinicId}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await admin.query(`USE \`${CLINIC_PREFIX}${clinicId}\``);
    await admin.query('SET FOREIGN_KEY_CHECKS=0');
    const [tables] = await platConn.query('SHOW TABLES');
    // Platform-only tables must never be cloned into a clinic database â€”
    // they hold platform credentials and the token-signing secret.
    const PLATFORM_TABLES = new Set([
      'users', 'clinics', 'platform_admins', 'roles', 'role_permissions',
      'audit_logs', 'plans', 'platform_settings', 'referrals',
      'password_resets',
    ]);
    for (const t of tables) {
      const name = Object.values(t)[0];
      if (PLATFORM_TABLES.has(name)) continue;
      const [[def]] = await platConn.query(`SHOW CREATE TABLE \`${name}\``);
      await admin.query(def['Create Table']);
    }
    await admin.query('SET FOREIGN_KEY_CHECKS=1');
    await admin.query(
      `INSERT INTO clinic_settings
         (id, clinic_name, brand_color, logo_url, address, phone, tagline, powered_by)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
      [
        branding.clinicName || clinicName,
        branding.brandColor || '#92CAED',
        branding.logoUrl || null,
        branding.address || null,
        branding.phone || null,
        branding.tagline || null,
        branding.poweredBy || null,
      ],
    );
    await admin.query('INSERT INTO branches (branch_name, is_active) VALUES ("Main Branch", 1)');
  } finally { await admin.end(); }
}

async function connectDB() {
  await ensurePlat();
}

// ---------------------------------------------------------------------------
// Token signing
//
// makeToken used to write the literal string "dummy" as the signature, and
// authMiddleware never looked at the signature at all - it only base64-decoded
// the payload. So the token was not a credential, it was a suggestion. Anyone
// could concatenate {alg,typ} . {sub,clinicId} . dummy and be admitted as any
// user in any clinic, and `exp` was never checked either, so an expired token
// stayed good forever. Verified against the running server: a hand-written
// token with no secret read back clients, pets, employees, services, branches
// and users.
//
// Tokens are now HMAC-SHA256 signed with a per-install secret and the signature
// is verified on every request.
//
// The secret has to survive a restart, because if it were regenerated on boot
// every signed-in clinic would be logged out every time the service restarted -
// and on Render the on-disk data dir is wiped on redeploy, which is also why
// the browser keeps its own copy of the token. It is read from JWT_SECRET when
// set, otherwise generated once into <userDataDir>/jwt-secret.
// ---------------------------------------------------------------------------
const TOKEN_HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
let cachedSecret = null;

function getTokenSecret() {
  if (cachedSecret) return cachedSecret;
  if (process.env.JWT_SECRET) {
    cachedSecret = process.env.JWT_SECRET;
    return cachedSecret;
  }
  const dir = process.env.WEB_USER_DATA_DIR || path.join(require('os').homedir(), '.podvet');
  const file = path.join(dir, 'jwt-secret');
  try {
    cachedSecret = fs.readFileSync(file, 'utf8').trim();
    if (cachedSecret) return cachedSecret;
  } catch { /* not written yet */ }
  cachedSecret = crypto.randomBytes(48).toString('hex');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, cachedSecret, { mode: 0o600 });
  } catch (err) {
    // Without a writable secret file the install still works, it just has to
    // sign everyone out when the process restarts.
    console.warn('[auth] could not persist token secret:', err.message);
  }
  return cachedSecret;
}

function signTokenPart(data) {
  return crypto.createHmac('sha256', getTokenSecret()).update(data).digest('base64url');
}

function makeToken(userId, clinicId) {
  const payload = Buffer.from(JSON.stringify({
    sub: userId,
    clinicId: Number(clinicId) || 1,
    iat: Date.now(),
    exp: Date.now() + TOKEN_TTL_MS,
  })).toString('base64url');
  const body = `${TOKEN_HEADER}.${payload}`;
  return `${body}.${signTokenPart(body)}`;
}

// Single place that decides whether a token is genuine. authMiddleware and
// /api/auth/refresh both go through it - refresh especially, because it used to
// decode the posted token without checking anything and then mint a fresh
// signed one from it, which handed anyone who asked a valid credential.
function verifyToken(raw) {
  const parts = String(raw || '').split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed token' };

  const body = `${parts[0]}.${parts[1]}`;
  const expected = signTokenPart(body);
  const given = parts[2];
  // timingSafeEqual throws on a length mismatch, hence the guard first.
  if (given.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
    return { ok: false, reason: 'bad signature' };
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'unreadable payload' };
  }

  // makeToken has always written epoch milliseconds. Tolerate seconds too, but
  // only after checking the signature - a number small enough to be seconds is
  // unambiguous, and by this point the payload is ours.
  const expMs = Number(payload.exp) < 1e12 ? Number(payload.exp) * 1000 : Number(payload.exp);
  if (!Number.isFinite(expMs)) return { ok: false, reason: 'no expiry' };
  if (expMs <= Date.now()) return { ok: false, reason: 'expired' };
  if (payload.sub === undefined || payload.sub === null) return { ok: false, reason: 'no subject' };

  return { ok: true, payload };
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });

  const verdict = verifyToken(auth.slice(7));
  if (!verdict.ok) return res.status(401).json({ error: 'Invalid token' });
  // Customer-portal tokens carry scope:'portal'. They are signed with the same
  // secret, so without this guard a signed-in customer could call every staff
  // endpoint with their own token. Portal routes use portalAuthMiddleware.
  if (verdict.payload.scope === 'portal') return res.status(401).json({ error: 'Invalid token' });

  req.userId = Number(verdict.payload.sub);
  req.clinicId = Number(verdict.payload.clinicId) || 1;
  clinicStore.run(Number(req.clinicId), () => next());
}

// Reads the clinic's single clinic_settings row and flattens it into the
// branding half of a session payload. Kept as its own helper because
// okClinicSession (login / me / refresh) and /api/auth/switch-clinic all need
// exactly this, and they previously each re-rolled their own query that only
// selected clinic_name — so the logo, colour and contact details never reached
// the client and every surface fell back to hardcoded platform branding.
async function clinicBrandingFor(clinicId) {
  const out = {
    clinicName: 'PodVet Clinic', logoUrl: null, brandColor: '#92CAED',
    address: '', phone: '', tagline: '', poweredBy: '',
  };
  try {
    const conn = await getClinicConn(clinicId);
    const [rows] = await conn.query(
      'SELECT clinic_name, logo_url, brand_color, address, phone, tagline, powered_by FROM clinic_settings WHERE id=1',
    );
    const s = rows[0] || {};
    if (s.clinic_name) out.clinicName = s.clinic_name;
    out.logoUrl = s.logo_url || null;
    if (s.brand_color) out.brandColor = s.brand_color;
    out.address = s.address || '';
    out.phone = s.phone || '';
    out.tagline = s.tagline || '';
    out.poweredBy = s.powered_by || '';
  } catch (e) {
    console.error('clinicBrandingFor failed', e.message);
  }
  return out;
}

async function okClinicSession(u, clinicId) {
  const cid = Number(clinicId) || Number(u.clinic_id) || 1;
  const brand = await clinicBrandingFor(cid);
  return {
    user: { id: u.id, name: u.name, username: u.username, email: u.email, isPlatformAdmin: u.role === 'OWNER' },
    activeClinic: {
      clinicId: cid, slug: 'podvet', role: u.role || 'OWNER', branchId: null, accessBlocked: null,
      ...brand,
    },
  };
}

const P = (v) => parseInt(v) || 0;

// MySQL returns snake_case; the Electron handlers expect camelCase.
function toCamel(row) {
  if (row === null || row === undefined) return row;
  if (Array.isArray(row)) return row.map(toCamel);
  if (typeof row !== 'object') return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    const ck = k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    if (v instanceof Date) {
      // DATE columns must keep their calendar day â€” toISOString() shifts
      // them into UTC and the frontend displays the wrong day.
      out[ck] = /_date$|_on$/.test(k)
        ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
        : v.toISOString();
    } else {
      out[ck] = v;
    }
  }
  return out;
}

function paginate(rows, total, page, pageSize) {
  return { data: toCamel(rows), total, page: Number(page), totalPages: Math.ceil((total || 0) / pageSize) };
}

const EMPTY = { data: [], total: 0, page: 1, totalPages: 0 };

// ─── NOTIFICATION CENTRE ────────────────────────────────────────────────────
// Single writer for every alert in the system. Business routes call this after
// a successful write; it must never be able to break that write, so it is
// fire-and-forget and swallows all errors (a duplicate event_key, a missing
// notifications table on a stale clinic DB, ...). Row + SSE fan-out.
//
//   recipientAudience: 'STAFF' (clinic bell, broadcast) | 'CLIENT' (portal)
//   recipientClientId: required for CLIENT — the customer it targets
//   eventKey:          optional idempotency key (UNIQUE index collapses retries)
function notify(payload) {
  const p = payload || {};
  const audience = p.recipientAudience === 'CLIENT' ? 'CLIENT' : 'STAFF';
  const clientId = p.recipientClientId != null ? Number(p.recipientClientId) : null;
  const userId = p.recipientUserId != null ? Number(p.recipientUserId) : null;
  const title = String(p.title || '').slice(0, 255);
  if (!title) return Promise.resolve();
  let queued;
  try {
    queued = db.query(
      `INSERT INTO notifications
         (recipient_audience,recipient_user_id,recipient_client_id,title,message,category,priority,related_entity_type,related_entity_id,action_url,event_key)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [audience, userId, clientId, title, p.message || null, p.category || 'general',
       ['low', 'normal', 'high', 'urgent'].includes(p.priority) ? p.priority : 'normal',
       p.relatedEntityType || null, p.relatedEntityId || null, p.actionUrl || null, p.eventKey || null],
    );
  } catch (e) { return Promise.resolve(); }
  return Promise.resolve(queued).then(() => {
    try { sseSend('notifications-updated', { audience, clientId }); } catch (_) {}
  }).catch(() => {});
}

// ─── SUBSCRIPTION / FREE-TRIAL HELPERS ──────────────────────────────────────
// All clinics carry: plan, status, subscription_start, subscription_expiry.
// A free trial whose expiry has passed is SUSPENDED (login rejected) and every
// referral card minted by that clinic is flipped to 'expired' so nobody can
// redeem it again once the sender's trial is over.
async function startTrial(clinicId, extraDays) {
  const days = TRIAL_DAYS + (extraDays || 0);
  await platConn.query(`UPDATE clinics
      SET status='trial', plan='trial',
          subscription_start = COALESCE(subscription_start, CURDATE()),
          subscription_expiry = DATE_ADD(GREATEST(COALESCE(subscription_expiry, CURDATE()), CURDATE()), INTERVAL ? DAY),
          registration_date = COALESCE(registration_date, CURDATE())
      WHERE id = ?`, [days, clinicId]);
}

// Extend an existing clinic by N days from its expiry (or from today if it has
// no expiry yet). Only applied to clinics that are still active/trial.
async function extendSubscription(clinicId, days) {
  await platConn.query(`UPDATE clinics
      SET subscription_expiry = DATE_ADD(GREATEST(COALESCE(subscription_expiry, CURDATE()), CURDATE()), INTERVAL ? DAY),
          subscription_start = COALESCE(subscription_start, CURDATE())
      WHERE id = ? AND status IN ('active','trial')`, [days, clinicId]);
}

// Returns true when the clinic has active/trial status AND its subscription is
// still in the future; otherwise suspends it, expires its cards and reports
// the block so callers can reject the action.
async function guardClinicSubscription(clinicId) {
  if (!clinicId) return true;
  const [rows] = await platConn.query('SELECT status, DATEDIFF(subscription_expiry, CURDATE()) AS days_left FROM clinics WHERE id = ?', [clinicId]);
  if (!rows.length) return false;
  const r = rows[0];
  const expired = r.days_left !== null && r.days_left !== undefined && Number(r.days_left) < 0;
  if (expired && (r.status === 'active' || r.status === 'trial')) {
    await platConn.query("UPDATE clinics SET status='suspended', plan='trial' WHERE id = ?", [clinicId]);
    await platConn.query("UPDATE referrals SET status='expired' WHERE referrer_clinic_id = ? AND status = 'active'", [clinicId]);
    return false;
  }
  return r.status !== 'suspended' && r.status !== 'disabled';
}

// Daily sweep: suspend every clinic whose trial expired and expire all cards
// they minted, so those cards can never be logged in with again.
async function sweepExpiredTrials() {
  try {
    const [rows] = await platConn.query(
      "SELECT id FROM clinics WHERE status IN ('active','trial') AND subscription_expiry IS NOT NULL AND DATEDIFF(subscription_expiry, CURDATE()) < 0");
    for (const c of rows) {
      await platConn.query("UPDATE clinics SET status='suspended', plan='trial' WHERE id = ?", [c.id]);
      await platConn.query("UPDATE referrals SET status='expired' WHERE referrer_clinic_id = ? AND status = 'active'", [c.id]);
      console.log(`[trial] clinic #${c.id} suspended (trial expired), its referral cards expired`);
    }
  } catch (_) {}
}

async function initSubscriptionSweep() {
  const timer = setInterval(sweepExpiredTrials, 60 * 60 * 1000);
  if (timer.unref) timer.unref();
  setTimeout(sweepExpiredTrials, 5000);
}

// â”€â”€â”€ UNPAID BALANCES (appointments / walk-in billing / quick bills) â”€â”€â”€â”€â”€â”€â”€â”€â”€
// All three "Outstanding Balances" panels + the client ledger share one shape:
// billing rows with a balance remaining (final_total > amount_paid).
const KINDS = {
  appt:      { sql: 'b.appointment_id IS NOT NULL',                        label: 'appt' },
  walkin:    { sql: 'b.appointment_id IS NULL AND (b.invoice_no IS NULL OR b.invoice_no NOT LIKE \'QB-%\')', label: 'walkin' },
  quickbill: { sql: 'b.invoice_no LIKE \'QB-%\'',                           label: 'quickbill' },
};
function isoLike(date, time) {
  const d = date instanceof Date
    ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    : String(date || '').slice(0, 10);
  return `${d}T${String(time || '00:00').slice(0, 5)}:00`;
}
async function unpaidAppointmentRows(clientId) {
  const [rows] = await db.query(`SELECT b.id, b.appointment_id, b.subtotal, b.discount, b.final_total, b.amount_paid, b.status, a.appointment_date, a.appointment_time, COALESCE(p.pet_name, b.pet_name) AS pet_name
    FROM billing b LEFT JOIN appointments a ON a.id = b.appointment_id LEFT JOIN pets p ON p.id = a.pet_id
    WHERE b.client_id = ? AND ${KINDS.appt.sql} AND b.final_total > b.amount_paid
    ORDER BY a.appointment_date DESC, a.appointment_time DESC`, [clientId]);
  const out = [];
  for (const r of rows) {
    const [svc] = await db.query('SELECT COALESCE(SUM(rate*quantity),0) AS fee FROM appointment_services WHERE appointment_id=?', [r.appointment_id]);
    const [bi] = await db.query('SELECT COALESCE(SUM(total),0) AS t FROM billing_items WHERE billing_id=?', [r.id]);
    const appointmentFee = Number(svc[0].fee) || 0;
    const productsTotal = Number(bi[0].t) || 0;
    const discountAmount = Number(r.discount) || 0;
    const amount = Math.max(0, (Number(r.subtotal) || 0) - discountAmount);
    const alreadyPaid = Number(r.amount_paid) || 0;
    const remaining = Math.max(0, amount - alreadyPaid);
    if (remaining <= 0) continue;
    const iso = isoLike(r.appointment_date, r.appointment_time);
    out.push({ appointmentId: r.appointment_id, date: iso, time: iso, petName: r.pet_name || '', billingStatus: r.status, appointmentFee, productsTotal, discountAmount, grossTotal: Number(r.subtotal) || 0, amount, alreadyPaid, remaining });
  }
  return out;
}
async function unpaidWalkinRows(clientId) {
  const [rows] = await db.query(`SELECT b.id AS billingId, DATE(b.created_at) AS date, b.final_total AS finalAmount, b.amount_paid AS paid, (b.final_total - b.amount_paid) AS remaining
    FROM billing b WHERE b.client_id = ? AND ${KINDS.walkin.sql} AND b.final_total > b.amount_paid ORDER BY b.id DESC`, [clientId]);
  const out = [];
  for (const r of rows) {
    const [bi] = await db.query('SELECT name,quantity,total FROM billing_items WHERE billing_id=?', [r.billingId]);
    out.push({ billingId: r.billingId, date: isoLike(r.date, null), finalAmount: Number(r.finalAmount), paid: Number(r.paid), remaining: Number(r.remaining), items: bi });
  }
  return out;
}
async function unpaidQuickBillRows(clientId) {
  const [rows] = await db.query(`SELECT b.id, b.invoice_no, DATE(b.created_at) AS date, b.final_total AS total, b.amount_paid AS paid, (b.final_total - b.amount_paid) AS remaining
    FROM billing b WHERE b.client_id = ? AND ${KINDS.quickbill.sql} AND b.final_total > b.amount_paid ORDER BY b.id DESC`, [clientId]);
  const out = [];
  for (const r of rows) {
    const [bi] = await db.query('SELECT name,quantity,total FROM billing_items WHERE billing_id=?', [r.id]);
    out.push({ customInvoiceId: r.id, invoiceNo: r.invoice_no || ('QB-' + r.id), date: isoLike(r.date, null), total: Number(r.total), paid: Number(r.paid), remaining: Number(r.remaining), items: bi });
  }
  return out;
}
async function unpaidClientIds(kind, search) {
  const extra = KINDS[kind].sql;
  let where = `b.${'final_total'} > b.${'amount_paid'}`, params = [];
  if (search) { where += ' AND (c.client_name LIKE ? OR c.contact_number LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
  const [rows] = await db.query(`SELECT DISTINCT c.id, c.client_name, c.contact_number, c.address FROM billing b JOIN clients c ON c.id = b.client_id WHERE ${where} AND ${extra} ORDER BY c.client_name`, params);
  return rows;
}
async function unpaidClientSummary(kind, { search = '', page = 1, pageSize = 10 }) {
  const pg = P(page) || 1, sz = P(pageSize) || 10;
  const all = await unpaidClientIds(kind, search);
  const total = all.length;
  const slice = all.slice((pg - 1) * sz, pg * sz);
  const data = [];
  for (const c of slice) {
    const rows = kind === 'appt' ? await unpaidAppointmentRows(c.id) : (kind === 'walkin' ? await unpaidWalkinRows(c.id) : await unpaidQuickBillRows(c.id));
    data.push({ clientId: c.id, clientName: c.client_name, contactNumber: c.contact_number, address: c.address, unpaidCount: rows.length, totalDue: rows.reduce((s, r) => s + Number(r.remaining || 0), 0), appointments: rows });
  }
  return { data, total, page: pg, totalPages: Math.ceil(total / sz) };
}

// â”€â”€â”€ AUTH â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post('/api/auth/login', async (req, res) => {
  try {
    const { identifier, password } = req.body;
    // Platform staff sign in through the same clinic login screen: detect them
    // first and hand back a marker the app turns into a /super-admin hand-off.
    const platform = await authenticatePlatformAdmin(platConn, bcrypt, identifier, password, req);
    if (platform) {
      if (platform.blocked) {
        const code = platform.blocked === 'Invalid credentials' ? 401 : 403;
        return res.status(code).json({ error: platform.blocked });
      }
      return res.json({ superAdmin: true, token: platform.token, admin: platform.admin });
    }
    const [rows] = await platConn.query('SELECT * FROM users WHERE username = ? OR email = ?', [identifier, identifier]);
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    const u = rows[0];
    const valid = await bcrypt.compare(password, u.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const clinicId = u.clinic_id || 1;
    // Trial over? Auto-suspend before we check login, so an expired free
    // trial can't sign in and its referral cards are deactivated.
    await guardClinicSubscription(clinicId);
    const [cl] = await platConn.query('SELECT status FROM clinics WHERE id = ?', [clinicId]);
    const status = cl.length ? cl[0].status : 'active';
    if (status === 'suspended' || status === 'disabled') {
      return res.status(403).json({ error: `This clinic is ${status}. Please contact platform support.` });
    }
    const token = makeToken(u.id, clinicId);
    res.json({ accessToken: token, refreshToken: token, ...(await okClinicSession(u, clinicId)) });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});

// Single source of truth for referral-code validation. Shared by the public
// verify endpoint and the signup path so a code that the UI accepts is exactly
// a code the server honours. It never mutates state; callers that redeem a code
// burn it themselves with a guarded `AND status='active'` UPDATE.
async function resolveReferral(rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) return { valid: false, message: 'Enter the referral code from the card.' };
  const [rows] = await platConn.query('SELECT * FROM referrals WHERE BINARY code = ?', [code]);
  if (!rows.length) return { valid: false, message: 'Invalid referral code. Check the card you received.' };
  const r = rows[0];
  if (r.status !== 'active') {
    return { valid: false, message: r.status === 'redeemed'
      ? 'This referral code has already been used.'
      : 'This referral code has expired.' };
  }
  // A card is only valid for one month from the day it was minted.
  if (r.created_at) {
    const created = new Date(r.created_at);
    if (!isNaN(created.getTime()) && created.getTime() < Date.now() - SUBSCRIPTION_DAY_MS * TRIAL_DAYS) {
      await platConn.query("UPDATE referrals SET status='expired' WHERE id = ?", [r.id]);
      return { valid: false, message: 'This referral card has expired. Ask your referrer for a new one.' };
    }
  }
  // A card is only worth anything while the sender's subscription is still live.
  if (r.referrer_clinic_id && !(await guardClinicSubscription(r.referrer_clinic_id))) {
    await platConn.query("UPDATE referrals SET status='expired' WHERE id = ?", [r.id]);
    return { valid: false, message: 'This referral code has expired because the referring clinic\u2019s trial ended.' };
  }
  return {
    valid: true,
    code: r.code,
    referrerId: r.referrer_clinic_id,
    clinicName: r.referrer_clinic_name,
    offer: r.offer,
    discount: REFERRAL_DISCOUNT,
  };
}

// Public referral verification, used by the signup form's inline code check and
// the shared referral card / QR code.
app.get('/api/referrals/verify', async (req, res) => {
  try {
    const r = await resolveReferral(req.query.code);
    if (!r.valid) return res.json(r);
    res.json({ valid: true, code: r.code, clinicName: r.clinicName, offer: r.offer, discount: r.discount, currency: PLAN_CURRENCY });
  } catch (e) { res.status(500).json({ valid: false, message: 'Could not verify this referral code right now.' }); }
});

// Referral redemption for a clinic that has ALREADY signed up. Signup itself
// accepts an optional referral code (see POST /api/clinics); this endpoint lets
// a signed-in owner attach a code later. It only ever grants the
// REFERRAL_DISCOUNT against the clinic's next invoice -- it never auto-creates
// an account and never invents a password.
app.post('/api/clinics/me/referral', authMiddleware, async (req, res) => {
  try {
    const r = await resolveReferral(req.body.code || req.body.referralCode);
    if (!r.valid) return res.status(400).json({ error: { message: r.message } });
    // Never stack a second referral discount on the same clinic.
    const [cl] = await platConn.query('SELECT referral_discount, referral_discount_applied FROM clinics WHERE id = ?', [req.clinicId]);
    if (cl.length && Number(cl[0].referral_discount || 0) > 0) {
      return res.status(400).json({ error: { message: 'A referral discount has already been applied to this clinic.' } });
    }
    await platConn.query('UPDATE clinics SET referral_discount = ? WHERE id = ?', [REFERRAL_DISCOUNT, req.clinicId]);
    await platConn.query(
      'UPDATE referrals SET status="redeemed", referred_clinic_id=?, redeemed_by=?, discount_amount=?, redeemed_at=IFNULL(redeemed_at, NOW()) WHERE BINARY code = ? AND status="active"',
      [req.clinicId, r.code, REFERRAL_DISCOUNT, r.code]);
    res.json({ success: true, discount: REFERRAL_DISCOUNT, currency: PLAN_CURRENCY, referredBy: { clinicName: r.clinicName, code: r.code } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});

// A logged-in clinic owner mints their own referral code to put on a card they
// share with another clinic. Every call creates a different, redeemable card.
app.post('/api/referrals', authMiddleware, async (req, res) => {
  try {
    // Suspended/expired clinics can't mint referral cards — their trial is over.
    if (!(await guardClinicSubscription(req.clinicId))) {
      return res.status(403).json({ error: { message: 'Your free trial has ended, so you can no longer generate referral cards until you upgrade or renew.' } });
    }
    // The card always carries the referring CLINIC's real name (never a pet
    // owner's), looked up from the platform database.
    let clinicName = 'PodVet Clinic';
    try {
      const [rows] = await platConn.query('SELECT clinic_name FROM clinics WHERE id = ?', [req.clinicId]);
      if (rows.length && rows[0].clinic_name) clinicName = rows[0].clinic_name;
    } catch (_) {}
    const offer = String(req.body.offer || '').trim() || '50% discount on Grooming for both clinics';
    const requested = String(req.body.code || '').trim().toUpperCase();
    const code = requested || `REF-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 90 + 10)}`;
    await platConn.query('INSERT INTO referrals (code, referrer_clinic_id, referrer_clinic_name, offer) VALUES (?, ?, ?, ?)',
      [code, req.clinicId, clinicName, offer]);
    // Card is valid for one month from today.
    const expiry = new Date(Date.now() + SUBSCRIPTION_DAY_MS * TRIAL_DAYS).toISOString();
    res.json({ success: true, code, clinicName, offer, discount: REFERRAL_DISCOUNT, currency: PLAN_CURRENCY, expiry });
  } catch (e) {
    res.status(500).json({ error: { message: /duplicate/i.test(String(e.message)) ? 'That referral code already exists.' : e.message } });
  }
});

// Clinic signup. The referral code is OPTIONAL: leaving it blank signs up
// normally with no discount, an unrecognised/used code is rejected with a
// readable message and NO clinic is created, and a valid code stores
// REFERRAL_DISCOUNT on the new clinic for its first invoice. Validation happens
// before any INSERT so a bad code can never leave a half-created clinic behind.
//
// Everything the signup form collected about the clinic itself (logo, address,
// phone, brand colour, tagline, powered-by) is persisted here too, so the
// clinic is branded from its very first login instead of showing the platform's
// logo and name until someone opens Settings.
app.post('/api/clinics', async (req, res) => {
  try {
    const owner = req.body.owner || req.body;
    const clinicName = req.body.clinicName || req.body.clinic_name || owner.clinicName || 'PodVet Clinic';
    const name = owner.name || 'Owner';
    const username = owner.username || 'owner';
    const email = owner.email || 'owner@podvet.local';
    const password = owner.password || 'password123';
    const rawCode = req.body.referralCode ?? req.body.referral_code ?? owner.referralCode ?? owner.referral_code ?? '';
    const hasCode = String(rawCode || '').trim() !== '';

    // The logo arrives as a data URL (the signup screen has no filesystem of its
    // own) and is materialised into /uploaded before any INSERT, so a malformed
    // payload fails here rather than after the clinic row exists.
    const logoDataUrl = req.body.logoDataUrl || owner.logoDataUrl || null;
    let logoUrl = null;
    if (logoDataUrl) {
      logoUrl = saveDataUrlImage(logoDataUrl, 'clinic_logo');
      if (!logoUrl) return res.status(400).json({ error: { message: 'Clinic logo must be a PNG, JPEG, WebP or GIF image.', field: 'logo' } });
    }
    const branding = {
      clinicName,
      logoUrl,
      address: (req.body.address ?? owner.address ?? '') || null,
      phone: (req.body.phone ?? owner.phone ?? owner.phoneNumber ?? '') || null,
      brandColor: (req.body.brandColor ?? req.body.color ?? '') || null,
      tagline: (req.body.tagline ?? '') || null,
      poweredBy: (req.body.poweredBy ?? '') || null,
    };

    let referral = null;
    if (hasCode) {
      referral = await resolveReferral(rawCode);
      if (!referral.valid) return res.status(400).json({ error: { message: referral.message, field: 'referralCode' } });
    }

    const hash = await bcrypt.hash(password, 10);
    const [reg] = await platConn.query('INSERT INTO clinics (clinic_name, slug) VALUES (?, ?)', [clinicName, 'podvet']);
    const clinicId = reg.insertId;
    // Mirror the branding onto the platform-side clinics row too, so the
    // Super Admin clinic list has it. Best-effort: those columns are added by
    // the startup migration and a genuinely missing one must not fail signup
    // after the clinic row already exists.
    try {
      await platConn.query('UPDATE clinics SET logo=?, address=? WHERE id=?', [logoUrl, branding.address, clinicId]);
    } catch (err) {
      console.error('clinics branding mirror skipped', err.message);
    }
    await createClinicDatabase(clinicId, clinicName, branding);
    await startTrial(clinicId, 0);
    if (referral) {
      await platConn.query('UPDATE clinics SET referral_discount = ? WHERE id = ?', [REFERRAL_DISCOUNT, clinicId]);
      // The code was validated above, so burn it here. `AND status="active"`
      // keeps this idempotent if two signups race for the same card.
      const [burned] = await platConn.query(
        'UPDATE referrals SET status="redeemed", referred_clinic_id=?, redeemed_by=?, discount_amount=?, redeemed_at=IFNULL(redeemed_at, NOW()) WHERE BINARY code = ? AND status="active"',
        [clinicId, name, REFERRAL_DISCOUNT, referral.code]);
      if (!burned.affectedRows) {
        // Lost the race: someone else redeemed the card mid-signup, so drop the
        // discount rather than granting one that isn't backed by a redemption.
        await platConn.query('UPDATE clinics SET referral_discount = 0 WHERE id = ?', [clinicId]);
        referral = null;
      }
    }
    const [r] = await platConn.query('INSERT INTO users (name, username, email, password, role, phone_number, clinic_id) VALUES (?, ?, ?, ?, "OWNER", ?, ?)',
      [name, username, email, hash, owner.phoneNumber || owner.phone_number || null, clinicId]);
    const token = makeToken(r.insertId, clinicId);
    res.json({
      accessToken: token, refreshToken: token,
      user: { id: r.insertId, name, username, email, isPlatformAdmin: false },
      activeClinic: {
        clinicId, clinicName, slug: 'podvet', role: 'OWNER', branchId: null, accessBlocked: null,
        // Ship the branding back on the signup response so the renderer can
        // rebrand the whole app straight out of signup, with no follow-up
        // request and no first-paint flash of the platform's logo and name.
        logoUrl: branding.logoUrl || null,
        brandColor: branding.brandColor || '#92CAED',
        address: branding.address || '',
        phone: branding.phone || '',
        tagline: branding.tagline || '',
        poweredBy: branding.poweredBy || '',
      },
      ...(referral ? {
        referralApplied: true,
        referralDiscount: REFERRAL_DISCOUNT,
        currency: PLAN_CURRENCY,
        referredBy: { clinicName: referral.clinicName, code: referral.code },
      } : { referralApplied: false }),
    });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    // Expire the session the moment the trial/subscription runs out, so a
    // clinic that logged in with a card gets logged back out after 1 month.
    if (!(await guardClinicSubscription(req.clinicId))) {
      return res.status(403).json({ error: { message: 'Your free month has ended. Please renew to continue.' } });
    }
    const [rows] = await platConn.query('SELECT * FROM users WHERE id = ?', [req.userId]);
    if (!rows.length) return res.status(404).json({ error: { message: 'Not found', code: 'NOT_FOUND' } });
    res.json(await okClinicSession(rows[0], req.clinicId));
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});

app.patch('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const { name, username } = req.body;
    await platConn.query('UPDATE users SET name=?, username=? WHERE id=?', [name, username, req.userId]);
    const [rows] = await platConn.query('SELECT * FROM users WHERE id=?', [req.userId]);
    res.json(await okClinicSession(rows[0], req.clinicId));
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});

app.post('/api/auth/switch-clinic', authMiddleware, async (req, res) => {
  const brand = await clinicBrandingFor(req.clinicId);
  const [rows] = await platConn.query('SELECT name FROM users WHERE id=?', [req.userId]);
  res.json({
    accessToken: makeToken(req.userId, req.clinicId),
    refreshToken: makeToken(req.userId, req.clinicId),
    // The real user's name, not a hardcoded 'User' — this payload feeds
    // toLocalUser(), so a placeholder here showed up as "User" in the app's
    // account UI after any clinic switch.
    user: { id: req.userId, name: (rows[0] && rows[0].name) || 'User' },
    activeClinic: { clinicId: req.clinicId, slug: 'podvet', role: 'OWNER', branchId: null, ...brand },
  });
});

app.post('/api/auth/logout', (req, res) => res.json({ success: true }));

// ── Password reset by emailed code ───────────────────────────────────────────
//
// The frontend flow (see the Forgot Password / Verify OTP screens) is:
//   POST /forgot-password { email }  -> mails a 6-digit code
//   POST /reset-password  { token, newPassword }
//                                        `token` is that 6-digit code.
//
// Two rules drive the implementation:
//
// 1. /forgot-password answers identically whether or not the address is
//    registered. Anything else turns the endpoint into an account-enumeration
//    oracle ("that email is not signed up"), which is why the lookup result
//    is never allowed to reach the response.
// 2. Only a hash of the code is stored, and it is single-use: a successful
//    reset marks it used, and issuing a new code deletes any earlier one.
const RESET_CODE_TTL_MIN = 10;
const RESET_MAX_ATTEMPTS = 5;
// Per-address throttle, on top of the code's own expiry: stops the endpoint
// being used to mail-bomb one inbox.
const RESET_RESEND_COOLDOWN_SEC = 60;

function resetCodeEmail({ code, clinicName }) {
  const app = process.env.APP_URL || 'https://podvet.biztrack.uk';
  return {
    subject: `${code} is your PodVet password reset code`,
    html: `<!doctype html><html><body style="margin:0;padding:0;background:#f4f8fb;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f8fb;padding:32px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;border:1px solid #e2e8f0">
        <tr><td style="padding:28px 32px 8px">
          <p style="margin:0 0 20px;font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#1b6ea1">Password reset</p>
          <h1 style="margin:0 0 14px;font-size:22px;line-height:1.3;color:#0d2e50">Your reset code</h1>
          <p style="margin:0 0 22px;font-size:15px;line-height:1.6;color:#475569">Use this code to choose a new password${clinicName ? ` for <strong>${clinicName}</strong>` : ''}. It expires in ${RESET_CODE_TTL_MIN} minutes.</p>
          <div style="margin:0 0 22px;padding:20px;background:#f4f8fb;border:1px solid #dce9f4;border-radius:12px;text-align:center">
            <span style="font-size:34px;font-weight:800;letter-spacing:.32em;color:#1b6ea1;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${code}</span>
          </div>
          <p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#64748b">If you did not request this, you can safely ignore this email &mdash; your password will not change.</p>
        </td></tr>
        <tr><td style="padding:8px 32px 28px">
          <a href="${app}/app#/forgot-password" style="display:inline-block;padding:13px 22px;background:#f8e327;color:#1b6ea1;font-size:14px;font-weight:700;border-radius:999px;text-decoration:none">Open PodVet</a>
          <p style="margin:20px 0 0;font-size:12px;color:#94a3b8">&copy; PodVet</p>
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`,
  };
}

app.post('/api/auth/forgot-password', async (req, res) => {
  // Same answer for every input -- see rule 1 above.
  const GENERIC = { success: true, message: 'If that email is registered, a code has been sent.' };
  try {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.json(GENERIC);

    const [users] = await platConn.query(
      'SELECT id, name, email, clinic_id FROM users WHERE LOWER(email) = ? LIMIT 1',
      [email],
    );
    if (!users.length) return res.json(GENERIC);
    const user = users[0];

    const [[throttle]] = await platConn.query(
      `SELECT id FROM password_resets
        WHERE user_id = ? AND created_at > DATE_SUB(NOW(), INTERVAL ? SECOND)
        LIMIT 1`,
      [user.id, RESET_RESEND_COOLDOWN_SEC],
    );
    if (throttle) return res.json({ ...GENERIC, message: 'Please wait a minute before requesting another code.' });

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    // A new code invalidates every earlier one, so only the newest is usable.
    await platConn.query('DELETE FROM password_resets WHERE user_id = ?', [user.id]);
    await platConn.query(
      `INSERT INTO password_resets (user_id, email, code_hash, expires_at)
       VALUES (?,?,?, DATE_ADD(NOW(), INTERVAL ? MINUTE))`,
      [user.id, user.email, await bcrypt.hash(code, 10), RESET_CODE_TTL_MIN],
    );

    let clinicName = null;
    try {
      const [cs] = await platConn.query('SELECT clinic_name FROM clinics WHERE id = ?', [user.clinic_id]);
      clinicName = cs.length ? cs[0].clinic_name : null;
    } catch (_) { /* branding is cosmetic -- never block the send on it */ }

    try {
      await sendMail({ to: user.email, ...resetCodeEmail({ code, clinicName }) });
    } catch (e) {
      // Do not leak the mail error to the caller, but do not lose it either:
      // a misconfigured SMTP block would otherwise look like a working
      // endpoint that simply never delivers.
      console.error('[mailer] password reset email failed:', e.message);
      return res.status(502).json({ success: false, message: 'We could not send the email right now. Please try again shortly.' });
    }

    return res.json(GENERIC);
  } catch (e) {
    console.error('[auth] forgot-password failed:', e.message);
    return res.status(500).json({ error: { message: e.message } });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const body = req.body || {};
    const code = String(body.token || '').trim();
    const newPassword = String(body.newPassword || '');
    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({ success: false, message: 'That code is invalid or has expired.' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ success: false, message: 'New password must be at least 8 characters.' });
    }

    const [rows] = await platConn.query(
      `SELECT id, user_id, code_hash, attempts FROM password_resets
        WHERE used_at IS NULL AND expires_at > NOW()
        ORDER BY id DESC LIMIT 1`,
    );
    let matched = null;
    for (const row of rows) {
      if (await bcrypt.compare(code, row.code_hash)) { matched = row; break; }
    }
    if (!matched) {
      // Count the burn on the newest live code so a wrong code cannot be
      // brute-forced by cycling through fresh requests.
      if (rows.length) {
        await platConn.query(
          'UPDATE password_resets SET attempts = attempts + 1 WHERE id = ? AND attempts < ?',
          [rows[0].id, RESET_MAX_ATTEMPTS],
        );
      }
      return res.status(400).json({ success: false, message: 'That code is invalid or has expired.' });
    }
    if (matched.attempts >= RESET_MAX_ATTEMPTS) {
      await platConn.query('DELETE FROM password_resets WHERE id = ?', [matched.id]);
      return res.status(429).json({ success: false, message: 'Too many attempts. Please request a new code.' });
    }

    await platConn.query(
      'UPDATE users SET password = ? WHERE id = ?',
      [await bcrypt.hash(newPassword, 10), matched.user_id],
    );
    await platConn.query('UPDATE password_resets SET used_at = NOW() WHERE id = ?', [matched.id]);
    return res.json({ success: true, message: 'Password reset successfully!' });
  } catch (e) {
    console.error('[auth] reset-password failed:', e.message);
    return res.status(500).json({ error: { message: e.message } });
  }
});
app.post('/api/auth/change-password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const [rows] = await platConn.query('SELECT password FROM users WHERE id=?', [req.userId]);
    if (rows.length && await bcrypt.compare(currentPassword, rows[0].password)) {
      await platConn.query('UPDATE users SET password=? WHERE id=?', [await bcrypt.hash(newPassword, 10), req.userId]);
    }
    res.json({ success: true });
  } catch { res.json({ success: true }); }
});

app.post('/api/auth/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    // This endpoint hands out a freshly signed token, so it is the most
    // dangerous place in the file to trust the caller's token. It used to just
    // base64-decode the payload and re-sign whatever `sub` it found, which
    // meant anyone could post a made-up token and walk out with a real one.
    const verdict = verifyToken(refreshToken);
    if (!verdict.ok) return res.status(401).json({ error: 'Invalid refresh token' });
    const p = verdict.payload;
    const token = makeToken(p.sub, p.clinicId || 1);
    const [rows] = await platConn.query('SELECT * FROM users WHERE id=?', [p.sub]);
    if (!rows.length) return res.status(401).json({ error: 'Invalid' });
    res.json({ accessToken: token, refreshToken: token, ...(await okClinicSession(rows[0], p.clinicId)) });
  } catch { res.status(401).json({ error: 'Invalid refresh token' }); }
});

// â”€â”€â”€ CLINIC â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function settingsRow() {
  return db.query('SELECT * FROM clinic_settings WHERE id=1');
}
function clinicDTO(row) {
  const s = toCamel(row || {});
  return {
    id: 1, clinicName: s.clinicName || 'PodVet Clinic', slug: 'podvet',
    logoUrl: s.logoUrl || null, brandColor: s.brandColor || '#92CAED',
    firstTimeFee: 1050, discountRange: 50, discountMinPercent: 1, discountMaxPercent: 7,
    use12HourTime: false, address: s.address || '', phone: s.phone || '',
    groupProductsOnInvoice: !!s.groupProductsOnInvoice, bankName: s.bankName || '',
    bankAccountNumber: s.bankAccountNumber || '',
    posShowLogo: s.posShowLogo, posShowClinicPhone: s.posShowClinicPhone, posShowClientPhone: s.posShowClientPhone,
    posShowVetName: s.posShowVetName, posShowAddress: s.posShowAddress, posShowBankDetails: s.posShowBankDetails,
    posHeaderShowClinicName: s.posHeaderShowClinicName,
    tagline: s.tagline || '', poweredBy: s.poweredBy || '',
  };
}
app.get('/api/clinics/me', authMiddleware, async (req, res) => {
  try { const [rows] = await settingsRow(); res.json({ clinic: clinicDTO(rows[0]) }); }
  catch { res.json({ clinic: clinicDTO(null) }); }
});
app.patch('/api/clinics/me', authMiddleware, async (req, res) => {
  try {
    const d = req.body, F = [], V = [];
    const sets = {
      clinicName: 'clinic_name', brandColor: 'brand_color', logoUrl: 'logo_url', address: 'address',
      phone: 'phone', groupProductsOnInvoice: 'group_products_on_invoice', bankName: 'bank_name',
      bankAccountNumber: 'bank_account_number', posShowLogo: 'pos_show_logo', posShowClinicPhone: 'pos_show_clinic_phone',
      posShowClientPhone: 'pos_show_client_phone', posShowVetName: 'pos_show_vet_name', posShowAddress: 'pos_show_address',
      posShowBankDetails: 'pos_show_bank_details', posHeaderShowClinicName: 'pos_header_show_clinic_name',
      tagline: 'tagline', poweredBy: 'powered_by',
    };
    for (const [k, col] of Object.entries(sets)) {
      if (d[k] !== undefined) { F.push(`${col}=?`); V.push(typeof d[k] === 'boolean' ? (d[k] ? 1 : 0) : d[k]); }
    }
    await db.query('INSERT IGNORE INTO clinic_settings (id) VALUES (1)');
    if (F.length) await db.query(`UPDATE clinic_settings SET ${F.join(',')} WHERE id=1`, V);
    // clinic_settings (this clinic's DB) is the source the app renders from,
    // but the platform tables keep their own copy of the name: referral cards,
    // invitations and the super-admin clinic list all read clinics.clinic_name.
    // It used to be written once at creation and never again, so a renamed
    // clinic kept announcing its old name everywhere outside the app shell.
    if (d.clinicName !== undefined) {
      const newName = String(d.clinicName || '').trim() || 'PodVet Clinic';
      try { await platConn.query('UPDATE clinics SET clinic_name=? WHERE id=?', [newName, req.clinicId]); }
      catch (e) { console.error('[PATCH /api/clinics/me] clinics.clinic_name mirror failed', e.message); }
    }
    const [rows] = await settingsRow();
    res.json({ success: true, clinic: clinicDTO(rows[0]) });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.get('/api/clinics/me/branding', authMiddleware, async (req, res) => {
  try { res.json(await clinicBrandingFor(req.clinicId)); }
  catch { res.json({ clinicName: 'PodVet Clinic', logoUrl: null, brandColor: '#92CAED', address: '', phone: '', tagline: '', poweredBy: '' }); }
});
app.get('/api/public/branding', async (req, res) => {
  try { res.json(await clinicBrandingFor(Number(req.query.clinicId) || 1)); }
  catch { res.json({ clinicName: 'PodVet Clinic', logoUrl: null, brandColor: '#92CAED', address: '', phone: '', tagline: '', poweredBy: '' }); }
});

// â”€â”€â”€ PLANS / SUBSCRIPTION â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// NOTE: the frontend's PlanSelectScreen reads result.data.plan (array) and each
// plan needs priceMonthly / trialDays / features to render. Server returns
// { data: [...] } so subscriptionHandlers' `result.data` is the plans array.
// Two entries: the trial plan (0, TRIAL_DAYS) is what a new clinic picks to
// start its one free month, and the paid plan carries the real MONTHLY_PRICE.
// A referral discount applies to the first paid invoice.
const PLANS = [
  {
    id: 1,
    name: 'Free Trial',
    priceMonthly: 0,
    priceYearly: 0,
    currency: PLAN_CURRENCY,
    trialDays: TRIAL_DAYS,
    referralDiscount: REFERRAL_DISCOUNT,
    features: [
      'Everything in Standard',
      '1 month free, no card required',
      'Unlimited clients and pets',
      'Appointments & billing',
      'Products & inventory',
      'Reports and analytics',
    ],
  },
  {
    id: 2,
    name: 'Standard',
    priceMonthly: MONTHLY_PRICE,
    priceYearly: MONTHLY_PRICE * 12,
    currency: PLAN_CURRENCY,
    trialDays: TRIAL_DAYS,
    referralDiscount: REFERRAL_DISCOUNT,
    features: [
      'Unlimited clients and pets',
      'Appointments & billing',
      'Products & inventory',
      'Reports and analytics',
      'Then Rs 3,000 per month',
    ],
  },
];
app.get('/api/plans', authMiddleware, (req, res) => res.json({ data: PLANS }));

// The clinic's own subscription + what it will actually be charged. A referral
// discount is applied to the FIRST invoice only, so `amountDue` reflects it
// until `referral_discount_applied` is set by the billing step.
app.post('/api/clinics/me/subscription', authMiddleware, async (req, res) => {
  try {
    const [rows] = await platConn.query(
      'SELECT plan, status, subscription_start, subscription_expiry, referral_discount, referral_discount_applied FROM clinics WHERE id = ?',
      [req.clinicId]);
    const c = rows[0] || {};
    const discount = Number(c.referral_discount || 0);
    const discountApplied = !!c.referral_discount_applied;
    const effective = discount > 0 && !discountApplied
      ? Math.max(0, MONTHLY_PRICE - discount)
      : MONTHLY_PRICE;
    res.json({
      success: true,
      plan: c.plan || 'trial',
      status: c.status || 'trial',
      currency: PLAN_CURRENCY,
      priceMonthly: MONTHLY_PRICE,
      trialDays: TRIAL_DAYS,
      subscriptionStart: c.subscription_start,
      subscriptionExpiry: c.subscription_expiry,
      referralDiscount: discount,
      referralDiscountApplied: discountApplied,
      amountDue: effective,
    });
  } catch (e) { res.status(500).json({ success: false, error: { message: e.message } }); }
});

// â”€â”€â”€ BRANCHES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/branches', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query('SELECT * FROM branches ORDER BY branch_name'); res.json({ data: toCamel(rows) }); }
  catch { res.json({ data: [] }); }
});
app.post('/api/branches', authMiddleware, async (req, res) => {
  try {
    const { branchName, branch_name } = req.body;
    const [r] = await db.query('INSERT INTO branches (branch_name) VALUES (?)', [branchName || branch_name]);
    res.json({ data: { id: r.insertId, branchName: branchName || branch_name, isActive: true } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.patch('/api/branches/:id', authMiddleware, async (req, res) => {
  try {
    const { branchName, branch_name, isActive, is_active } = req.body;
    const bn = branchName || branch_name; const ia = isActive !== undefined ? isActive : (is_active !== undefined ? is_active : 1);
    await db.query('UPDATE branches SET branch_name=?, is_active=? WHERE id=?', [bn, ia ? 1 : 0, req.params.id]);
    res.json({ success: true });
  } catch { res.json({ success: true }); }
});
app.patch('/api/branches/:id/contact-info', authMiddleware, (req, res) => res.json({ success: true }));
app.delete('/api/branches/:id', authMiddleware, async (req, res) => {
  try { await db.query('DELETE FROM branches WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch { res.json({ success: true }); }
});

// â”€â”€â”€ EMPLOYEES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// ── EMPLOYEE SOCIAL LINKS ────────────────────────────────────────────────────
// Fixed platform list (the UI ships an icon per platform), stored as a JSON
// array of { platform, url } so the roster row and the profile modal can both
// render links without a join.
const SOCIAL_PLATFORMS = ['instagram', 'facebook', 'linkedin', 'twitter', 'whatsapp', 'website'];
function parseSocialLinks(raw) {
  if (!raw) return [];
  let list = raw;
  if (typeof raw === 'string') { try { list = JSON.parse(raw); } catch (_) { return []; } }
  if (!Array.isArray(list)) return [];
  return list.filter((x) => x && typeof x === 'object' && SOCIAL_PLATFORMS.includes(String(x.platform || '').toLowerCase()) && String(x.url || '').trim())
    .map((x) => ({ platform: String(x.platform).toLowerCase(), url: String(x.url).trim() }));
}
function normaliseSocialLinks(value) {
  const list = parseSocialLinks(value);
  return list.length ? JSON.stringify(list) : null;
}

app.get('/api/employees', authMiddleware, async (req, res) => {
  try {
    const { page = 1, pageSize = 20, search = '' } = req.query;
    const sz = P(pageSize), offset = (P(page) - 1) * sz;
    let where = '', params = [];
    if (search) { where = 'WHERE name LIKE ? OR position LIKE ?'; params = [`%${search}%`, `%${search}%`]; }
    const [count] = await db.query(`SELECT COUNT(*) as cnt FROM employees ${where}`, params);
    const [rows] = await db.query(`SELECT * FROM employees ${where} ORDER BY name LIMIT ? OFFSET ?`, [...params, sz, offset]);
    res.json(paginate(rows.map((r) => ({ ...r, social_links: parseSocialLinks(r.social_links) })), count[0].cnt, page, sz));
  } catch { res.json(EMPTY); }
});
app.post('/api/employees', authMiddleware, async (req, res) => {
  try {
    const { name, position, designation, salary, contact, joinedOn, joined_on } = req.body;
    const socialLinks = normaliseSocialLinks(req.body.socialLinks ?? req.body.social_links);
    const [r] = await db.query('INSERT INTO employees (name,position,designation,salary,contact,joined_on,social_links) VALUES (?,?,?,?,?,?,?)',
      [name, position||'', designation||'', salary||0, contact||'', joinedOn||joined_on||null, socialLinks]);
    res.json({ data: { id: r.insertId, name } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.patch('/api/employees/:id', authMiddleware, async (req, res) => {
  try {
    const { name, position, designation, salary, contact, joinedOn, joined_on } = req.body;
    const socialLinks = normaliseSocialLinks(req.body.socialLinks ?? req.body.social_links);
    await db.query('UPDATE employees SET name=?,position=?,designation=?,salary=?,contact=?,joined_on=?,social_links=? WHERE id=?',
      [name, position||'', designation||'', salary||0, contact||'', joinedOn||joined_on||null, socialLinks, req.params.id]);
    res.json({ success: true });
  } catch { res.json({ success: true }); }
});
app.delete('/api/employees/:id', authMiddleware, async (req, res) => {
  try { await db.query('DELETE FROM employees WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch { res.json({ success: true }); }
});

// â”€â”€â”€ USERS (clinic staff) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/users', authMiddleware, async (req, res) => {
  try {
    const { page = 1, pageSize = 20, search = '' } = req.query;
    const sz = P(pageSize), offset = (P(page) - 1) * sz;
    let where = 'WHERE clinic_id=?', params = [req.clinicId];
    if (search) { where += ' AND (name LIKE ? OR email LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    const [count] = await platConn.query(`SELECT COUNT(*) as cnt FROM users ${where}`, params);
    const [rows] = await platConn.query(`SELECT id,name,username,email,role FROM users ${where} ORDER BY name LIMIT ? OFFSET ?`, [...params, sz, offset]);
    res.json(paginate(rows, count[0].cnt, page, sz));
  } catch { res.json(EMPTY); }
});
app.post('/api/users', authMiddleware, async (req, res) => {
  try {
    const { name, username, email, password, role } = req.body;
    const hash = await bcrypt.hash(password || 'password123', 10);
    const [r] = await platConn.query('INSERT INTO users (name,username,email,password,role,clinic_id) VALUES (?,?,?,?,?,?)',
      [name, username||email, email, hash, role||'USER', req.clinicId]);
    res.json({ data: { id: r.insertId, name } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.patch('/api/users/:id', authMiddleware, async (req, res) => {
  try { const { name, email, role } = req.body; await platConn.query("UPDATE users SET name=?,email=?,role=? WHERE id=? AND clinic_id=?", [name, email, role||'USER', req.params.id, req.clinicId]); res.json({ success: true }); }
  catch { res.json({ success: true }); }
});
app.delete('/api/users/:id', authMiddleware, async (req, res) => {
  try { await platConn.query('DELETE FROM users WHERE id=? AND clinic_id=?', [req.params.id, req.clinicId]); res.json({ success: true }); }
  catch { res.json({ success: true }); }
});

// ─── INVITATIONS ───
// The "Add User" modal in Employees > Users collects only an email, role,
// designation and branch; the invitee sets their own username and password on
// the accept page. These four routes used to be stubs that answered
// {success:true} without writing anything, so an invite was never recorded, the
// Pending list stayed permanently empty, and clinicUsersHandlers'
// toLegacyInvitation threw on the missing row ("Cannot read properties of
// undefined (reading 'id')") - which is why inviting a user always failed.
const INVITATION_TTL_DAYS = 7;
const INVITATION_ROLES = new Set(['OWNER', 'ADMIN', 'USER']);
// Public origin, used to build the accept link inside the invitation email.
const APP_URL = process.env.APP_URL || 'https://podvet.biztrack.uk';

function invitationToken() {
  return crypto.randomBytes(24).toString('hex');
}

function invitationRow(r) {
  return {
    id: r.id, email: r.email, role: r.role, designation: r.designation,
    branchId: r.branch_id, invitedByName: r.invited_by_name || '',
    status: r.status, expiresAt: r.expires_at, createdAt: r.created_at,
  };
}

function invitationEmail({ role, clinicName, inviterName, link }) {
  return {
    subject: `You have been invited to join ${clinicName} on PodVet`,
    html: `<!doctype html><html><body style="margin:0;padding:0;background:#f4f8fb;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f8fb;padding:32px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;border:1px solid #e2e8f0">
        <tr><td style="padding:28px 32px 8px">
          <p style="margin:0 0 20px;font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#1b6ea1">You're invited</p>
          <h1 style="margin:0 0 14px;font-size:22px;line-height:1.3;color:#0d2e50">Join ${clinicName}</h1>
          <p style="margin:0 0 22px;font-size:15px;line-height:1.6;color:#475569">${inviterName || 'A clinic administrator'} invited you to join <strong>${clinicName}</strong> as <strong>${String(role || 'USER').toUpperCase()}</strong>. Choose a username and password to get started.</p>
          <div style="margin:0 0 22px">
            <a href="${link}" style="display:inline-block;padding:14px 28px;background:#1b6ea1;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;border-radius:10px">Accept invitation</a>
          </div>
          <p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#64748b">Or paste this link into your browser:<br><span style="word-break:break-all">${link}</span></p>
          <p style="margin:0;font-size:13px;line-height:1.6;color:#94a3b8">This invitation expires in ${INVITATION_TTL_DAYS} days.</p>
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`,
  };
}

const INVITATION_SELECT = `SELECT i.*, COALESCE(u.name,'') AS invited_by_name, c.clinic_name
  FROM invitations i
  LEFT JOIN users u ON u.id = i.invited_by
  LEFT JOIN clinics c ON c.id = i.clinic_id`;

app.get('/api/invitations', authMiddleware, async (req, res) => {
  try {
    const { page = 1, pageSize = 5, search = '' } = req.query;
    const sz = P(pageSize) || 5, offset = (P(page) - 1) * sz;
    let where = 'WHERE i.clinic_id=?', params = [req.clinicId];
    if (search) { where += ' AND i.email LIKE ?'; params.push(`%${search}%`); }
    const [count] = await platConn.query(`SELECT COUNT(*) AS cnt FROM invitations i ${where}`, params);
    const [rows] = await platConn.query(
      `${INVITATION_SELECT} ${where} ORDER BY i.id DESC LIMIT ? OFFSET ?`, [...params, sz, offset]);
    res.json(paginate(rows.map(invitationRow), count[0].cnt, page, sz));
  } catch (e) { console.error('[invitations GET]', e.message); res.json(EMPTY); }
});

app.post('/api/invitations', authMiddleware, async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: { message: 'A valid email address is required' } });
    }
    const role = String(req.body.role || 'USER').toUpperCase();
    if (!INVITATION_ROLES.has(role)) {
      return res.status(400).json({ error: { message: 'That role is not available for an invitation' } });
    }
    // An admin must not be able to mint an OWNER - that would be a privilege
    // escalation through the invite flow. The caller's own role is read here
    // rather than in authMiddleware, so the common request path stays free of
    // an extra round trip.
    if (role === 'OWNER') {
      const [[me]] = await platConn.query(
        'SELECT role FROM users WHERE id=? AND clinic_id=?', [req.userId, req.clinicId]);
      if (!me || String(me.role || '').toUpperCase() !== 'OWNER') {
        return res.status(403).json({ error: { message: 'Only the clinic owner can invite another owner' } });
      }
    }

    const token = invitationToken();
    const expires = new Date(Date.now() + INVITATION_TTL_DAYS * 864e5);
    // Re-inviting a pending address refreshes the existing row instead of
    // tripping the (clinic_id, email) unique key - which is exactly what the
    // modal's resend button is for.
    await platConn.query(
      `INSERT INTO invitations (clinic_id, email, role, designation, branch_id, invited_by, token, status, expires_at)
       VALUES (?,?,?,?,?,?,?, 'pending', ?)
       ON DUPLICATE KEY UPDATE role=VALUES(role), designation=VALUES(designation),
         branch_id=VALUES(branch_id), invited_by=VALUES(invited_by), token=VALUES(token),
         status='pending', expires_at=VALUES(expires_at), accepted_at=NULL`,
      [req.clinicId, email, role, req.body.designation || null,
        req.body.branchId ?? null, req.userId || null, token, expires]);

    const [rows] = await platConn.query(`${INVITATION_SELECT} WHERE i.clinic_id=? AND i.email=?`, [req.clinicId, email]);
    const inv = rows[0];
    try {
      await sendMail({
        to: email,
        ...invitationEmail({
          role: inv.role, clinicName: inv.clinic_name || 'your clinic',
          inviterName: inv.invited_by_name,
          link: `${APP_URL}/app#/accept-invitation?token=${token}`,
        }),
      });
    } catch (e) {
      // The invitation is recorded either way. A mail failure must not read as
      // "invite failed", or the admin creates a second copy of the same pending
      // row and nobody can tell which one is live.
      console.error('[invitations mail]', e.message);
    }
    res.json({ data: invitationRow(inv) });
  } catch (e) { console.error('[invitations POST]', e.message); res.status(500).json({ error: { message: e.message } }); }
});

app.post('/api/invitations/:id/resend', authMiddleware, async (req, res) => {
  try {
    const token = invitationToken();
    const expires = new Date(Date.now() + INVITATION_TTL_DAYS * 864e5);
    const [r] = await platConn.query(
      `UPDATE invitations SET token=?, status='pending', expires_at=?, accepted_at=NULL
        WHERE id=? AND clinic_id=?`, [token, expires, req.params.id, req.clinicId]);
    if (!r.affectedRows) return res.status(404).json({ error: { message: 'Invitation not found' } });

    const [rows] = await platConn.query(`${INVITATION_SELECT} WHERE i.id=? AND i.clinic_id=?`, [req.params.id, req.clinicId]);
    const inv = rows[0];
    try {
      await sendMail({
        to: inv.email,
        ...invitationEmail({
          role: inv.role, clinicName: inv.clinic_name || 'your clinic',
          inviterName: inv.invited_by_name,
          link: `${APP_URL}/app#/accept-invitation?token=${token}`,
        }),
      });
    } catch (e) { console.error('[invitations resend mail]', e.message); }
    res.json({ success: true, message: 'Invitation resent', data: invitationRow(inv) });
  } catch (e) { console.error('[invitations resend]', e.message); res.status(500).json({ error: { message: e.message } }); }
});

app.delete('/api/invitations/:id', authMiddleware, async (req, res) => {
  try {
    const [r] = await platConn.query(
      `UPDATE invitations SET status='revoked' WHERE id=? AND clinic_id=?`, [req.params.id, req.clinicId]);
    if (!r.affectedRows) return res.status(404).json({ error: { message: 'Invitation not found' } });
    res.json({ success: true, message: 'Invitation revoked' });
  } catch (e) { console.error('[invitations DELETE]', e.message); res.status(500).json({ error: { message: e.message } }); }
});

// The accept page is unauthenticated by necessity - the invitee has no account
// yet - so the single-use token is the entire credential. It is checked with a
// strict shape first, and only ever reveals the invitation's own details.
app.get('/api/invitations/accept/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '');
    if (!/^[a-f0-9]{48}$/.test(token)) return res.status(404).json({ error: { message: 'This invitation link is not valid' } });
    const [rows] = await platConn.query(`${INVITATION_SELECT} WHERE i.token=?`, [token]);
    const inv = rows[0];
    if (!inv) return res.status(404).json({ error: { message: 'This invitation link is not valid' } });
    if (inv.status !== 'pending') return res.status(410).json({ error: { message: `This invitation has already been ${inv.status}` } });
    if (new Date(inv.expires_at).getTime() < Date.now()) return res.status(410).json({ error: { message: 'This invitation has expired' } });
    res.json({
      data: {
        email: inv.email, role: inv.role, designation: inv.designation,
        clinicName: inv.clinic_name, invitedByName: inv.invited_by_name,
      },
    });
  } catch (e) { console.error('[invitations accept GET]', e.message); res.status(500).json({ error: { message: e.message } }); }
});

app.post('/api/invitations/accept/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '');
    if (!/^[a-f0-9]{48}$/.test(token)) return res.status(404).json({ error: { message: 'This invitation link is not valid' } });
    const { name, username, password } = req.body || {};
    if (!String(name || '').trim()) return res.status(400).json({ error: { message: 'Please enter your name' } });
    if (!String(username || '').trim()) return res.status(400).json({ error: { message: 'Please choose a username' } });
    if (String(password || '').length < 8) return res.status(400).json({ error: { message: 'Password must be at least 8 characters' } });

    const [rows] = await platConn.query('SELECT * FROM invitations WHERE token=?', [token]);
    const inv = rows[0];
    if (!inv) return res.status(404).json({ error: { message: 'This invitation link is not valid' } });
    if (inv.status !== 'pending') return res.status(410).json({ error: { message: `This invitation has already been ${inv.status}` } });
    if (new Date(inv.expires_at).getTime() < Date.now()) return res.status(410).json({ error: { message: 'This invitation has expired' } });

    const [dupe] = await platConn.query('SELECT id FROM users WHERE username=? LIMIT 1', [String(username).trim()]);
    if (dupe.length) return res.status(409).json({ error: { message: 'That username is already taken' } });

    const hash = await bcrypt.hash(password, 10);
    // The status flip happens in the same transaction as the user insert, so a
    // leaked link cannot be replayed and a failed insert leaves it usable.
    const conn = await mysql.createConnection({ ...DB_OPTS });
    try {
      await conn.beginTransaction();
      await conn.query(
        `INSERT INTO users (name, username, email, password, role, phone_number, clinic_id)
         VALUES (?,?,?,?,?,?,?)`,
        [String(name).trim(), String(username).trim(), inv.email, hash, inv.role, null, inv.clinic_id]);
      const [flip] = await conn.query(
        `UPDATE invitations SET status='accepted', accepted_at=NOW() WHERE id=? AND status='pending'`, [inv.id]);
      if (!flip.affectedRows) throw new Error('This invitation has already been accepted');
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      await conn.end();
    }
    res.json({ success: true, message: 'Your account is ready, you can sign in now' });
  } catch (e) { console.error('[invitations accept POST]', e.message); res.status(500).json({ error: { message: e.message } }); }
});

// â”€â”€â”€ CLIENTS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/clients', authMiddleware, async (req, res) => {
  try {
    const { page = 1, pageSize = 20, limit = 20, search = '' } = req.query;
    const pg = P(page), sz = P(pageSize) || P(limit) || 20, offset = (pg - 1) * sz;
    let where = '', params = [];
    if (search) { where = 'WHERE c.client_name LIKE ? OR c.contact_number LIKE ?'; params = [`%${search}%`, `%${search}%`]; }
    const [count] = await db.query(`SELECT COUNT(*) as cnt FROM clients c ${where}`, params);
    const [rows] = await db.query(`SELECT c.* FROM clients c ${where} ORDER BY c.client_name LIMIT ? OFFSET ?`, [...params, sz, offset]);
    const data = [];
    for (const c of rows) {
      const [pets] = await db.query('SELECT * FROM pets WHERE client_id=?', [c.id]);
      data.push({ ...toCamel(c), pets: toCamel(pets) });
    }
    res.json({ data, total: count[0].cnt, page: pg, totalPages: Math.ceil(count[0].cnt / sz) });
  } catch { res.json(EMPTY); }
});
app.get('/api/clients/unpaid-summary', authMiddleware, async (req, res) => {
  try { res.json(await unpaidClientSummary('appt', req.query)); } catch { res.json(EMPTY); }
});
app.post('/api/clients', authMiddleware, async (req, res) => {
  try {
    const { clientName, contactNumber, address } = req.body;
    const [r] = await db.query('INSERT INTO clients (client_name,contact_number,address) VALUES (?,?,?)', [clientName, contactNumber||'', address||'']);
    res.json({ data: { id: r.insertId, clientName } });
    notify({ recipientAudience: 'STAFF', title: 'New client added', message: `${clientName || 'Client'}`, category: 'client', priority: 'low', relatedEntityType: 'client', relatedEntityId: r.insertId, eventKey: `client-new-${r.insertId}` });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.post('/api/clients/with-pet', authMiddleware, async (req, res) => {
  try {
    const { client, pet } = req.body;
    const [cr] = await db.query('INSERT INTO clients (client_name,contact_number,address) VALUES (?,?,?)',
      [client.clientName, client.contactNumber||'', client.address||'']);
    let petRow = null;
    if (pet) {
      const [pr] = await db.query('INSERT INTO pets (client_id,pet_name,sex,species,breed,color,date_of_birth,is_neutered,is_microchipped) VALUES (?,?,?,?,?,?,?,?,?)',
        [cr.insertId, pet.petName||'', pet.sex||'Unknown', pet.species||'Dog', pet.breed||'', pet.color||'', pet.dateOfBirth||null, pet.isNeutered?1:0, pet.isMicrochipped?1:0]);
      petRow = { id: pr.insertId, ...pet };
    }
    res.json({ data: { client: { id: cr.insertId, clientName: client.clientName }, pet: petRow } });
    notify({ recipientAudience: 'STAFF', title: 'New client added', message: `${client.clientName || 'Client'}${pet ? ' with ' + (pet.petName || 'a new pet') : ''}`, category: 'client', priority: 'low', relatedEntityType: 'client', relatedEntityId: cr.insertId, eventKey: `client-new-${cr.insertId}` });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.get('/api/clients/:id', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM clients WHERE id=?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: { message: 'Not found', code: 'NOT_FOUND' } });
    const [pets] = await db.query('SELECT * FROM pets WHERE client_id=?', [req.params.id]);
    res.json({ data: { ...toCamel(rows[0]), pets: toCamel(pets) } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.patch('/api/clients/:id', authMiddleware, async (req, res) => {
  try { const { clientName, contactNumber, address } = req.body; await db.query('UPDATE clients SET client_name=?,contact_number=?,address=? WHERE id=?', [clientName, contactNumber||'', address||'', req.params.id]); res.json({ success: true }); }
  catch { res.json({ success: true }); }
});
app.delete('/api/clients/:id', authMiddleware, async (req, res) => {
  try { await db.query('DELETE FROM pets WHERE client_id=?', [req.params.id]); await db.query('DELETE FROM clients WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch { res.json({ success: true }); }
});
app.get('/api/clients/:id/pets', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query('SELECT * FROM pets WHERE client_id=?', [req.params.id]); res.json({ data: toCamel(rows) }); }
  catch { res.json({ data: [] }); }
});
app.post('/api/clients/:id/pets', authMiddleware, async (req, res) => {
  try {
    const d = req.body;
    const [r] = await db.query('INSERT INTO pets (client_id,pet_name,sex,species,breed,color,date_of_birth,age,is_neutered,is_microchipped) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [req.params.id, d.petName||'', d.sex||'Unknown', d.species||'Dog', d.breed||'', d.color||'', d.dateOfBirth||null, d.age||'', d.isNeutered?1:0, d.isMicrochipped?1:0]);
    res.json({ data: { id: r.insertId } });
    notify({ recipientAudience: 'STAFF', title: 'New pet registered', message: `${d.petName || 'A pet'} (${d.species || 'pet'})`, category: 'pet', priority: 'low', relatedEntityType: 'pet', relatedEntityId: r.insertId, eventKey: `pet-new-${r.insertId}` });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
// ── Customer portal access (clinic-created logins) ──────────────────────────
// Self sign-up is disabled, so each clinic creates its customers' portal logins
// here and shares the returned email + password with them.
function generatePortalPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(10);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}
app.get('/api/clients/:id/portal-account', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT id, email, is_active, last_login_at, created_at FROM client_accounts WHERE client_id=? ORDER BY id LIMIT 1', [req.params.id]);
    if (!rows.length) return res.json({ data: { hasAccount: false } });
    const a = rows[0];
    res.json({ data: { hasAccount: true, id: a.id, email: a.email, isActive: !!a.is_active, lastLoginAt: a.last_login_at, createdAt: a.created_at } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.post('/api/clients/:id/portal-account', authMiddleware, async (req, res) => {
  try {
    const [cl] = await db.query('SELECT id, client_name, contact_number FROM clients WHERE id=?', [req.params.id]);
    if (!cl.length) return res.status(404).json({ error: { message: 'Client not found' } });
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    let password = String((req.body && req.body.password) || '');
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: { message: 'Enter a valid email address.' } });
    const generated = !password;
    if (generated) password = generatePortalPassword();
    if (password.length < 6) return res.status(400).json({ error: { message: 'Password must be at least 6 characters.' } });
    const [dup] = await db.query('SELECT id, client_id FROM client_accounts WHERE email=?', [email]);
    if (dup.length && Number(dup[0].client_id) !== Number(req.params.id)) {
      return res.status(409).json({ error: { message: 'That email is already used by another customer.' } });
    }
    const hash = await bcrypt.hash(password, 10);
    const [existing] = await db.query('SELECT id FROM client_accounts WHERE client_id=? ORDER BY id LIMIT 1', [req.params.id]);
    let accountId;
    if (existing.length) {
      accountId = existing[0].id;
      await db.query('UPDATE client_accounts SET email=?, password_hash=?, is_active=1 WHERE id=?', [email, hash, accountId]);
    } else {
      const [r] = await db.query('INSERT INTO client_accounts (client_id, email, password_hash, full_name, phone) VALUES (?,?,?,?,?)',
        [req.params.id, email, hash, cl[0].client_name || null, cl[0].contact_number || null]);
      accountId = r.insertId;
    }
    const clinicId = req.clinicId || 1;
    notify({ recipientAudience: 'STAFF', title: 'Customer portal login ready', message: `${cl[0].client_name || 'Customer'} — ${email}`, category: 'client', priority: 'low', relatedEntityType: 'client', relatedEntityId: Number(req.params.id), eventKey: `client-portal-${accountId}-${Date.now()}` });
    res.json({ success: true, data: { id: accountId, email, password, generated, portalPath: `/portal?c=${clinicId}` } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.get('/api/clients/:id/unpaid-ledger', authMiddleware, async (req, res) => {
  try {
    const [c] = await db.query('SELECT id, client_name, contact_number, address FROM clients WHERE id=?', [req.params.id]);
    if (!c.length) return res.status(404).json({ error: { message: 'Not found' } });
    const appointments = await unpaidAppointmentRows(req.params.id);
    res.json({ data: { clientId: c[0].id, clientName: c[0].client_name, contactNumber: c[0].contact_number, address: c[0].address, totalDue: appointments.reduce((s, a) => s + a.remaining, 0), appointments } });
  } catch { res.json({ data: [] }); }
});
app.get('/api/clients/:id/payment-history', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT b.id, b.invoice_no, b.appointment_id, b.client_id, b.pet_name, b.subtotal, b.discount,
              b.final_total, b.amount_paid, b.status, b.payment_mode, b.coupon_code, b.created_at
       FROM billing b WHERE b.client_id = ? ORDER BY b.created_at DESC, b.id DESC`,
      [req.params.id]
    );
    const [sum] = await db.query(
      `SELECT COUNT(*) AS bills, COALESCE(SUM(final_total),0) AS billed, COALESCE(SUM(amount_paid),0) AS paid,
              COALESCE(SUM(final_total - amount_paid),0) AS balance
       FROM billing WHERE client_id = ?`,
      [req.params.id]
    );
    res.json({
      data: toCamel(rows),
      summary: {
        bills: Number(sum[0].bills) || 0,
        billed: Number(sum[0].billed) || 0,
        paid: Number(sum[0].paid) || 0,
        balance: Number(sum[0].balance) || 0,
      },
    });
  } catch (e) { console.error('[payment-history]', e.message); res.json({ data: [], summary: { bills: 0, billed: 0, paid: 0, balance: 0 } }); }
});
app.post('/api/clients/:id/pay-all', authMiddleware, async (req, res) => {
  try {
    const kindSql = KINDS.appt.sql;
    const [t] = await db.query(`SELECT COALESCE(SUM(final_total - amount_paid),0) AS due FROM billing WHERE client_id = ? AND ${kindSql.replaceAll('b.', '')} AND final_total > amount_paid`, [req.params.id]);
    const [r] = await db.query(`UPDATE billing SET amount_paid = final_total, status = 'PAID' WHERE client_id = ? AND ${kindSql.replaceAll('b.', '')} AND final_total > amount_paid`, [req.params.id]);
    res.json({ data: { appointmentCount: r.affectedRows, totalPaid: Number(t[0].due) || 0 } });
    if (r.affectedRows > 0) notify({ recipientAudience: 'STAFF', title: 'Payment received', message: `Rs ${Number(t[0].due || 0).toLocaleString()} settled for client #${req.params.id}`, category: 'payment', relatedEntityType: 'client', relatedEntityId: Number(req.params.id), eventKey: `payall-${req.params.id}-${Date.now()}` });
  } catch { res.json({ success: false }); }
});

// â”€â”€â”€ PETS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/pets', authMiddleware, async (req, res) => {
  try {
    const { page = 1, pageSize = 20, limit = 20, search = '', clientId } = req.query;
    const pg = P(page), sz = P(pageSize) || P(limit) || 20, offset = (pg - 1) * sz;
    let where = '1=1', params = [];
    if (search) { where += ' AND (p.pet_name LIKE ? OR c.client_name LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    if (clientId) { where += ' AND p.client_id=?'; params.push(clientId); }
    const [count] = await db.query(`SELECT COUNT(*) as cnt FROM pets p JOIN clients c ON p.client_id=c.id WHERE ${where}`, params);
    const [rows] = await db.query(`SELECT p.*, c.client_name, c.contact_number FROM pets p JOIN clients c ON p.client_id=c.id WHERE ${where} ORDER BY p.pet_name LIMIT ? OFFSET ?`, [...params, sz, offset]);
    res.json(paginate(rows, count[0].cnt, pg, sz));
  } catch { res.json(EMPTY); }
});
app.get('/api/pets/species', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query('SELECT DISTINCT species FROM pets WHERE species IS NOT NULL ORDER BY species'); res.json({ data: rows.map(r => r.species) }); }
  catch { res.json({ data: [] }); }
});
app.get('/api/pets/upcoming-birthdays', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.query(`SELECT p.*, c.client_name, c.contact_number FROM pets p JOIN clients c ON p.client_id=c.id WHERE MONTH(p.date_of_birth) = MONTH(CURDATE()) AND DAY(p.date_of_birth) >= DAY(CURDATE()) ORDER BY DAY(p.date_of_birth)`);
    res.json({ data: toCamel(rows) });
  } catch { res.json({ data: [] }); }
});
app.get('/api/pets/:id', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT p.*, c.client_name, c.contact_number FROM pets p JOIN clients c ON p.client_id=c.id WHERE p.id=?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: { message: 'Not found', code: 'NOT_FOUND' } });
    res.json({ data: toCamel(rows[0]) });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.post('/api/pets', authMiddleware, async (req, res) => {
  try {
    const d = req.body;
    const [r] = await db.query('INSERT INTO pets (client_id,pet_name,sex,species,breed,color,date_of_birth,age,is_neutered,is_microchipped) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [d.clientId||d.client_id, d.petName||d.pet_name, d.sex||'Unknown', d.species||'Dog', d.breed||'', d.color||'', d.dateOfBirth||d.date_of_birth||null, d.age||'', d.isNeutered?1:0, d.isMicrochipped?1:0]);
    res.json({ data: { id: r.insertId } });
    notify({ recipientAudience: 'STAFF', title: 'New pet registered', message: `${d.petName||d.pet_name || 'A pet'} (${d.species || 'pet'})`, category: 'pet', priority: 'low', relatedEntityType: 'pet', relatedEntityId: r.insertId, eventKey: `pet-new-${r.insertId}` });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.patch('/api/pets/:id', authMiddleware, async (req, res) => {
  try {
    const d = req.body;
    await db.query('UPDATE pets SET client_id=?,pet_name=?,sex=?,species=?,breed=?,color=?,date_of_birth=?,age=?,is_neutered=?,is_microchipped=?,deceased=? WHERE id=?',
      [d.clientId||d.client_id, d.petName||d.pet_name, d.sex||'Unknown', d.species||'Dog', d.breed||'', d.color||'', d.dateOfBirth||d.date_of_birth||null, d.age||'', d.isNeutered?1:0, d.isMicrochipped?1:0, d.deceased?1:0, req.params.id]);
    res.json({ success: true });
  } catch { res.json({ success: true }); }
});
app.delete('/api/pets/:id', authMiddleware, async (req, res) => {
  try { await db.query('DELETE FROM pets WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch { res.json({ success: true }); }
});

// â”€â”€â”€ SERVICES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/services', authMiddleware, async (req, res) => {
  try {
    const { category, excludeCategory } = req.query;
    let q = 'SELECT * FROM services', params = [], conds = [];
    if (category) { conds.push('category=?'); params.push(category); }
    if (excludeCategory) { conds.push('category!=?'); params.push(excludeCategory); }
    if (conds.length) q += ' WHERE ' + conds.join(' AND ');
    q += ' ORDER BY category, name';
    const [rows] = await db.query(q, params);
    res.json({ data: toCamel(rows) });
  } catch { res.json({ data: [] }); }
});
app.post('/api/services', authMiddleware, async (req, res) => {
  try {
    const { name, category, baseRate, purchasePrice, isGrooming } = req.body;
    const [r] = await db.query('INSERT INTO services (name,category,base_rate,purchase_price,is_grooming) VALUES (?,?,?,?,?)',
      [name, category||'General', baseRate||0, purchasePrice||0, isGrooming?1:0]);
    res.json({ data: { id: r.insertId, name } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.patch('/api/services/:id', authMiddleware, async (req, res) => {
  try {
    const { name, category, baseRate, purchasePrice, isGrooming } = req.body;
    await db.query('UPDATE services SET name=?,category=?,base_rate=?,purchase_price=?,is_grooming=? WHERE id=?',
      [name, category||'General', baseRate||0, purchasePrice||0, isGrooming?1:0, req.params.id]);
    res.json({ success: true });
  } catch { res.json({ success: true }); }
});
app.delete('/api/services/:id', authMiddleware, async (req, res) => {
  try { await db.query('DELETE FROM services WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch { res.json({ success: true }); }
});

// â”€â”€â”€ PRODUCTS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/products', authMiddleware, async (req, res) => {
  try {
    const { page = 1, pageSize = 20, limit = 20, search = '' } = req.query;
    const pg = P(page), sz = P(pageSize) || P(limit) || 20, offset = (pg - 1) * sz;
    let where = '', params = [];
    if (search) { where = 'WHERE p.name LIKE ? OR p.barcode_number LIKE ?'; params = [`%${search}%`, `%${search}%`]; }
    const [count] = await db.query(`SELECT COUNT(*) as cnt FROM products p ${where}`, params);
    const [rows] = await db.query(
      `SELECT p.*, v.vendor_name as vendorName
       FROM products p LEFT JOIN vendors v ON v.id = p.vendor_id
       ${where} ORDER BY p.name LIMIT ? OFFSET ?`, [...params, sz, offset]);
    res.json(paginate(rows, count[0].cnt, pg, sz));
  } catch { res.json(EMPTY); }
});
app.get('/api/products/search', authMiddleware, async (req, res) => {
  try { const { term = '', q = '' } = req.query; const s = term || q;
    const [rows] = await db.query('SELECT * FROM products WHERE quantity > 0 AND name LIKE ? ORDER BY name LIMIT 10', [`%${s}%`]);
    res.json({ data: toCamel(rows) });
  } catch { res.json({ data: [] }); }
});
app.get('/api/products/search-by-category', authMiddleware, async (req, res) => {
  try { const { term = '', category = '' } = req.query;
    let q = 'SELECT * FROM products WHERE quantity > 0', params = [];
    if (term) { q += ' AND name LIKE ?'; params.push(`%${term}%`); }
    if (category) { q += ' AND category=?'; params.push(category); }
    const [rows] = await db.query(q + ' ORDER BY name LIMIT 10', params);
    res.json({ data: toCamel(rows) });
  } catch { res.json({ data: [] }); }
});
app.get('/api/products/find', authMiddleware, async (req, res) => {
  try { const { term = '' } = req.query;
    const [rows] = await db.query('SELECT * FROM products WHERE name LIKE ? OR barcode_number=? ORDER BY name LIMIT 10', [`%${term}%`, term]);
    res.json({ data: rows.length ? toCamel(rows[0]) : null });
  } catch { res.json({ data: null }); }
});
app.get('/api/products/transactions', authMiddleware, async (req, res) => {
  try {
    const { page = 1, pageSize = 10, search } = req.query;
    const pg = P(page) || 1, sz = P(pageSize) || 10;
    let where = 'bi.product_id IS NOT NULL', params = [];
    if (search) {
      where += ' AND (b.customer_name LIKE ? OR b.customer_phone LIKE ? OR b.pet_name LIKE ? OR p.name LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    const [count] = await db.query(
      `SELECT COUNT(*) cnt FROM billing_items bi JOIN billing b ON b.id = bi.billing_id
       LEFT JOIN products p ON p.id = bi.product_id WHERE ${where}`, params);
    const [rows] = await db.query(
      `SELECT bi.id as itemId, bi.billing_id as billingId, bi.product_id as productId,
              COALESCE(bi.name, p.name, '') as productName, bi.quantity, bi.price, bi.total,
              b.created_at as billingDate, b.customer_name as customerName, b.customer_phone as customerPhone,
              b.pet_name as petName, b.invoice_no as invoiceNo
       FROM billing_items bi JOIN billing b ON b.id = bi.billing_id
       LEFT JOIN products p ON p.id = bi.product_id
       WHERE ${where} ORDER BY bi.id DESC LIMIT ? OFFSET ?`,
      [...params, sz, (pg - 1) * sz]);
    const items = rows.map((r) => {
      const dt = r.billingDate ? new Date(r.billingDate) : null;
      return {
        ...r,
        billingDate: dt ? dt.toISOString().slice(0, 10) : null,
        billingTime: dt ? dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : null,
        linkedAppointmentCount: 0,
      };
    });
    res.json(paginate(items, count[0].cnt, pg, sz));
  } catch (e) { console.error('[products/transactions]', e.message); res.json(EMPTY); }
});
app.post('/api/products/transactions/:id/return', authMiddleware, (req, res) => res.json({ success: true }));
app.post('/api/products', authMiddleware, async (req, res) => {
  try {
    const { barcodeNumber, name, price, quantity, category, vendorId, vendorSharePercentage, vendorCreditPercent, vendorClinicFixedPerUnit } = req.body;
    const [r] = await db.query('INSERT INTO products (barcode_number,name,price,quantity,category,vendor_id,vendor_share_percentage,vendor_credit_percent,vendor_clinic_fixed_per_unit) VALUES (?,?,?,?,?,?,?,?,?)',
      [barcodeNumber || '', name, price || 0, quantity || 0, category || '', vendorId || null, vendorSharePercentage ?? null, vendorCreditPercent ?? null, vendorClinicFixedPerUnit ?? null]);
    res.json({ data: { id: r.insertId } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.patch('/api/products/:id', authMiddleware, async (req, res) => {
  try {
    const { barcodeNumber, name, price, quantity, category, vendorId, vendorSharePercentage, vendorCreditPercent, vendorClinicFixedPerUnit } = req.body;
    await db.query('UPDATE products SET barcode_number=?,name=?,price=?,quantity=?,category=?,vendor_id=?,vendor_share_percentage=?,vendor_credit_percent=?,vendor_clinic_fixed_per_unit=? WHERE id=?',
      [barcodeNumber || '', name, price || 0, quantity || 0, category || '', vendorId || null, vendorSharePercentage ?? null, vendorCreditPercent ?? null, vendorClinicFixedPerUnit ?? null, req.params.id]);
    res.json({ success: true });
    const qty = Number(quantity || 0);
    if (qty <= 5) notify({ recipientAudience: 'STAFF', title: qty <= 0 ? 'Product out of stock' : 'Low stock alert', message: `${name || 'Product'} — ${qty <= 0 ? 'out of stock' : qty + ' left'}.`, category: 'inventory', priority: qty <= 0 ? 'high' : 'normal', relatedEntityType: 'product', relatedEntityId: Number(req.params.id), eventKey: `lowstock-${req.params.id}-${qty}` });
  } catch { res.json({ success: true }); }
});
app.delete('/api/products/:id', authMiddleware, async (req, res) => {
  try { await db.query('DELETE FROM products WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch { res.json({ success: true }); }
});

// â”€â”€â”€ VENDORS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/vendors', authMiddleware, async (req, res) => {
  try {
    const { page = 1, pageSize = 100, search } = req.query; const pg = P(page), sz = P(pageSize) || 50;
    let where = '1=1', params = [];
    if (search) { where += ' AND (v.vendor_name LIKE ? OR v.contact_person LIKE ? OR v.contact_number LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
    const [count] = await db.query(`SELECT COUNT(*) as cnt FROM vendors v WHERE ${where}`, params);
    const [rows] = await db.query(
      `SELECT v.*,
        COALESCE(agg.units_sold, 0) as unitsSoldLifetime,
        COALESCE(agg.gross_sales, 0) as grossSalesLifetime,
        COALESCE(agg.vendor_share, 0) as outstandingPayable,
        COALESCE(sett.settled_share, 0) as settledVendorShare,
        COALESCE(sett.settled_gross, 0) as settledGrossSales,
        COALESCE(sett.count, 0) as settlementsCount
       FROM vendors v
       LEFT JOIN (
         SELECT p.vendor_id, SUM(bi.quantity) as units_sold, SUM(bi.total) as gross_sales,
                SUM(CASE WHEN p.vendor_share_percentage IS NOT NULL THEN bi.total * p.vendor_share_percentage / 100
                         ELSE COALESCE(bi.total,0) END) as vendor_share
         FROM billing_items bi JOIN billing b ON b.id = bi.billing_id
         LEFT JOIN products p ON p.id = bi.product_id
         WHERE bi.product_id IS NOT NULL AND p.vendor_id IS NOT NULL
         GROUP BY p.vendor_id
       ) agg ON agg.vendor_id = v.id
       LEFT JOIN (
         SELECT vendor_id, SUM(vendor_share) as settled_share, SUM(gross_sales) as settled_gross, COUNT(*) as count
         FROM vendor_settlements GROUP BY vendor_id
       ) sett ON sett.vendor_id = v.id
       WHERE ${where} ORDER BY v.id DESC LIMIT ? OFFSET ?`,
      [...params, sz, (pg - 1) * sz]);
    // Products bought from each vendor + total purchase value, so the vendors
    // table can show Product / Price columns without a per-row round trip.
    const vids = rows.map((r) => r.id);
    const pMap = {};
    if (vids.length) {
      const [pit] = await db.query(
        `SELECT vp.vendor_id, vpi.item_name, vpi.line_total
         FROM vendor_purchase_items vpi JOIN vendor_purchases vp ON vp.id = vpi.purchase_id
         WHERE vp.vendor_id IN (${vids.map(() => '?').join(',')}) ORDER BY vpi.id`, vids);
      for (const it of pit) {
        const m = pMap[it.vendor_id] || (pMap[it.vendor_id] = { names: [], total: 0 });
        if (it.item_name && !m.names.includes(it.item_name)) m.names.push(it.item_name);
        m.total += Number(it.line_total || 0);
      }
    }
    for (const r of rows) { const m = pMap[r.id]; r.products = m ? m.names : []; r.purchase_total = m ? +m.total.toFixed(2) : 0; }
    res.json(paginate(rows, count[0].cnt, pg, sz));
  } catch (e) { console.error('[vendors]', e.message); res.json(EMPTY); }
});
app.get('/api/vendors/settlements', authMiddleware, async (req, res) => {
  try {
    const { page = 1, pageSize = 100, vendorId } = req.query;
    const pg = P(page), sz = P(pageSize) || 50;
    let where = '1=1', params = [];
    if (vendorId) { where += ' AND vendor_id = ?'; params.push(Number(vendorId)); }
    const [count] = await db.query(`SELECT COUNT(*) cnt FROM vendor_settlements WHERE ${where}`, params);
    const [rows] = await db.query(
      `SELECT vs.*, v.vendor_name as vendorName
       FROM vendor_settlements vs LEFT JOIN vendors v ON v.id = vs.vendor_id
       WHERE ${where} ORDER BY vs.id DESC LIMIT ? OFFSET ?`, [...params, sz, (pg - 1) * sz]);
    res.json(paginate(rows, count[0].cnt, pg, sz));
  } catch (e) { console.error('[vendors/settlements]', e.message); res.json(EMPTY); }
});
app.get('/api/vendors/consignment-period-summary', authMiddleware, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      return res.json({ data: { vendors: [], grandTotal: { grossSales: 0, clinicAmount: 0, vendorOwed: 0, unitsSold: 0 } } });
    }
    const [rows] = await db.query(
      `SELECT v.id as vendorId, v.vendor_name as vendorName,
              COALESCE(SUM(bi.quantity),0) as unitsSold,
              COALESCE(SUM(bi.total),0) as grossSales,
              COALESCE(SUM(CASE WHEN p.vendor_share_percentage IS NOT NULL
                                THEN bi.total * p.vendor_share_percentage / 100 ELSE bi.total END),0) as vendorOwed,
              COALESCE(SUM(bi.total),0) - COALESCE(SUM(CASE WHEN p.vendor_share_percentage IS NOT NULL
                                THEN bi.total * p.vendor_share_percentage / 100 ELSE bi.total END),0) as clinicAmount
       FROM billing_items bi JOIN billing b ON b.id = bi.billing_id
       LEFT JOIN products p ON p.id = bi.product_id
       JOIN vendors v ON v.id = p.vendor_id
       WHERE bi.product_id IS NOT NULL AND p.vendor_id IS NOT NULL
         AND DATE(b.created_at) BETWEEN ? AND ?
       GROUP BY v.id, v.vendor_name`,
      [startDate, endDate]);
    const vendors = toCamel(rows);
    const grandTotal = {
      grossSales: vendors.reduce((s, x) => s + Number(x.grossSales || 0), 0),
      clinicAmount: vendors.reduce((s, x) => s + Number(x.clinicAmount || 0), 0),
      vendorOwed: vendors.reduce((s, x) => s + Number(x.vendorOwed || 0), 0),
      unitsSold: vendors.reduce((s, x) => s + Number(x.unitsSold || 0), 0),
    };
    res.json({ data: { vendors, grandTotal } });
  } catch (e) { console.error('[vendors/consignment-period-summary]', e.message); res.json({ data: { vendors: [], grandTotal: { grossSales: 0, clinicAmount: 0, vendorOwed: 0, unitsSold: 0 } } }); }
});
app.post('/api/vendors', authMiddleware, async (req, res) => {
  try {
    const d = req.body;
    const nz = (v) => (v === '' || v === undefined ? null : v);
    const [r] = await db.query('INSERT INTO vendors (vendor_name,contact_person,contact_number,email,address,city,website,category,notes,is_active,manual_sales,manual_vendor_share,manual_clinic_profit,manual_settled,manual_remaining,manual_settlement_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [d.vendorName || d.name || '', d.contactPerson || null, d.contactNumber || d.contact || null, d.email || null, d.address || null, d.city || null, d.website || null, d.category || null, d.notes || null, d.isActive === undefined ? 1 : (d.isActive ? 1 : 0), nz(d.manualSales), nz(d.manualVendorShare), nz(d.manualClinicProfit), nz(d.manualSettled), nz(d.manualRemaining), nz(d.manualSettlementStatus)]);
    res.json({ data: { id: r.insertId, ...d } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.patch('/api/vendors/:id', authMiddleware, async (req, res) => {
  try { const d = req.body;
    const nz = (v) => (v === '' || v === undefined ? null : v);
    await db.query('UPDATE vendors SET vendor_name=?,contact_person=?,contact_number=?,email=?,address=?,city=?,website=?,category=?,notes=?,is_active=?,manual_sales=?,manual_vendor_share=?,manual_clinic_profit=?,manual_settled=?,manual_remaining=?,manual_settlement_status=? WHERE id=?',
      [d.vendorName || d.name || '', d.contactPerson ?? null, d.contactNumber ?? null, d.email ?? null, d.address ?? null, d.city ?? null, d.website ?? null, d.category ?? null, d.notes ?? null, d.isActive === undefined ? 1 : (d.isActive ? 1 : 0), nz(d.manualSales), nz(d.manualVendorShare), nz(d.manualClinicProfit), nz(d.manualSettled), nz(d.manualRemaining), nz(d.manualSettlementStatus), req.params.id]);
    res.json({ success: true }); } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.delete('/api/vendors/:id', authMiddleware, async (req, res) => {
  try { await db.query('DELETE FROM vendors WHERE id=?', [req.params.id]); res.json({ success: true }); } catch { res.json({ success: true }); }
});
app.get('/api/vendors/:id/settlement-preview', authMiddleware, async (req, res) => {
  try {
    const vendorId = Number(req.params.id);
    const { startDate, endDate } = req.query;
    let dateFilter = '', params = [];
    if (startDate && endDate) { dateFilter = ' AND DATE(b.created_at) BETWEEN ? AND ?'; params.push(startDate, endDate); }
    const [items] = await db.query(
      `SELECT p.id as productId, p.name as productName,
              COALESCE(SUM(bi.quantity),0) as unitsSold,
              COALESCE(SUM(bi.total),0) as grossSales,
              COALESCE(SUM(CASE WHEN p.vendor_share_percentage IS NOT NULL
                                THEN bi.total * p.vendor_share_percentage / 100 ELSE bi.total END),0) as vendorShare,
              COALESCE(SUM(bi.total),0) - COALESCE(SUM(CASE WHEN p.vendor_share_percentage IS NOT NULL
                                THEN bi.total * p.vendor_share_percentage / 100 ELSE bi.total END),0) as clinicShare
       FROM billing_items bi JOIN billing b ON b.id = bi.billing_id
       LEFT JOIN products p ON p.id = bi.product_id
       WHERE bi.product_id IS NOT NULL AND p.vendor_id = ?${dateFilter}
       GROUP BY p.id, p.name`,
      [vendorId].concat(params));
    const itemRows = toCamel(items);
    const totals = {
      unitsSold: itemRows.reduce((s, x) => s + Number(x.unitsSold || 0), 0),
      grossSales: itemRows.reduce((s, x) => s + Number(x.grossSales || 0), 0),
      vendorShare: itemRows.reduce((s, x) => s + Number(x.vendorShare || 0), 0),
      clinicShare: itemRows.reduce((s, x) => s + Number(x.clinicShare || 0), 0),
    };
    res.json({ data: { items: itemRows, totals, totalPayable: totals.vendorShare } });
  } catch (e) { console.error('[vendors/:id/settlement-preview]', e.message); res.json({ data: { items: [], totals: { unitsSold: 0, grossSales: 0, vendorShare: 0, clinicShare: 0 }, totalPayable: 0 } }); }
});
app.post('/api/vendors/:id/settlements', authMiddleware, async (req, res) => {
  try {
    const vendorId = Number(req.params.id);
    const { startDate, endDate, notes } = req.body;
    let dateFilter = '', params = [];
    if (startDate && endDate) { dateFilter = ' AND DATE(b.created_at) BETWEEN ? AND ?'; params.push(startDate, endDate); }
    const [rows] = await db.query(
      `SELECT COALESCE(SUM(bi.quantity),0) as grossUnits, COALESCE(SUM(bi.total),0) as grossSales,
              COALESCE(SUM(CASE WHEN p.vendor_share_percentage IS NOT NULL
                                THEN bi.total * p.vendor_share_percentage / 100 ELSE bi.total END),0) as vendorShare,
              COALESCE(SUM(bi.total),0) - COALESCE(SUM(CASE WHEN p.vendor_share_percentage IS NOT NULL
                                THEN bi.total * p.vendor_share_percentage / 100 ELSE bi.total END),0) as clinicShare
       FROM billing_items bi JOIN billing b ON b.id = bi.billing_id
       LEFT JOIN products p ON p.id = bi.product_id
       WHERE bi.product_id IS NOT NULL AND p.vendor_id = ?${dateFilter}`,
      [vendorId].concat(params));
    const r = rows[0];
    const vendorShare = Number(r.vendorShare || 0), grossSales = Number(r.grossSales || 0);
    const clinicShare = Number(r.clinicShare || 0);
    await db.query('INSERT INTO vendor_settlements (vendor_id, start_date, end_date, gross_sales, clinic_share, vendor_share, notes) VALUES (?,?,?,?,?,?,?)',
      [vendorId, startDate || null, endDate || null, grossSales, clinicShare, vendorShare, notes || null]);
    res.json({ success: true, data: { id: null } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.get('/api/vendors/:id/settlements', authMiddleware, async (req, res) => {
  try {
    const vendorId = Number(req.params.id);
    const [rows] = await db.query(
      `SELECT vs.*, v.vendor_name as vendorName FROM vendor_settlements vs
       LEFT JOIN vendors v ON v.id = vs.vendor_id WHERE vs.vendor_id = ? ORDER BY vs.id DESC`,
      [vendorId]);
    res.json(paginate(rows, rows.length, 1, 100));
  } catch { res.json(EMPTY); }
});

// ── VENDOR PURCHASES (stock bought from a vendor) ────────────────────────────
// Distinct from vendor_settlements (what consignment sales owe the vendor):
// this is stock the clinic bought, and saving one adds the linked products'
// quantity back to inventory. Deleting it reverses exactly that addition.
async function loadVendorPurchases(vendorId) {
  const [rows] = await db.query(
    'SELECT * FROM vendor_purchases WHERE vendor_id=? ORDER BY purchase_date DESC, id DESC', [vendorId]);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [items] = await db.query(
    `SELECT i.*, p.name as product_name FROM vendor_purchase_items i
     LEFT JOIN products p ON p.id = i.product_id
     WHERE i.purchase_id IN (${ids.map(() => '?').join(',')}) ORDER BY i.id`, ids);
  const byPurchase = {};
  for (const it of items) { (byPurchase[it.purchase_id] = byPurchase[it.purchase_id] || []).push(toCamel(it)); }
  return rows.map((r) => ({ ...toCamel(r), items: byPurchase[r.id] || [] }));
}
app.get('/api/vendors/:id/purchases', authMiddleware, async (req, res) => {
  try {
    const list = await loadVendorPurchases(Number(req.params.id));
    res.json(paginate(list, list.length, 1, 100));
  } catch (e) { console.error('[vendors/:id/purchases]', e.message); res.json(EMPTY); }
});
app.post('/api/vendors/:id/purchases', authMiddleware, async (req, res) => {
  try {
    const vendorId = Number(req.params.id);
    const d = req.body || {};
    const raw = Array.isArray(d.items) ? d.items : [];
    const lines = raw.map((it) => {
      const quantity = Math.max(1, Math.round(Number(it.quantity ?? it.qty) || 0));
      const unitPrice = Math.max(0, Number(it.unitPrice ?? it.unit_price ?? 0) || 0);
      const productId = it.productId ?? it.product_id ?? null;
      const itemName = String(it.itemName ?? it.item_name ?? it.name ?? '').trim();
      return { productId: productId ? Number(productId) : null, itemName, quantity, unitPrice, lineTotal: +(quantity * unitPrice).toFixed(2) };
    }).filter((l) => l.itemName);
    if (!lines.length) return res.status(400).json({ error: { message: 'Add at least one item to the purchase.' } });
    const paymentStatus = ['paid', 'partial', 'due'].includes(String(d.paymentStatus || '').toLowerCase())
      ? String(d.paymentStatus).toLowerCase() : 'paid';
    const totalAmount = +lines.reduce((s, l) => s + l.lineTotal, 0).toFixed(2);
    const purchaseDate = /^\d{4}-\d{2}-\d{2}$/.test(String(d.purchaseDate || '')) ? d.purchaseDate : new Date().toISOString().slice(0, 10);
    const [r] = await db.query(
      'INSERT INTO vendor_purchases (vendor_id, purchase_date, payment_status, total_amount, notes) VALUES (?,?,?,?,?)',
      [vendorId, purchaseDate, paymentStatus, totalAmount, d.notes || null]);
    for (const l of lines) {
      await db.query(
        'INSERT INTO vendor_purchase_items (purchase_id, product_id, item_name, quantity, unit_price, line_total) VALUES (?,?,?,?,?,?)',
        [r.insertId, l.productId, l.itemName, l.quantity, l.unitPrice, l.lineTotal]);
      // Stock in: only a line that names an existing product moves inventory.
      if (l.productId) await db.query('UPDATE products SET quantity = quantity + ? WHERE id = ?', [l.quantity, l.productId]);
    }
    res.json({ data: { id: r.insertId, vendorId, purchaseDate, paymentStatus, totalAmount } });
  } catch (e) { console.error('[vendors/:id/purchases POST]', e.message); res.status(500).json({ error: { message: e.message } }); }
});
app.delete('/api/vendors/:id/purchases/:purchaseId', authMiddleware, async (req, res) => {
  try {
    const purchaseId = Number(req.params.purchaseId);
    const [items] = await db.query('SELECT product_id, quantity FROM vendor_purchase_items WHERE purchase_id = ?', [purchaseId]);
    const [del] = await db.query('DELETE FROM vendor_purchases WHERE id = ? AND vendor_id = ?', [purchaseId, Number(req.params.id)]);
    if (!del.affectedRows) return res.status(404).json({ error: { message: 'Purchase not found.' } });
    // Take back only what this purchase added, and never below zero: stock may
    // have been sold (or manually corrected) since it was recorded.
    for (const it of items) {
      if (it.product_id) await db.query('UPDATE products SET quantity = GREATEST(0, quantity - ?) WHERE id = ?', [it.quantity, it.product_id]);
    }
    res.json({ success: true });
  } catch (e) { console.error('[vendors/:id/purchases DELETE]', e.message); res.status(500).json({ error: { message: e.message } }); }
});

// â”€â”€â”€ COUPONS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/coupons', authMiddleware, async (req, res) => {
  try { const { page = 1, pageSize = 5, search } = req.query; const pg = P(page) || 1, sz = P(pageSize) || 5;
    let where = '1=1', params = [];
    if (search) { where += ' AND code LIKE ?'; params.push(`%${search}%`); }
    const [count] = await db.query(`SELECT COUNT(*) as cnt FROM coupons WHERE ${where}`, params);
    const [rows] = await db.query(`SELECT * FROM coupons WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, sz, (pg - 1) * sz]);
    res.json(paginate(rows, count[0].cnt, pg, sz));
  } catch { res.json(EMPTY); }
});
app.post('/api/coupons', authMiddleware, async (req, res) => {
  try {
    const d = req.body;
    const dType = d.discountType || d.discount_type || 'PERCENT';
    const dVal = Number(d.discountValue ?? d.discount_value ?? 0);
    const [r] = await db.query('INSERT INTO coupons (code,discount_type,discount_value,start_date,expiry_date,usage_limit,is_active) VALUES (?,?,?,?,?,?,?)',
      [d.code||'', dType==='PERCENTAGE'?'PERCENT':(dType==='FIXED'?'FIXED':'PERCENT'), dVal, d.startDate || d.start_date || null, d.expiryDate || d.expiry_date || null, d.usageLimit || d.usage_limit || 0, d.isActive === undefined ? (d.is_active_status === undefined ? 1 : (d.is_active_status ? 1 : 0)) : (d.isActive ? 1 : 0)]);
    res.json({ data: { id: r.insertId, discountType: dType==='PERCENTAGE'?'PERCENT':dType, discountValue: dVal, ...d } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.patch('/api/coupons/:id', authMiddleware, async (req, res) => {
  try { const d = req.body;
    await db.query('UPDATE coupons SET code=?,discount_type=?,discount_value=?,start_date=?,expiry_date=?,usage_limit=?,is_active=? WHERE id=?',
      [d.code || '', d.discountType === 'PERCENTAGE' ? 'PERCENT' : (d.discountType === 'FIXED' ? 'FIXED' : 'PERCENT'), d.discountValue || 0, d.startDate || null, d.expiryDate || null, d.usageLimit || 0, d.isActive === undefined ? 1 : (d.isActive ? 1 : 0), req.params.id]);
    res.json({ success: true }); } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.delete('/api/coupons/:id', authMiddleware, async (req, res) => {
  try { await db.query('DELETE FROM coupons WHERE id=?', [req.params.id]); res.json({ success: true }); } catch { res.json({ success: true }); }
});
app.post('/api/coupons/apply', authMiddleware, async (req, res) => {
  try {
    const { code, total, subtotal } = req.body;
    const [rows] = await db.query('SELECT * FROM coupons WHERE code=?', [code||'']);
    if (!rows.length) return res.json({ data: { discountValue: 0, couponId: null, discountType: null } });
    const c = rows[0];
    const amt = Number(total) || Number(subtotal) || 0;
    const dv = c.discount_type === 'FIXED' ? (amt > 0 ? Math.min(c.discount_value, amt) : c.discount_value) : (amt > 0 ? Math.round(amt * c.discount_value / 100 * 100) / 100 : c.discount_value);
    res.json({ data: { discountValue: dv, couponId: c.id, discountType: c.discount_type, rawDiscountValue: c.discount_value } });
  } catch { res.json({ data: { discountValue: 0, couponId: null, discountType: null } }); }
});

// â”€â”€â”€ APPOINTMENTS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/appointments', authMiddleware, async (req, res) => {
  try {
    const { page = 1, pageSize = 50, limit = 50, search = '', date, status, startDate, endDate } = req.query;
    const pg = P(page), sz = P(pageSize) || P(limit) || 50, offset = (pg - 1) * sz;
    let where = '1=1', params = [];
    if (search) { where += ' AND (c.client_name LIKE ? OR p.pet_name LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    if (date) { where += ' AND a.appointment_date=?'; params.push(date); }
    if (startDate) { where += ' AND a.appointment_date>=?'; params.push(startDate); }
    if (endDate) { where += ' AND a.appointment_date<=?'; params.push(endDate); }
    if (status) { where += ' AND a.status=?'; params.push(status); }
    const [count] = await db.query(`SELECT COUNT(*) as cnt FROM appointments a JOIN clients c ON a.client_id=c.id JOIN pets p ON a.pet_id=p.id WHERE ${where}`, params);
    const [rows] = await db.query(`SELECT a.*, c.client_name, c.contact_number, p.pet_name, p.species, p.breed, (SELECT COALESCE(SUM(quantity*rate),0) FROM appointment_services WHERE appointment_id=a.id) as total_amount FROM appointments a JOIN clients c ON a.client_id=c.id JOIN pets p ON a.pet_id=p.id WHERE ${where} ORDER BY a.appointment_date DESC, a.appointment_time DESC LIMIT ? OFFSET ?`, [...params, sz, offset]);
    for (const a of rows) {
      const [svcs] = await db.query('SELECT * FROM appointment_services WHERE appointment_id=?', [a.id]);
      a.services = svcs;
    }
    res.json(paginate(rows, count[0].cnt, pg, sz));
  } catch { res.json(EMPTY); }
});
app.post('/api/appointments', authMiddleware, async (req, res) => {
  try {
    const d = req.body;
    let clientId = d.clientId || d.client_id || null;
    if (!clientId && (d.petId || d.pet_id)) {
      const [prows] = await db.query('SELECT client_id FROM pets WHERE id=?', [d.petId || d.pet_id]);
      if (prows.length) clientId = prows[0].client_id;
    }
    const [r] = await db.query('INSERT INTO appointments (pet_id,client_id,appointment_date,appointment_time,notes,status,doctor) VALUES (?,?,?,?,?,?,?)',
      [d.petId||d.pet_id, clientId, d.appointmentDate||d.appointment_date, d.appointmentTime||d.appointment_time||null, d.notes||'', d.status||'CONFIRMED', d.doctor||'']);
    if (d.services && d.services.length) {
      for (const s of d.services) {
        await db.query('INSERT INTO appointment_services (appointment_id,service_id,service_name,quantity,rate,notes) VALUES (?,?,?,?,?,?)',
          [r.insertId, s.serviceId||null, s.serviceName||s.name||'', s.quantity||1, s.rate||s.baseRate||0, s.notes||'']);
      }
    }
    res.json({ data: { id: r.insertId, isNewClient: false, firstTimeFee: 1050 } });
    notify({ recipientAudience: 'STAFF', title: 'New appointment booked', message: `${d.petName || 'A pet'} — ${d.appointmentDate || d.appointment_date || ''} ${d.appointmentTime || d.appointment_time || ''}`.trim(), category: 'appointment', priority: 'normal', relatedEntityType: 'appointment', relatedEntityId: r.insertId, eventKey: `appt-booked-${r.insertId}` });
    if (clientId) notify({ recipientAudience: 'CLIENT', recipientClientId: clientId, title: 'Appointment booked', message: `Your appointment is scheduled for ${d.appointmentDate || d.appointment_date || ''} ${d.appointmentTime || d.appointment_time || ''}`.trim(), category: 'appointment', relatedEntityType: 'appointment', relatedEntityId: r.insertId, actionUrl: `/portal/appointments`, eventKey: `appt-booked-client-${r.insertId}` });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.get('/api/appointments/:id/for-billing', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT a.*, c.client_name, c.contact_number, p.pet_name FROM appointments a JOIN clients c ON a.client_id=c.id JOIN pets p ON a.pet_id=p.id WHERE a.id=?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: { message: 'Not found', code: 'NOT_FOUND' } });
    const [svcs] = await db.query('SELECT * FROM appointment_services WHERE appointment_id=?', [req.params.id]);
    rows[0].services = toCamel(svcs);
    rows[0].totalAmount = svcs.reduce((s, x) => s + Number(x.quantity || 1) * Number(x.rate || 0), 0);
    rows[0].serviceCosts = rows[0].totalAmount;
    const [fr] = await db.query('SELECT COUNT(*) AS c FROM clients WHERE id=?', [rows[0].client_id]);
    rows[0].firstTimeFee = 0;
    res.json({ data: toCamel(rows[0]) });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.get('/api/appointments/:id/invoice-payload', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT a.*, c.client_name, c.contact_number, p.pet_name FROM appointments a JOIN clients c ON a.client_id=c.id JOIN pets p ON a.pet_id=p.id WHERE a.id=?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: { message: 'Not found', code: 'NOT_FOUND' } });
    const [svcs] = await db.query('SELECT * FROM appointment_services WHERE appointment_id=?', [req.params.id]);
    const a = rows[0];
    res.json({ data: { ...toCamel(a), lineItems: svcs.map(s => ({ label: s.service_name, cartQty: s.quantity, price: s.rate, total: s.quantity * s.rate })), subtotal: svcs.reduce((s,x) => s + x.quantity * x.rate, 0), couponDiscount: 0, manualDiscount: 0, finalTotal: svcs.reduce((s,x) => s + x.quantity * x.rate, 0), totalPaid: 0, remaining: svcs.reduce((s,x) => s + x.quantity * x.rate, 0), invoiceNo: 'INV-' + a.id } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.get('/api/appointments/:id/payment-details', authMiddleware, async (req, res) => {
  try {
    if (!/^\d+$/.test(String(req.params.id))) return res.json({ data: { payments: [], appointment: null, totalDue: 0, totalPaid: 0, remaining: 0 } });
    const [arows] = await db.query('SELECT a.*, c.client_name, c.contact_number, p.pet_name FROM appointments a JOIN clients c ON a.client_id=c.id JOIN pets p ON a.pet_id=p.id WHERE a.id=?', [req.params.id]);
    if (!arows.length) return res.status(404).json({ error: { message: 'Not found', code: 'NOT_FOUND' } });
    const [brows] = await db.query('SELECT * FROM billing WHERE appointment_id=?', [req.params.id]);
    const a = toCamel(arows[0]);
    const [srows] = await db.query('SELECT COALESCE(SUM(quantity*rate),0) as total FROM appointment_services WHERE appointment_id=?', [req.params.id]);
    const total = Number(srows[0].total) || 0;
    const amountPaid = brows.reduce((s, b) => s + Number(b.amount_paid || 0), 0);
    const totalDue = total || amountPaid;
    res.json({ data: {
      payments: toCamel(brows).map(b => ({ id: b.id, amount: Number(b.amountPaid || 0), paymentMode: b.paymentMode, paidAt: b.createdAt })),
      appointment: { id: a.id, petName: a.petName, clientName: a.clientName, contactNumber: a.contactNumber, doctor: a.doctor, appointmentDate: a.appointmentDate, appointmentTime: a.appointmentTime, totalAmount: totalDue, firstTimeFee: 0, billingStatus: amountPaid >= totalDue && amountPaid > 0 ? 'PAID' : (amountPaid > 0 ? 'PARTIALLY_PAID' : 'UNPAID'), billingId: null },
      totalDue, totalPaid: amountPaid, remaining: Math.max(totalDue - amountPaid, 0),
    } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.patch('/api/appointments/:id', authMiddleware, async (req, res) => {
  try {
    const d = req.body;
    await db.query('UPDATE appointments SET pet_id=?,client_id=?,appointment_date=?,appointment_time=?,notes=?,status=?,doctor=? WHERE id=?',
      [d.petId||d.pet_id, d.clientId||d.client_id, d.appointmentDate||d.appointment_date, d.appointmentTime||d.appointment_time||null, d.notes||'', d.status||'CONFIRMED', d.doctor||'', req.params.id]);
    res.json({ success: true });
  } catch { res.json({ success: true }); }
});
app.delete('/api/appointments/:id', authMiddleware, async (req, res) => {
  try { await db.query('DELETE FROM appointment_services WHERE appointment_id=?', [req.params.id]); await db.query('DELETE FROM appointments WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch { res.json({ success: true }); }
});
app.patch('/api/appointments/:id/status', authMiddleware, async (req, res) => {
  try {
    await db.query('UPDATE appointments SET status=? WHERE id=?', [req.body.status, req.params.id]);
    res.json({ success: true });
    const status = String(req.body.status || '').toUpperCase();
    if (status === 'CANCELLED' || status === 'COMPLETED' || status === 'CONFIRMED') {
      try {
        const [a] = await db.query('SELECT a.id, a.client_id, p.pet_name, a.appointment_date FROM appointments a LEFT JOIN pets p ON a.pet_id=p.id WHERE a.id=?', [req.params.id]);
        if (a.length) {
          const label = status === 'CANCELLED' ? 'cancelled' : status === 'COMPLETED' ? 'completed' : 'confirmed';
          notify({ recipientAudience: 'STAFF', title: `Appointment ${label}`, message: `${a[0].pet_name || 'Appointment'} #${a[0].id}`, category: 'appointment', relatedEntityType: 'appointment', relatedEntityId: a[0].id, eventKey: `appt-status-${a[0].id}-${status}` });
          if (a[0].client_id) notify({ recipientAudience: 'CLIENT', recipientClientId: a[0].client_id, title: `Appointment ${label}`, message: `Your appointment for ${a[0].pet_name || 'your pet'}${a[0].appointment_date ? ' on ' + new Date(a[0].appointment_date).toISOString().slice(0, 10) : ''} has been ${label}.`, category: 'appointment', relatedEntityType: 'appointment', relatedEntityId: a[0].id, actionUrl: '/portal/appointments', eventKey: `appt-status-client-${a[0].id}-${status}` });
        }
      } catch (_) {}
    }
  }
  catch { res.json({ success: true }); }
});
app.patch('/api/appointments/:id/payment-status', authMiddleware, (req, res) => res.json({ success: true }));
app.post('/api/appointments/:id/services', authMiddleware, async (req, res) => {
  try {
    const { serviceId, serviceName, quantity, rate, notes } = req.body;
    const [r] = await db.query('INSERT INTO appointment_services (appointment_id,service_id,service_name,quantity,rate,notes) VALUES (?,?,?,?,?,?)',
      [req.params.id, serviceId||null, serviceName||'', quantity||1, rate||0, notes||'']);
    res.json({ data: { id: r.insertId } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.patch('/api/appointments/:id/services/:sid', authMiddleware, async (req, res) => {
  try { const { serviceName, quantity, rate, notes } = req.body; await db.query('UPDATE appointment_services SET service_name=?,quantity=?,rate=?,notes=? WHERE id=?', [serviceName||'', quantity||1, rate||0, notes||'', req.params.sid]); res.json({ success: true }); }
  catch { res.json({ success: true }); }
});
app.delete('/api/appointments/:id/services/:sid', authMiddleware, async (req, res) => {
  try { await db.query('DELETE FROM appointment_services WHERE id=?', [req.params.sid]); res.json({ success: true }); }
  catch { res.json({ success: true }); }
});
app.delete('/api/appointments/services/:sid', authMiddleware, async (req, res) => {
  try { await db.query('DELETE FROM appointment_services WHERE id=?', [req.params.sid]); res.json({ success: true }); }
  catch { res.json({ success: true }); }
});
app.post('/api/appointments/:id/payments', authMiddleware, async (req, res) => {
  try {
    const { amountPaid, paymentMode, clientId, clientName, customerPhone } = req.body;
    const invNo = 'INV-' + Date.now();
    const [r] = await db.query('INSERT INTO billing (appointment_id,client_id,customer_name,customer_phone,amount_paid,status,payment_mode,invoice_no) VALUES (?,?,?,?,?,?,?,?)',
      [req.params.id, clientId||null, clientName||customerPhone||'', customerPhone||'', amountPaid||0, 'PAID', paymentMode||'CASH', invNo]);
    res.json({ data: { id: r.insertId, invoiceNo: invNo, status: 'PAID' } });
    notify({ recipientAudience: 'STAFF', title: 'Payment received', message: `${invNo} — Rs ${Number(amountPaid||0).toLocaleString()}`, category: 'payment', priority: 'normal', relatedEntityType: 'billing', relatedEntityId: r.insertId, eventKey: `payment-${r.insertId}` });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.get('/api/appointment-payments', authMiddleware, async (req, res) => {
  try {
    const { page = 1, pageSize = 10, statusFilter, search } = req.query;
const pg = P(page) || 1, sz = P(pageSize) || 10;
    let where = '1=1 AND b.appointment_id IS NOT NULL', params = [];
    if (statusFilter && statusFilter !== 'all' && statusFilter !== 'All') {
      const up = String(statusFilter).toUpperCase();
      const st = up === 'PAID' ? 'PAID' : (up === 'UNPAID' ? 'UNPAID' : (up === 'PARTIALLY PAID' || up === 'PARTIALLY_PAID' ? 'PARTIALLY_PAID' : null));
      if (st) { where += ' AND b.status=?'; params.push(st); }
    }
    if (search) { where += ' AND (b.customer_name LIKE ? OR b.pet_name LIKE ? OR b.invoice_no LIKE ? OR c.client_name LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`); }
    const base = `FROM billing b
      LEFT JOIN appointments a ON b.appointment_id=a.id
      LEFT JOIN clients c ON c.id = COALESCE(b.client_id, a.client_id)
      LEFT JOIN pets p ON p.id = a.pet_id`;
    const [count] = await db.query(`SELECT COUNT(*) as cnt ${base} WHERE ${where}`, params);
    const [rows] = await db.query(`SELECT b.id as billing_id, b.appointment_id, b.customer_name, b.customer_phone, b.pet_name, b.final_total, b.amount_paid, b.status as billing_status, b.invoice_no, b.created_at, b.payment_mode,
      a.appointment_date, a.appointment_time, c.client_name, c.contact_number, p.pet_name as joined_pet_name,
      (SELECT COALESCE(SUM(quantity*rate),0) FROM appointment_services WHERE appointment_id=b.appointment_id) as services_total
      ${base} WHERE ${where} ORDER BY b.id DESC LIMIT ? OFFSET ?`, [...params, sz, (pg - 1) * sz]);
    const data = rows.map(r => {
      const services = Number(r.services_total) || 0;
      const totalAmt = Math.max(services, Number(r.final_total) || 0);
      return {
        appointmentId: r.appointment_id,
        appointmentDate: r.appointment_date ? (r.appointment_date instanceof Date ? `${r.appointment_date.getFullYear()}-${String(r.appointment_date.getMonth()+1).padStart(2,'0')}-${String(r.appointment_date.getDate()).padStart(2,'0')}` : r.appointment_date) : null,
        appointmentTime: r.appointment_time ? (r.appointment_time instanceof Date ? r.appointment_time.toISOString() : r.appointment_time) : null,
        totalAmount: totalAmt, firstTimeFee: 0,
        billingStatus: r.billing_status, billingId: r.billing_id,
        clientName: r.customer_name || r.client_name || '', contactNumber: r.customer_phone || r.contact_number || '',
        petName: r.pet_name || r.joined_pet_name || '',
        totalDue: totalAmt, totalPaid: Number(r.amount_paid) || 0,
        paymentSummary: r.invoice_no,
      };
    });
    res.json({ data, total: count[0].cnt, page: pg, totalPages: Math.ceil(count[0].cnt / sz) });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
// â”€â”€â”€ APPOINTMENT PRODUCTS / INVENTORY USAGE / PREDISCOUNT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function appointmentProductsSql(appointmentId, onlyUnlocked) {
  return `SELECT ap.*, p.name, p.barcode_number FROM appointment_products ap LEFT JOIN products p ON p.id = ap.product_id WHERE ap.appointment_id = ${Number(appointmentId) || 0}${onlyUnlocked ? ' AND ap.locked = 0' : ''} ORDER BY ap.locked, ap.id DESC`;
}
app.get('/api/appointments/:id/products', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query(appointmentProductsSql(req.params.id, false)); res.json({ data: toCamel(rows) }); }
  catch { res.json({ data: [] }); }
});
app.get('/api/appointments/:id/products/display', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query(appointmentProductsSql(req.params.id, false)); res.json({ data: toCamel(rows) }); }
  catch { res.json({ data: [] }); }
});
app.post('/api/appointments/:id/products', authMiddleware, async (req, res) => {
  try {
    const productId = Number(req.body.productId);
    const qty = Number(req.body.quantity) || 1;
    const [prod] = await db.query('SELECT id,name,price FROM products WHERE id=?', [productId]);
    if (!prod.length) return res.status(404).json({ error: { message: 'Product not found' } });
    const price = Number(prod[0].price) || 0;
    const [dup] = await db.query('SELECT id,quantity FROM appointment_products WHERE appointment_id=? AND product_id=? AND locked=0', [req.params.id, productId]);
    if (dup.length) {
      const q = Number(dup[0].quantity) + qty;
      await db.query('UPDATE appointment_products SET quantity=?, total=? WHERE id=?', [q, q * price, dup[0].id]);
    } else {
      await db.query('INSERT INTO appointment_products (appointment_id,product_id,quantity,price,total,locked) VALUES (?,?,?,?,?,0)', [req.params.id, productId, qty, price, qty * price]);
    }
    res.json({ data: { message: prod[0].name + ' added to appointment' } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.delete('/api/appointment-products/:id', authMiddleware, async (req, res) => {
  try { await db.query('DELETE FROM appointment_products WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch { res.json({ success: true }); }
});
app.get('/api/appointments/:id/inventory-usage', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.query(`SELECT ap.product_id AS productId, (SELECT name FROM products WHERE id=ap.product_id) AS name,
      (SELECT barcode_number FROM products WHERE id=ap.product_id) AS barcodeNumber,
      (SELECT quantity FROM products WHERE id=ap.product_id) AS stockRemaining,
      SUM(ap.quantity) AS totalDeducted FROM appointment_products ap WHERE ap.appointment_id=? AND ap.product_id IS NOT NULL GROUP BY ap.product_id`, [req.params.id]);
    res.json({ data: rows }); } catch { res.json({ data: [] }); }
});
app.post('/api/appointments/:id/inventory-usage', authMiddleware, async (req, res) => {
  try {
    const productId = Number(req.body.productId);
    const qty = Number(req.body.quantity) || 1;
    const [prod] = await db.query('SELECT id,name,quantity FROM products WHERE id=?', [productId]);
    if (!prod.length) return res.status(404).json({ error: { message: 'Product not found' } });
    const remaining = Number(prod[0].quantity) - qty;
    if (remaining < 0) return res.status(400).json({ error: { message: 'Insufficient stock for ' + prod[0].name } });
    await db.query('UPDATE products SET quantity=? WHERE id=?', [remaining, productId]);
    res.json({ data: { productName: prod[0].name } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
async function appointmentTotals(appointmentId) {
  const [svc] = await db.query('SELECT COALESCE(SUM(rate*quantity),0) AS fee FROM appointment_services WHERE appointment_id=?', [appointmentId]);
  const [prod] = await db.query('SELECT COALESCE(SUM(total),0) AS pt, COALESCE(SUM(CASE WHEN locked=1 THEN total ELSE 0 END),0) AS locked FROM appointment_products WHERE appointment_id=?', [appointmentId]);
  const [paid] = await db.query('SELECT COALESCE(SUM(amount_paid),0) AS paid FROM billing WHERE appointment_id=?', [appointmentId]);
  const [bill] = await db.query('SELECT id FROM billing WHERE appointment_id=? ORDER BY id DESC LIMIT 1', [appointmentId]);
  return {
    appointmentFee: Number(svc[0].fee), productsTotal: Number(prod[0].pt) - Number(prod[0].locked),
    rawTotal: Number(svc[0].fee) + Number(prod[0].pt) - Number(prod[0].locked),
    alreadyPaid: Number(paid[0].paid), billingId: bill.length ? bill[0].id : null,
  };
}
function discountAmountFor(type, value, rawTotal) {
  if (type === 'percent') return Math.min(100, Number(value) || 0) * rawTotal / 100;
  if (type === 'fixed') return Math.min(Number(value) || 0, rawTotal);
  return 0;
}
app.get('/api/appointments/:id/prediscount', authMiddleware, async (req, res) => {
  try {
    const t = await appointmentTotals(req.params.id);
    const [appt] = await db.query('SELECT prediscount_type,prediscount_value FROM appointments WHERE id=?', [req.params.id]);
    let existingDiscount = null;
    if (appt.length && appt[0].prediscount_type) {
      const da = discountAmountFor(appt[0].prediscount_type, appt[0].prediscount_value, t.rawTotal);
      existingDiscount = { billingId: t.billingId, rawTotal: t.rawTotal, discountAmount: da, finalAmount: Math.max(0, t.rawTotal - da), discountType: appt[0].prediscount_type, discountValue: Number(appt[0].prediscount_value) };
    }
    res.json({ data: { ...t, existingDiscount } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.put('/api/appointments/:id/prediscount', authMiddleware, async (req, res) => {
  try {
    const type = req.body.discountType === 'fixed' ? 'fixed' : 'percent';
    const value = Number(req.body.discountValue) || 0;
    await db.query('UPDATE appointments SET prediscount_type=?, prediscount_value=? WHERE id=?', [type, value, req.params.id]);
    const t = await appointmentTotals(req.params.id);
    const da = discountAmountFor(type, value, t.rawTotal);
    res.json({ data: { billingId: t.billingId, rawTotal: t.rawTotal, discountAmount: da, finalAmount: Math.max(0, t.rawTotal - da) } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.delete('/api/appointments/:id/prediscount', authMiddleware, async (req, res) => {
  try { await db.query('UPDATE appointments SET prediscount_type=NULL, prediscount_value=NULL WHERE id=?', [req.params.id]); res.json({ data: { removed: true } }); }
  catch { res.json({ data: { removed: false } }); }
});

// â”€â”€â”€ BILLING â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/billing', authMiddleware, async (req, res) => {
  try {
    const { page = 1, pageSize = 20, limit = 20, search = '', status } = req.query;
    const pg = P(page), sz = P(pageSize) || P(limit) || 20, offset = (pg - 1) * sz;
    let where = '1=1', params = [];
    if (search) { where += ' AND (customer_name LIKE ? OR invoice_no LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    if (status) { where += ' AND status=?'; params.push(status); }
    const [count] = await db.query(`SELECT COUNT(*) as cnt FROM billing WHERE ${where}`, params);
    const [rows] = await db.query(`SELECT * FROM billing WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, sz, offset]);
    res.json(paginate(rows, count[0].cnt, pg, sz));
  } catch { res.json(EMPTY); }
});
app.post('/api/billing/complete-payment', authMiddleware, async (req, res) => {
  try {
    const d = req.body;
    const cart = Array.isArray(d.cart) ? d.cart : [];
    const methods = Array.isArray(d.paymentMethods) ? d.paymentMethods : [];
    const subtotal = Number(d.subtotal) || cart.reduce((s, i) => s + Number(i.total || 0), 0);
    const discount = Number(d.discount || d.manualDiscountAmount || 0);
    const finalTotal = Number(d.finalTotal || d.total) || Math.max(0, subtotal - discount);
    const totalPaid = methods.reduce((s, m) => s + Number(m.amount || 0), 0);
    const status = totalPaid >= finalTotal && finalTotal > 0 ? 'PAID' : (totalPaid > 0 ? 'PARTIALLY_PAID' : 'UNPAID');
    const rawMode = methods[0]?.method || d.paymentMode || 'CASH';
    const paymentMode = rawMode === 'CARD_PAYMENT' ? 'CARD' : (rawMode === 'BANK_TRANSFER' ? 'BANK_TRANSFER' : 'CASH');
    const invNo = 'INV-' + Date.now();
    const [r] = await db.query('INSERT INTO billing (appointment_id,client_id,customer_name,customer_phone,subtotal,discount,final_total,amount_paid,status,payment_mode,coupon_code,invoice_no) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [d.appointmentId || null, d.clientId || null, d.customerName || '', d.customerPhone || '', subtotal, discount, finalTotal, totalPaid, status, paymentMode, d.coupon || null, invNo]);
    for (const item of cart) {
      await db.query('INSERT INTO billing_items (billing_id,product_id,name,quantity,price,total) VALUES (?,?,?,?,?,?)',
        [r.insertId, item.id || null, item.name || '', item.cartQty != null ? item.cartQty : 1, item.price || 0, item.total != null ? item.total : (item.cartQty || 1) * (item.price || 0)]);
    }
    if (d.appointmentId) { await db.query('UPDATE appointment_products SET locked=1 WHERE appointment_id=?', [d.appointmentId]); }
    res.json({ data: { billingId: invNo, id: r.insertId, subtotal, discount, finalTotal, amountPaid: totalPaid, status } });
    if (status === 'PAID') {
      notify({ recipientAudience: 'STAFF', title: 'Payment received', message: `${invNo} — Rs ${Number(finalTotal||0).toLocaleString()}`, category: 'payment', relatedEntityType: 'billing', relatedEntityId: r.insertId, eventKey: `payment-${r.insertId}` });
      if (d.clientId) notify({ recipientAudience: 'CLIENT', recipientClientId: d.clientId, title: 'Payment received', message: `Rs ${Number(totalPaid||0).toLocaleString()} received — invoice ${invNo}. Thank you!`, category: 'billing', relatedEntityType: 'billing', relatedEntityId: r.insertId, actionUrl: '/portal/billing', eventKey: `payment-client-${r.insertId}` });
    } else if (status === 'PARTIALLY_PAID' && d.clientId) {
      notify({ recipientAudience: 'CLIENT', recipientClientId: d.clientId, title: 'Partial payment received', message: `Rs ${Number(totalPaid||0).toLocaleString()} received of Rs ${Number(finalTotal||0).toLocaleString()} — invoice ${invNo}.`, category: 'billing', relatedEntityType: 'billing', relatedEntityId: r.insertId, actionUrl: '/portal/billing', eventKey: `payment-client-${r.insertId}` });
    }
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.post('/api/billing/preview', authMiddleware, (req, res) => res.json({ ...req.body, invoiceNo: 'PREVIEW' }));
app.get('/api/billing/clients/unpaid-summary', authMiddleware, async (req, res) => {
  try { res.json(await unpaidClientSummary('walkin', { ...req.query, appointments: false })); } catch { res.json(EMPTY); }
});
app.get('/api/billing/clients/:id/unpaid-detail', authMiddleware, async (req, res) => {
  try {
    const [c] = await db.query('SELECT id, client_name, contact_number, address FROM clients WHERE id=?', [req.params.id]);
    const billings = await unpaidWalkinRows(req.params.id);
    res.json({ data: { clientId: c[0].id, clientName: c[0].client_name, contactNumber: c[0].contact_number, address: c[0].address, totalDue: billings.reduce((s, b) => s + b.remaining, 0), billings } });
  } catch { res.json({ data: [] }); }
});
app.post('/api/billing/clients/:id/pay-all', authMiddleware, async (req, res) => {
  try {
    const kindSql = KINDS.walkin.sql;
    const [t] = await db.query(`SELECT COALESCE(SUM(final_total - amount_paid),0) AS due FROM billing WHERE client_id = ? AND ${kindSql.replaceAll('b.', '')} AND final_total > amount_paid`, [req.params.id]);
    const [r] = await db.query(`UPDATE billing SET amount_paid = final_total, status = 'PAID' WHERE client_id = ? AND ${kindSql.replaceAll('b.', '')} AND final_total > amount_paid`, [req.params.id]);
    res.json({ data: { billingCount: r.affectedRows, totalPaid: Number(t[0].due) || 0 } });
  } catch { res.json({ success: false }); }
});
function quickBillDTO(row, items) {
  const r = toCamel(row || {});
  return {
    id: r.id, invoiceNo: r.invoiceNo, clientId: r.clientId, customerName: r.customerName,
    customerPhone: r.customerPhone, petName: r.petName, subtotal: r.subtotal,
    discountAmount: Number(r.discount), couponCode: r.couponCode, total: r.finalTotal,
    paymentMode: r.paymentMode, amountPaid: r.amountPaid, status: r.status,
    createdAt: r.createdAt, items: (items || []).map(i => ({ id: i.id, productId: i.productId, name: i.name, quantity: i.quantity, price: i.price, total: i.total })),
  };
}
app.post('/api/billing/custom-invoice', authMiddleware, async (req, res) => {
  try {
    const d = req.body;
    const lineItems = Array.isArray(d.lineItems) ? d.lineItems : [];
    const subtotal = Number(d.subtotal) || lineItems.reduce((s, i) => s + (Number(i.quantity) || 0) * (Number(i.price) || 0), 0);
    const discount = Number(d.manualDiscountAmount || 0);
    const finalTotal = Math.max(0, subtotal - discount);
    const amountPaid = d.amountPaid != null && d.amountPaid !== '' ? Number(d.amountPaid) : 0;
    const apiMode = d.paymentMode;
    const paymentMode = apiMode === 'CARD_PAYMENT' ? 'CARD' : (apiMode === 'BANK_TRANSFER' ? 'BANK_TRANSFER' : 'CASH');
    const status = amountPaid >= finalTotal && finalTotal > 0 ? 'PAID' : (amountPaid > 0 ? 'PARTIALLY_PAID' : 'UNPAID');
    const [r] = await db.query('INSERT INTO billing (client_id,customer_name,customer_phone,pet_name,subtotal,discount,final_total,amount_paid,status,payment_mode,coupon_code,invoice_no) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [d.clientId || null, d.customerName || '', d.customerPhone || '', d.petName || '', subtotal, discount, finalTotal, amountPaid, status, paymentMode, d.couponCode || null, null]);
    const invNo = 'QB-' + r.insertId;
    await db.query('UPDATE billing SET invoice_no=? WHERE id=?', [invNo, r.insertId]);
    for (const li of lineItems) {
      await db.query('INSERT INTO billing_items (billing_id,product_id,name,quantity,price,total) VALUES (?,?,?,?,?,?)',
        [r.insertId, li.productId || null, li.name || '', Number(li.quantity) || 1, Number(li.price) || 0, (Number(li.quantity) || 1) * (Number(li.price) || 0)]);
    }
    const [row] = await db.query('SELECT * FROM billing WHERE id=?', [r.insertId]);
    const [items] = await db.query('SELECT * FROM billing_items WHERE billing_id=?', [r.insertId]);
    res.json({ data: quickBillDTO(row[0], toCamel(items)) });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.get('/api/billing/custom-invoices', authMiddleware, async (req, res) => {
  try {
    const { page = 1, pageSize = 10, search } = req.query; const pg = P(page) || 1, sz = P(pageSize) || 10;
    let where = '1=1', params = [];
    if (search) { where += ' AND (customer_name LIKE ? OR invoice_no LIKE ? OR customer_phone LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
    const [count] = await db.query(`SELECT COUNT(*) as cnt FROM billing WHERE ${where}`, params);
    const [rows] = await db.query(`SELECT * FROM billing WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, sz, (pg - 1) * sz]);
    const rowsC = toCamel(rows);
    for (const b of rowsC) {
      const [items] = await db.query('SELECT * FROM billing_items WHERE billing_id=?', [b.id]);
      b.items = toCamel(items).map(i => ({ id: i.id, productId: i.productId, name: i.name, quantity: i.quantity, price: i.price, total: i.total }));
    }
    res.json({ data: rowsC, total: count[0].cnt, page: pg, totalPages: Math.ceil(count[0].cnt / sz) });
  } catch { res.json(EMPTY); }
});
app.patch('/api/billing/custom-invoice/:id', authMiddleware, async (req, res) => {
  try {
    const d = req.body;
    const lineItems = Array.isArray(d.lineItems) ? d.lineItems : [];
    const subtotal = Number(d.subtotal) || lineItems.reduce((s, i) => s + (Number(i.quantity) || 0) * (Number(i.price) || 0), 0);
    const discount = Number(d.manualDiscountAmount || 0);
    const finalTotal = Math.max(0, subtotal - discount);
    const amountPaid = d.amountPaid != null && d.amountPaid !== '' ? Number(d.amountPaid) : 0;
    const apiMode = d.paymentMode;
    const paymentMode = apiMode === 'CARD_PAYMENT' ? 'CARD' : (apiMode === 'BANK_TRANSFER' ? 'BANK_TRANSFER' : 'CASH');
    const status = amountPaid >= finalTotal && finalTotal > 0 ? 'PAID' : (amountPaid > 0 ? 'PARTIALLY_PAID' : 'UNPAID');
    await db.query('UPDATE billing SET client_id=?, customer_name=?, customer_phone=?, pet_name=?, subtotal=?, discount=?, final_total=?, amount_paid=?, status=?, payment_mode=?, coupon_code=? WHERE id=?',
      [d.clientId || null, d.customerName || '', d.customerPhone || '', d.petName || '', subtotal, discount, finalTotal, amountPaid, status, paymentMode, d.couponCode || null, req.params.id]);
    await db.query('DELETE FROM billing_items WHERE billing_id=?', [req.params.id]);
    for (const li of lineItems) {
      await db.query('INSERT INTO billing_items (billing_id,product_id,name,quantity,price,total) VALUES (?,?,?,?,?,?)',
        [req.params.id, li.productId || null, li.name || '', Number(li.quantity) || 1, Number(li.price) || 0, (Number(li.quantity) || 1) * (Number(li.price) || 0)]);
    }
    const [row] = await db.query('SELECT * FROM billing WHERE id=?', [req.params.id]);
    const [items] = await db.query('SELECT * FROM billing_items WHERE billing_id=?', [req.params.id]);
    res.json({ data: quickBillDTO(row[0], toCamel(items)) });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.delete('/api/billing/custom-invoice/:id', authMiddleware, async (req, res) => {
  try { await db.query('DELETE FROM billing_items WHERE billing_id=?', [req.params.id]); await db.query('DELETE FROM billing WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch { res.json({ success: true }); }
});
app.get('/api/billing/custom-invoices/clients/unpaid-summary', authMiddleware, async (req, res) => {
  try { res.json(await unpaidClientSummary('quickbill', { ...req.query, appointments: false })); } catch { res.json(EMPTY); }
});
app.get('/api/billing/custom-invoices/clients/:id/unpaid-detail', authMiddleware, async (req, res) => {
  try {
    const [c] = await db.query('SELECT id, client_name, contact_number, address FROM clients WHERE id=?', [req.params.id]);
    const quickBills = await unpaidQuickBillRows(req.params.id);
    res.json({ data: { clientId: c[0].id, clientName: c[0].client_name, contactNumber: c[0].contact_number, address: c[0].address, totalDue: quickBills.reduce((s, b) => s + b.remaining, 0), quickBills } });
  } catch { res.json({ data: [] }); }
});
app.post('/api/billing/custom-invoices/clients/:id/pay-all', authMiddleware, async (req, res) => {
  try {
    const kindSql = KINDS.quickbill.sql;
    const [t] = await db.query(`SELECT COALESCE(SUM(final_total - amount_paid),0) AS due FROM billing WHERE client_id = ? AND ${kindSql.replaceAll('b.', '')} AND final_total > amount_paid`, [req.params.id]);
    const [r] = await db.query(`UPDATE billing SET amount_paid = final_total, status = 'PAID' WHERE client_id = ? AND ${kindSql.replaceAll('b.', '')} AND final_total > amount_paid`, [req.params.id]);
    res.json({ data: { billingCount: r.affectedRows, totalPaid: Number(t[0].due) || 0 } });
  } catch { res.json({ success: false }); }
});

// â”€â”€â”€ EXPENSES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/expenses', authMiddleware, async (req, res) => {
  try {
    const { page = 1, pageSize = 50, search = '', startDate, endDate, categoryId } = req.query;
    let where = '1=1', params = [];
    if (startDate) { where += ' AND e.date>=?'; params.push(startDate); }
    if (endDate) { where += ' AND e.date<=?'; params.push(endDate); }
    if (categoryId) { where += ' AND e.category_id=?'; params.push(categoryId); }
    const [rows] = await db.query(`SELECT e.*, ec.name as category_name FROM expenses e LEFT JOIN expense_categories ec ON e.category_id=ec.id WHERE ${where} ORDER BY e.date DESC`, params);
    res.json({ data: toCamel(rows), total: rows.length });
  } catch { res.json({ data: [], total: 0 }); }
});
app.get('/api/expenses/total', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query('SELECT COALESCE(SUM(amount),0) as total FROM expenses'); res.json({ total: rows[0].total }); }
  catch { res.json({ total: 0 }); }
});
app.get('/api/expenses/list', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query('SELECT e.*, ec.name as category_name FROM expenses e LEFT JOIN expense_categories ec ON e.category_id=ec.id ORDER BY e.date DESC'); res.json({ data: toCamel(rows), total: rows.length }); }
  catch { res.json({ data: [], total: 0 }); }
});
// Names are compared case/whitespace-insensitively everywhere below so "Rent",
// "rent" and " Rent " can never become three separate dropdown entries. The
// same expression is what dedupeSeedRows groups on and what the
// uq_expense_categories_name unique key enforces.
const CATEGORY_NAME_MATCH = 'LOWER(TRIM(name)) = LOWER(TRIM(?))';

app.get('/api/expense-categories', authMiddleware, async (req, res) => {
  try {
    // Belt-and-braces: dedupeSeedRows has already collapsed these, but a clinic
    // DB whose repair has not run yet must not be able to show a doubled
    // dropdown. Grouping on the normalised name and keeping MIN(id) returns the
    // same survivor the migration would have kept, so ids stay stable.
    const [rows] = await db.query(
      `SELECT * FROM expense_categories WHERE id IN (SELECT MIN(id) FROM expense_categories GROUP BY LOWER(TRIM(name))) ORDER BY name`,
    );
    res.json({ data: toCamel(rows) });
  }
  catch { res.json({ data: [] }); }
});
app.post('/api/expense-categories', authMiddleware, async (req, res) => {
  try {
    const name = String(req.body?.name ?? '').trim();
    if (!name) return res.status(400).json({ error: { message: 'Category name is required' } });
    // Returning the existing row (rather than a 409) keeps the UI's
    // "add then select" flow working when a category is typed that already
    // exists -- the caller gets a usable id instead of an error to handle.
    const [existing] = await db.query(`SELECT * FROM expense_categories WHERE ${CATEGORY_NAME_MATCH} ORDER BY id LIMIT 1`, [name]);
    if (existing.length) {
      return res.json({ data: { id: existing[0].id, name: existing[0].name }, existing: true });
    }
    const [r] = await db.query('INSERT INTO expense_categories (name,description) VALUES (?,?)', [name, req.body?.description || '']);
    res.json({ data: { id: r.insertId, name } });
  }
  catch (e) {
    // Two concurrent adds can still race past the SELECT above; the unique key
    // catches the loser and we answer with the row that won.
    if (e.code === 'ER_DUP_ENTRY') {
      const [existing] = await db.query(`SELECT * FROM expense_categories WHERE ${CATEGORY_NAME_MATCH} ORDER BY id LIMIT 1`, [String(req.body?.name ?? '').trim()]);
      if (existing.length) return res.json({ data: { id: existing[0].id, name: existing[0].name }, existing: true });
    }
    res.status(500).json({ error: { message: e.message } });
  }
});
app.patch('/api/expense-categories/:id', authMiddleware, async (req, res) => {
  try {
    const name = String(req.body?.name ?? '').trim();
    if (!name) return res.status(400).json({ error: { message: 'Category name is required' } });
    // A rename must not collide with a different category either, otherwise the
    // unique key rejects the UPDATE with an opaque ER_DUP_ENTRY.
    const [clash] = await db.query(
      `SELECT id FROM expense_categories WHERE ${CATEGORY_NAME_MATCH} AND id <> ? LIMIT 1`,
      [name, req.params.id],
    );
    if (clash.length) return res.status(409).json({ error: { message: `A category named "${name}" already exists` } });
    await db.query('UPDATE expense_categories SET name=?,description=? WHERE id=?', [name, req.body?.description || '', req.params.id]);
    res.json({ success: true });
  }
  catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.delete('/api/expense-categories/:id', authMiddleware, async (req, res) => {
  try { await db.query('DELETE FROM expense_categories WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch { res.json({ success: true }); }
});
app.post('/api/expenses', authMiddleware, async (req, res) => {
  try { const { name, categoryId, amount, date, notes } = req.body; const [r] = await db.query('INSERT INTO expenses (name,category_id,amount,date,notes) VALUES (?,?,?,?,?)', [name, categoryId||null, amount||0, date||new Date().toISOString().slice(0,10), notes||'']); res.json({ data: { id: r.insertId } }); }
  catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.patch('/api/expenses/:id', authMiddleware, async (req, res) => {
  try { const { name, categoryId, amount, date, notes } = req.body; await db.query('UPDATE expenses SET name=?,category_id=?,amount=?,date=?,notes=? WHERE id=?', [name, categoryId||null, amount||0, date||new Date().toISOString().slice(0,10), notes||'', req.params.id]); res.json({ success: true }); }
  catch { res.json({ success: true }); }
});
app.delete('/api/expenses/:id', authMiddleware, async (req, res) => {
  try { await db.query('DELETE FROM expenses WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch { res.json({ success: true }); }
});
app.get('/api/expenses/pdf', authMiddleware, (req, res) => { res.setHeader('Content-Type', 'application/pdf'); res.end(''); });

// â”€â”€â”€ RECORDS (EMR) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/records/recent', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query('SELECT sn.*, p.pet_name, c.client_name FROM soap_notes sn JOIN pets p ON sn.pet_id=p.id JOIN clients c ON p.client_id=c.id ORDER BY sn.created_at DESC LIMIT ?', [P(req.query.limit)||20]);
    res.json({ data: rows.map(r => ({ id: r.id, petId: r.pet_id, petName: r.pet_name, recordType: 'SOAP NOTE', createdAt: r.created_at })) }); }
  catch { res.json({ data: [] }); }
});
app.get('/api/records/stats', authMiddleware, async (req, res) => {
  try { const [pets]=await db.query('SELECT COUNT(*) as cnt FROM pets'); const [soaps]=await db.query('SELECT COUNT(*) as cnt FROM soap_notes WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 1 MONTH)'); const [apts]=await db.query('SELECT COUNT(*) as cnt FROM appointments'); res.json({ data: { totalRecords: pets[0].cnt, recordsThisMonth: soaps[0].cnt, activePatients: pets[0].cnt } }); }
  catch { res.json({ data: { totalRecords: 0, recordsThisMonth: 0, activePatients: 0 } }); }
});
app.get('/api/records/search-pets', authMiddleware, async (req, res) => {
  try { const { q='' } = req.query; const [rows] = await db.query('SELECT p.id,p.pet_name,c.client_name FROM pets p JOIN clients c ON p.client_id=c.id WHERE p.pet_name LIKE ? OR c.client_name LIKE ? LIMIT 10', [`%${q}%`,`%${q}%`]); res.json({ data: toCamel(rows) }); }
  catch { res.json({ data: [] }); }
});

// â”€â”€â”€ SOAP NOTES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/pets/:petId/soap-notes', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM soap_notes WHERE pet_id=? ORDER BY created_at DESC', [req.params.petId]);
    res.json({ data: (rows.map(toCamel)).map((r) => {
      let tests = r.testsAdvised ?? r.tests_advised ?? null;
      if (typeof tests === 'string' && tests) {
        try { tests = JSON.parse(tests); } catch { tests = [tests]; }
      }
      return { ...r, testsAdvised: Array.isArray(tests) ? tests : [] };
    }) });
  } catch { res.json({ data: [] }); }
});
app.get('/api/soap-notes/:id', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query('SELECT * FROM soap_notes WHERE id=?', [req.params.id]); if (!rows.length) return res.status(404).json({ error: { message: 'Not found', code: 'NOT_FOUND' } }); res.json({ data: toCamel(rows[0]) }); }
  catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.get('/api/soap-notes/by-appointment/:id', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query('SELECT * FROM soap_notes WHERE appointment_id=?', [req.params.id]); if (!rows.length) return res.status(404).json({ error: { message: 'Not found', code: 'NOT_FOUND' } }); res.json({ data: toCamel(rows[0]) }); }
  catch { res.json({ data: null }); }
});
app.get('/api/soap-notes/by-boarding-stay/:id', authMiddleware, (req, res) => res.json(null));
app.get('/api/soap-notes/by-boarding-stay/:id/exists', authMiddleware, (req, res) => res.json({ exists: false }));
app.post('/api/pets/:petId/soap-notes', authMiddleware, async (req, res) => {
  try {
    if (!/^\d+$/.test(req.params.petId)) return res.status(400).json({ error: { message: 'Invalid pet id: ' + req.params.petId, code: 'BAD_REQUEST' } });
    const d = req.body; const [r] = await db.query(`INSERT INTO soap_notes (pet_id,appointment_id,boarding_stay_id,doctor,subjective,objective,assessment,diagnosis,\`plan\`,temperature,temperature_input_unit,heart_rate,respiratory_rate,weight,weight_input_unit,bcs,mucous_membrane,crt,crt_under_2,pulse_quality,hydration_status,mentation,visit_type,condition_status,is_pregnant,has_anemia,vaccination_given,deworming_given,diarrhea_type,vomit_type,ddx,prognosis,next_visit_days,doctor_notes,exam_eyes_normal,exam_eyes_note,exam_eyes_discharge_type,exam_eyes_color,exam_eyes_cornea,exam_eyes_pupils,exam_ears_normal,exam_ears_note,exam_ears_discharge_type,exam_ears_odor,exam_ears_appearance,exam_ears_pain,exam_oral_normal,exam_oral_note,exam_skin_normal,exam_skin_note,exam_lymph_normal,exam_lymph_note,exam_cardio_normal,exam_cardio_note,exam_resp_normal,exam_resp_note,exam_gi_normal,exam_gi_note,exam_musculo_normal,exam_musculo_note,exam_neuro_normal,exam_neuro_note,exam_uro_normal,exam_uro_note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [req.params.petId, d.appointmentId||d.appointment_id||null, d.boardingStayId||d.boarding_stay_id||null, d.doctor||'', d.subjective||'', d.objective||'', d.assessment||'', d.diagnosis||'', d.plan||'', d.temperature||null, d.temperatureInputUnit||d.temperature_input_unit||'C', d.heartRate||d.heart_rate||null, d.respiratoryRate||d.respiratory_rate||null, d.weight||null, d.weightInputUnit||d.weight_input_unit||'kg', d.bcs||null, d.mucousMembrane||d.mucous_membrane||null, d.crt||null, (d.crtUnder2??d.crt_under_2)??null, d.pulseQuality||d.pulse_quality||null, d.hydrationStatus||d.hydration_status||null, d.mentation||null, d.visitType||d.visit_type||null, d.conditionStatus||d.condition_status||null, (d.isPregnant??d.is_pregnant)??0, (d.hasAnemia??d.has_anemia)??0, (d.vaccinationGiven??d.vaccination_given)??0, (d.dewormingGiven??d.deworming_given)??0, d.diarrheaType||d.diarrhea_type||null, d.vomitType||d.vomit_type||null, d.ddx||null, d.prognosis||null, d.nextVisitDays||d.next_visit_days||null, d.doctorNotes||d.doctor_notes||null, (d.examEyesNormal??d.exam_eyes_normal)??1, d.examEyesNote||d.exam_eyes_note||null, d.examEyesDischargeType||d.exam_eyes_discharge_type||null, d.examEyesColor||d.exam_eyes_color||null, d.examEyesCornea||d.exam_eyes_cornea||null, d.examEyesPupils||d.exam_eyes_pupils||null, (d.examEarsNormal??d.exam_ears_normal)??1, d.examEarsNote||d.exam_ears_note||null, d.examEarsDischargeType||d.exam_ears_discharge_type||null, d.examEarsOdor||d.exam_ears_odor||null, d.examEarsAppearance||d.exam_ears_appearance||null, (d.examEarsPain??d.exam_ears_pain)??null, (d.examOralNormal??d.exam_oral_normal)??1, d.examOralNote||d.exam_oral_note||null, (d.examSkinNormal??d.exam_skin_normal)??1, d.examSkinNote||d.exam_skin_note||null, (d.examLymphNormal??d.exam_lymph_normal)??1, d.examLymphNote||d.exam_lymph_note||null, (d.examCardioNormal??d.exam_cardio_normal)??1, d.examCardioNote||d.exam_cardio_note||null, (d.examRespNormal??d.exam_resp_normal)??1, d.examRespNote||d.exam_resp_note||null, (d.examGiNormal??d.exam_gi_normal)??1, d.examGiNote||d.exam_gi_note||null, (d.examMusculoNormal??d.exam_musculo_normal)??1, d.examMusculoNote||d.exam_musculo_note||null, (d.examNeuroNormal??d.exam_neuro_normal)??1, d.examNeuroNote||d.exam_neuro_note||null, (d.examUroNormal??d.exam_uro_normal)??1, d.examUroNote||d.exam_uro_note||null]);
    const [pt] = await db.query('SELECT pet_name, client_id FROM pets WHERE id=?', [req.params.petId]);
    const soPetName = pt[0] ? pt[0].pet_name : 'A pet';
    notify({ recipientAudience: 'STAFF', title: 'New medical record', message: `${soPetName} — SOAP note added${d.doctor ? ' by ' + d.doctor : ''}`, category: 'record', relatedEntityType: 'pet', relatedEntityId: Number(req.params.petId), eventKey: `soap-${r.insertId}` });
    if (pt[0] && pt[0].client_id) notify({ recipientAudience: 'CLIENT', recipientClientId: pt[0].client_id, title: 'New medical record', message: `A new medical record for ${soPetName} has been added.`, category: 'record', relatedEntityType: 'pet', relatedEntityId: Number(req.params.petId), actionUrl: '/portal/medical-records', eventKey: `soap-client-${r.insertId}` });
    res.json({ data: { id: r.insertId } }); } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.patch('/api/soap-notes/:id', authMiddleware, async (req, res) => {
  try { const d = req.body; await db.query(`UPDATE soap_notes SET appointment_id=?,boarding_stay_id=?,doctor=?,subjective=?,objective=?,assessment=?,diagnosis=?,\`plan\`=?,temperature=?,temperature_input_unit=?,heart_rate=?,respiratory_rate=?,weight=?,weight_input_unit=?,bcs=?,mucous_membrane=?,crt=?,crt_under_2=?,pulse_quality=?,hydration_status=?,mentation=?,visit_type=?,condition_status=?,is_pregnant=?,has_anemia=?,vaccination_given=?,deworming_given=?,diarrhea_type=?,vomit_type=?,ddx=?,prognosis=?,next_visit_days=?,doctor_notes=?,exam_eyes_normal=?,exam_eyes_note=?,exam_eyes_discharge_type=?,exam_eyes_color=?,exam_eyes_cornea=?,exam_eyes_pupils=?,exam_ears_normal=?,exam_ears_note=?,exam_ears_discharge_type=?,exam_ears_odor=?,exam_ears_appearance=?,exam_ears_pain=?,exam_oral_normal=?,exam_oral_note=?,exam_skin_normal=?,exam_skin_note=?,exam_lymph_normal=?,exam_lymph_note=?,exam_cardio_normal=?,exam_cardio_note=?,exam_resp_normal=?,exam_resp_note=?,exam_gi_normal=?,exam_gi_note=?,exam_musculo_normal=?,exam_musculo_note=?,exam_neuro_normal=?,exam_neuro_note=?,exam_uro_normal=?,exam_uro_note=? WHERE id=?`,
    [d.appointmentId||d.appointment_id||null, d.boardingStayId||d.boarding_stay_id||null, d.doctor||'', d.subjective||'', d.objective||'', d.assessment||'', d.diagnosis||'', d.plan||'', d.temperature||null, d.temperatureInputUnit||d.temperature_input_unit||'C', d.heartRate||d.heart_rate||null, d.respiratoryRate||d.respiratory_rate||null, d.weight||null, d.weightInputUnit||d.weight_input_unit||'kg', d.bcs||null, d.mucousMembrane||d.mucous_membrane||null, d.crt||null, (d.crtUnder2??d.crt_under_2)??null, d.pulseQuality||d.pulse_quality||null, d.hydrationStatus||d.hydration_status||null, d.mentation||null, d.visitType||d.visit_type||null, d.conditionStatus||d.condition_status||null, (d.isPregnant??d.is_pregnant)??0, (d.hasAnemia??d.has_anemia)??0, (d.vaccinationGiven??d.vaccination_given)??0, (d.dewormingGiven??d.deworming_given)??0, d.diarrheaType||d.diarrhea_type||null, d.vomitType||d.vomit_type||null, d.ddx||null, d.prognosis||null, d.nextVisitDays||d.next_visit_days||null, d.doctorNotes||d.doctor_notes||null, (d.examEyesNormal??d.exam_eyes_normal)??1, d.examEyesNote||d.exam_eyes_note||null, d.examEyesDischargeType||d.exam_eyes_discharge_type||null, d.examEyesColor||d.exam_eyes_color||null, d.examEyesCornea||d.exam_eyes_cornea||null, d.examEyesPupils||d.exam_eyes_pupils||null, (d.examEarsNormal??d.exam_ears_normal)??1, d.examEarsNote||d.exam_ears_note||null, d.examEarsDischargeType||d.exam_ears_discharge_type||null, d.examEarsOdor||d.exam_ears_odor||null, d.examEarsAppearance||d.exam_ears_appearance||null, (d.examEarsPain??d.exam_ears_pain)??null, (d.examOralNormal??d.exam_oral_normal)??1, d.examOralNote||d.exam_oral_note||null, (d.examSkinNormal??d.exam_skin_normal)??1, d.examSkinNote||d.exam_skin_note||null, (d.examLymphNormal??d.exam_lymph_normal)??1, d.examLymphNote||d.exam_lymph_note||null, (d.examCardioNormal??d.exam_cardio_normal)??1, d.examCardioNote||d.exam_cardio_note||null, (d.examRespNormal??d.exam_resp_normal)??1, d.examRespNote||d.exam_resp_note||null, (d.examGiNormal??d.exam_gi_normal)??1, d.examGiNote||d.exam_gi_note||null, (d.examMusculoNormal??d.exam_musculo_normal)??1, d.examMusculoNote||d.exam_musculo_note||null, (d.examNeuroNormal??d.exam_neuro_normal)??1, d.examNeuroNote||d.exam_neuro_note||null, (d.examUroNormal??d.exam_uro_normal)??1, d.examUroNote||d.exam_uro_note||null, req.params.id]); 
    res.json({ success: true }); } catch (e) { console.error('soap-note update err', e.message); res.json({ success: false }); }
});
app.delete('/api/soap-notes/:id', authMiddleware, async (req, res) => { try { await db.query('DELETE FROM soap_notes WHERE id=?', [req.params.id]); res.json({ success: true }); } catch { res.json({ success: true }); } });
app.get('/api/soap-notes/:id/tests-advised', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT tests_advised FROM soap_notes WHERE id=?', [req.params.id]);
    if (!rows.length) return res.json({ data: [] });
    let tests = rows[0].tests_advised;
    if (typeof tests === 'string' && tests) {
      try { tests = JSON.parse(tests); } catch { tests = [tests]; }
    }
    res.json({ data: Array.isArray(tests) ? tests : [] });
  } catch { res.json({ data: [] }); }
});
app.put('/api/soap-notes/:id/tests-advised', authMiddleware, async (req, res) => {
  try {
    const tests = Array.isArray(req.body.tests) ? req.body.tests : [];
    await db.query('UPDATE soap_notes SET tests_advised=? WHERE id=?', [JSON.stringify(tests), req.params.id]);
    res.json({ success: true });
  } catch { res.json({ success: true }); }
});

// â”€â”€â”€ VACCINATIONS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/pets/:petId/vaccinations', authMiddleware, async (req, res) => { try { const [rows] = await db.query('SELECT * FROM vaccinations WHERE pet_id=? ORDER BY administered_on DESC', [req.params.petId]); res.json({ data: toCamel(rows) }); } catch { res.json({ data: [] }); } });
app.post('/api/pets/:petId/vaccinations', authMiddleware, async (req, res) => {
  try { const d = req.body; const [r] = await db.query('INSERT INTO vaccinations (pet_id,vaccine_name,administered_on,next_due_date,batch_number,notes,administered_by) VALUES (?,?,?,?,?,?,?)',
    [req.params.petId, d.vaccineName||d.vaccine_name||'', d.administeredOn||d.administered_on||null, d.nextDueDate||d.next_due_date||null, d.batchNumber||d.batch_number||'', d.notes||'', d.administeredBy||d.administered_by||'']);
    const [vp] = await db.query('SELECT pet_name, client_id FROM pets WHERE id=?', [req.params.petId]);
    const vPetName = vp[0] ? vp[0].pet_name : 'A pet';
    notify({ recipientAudience: 'STAFF', title: 'Vaccination recorded', message: `${vPetName} — ${d.vaccineName||d.vaccine_name||'vaccine'}`, category: 'record', relatedEntityType: 'pet', relatedEntityId: Number(req.params.petId), eventKey: `vacc-${r.insertId}` });
    if (vp[0] && vp[0].client_id) notify({ recipientAudience: 'CLIENT', recipientClientId: vp[0].client_id, title: 'Vaccination recorded', message: `${vPetName} received ${d.vaccineName||d.vaccine_name||'a vaccine'}${(d.nextDueDate||d.next_due_date) ? ' — next due ' + (d.nextDueDate||d.next_due_date) : ''}.`, category: 'record', relatedEntityType: 'pet', relatedEntityId: Number(req.params.petId), actionUrl: '/portal/medical-records', eventKey: `vacc-client-${r.insertId}` });
    res.json({ data: { id: r.insertId } }); } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.patch('/api/vaccinations/:id', authMiddleware, async (req, res) => { try { const d = req.body; await db.query('UPDATE vaccinations SET vaccine_name=?,administered_on=?,next_due_date=?,batch_number=?,notes=?,administered_by=? WHERE id=?',
  [d.vaccineName||d.vaccine_name||'', d.administeredOn||d.administered_on||null, d.nextDueDate||d.next_due_date||null, d.batchNumber||d.batch_number||'', d.notes||'', d.administeredBy||d.administered_by||'', req.params.id]); res.json({ success: true }); } catch { res.json({ success: true }); } });
app.delete('/api/vaccinations/:id', authMiddleware, async (req, res) => { try { await db.query('DELETE FROM vaccinations WHERE id=?', [req.params.id]); res.json({ success: true }); } catch { res.json({ success: true }); } });

// â”€â”€â”€ DEWORMINGS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/pets/:petId/dewormings', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query('SELECT * FROM dewormings WHERE pet_id=? ORDER BY administered_on DESC', [req.params.petId]); res.json({ data: toCamel(rows) }); }
  catch { res.json({ data: [] }); }
});
app.post('/api/pets/:petId/dewormings', authMiddleware, async (req, res) => {
  try { const d = req.body;
    const [r] = await db.query('INSERT INTO dewormings (pet_id,soap_note_id,product_name,administered_on,next_due_date,batch_number,notes,administered_by) VALUES (?,?,?,?,?,?,?,?)',
      [req.params.petId, d.soapNoteId || d.soap_note_id || null, d.productName || d.product_name || '', d.administeredOn || d.administered_on || null, d.nextDueDate || d.next_due_date || null, d.batchNumber || d.batch_number || '', d.notes || '', d.administeredBy || d.administered_by || '']);
    res.json({ data: { id: r.insertId } }); }
  catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.patch('/api/dewormings/:id', authMiddleware, async (req, res) => {
  try { const d = req.body;
    await db.query('UPDATE dewormings SET product_name=?,administered_on=?,next_due_date=?,batch_number=?,notes=?,administered_by=? WHERE id=?',
      [d.productName || d.product_name || '', d.administeredOn || d.administered_on || null, d.nextDueDate || d.next_due_date || null, d.batchNumber || d.batch_number || '', d.notes || '', d.administeredBy || d.administered_by || '', req.params.id]);
    res.json({ success: true }); } catch { res.json({ success: true }); }
});
app.delete('/api/dewormings/:id', authMiddleware, async (req, res) => { try { await db.query('DELETE FROM dewormings WHERE id=?', [req.params.id]); res.json({ success: true }); } catch { res.json({ success: true }); } });

// â”€â”€â”€ PRESCRIPTIONS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/pets/:petId/prescriptions', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query('SELECT * FROM prescriptions WHERE pet_id=? ORDER BY prescribed_on DESC', [req.params.petId]);
    for (const rx of rows) { const [meds] = await db.query('SELECT * FROM prescription_medications WHERE prescription_id=?', [rx.id]); rx.medications = meds; }
    res.json({ data: toCamel(rows) }); } catch { res.json({ data: [] }); }
});
app.post('/api/pets/:petId/prescriptions', authMiddleware, async (req, res) => {
  try { const d = req.body; const [r] = await db.query('INSERT INTO prescriptions (pet_id,prescribed_by,prescribed_on,notes) VALUES (?,?,?,?)',
    [req.params.petId, d.prescribedBy||d.prescribed_by||'', d.prescribedOn||d.prescribed_on||new Date().toISOString().slice(0,10), d.notes||'']);
    if (d.medications && d.medications.length) { for (const m of d.medications) { await db.query('INSERT INTO prescription_medications (prescription_id,name,dosage,frequency,duration) VALUES (?,?,?,?,?)', [r.insertId, m.name||'', m.dosage||'', m.frequency||'', m.duration||'']); } }
    res.json({ data: { id: r.insertId } }); } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.patch('/api/prescriptions/:id', authMiddleware, (req, res) => res.json({ success: true }));
app.delete('/api/prescriptions/:id', authMiddleware, async (req, res) => { try { await db.query('DELETE FROM prescription_medications WHERE prescription_id=?', [req.params.id]); await db.query('DELETE FROM prescriptions WHERE id=?', [req.params.id]); res.json({ success: true }); } catch { res.json({ success: true }); } });

// â”€â”€â”€ PRESCRIPTION UPDATE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.patch('/api/prescriptions/:id', authMiddleware, async (req, res) => {
  try { const d = req.body;
    await db.query('UPDATE prescriptions SET prescribed_by=?,prescribed_on=?,notes=? WHERE id=?',
      [d.prescribedBy || d.prescribed_by || '', d.prescribedOn || d.prescribed_on || new Date().toISOString().slice(0, 10), d.notes || '', req.params.id]);
    if (Array.isArray(d.medications)) {
      await db.query('DELETE FROM prescription_medications WHERE prescription_id=?', [req.params.id]);
      for (const m of d.medications) { await db.query('INSERT INTO prescription_medications (prescription_id,name,dosage,frequency,duration) VALUES (?,?,?,?,?)', [req.params.id, m.name || '', m.dosage || '', m.frequency || '', m.duration || '']); }
    }
    res.json({ success: true }); } catch { res.json({ success: true }); }
});

// â”€â”€â”€ LAB / PROCEDURES / BODY WEIGHT (pet-scoped) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/pets/:petId/lab-results', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query('SELECT * FROM lab_test_results WHERE pet_id=? ORDER BY test_date DESC', [req.params.petId]); res.json({ data: toCamel(rows) }); }
  catch { res.json({ data: [] }); }
});
app.post('/api/pets/:petId/lab-results', authMiddleware, async (req, res) => {
  try { const d = req.body;
    const [r] = await db.query('INSERT INTO lab_test_results (pet_id,soap_note_id,test_name,test_date,result_summary,result_value,reference_range,status,lab_name,notes) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [req.params.petId, d.soapNoteId || d.soap_note_id || null, d.testName || d.test_name || '', d.testDate || d.test_date || null, d.resultSummary || d.result_summary || '', d.resultValue || d.result_value || '', d.referenceRange || d.reference_range || '', d.status || '', d.labName || d.lab_name || '', d.notes || '']);
    res.json({ data: { id: r.insertId } }); }
  catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.patch('/api/lab-results/:id', authMiddleware, async (req, res) => {
  try { const d = req.body;
    await db.query('UPDATE lab_test_results SET test_name=?,test_date=?,result_summary=?,result_value=?,reference_range=?,status=?,lab_name=?,notes=? WHERE id=?',
      [d.testName || d.test_name || '', d.testDate || d.test_date || null, d.resultSummary || d.result_summary || '', d.resultValue || d.result_value || '', d.referenceRange || d.reference_range || '', d.status || '', d.labName || d.lab_name || '', d.notes || '', req.params.id]);
    res.json({ success: true }); } catch { res.json({ success: true }); }
});
app.delete('/api/lab-results/:id', authMiddleware, async (req, res) => { try { await db.query('DELETE FROM lab_test_results WHERE id=?', [req.params.id]); res.json({ success: true }); } catch { res.json({ success: true }); } });

app.get('/api/pets/:petId/procedures', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query('SELECT * FROM procedures WHERE pet_id=? ORDER BY performed_on DESC', [req.params.petId]);
    for (const pc of rows) { const [mats] = await db.query('SELECT * FROM procedure_materials WHERE procedure_id=?', [pc.id]); pc.materials = toCamel(mats); }
    res.json({ data: toCamel(rows) }); }
  catch { res.json({ data: [] }); }
});
app.post('/api/pets/:petId/procedures', authMiddleware, async (req, res) => {
  try { const d = req.body;
    const [r] = await db.query('INSERT INTO procedures (pet_id,soap_note_id,procedure_name,performed_on,performed_by,notes,outcome) VALUES (?,?,?,?,?,?,?)',
      [req.params.petId, d.soapNoteId || d.soap_note_id || null, d.procedureName || d.procedure_name || '', d.performedOn || d.performed_on || null, d.performedBy || d.performed_by || '', d.notes || '', d.outcome || '']);
    if (Array.isArray(d.materials)) { for (const m of d.materials) { await db.query('INSERT INTO procedure_materials (procedure_id,product_id,material_name,quantity,dose,route,batch_number,notes) VALUES (?,?,?,?,?,?,?,?)', [r.insertId, m.productId || null, m.materialName || '', m.quantity ?? null, m.dose || '', m.route || '', m.batchNumber || '', m.notes || '']); } }
    res.json({ data: { id: r.insertId } }); }
  catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.patch('/api/procedures/:id', authMiddleware, async (req, res) => {
  try { const d = req.body;
    await db.query('UPDATE procedures SET procedure_name=?,performed_on=?,performed_by=?,notes=?,outcome=? WHERE id=?',
      [d.procedureName || d.procedure_name || '', d.performedOn || d.performed_on || null, d.performedBy || d.performed_by || '', d.notes || '', d.outcome || '', req.params.id]);
    if (Array.isArray(d.materials)) {
      await db.query('DELETE FROM procedure_materials WHERE procedure_id=?', [req.params.id]);
      for (const m of d.materials) { await db.query('INSERT INTO procedure_materials (procedure_id,product_id,material_name,quantity,dose,route,batch_number,notes) VALUES (?,?,?,?,?,?,?,?)', [req.params.id, m.productId || null, m.materialName || '', m.quantity ?? null, m.dose || '', m.route || '', m.batchNumber || '', m.notes || '']); }
    }
    res.json({ success: true }); } catch { res.json({ success: true }); }
});
app.delete('/api/procedures/:id', authMiddleware, async (req, res) => { try { await db.query('DELETE FROM procedure_materials WHERE procedure_id=?', [req.params.id]); await db.query('DELETE FROM procedures WHERE id=?', [req.params.id]); res.json({ success: true }); } catch { res.json({ success: true }); } });

app.get('/api/pets/:petId/body-weight-records', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query('SELECT * FROM body_weight_records WHERE pet_id=? ORDER BY recorded_on DESC', [req.params.petId]); res.json({ data: toCamel(rows) }); }
  catch { res.json({ data: [] }); }
});
app.post('/api/pets/:petId/body-weight-records', authMiddleware, async (req, res) => {
  try { const d = req.body;
    const [r] = await db.query('INSERT INTO body_weight_records (pet_id,soap_note_id,weight,weight_unit,recorded_on,notes,recorded_by) VALUES (?,?,?,?,?,?,?)',
      [req.params.petId, d.soapNoteId || d.soap_note_id || null, d.weight, d.weightUnit || d.weight_unit || 'kg', d.recordedOn || d.recorded_on || new Date().toISOString().slice(0, 10), d.notes || '', d.recordedBy || d.recorded_by || '']);
    res.json({ data: { id: r.insertId } }); }
  catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.patch('/api/body-weight-records/:id', authMiddleware, async (req, res) => {
  try { const d = req.body;
    await db.query('UPDATE body_weight_records SET weight=?,weight_unit=?,recorded_on=?,notes=?,recorded_by=? WHERE id=?',
      [d.weight, d.weightUnit || d.weight_unit || 'kg', d.recordedOn || d.recorded_on || null, d.notes || '', d.recordedBy || d.recorded_by || '', req.params.id]);
    res.json({ success: true }); } catch { res.json({ success: true }); }
});
app.delete('/api/body-weight-records/:id', authMiddleware, async (req, res) => { try { await db.query('DELETE FROM body_weight_records WHERE id=?', [req.params.id]); res.json({ success: true }); } catch { res.json({ success: true }); } });
app.get('/api/pets/:petId/reports', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query('SELECT * FROM lab_reports WHERE pet_id=? ORDER BY id DESC', [req.params.petId]); res.json({ data: toCamel(rows) }); }
  catch { res.json({ data: [] }); }
});
app.post('/api/pets/:petId/reports', authMiddleware, async (req, res) => {
  try { const d = req.body;
    const [r] = await db.query('INSERT INTO lab_reports (pet_id,test_type,custom_test_type,file_url,file_type,original_filename,notes) VALUES (?,?,?,?,?,?,?)',
      [req.params.petId, d.testType || '', d.customTestType || null, d.fileUrl || null, d.fileType === 'pdf' ? 'pdf' : 'image', d.originalFilename || null, d.notes || null]);
    res.json({ data: { id: r.insertId, petId: Number(req.params.petId), ...d } }); }
  catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.patch('/api/reports/:id', authMiddleware, async (req, res) => {
  try { const { notes } = req.body; await db.query('UPDATE lab_reports SET notes=? WHERE id=?', [notes ?? null, req.params.id]); res.json({ success: true }); }
  catch { res.json({ success: true }); }
});
app.delete('/api/reports/:id', authMiddleware, async (req, res) => {
  try { await db.query('DELETE FROM lab_reports WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch { res.json({ success: true }); }
});

// â”€â”€â”€ VETERINARIANS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/veterinarians', authMiddleware, async (req, res) => {
  try {
    const [emp] = await db.query('SELECT id, name FROM employees WHERE position LIKE "%vet%" OR designation LIKE "%vet%" OR LOWER(name) LIKE "%vet%"');
    const empDocs = emp.map(e => ({ id: e.id, name: String(e.name).trim() }));
    const [appt] = await db.query('SELECT DISTINCT doctor as name FROM appointments WHERE doctor IS NOT NULL AND doctor != ""');
    const apptNames = appt.map(a => String(a.name).trim()).filter(n => n.length);
    const empNames = empDocs.map(d => d.name);
    const extras = apptNames.filter((n, i, arr) => arr.indexOf(n) === i && !empNames.includes(n))
      .map((n, i) => ({ id: -(i + 1), name: n }));
    res.json({ data: [...empDocs, ...extras] });
  } catch { res.json({ data: [] }); }
});

// â”€â”€â”€ REMINDERS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/reminders', authMiddleware, async (req, res) => {
  try { const { today } = req.query; let q = 'SELECT * FROM reminders WHERE is_dismissed=0', params = [];
    if (today) { q += ' AND remind_on<=?'; params.push(today); }
    q += ' ORDER BY remind_on ASC'; const [rows] = await db.query(q, params); res.json({ data: toCamel(rows) }); }
  catch { res.json({ data: [] }); }
});
app.get('/api/reminders/by-entity', authMiddleware, async (req, res) => {
  try { const { entityType, entityId } = req.query; const [rows] = await db.query('SELECT * FROM reminders WHERE entity_type=? AND entity_id=? AND is_dismissed=0 ORDER BY remind_on ASC LIMIT 1', [entityType, entityId]); res.json({ data: rows[0] ? toCamel(rows[0]) : null }); }
  catch { res.json({ data: null }); }
});
app.get('/api/reminders/by-entity/list', authMiddleware, async (req, res) => {
  try { const { entityType, entityId } = req.query; const [rows] = await db.query('SELECT * FROM reminders WHERE entity_type=? AND entity_id=? AND is_dismissed=0 ORDER BY remind_on ASC', [entityType, entityId]); res.json({ data: toCamel(rows) }); }
  catch { res.json({ data: [] }); }
});
app.put('/api/reminders', authMiddleware, async (req, res) => {
  try { const d = req.body; const [r] = await db.query('INSERT INTO reminders (entity_type,entity_id,remind_on,note,due_date,doctor,pet_name,client_name,contact_number) VALUES (?,?,?,?,?,?,?,?,?)',
    [d.entityType||'pet', d.entityId||0, d.remindOn||d.remind_on||null, d.note||'', d.dueDate||d.due_date||null, d.doctor||'', d.petName||d.pet_name||'', d.clientName||d.client_name||'', d.contactNumber||d.contact_number||'']);
    res.json({ data: { id: r.insertId, ...d } }); } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.patch('/api/reminders/:id/dismiss', authMiddleware, async (req, res) => { try { await db.query('UPDATE reminders SET is_dismissed=1 WHERE id=?', [req.params.id]); res.json({ success: true }); } catch { res.json({ success: true }); } });
app.patch('/api/reminders/:id', authMiddleware, async (req, res) => {
  try { const d = req.body; const fields=[], vals=[];
    for (const [k,v] of Object.entries(d)) { if (['remind_on','note','due_date','doctor','is_dismissed'].includes(k)) { fields.push(`${k}=?`); vals.push(v); } }
    if (fields.length) { vals.push(req.params.id); await db.query(`UPDATE reminders SET ${fields.join(',')} WHERE id=?`, vals); }
    res.json({ data: { id: P(req.params.id), ...d } }); } catch { res.json({ success: true }); }
});
app.delete('/api/reminders/:id', authMiddleware, async (req, res) => { try { await db.query('DELETE FROM reminders WHERE id=?', [req.params.id]); res.json({ success: true }); } catch { res.json({ success: true }); } });
app.delete('/api/reminders', authMiddleware, async (req, res) => { try { const { entityType, entityId } = req.query; await db.query('DELETE FROM reminders WHERE entity_type=? AND entity_id=?', [entityType, entityId]); res.json({ success: true }); } catch { res.json({ success: true }); } });
app.get('/api/reminder-notifications', authMiddleware, async (req, res) => { try { const [rows] = await db.query('SELECT * FROM reminders WHERE is_dismissed=0 AND remind_on<=CURDATE() ORDER BY remind_on ASC');
  res.json({ success: true, notifications: rows.map(r => ({ id:r.id, entityType:r.entity_type, petName:r.pet_name, clientName:r.client_name, note:r.note, remindOn:r.remind_on, dueDate:r.due_date, doctor:r.doctor, firedAt:new Date().toISOString(), isRead:false })), unreadCount: rows.length }); }
  catch { res.json({ success: true, notifications: [], unreadCount: 0 }); } });
app.patch('/api/reminder-notifications/:id/read', authMiddleware, (req, res) => res.json({ success: true }));

// â”€â”€â”€ REPORTS (financial) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/reports', authMiddleware, async (req, res) => {
  try {
    const { startDate, endDate, period } = req.query;
    const hasRange = !!(startDate || endDate);
    const range = [];
    let rangeWhere = '';
    if (startDate) { range.push(startDate); rangeWhere += ' AND created_at >= ?'; }
    if (endDate) { range.push(endDate + ' 23:59:59'); rangeWhere += ' AND created_at <= ?'; }

    const [rev] = await db.query(`SELECT COALESCE(SUM(amount_paid),0) as total FROM billing WHERE status="PAID" ${rangeWhere}`, range);
    const [exp] = await db.query(`SELECT COALESCE(SUM(amount),0) as total FROM expenses WHERE 1=1 ${rangeWhere.replaceAll('created_at', 'date')}`, range);
    const [apts] = await db.query(`SELECT COUNT(*) as total FROM appointments WHERE 1=1 ${rangeWhere.replaceAll('created_at', 'appointment_date')}`, range);
    const [clts] = await db.query(`SELECT COUNT(*) as total FROM clients WHERE 1=1 ${rangeWhere.replaceAll('created_at', 'created_at')}`, range);
    const [pets] = await db.query('SELECT COUNT(*) as total FROM pets');
    // bucket start: requested range start if given, else 11 months ago
    let bucketStart = new Date();
    bucketStart.setDate(1);
    if (startDate) {
      const y = Math.max(2000, parseInt(startDate.slice(0, 4), 10) || 2000);
      const m = Math.max(1, Math.min(12, parseInt(startDate.slice(5, 7), 10) || 1));
      bucketStart = new Date(y, m - 1, 1);
    } else {
      bucketStart = new Date(bucketStart.getFullYear(), bucketStart.getMonth() - 11, 1);
    }
    let bucketEnd = endDate ? new Date(endDate.slice(0, 4), (parseInt(endDate.slice(5, 7), 10) || 1), 1) : new Date();
    if (bucketEnd < bucketStart) bucketEnd = bucketStart;

    // last N months revenue + expenses inside the range
    const [mrev] = await db.query(`SELECT DATE_FORMAT(created_at, '%Y-%m') as ym, COALESCE(SUM(amount_paid),0) as revenue FROM billing WHERE status='PAID' ${rangeWhere} GROUP BY ym`, range);
    const [mexp] = await db.query(`SELECT DATE_FORMAT(date, '%Y-%m') as ym, COALESCE(SUM(amount),0) as expenses FROM expenses WHERE 1=1 ${rangeWhere.replaceAll('created_at', 'date')} GROUP BY ym`, range);
    const revByMonth = {}, expByMonth = {};
    mrev.forEach(r => revByMonth[r.ym] = Number(r.revenue)); mexp.forEach(r => expByMonth[r.ym] = Number(r.expenses));
    const monthlyRevenue = [];
    const d0 = bucketStart;
    let months = 0;
    while (d0 <= bucketEnd && months < 24) {
      const ym = `${d0.getFullYear()}-${String(d0.getMonth()+1).padStart(2,'0')}`;
      monthlyRevenue.push({ month: d0.toLocaleString('en', { month: 'short' }), revenue: revByMonth[ym] || 0, expenses: expByMonth[ym] || 0, targetRevenue: 0 });
      months++;
      d0.setMonth(d0.getMonth() + 1);
    }
    const [svc] = await db.query(`SELECT s.service_name as name, COUNT(*) as count, COALESCE(SUM(s.quantity*s.rate),0) as revenue FROM appointment_services s GROUP BY s.service_name ORDER BY revenue DESC LIMIT 10`);
    const svcC = toCamel(svc);
    const svcTotal = svcC.reduce((s, r) => s + Number(r.revenue), 0) || 1;
    const serviceBreakdown = svcC.map(r => ({ ...r, percentage: Math.round((Number(r.revenue) / svcTotal) * 1000) / 10 }));
    // recent transactions
    const [recent] = await db.query(`SELECT b.customer_name, b.pet_name, b.final_total, b.amount_paid, b.status, b.invoice_no, b.created_at,
      (SELECT i.name FROM billing_items i WHERE i.billing_id=b.id ORDER BY i.id LIMIT 1) as service
      FROM billing b ORDER BY b.id DESC LIMIT 6`);
    const recentTransactions = toCamel(recent).map(r => ({ client: r.customerName || '-', pet: r.petName || '-', service: r.service || 'Payment', type: r.status || 'PAID', amount: Number(r.amountPaid) || 0, invoice: r.invoiceNo, date: r.createdAt }));
    // new clients per month (last 6 months)
    const growStart = new Date(bucketEnd); growStart.setMonth(growStart.getMonth() - 5); growStart.setDate(1);
    const gs = `${growStart.getFullYear()}-${String(growStart.getMonth()+1).padStart(2,'0')}-01`;
    const [grow] = await db.query(`SELECT DATE_FORMAT(created_at, '%Y-%m') as ym, COUNT(*) as newClients FROM clients WHERE created_at >= ? GROUP BY ym`, [gs]);
    const growByMonth = {}; grow.forEach(r => growByMonth[r.ym] = Number(r.newClients));
    const clientGrowth = [];
    const d1 = new Date(growStart);
    for (let i = 5; i >= 0; i--) {
      const d = new Date(d1.getFullYear(), d1.getMonth() - i, 1);
      const ym = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      clientGrowth.push({ month: d.toLocaleString('en', { month: 'short' }), newClients: growByMonth[ym] || 0, revenue: revByMonth[ym] || 0 });
    }
    res.json({ data: { monthlyRevenue, totalRevenue: Number(rev[0].total), grossRevenue: Number(rev[0].total), totalExpenses: Number(exp[0].total), totalAppointments: Number(apts[0].total), totalBilling: Number(rev[0].total), appointmentRevenue: Number(rev[0].total), billingRevenue: 0, totalClients: Number(clts[0].total), totalPets: Number(pets[0].total), serviceBreakdown, recentTransactions, topServices: serviceBreakdown, clientGrowth } });
  } catch (e) { console.error('[reports]', e.message); res.json({ data: { monthlyRevenue:[],totalRevenue:0,grossRevenue:0,totalExpenses:0,totalAppointments:0,totalBilling:0,appointmentRevenue:0,billingRevenue:0,totalClients:0,totalPets:0,serviceBreakdown:[],recentTransactions:[],topServices:[],clientGrowth:[] } }); }
});

// â”€â”€â”€ FORMS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Resolves user ids to display names from the platform database. `users` is a
// platform-only table (never cloned into a clinic database), and forms.created_by
// is an int FK into it, so the name has to be looked up platform-side.
async function userNamesById(ids) {
  const out = new Map();
  const clean = [...new Set((ids || []).filter((n) => Number.isFinite(Number(n)) && n !== null))];
  if (!clean.length) return out;
  try {
    const [rows] = await platConn.query(`SELECT id, name FROM users WHERE id IN (${clean.map(() => '?').join(',')})`, clean);
    for (const r of rows) out.set(Number(r.id), r.name);
  } catch (e) {
    console.error('[userNamesById]', e.message);
  }
  return out;
}

// form_pages.fields is a longtext column holding a JSON array. A single
// unparseable row must not turn into a 500 for the whole form - the editor
// would show the form as broken and the user could not open it to fix the page.
function parseStoredFields(raw) {
  if (raw === null || raw === undefined) return [];
  if (typeof raw === 'object') return raw;
  const text = String(raw).trim();
  if (!text) return [];
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : [];
  } catch (e) {
    console.error('[parseStoredFields]', e.message);
    return [];
  }
}

async function formPagesOf(formRow) {
  if (!formRow) return null;
  const names = await userNamesById([formRow.created_by]);
  return {
    id: formRow.id,
    name: formRow.name,
    branchId: formRow.branch_id,
    thumbnailUrl: formRow.thumbnail_url,
    createdByName: names.get(Number(formRow.created_by)) || '',
    createdAt: formRow.created_at,
    updatedAt: formRow.updated_at,
    pageCount: null,
    pages: [],
  };
}

app.get('/api/forms', authMiddleware, async (req, res) => {
  try {
    const { page = 1, pageSize = 12, search = '' } = req.query;
    const pg = P(page), sz = P(pageSize) || 12;
    let where = '1=1', params = [];
    if (search) { where += ' AND f.name LIKE ?'; params.push(`%${search}%`); }
    const [count] = await db.query(`SELECT COUNT(*) cnt FROM forms f WHERE ${where}`, params);
    const [rows] = await db.query(
      `SELECT f.*, COALESCE((SELECT COUNT(*) FROM form_pages fp WHERE fp.form_id = f.id), 0) as pageCount
       FROM forms f WHERE ${where} ORDER BY f.id DESC LIMIT ? OFFSET ?`, [...params, sz, (pg - 1) * sz]);
    // `users` is a platform table and is deliberately NOT cloned into each
    // clinic database, so it cannot be joined from the clinic connection. The
    // creator's name is resolved with a second platform-side lookup instead.
    const names = await userNamesById(rows.map((r) => r.created_by));
    const data = rows.map((r) => ({
      id: r.id, name: r.name, branchId: r.branch_id, pageCount: r.pageCount,
      thumbnailUrl: r.thumbnail_url, createdByName: names.get(r.created_by) || '',
      createdAt: r.created_at, updatedAt: r.updated_at,
    }));
    res.json(paginate(data, count[0].cnt, pg, sz));
  } catch (e) { console.error('[forms]', e.message); res.json(EMPTY); }
});
app.post('/api/forms', authMiddleware, async (req, res) => {
  try {
    const { name, branchId, pages, thumbnailUrl } = req.body;
    // created_by is an int FK to users.id. It was hardcoded to the string
    // 'Owner', so every single create died with "Incorrect integer value:
    // 'Owner' for column forms.created_by" and no form could ever be saved.
    const [r] = await db.query('INSERT INTO forms (name, branch_id, thumbnail_url, created_by) VALUES (?,?,?,?)',
      [name || 'Untitled Form', branchId ?? null, thumbnailUrl || null, req.userId || null]);
    const formId = r.insertId;
    const pageRows = Array.isArray(pages) ? pages : [];
    for (let i = 0; i < pageRows.length; i++) {
      await db.query('INSERT INTO form_pages (form_id, page_index, image_url, fields) VALUES (?,?,?,?)',
        [formId, i, pageRows[i].imageUrl || pageRows[i].image_url || null,
         pageRows[i].fields ? JSON.stringify(pageRows[i].fields) : null]);
    }
    // db.query resolves to [rows, fields]; taking element 0 hands over the rows
    // ARRAY, not the row, so every field read off it came back undefined and the
    // create response lost its id and name.
    const [createdRows] = await db.query('SELECT * FROM forms WHERE id=?', [formId]);
    res.json({ data: await formPagesOf(createdRows[0]) });
  } catch (e) { console.error('[forms POST]', e.message); res.status(500).json({ error: { message: e.message } }); }
});
// The full form, pages included, in the shape the editor expects. Shared by GET
// and PATCH: the PATCH used to answer {success:true} with no row, and the
// handler maps result.data straight into toLocalForm, so the update reported
// "Cannot read properties of undefined (reading 'id')" even though the rename
// itself had been written.
async function fullForm(formId) {
  const [forms] = await db.query('SELECT * FROM forms WHERE id=?', [formId]);
  if (!forms.length) return null;
  const f = forms[0];
  const [pages] = await db.query('SELECT * FROM form_pages WHERE form_id=? ORDER BY page_index', [formId]);
  const names = await userNamesById([f.created_by]);
  return {
    id: f.id, name: f.name, branchId: f.branch_id,
    thumbnailUrl: f.thumbnail_url,
    createdByName: names.get(Number(f.created_by)) || '',
    createdAt: f.created_at, updatedAt: f.updated_at,
    pageCount: pages.length,
    pages: pages.map((p) => ({ id: p.id, imageUrl: p.image_url, fields: parseStoredFields(p.fields) })),
  };
}

app.get('/api/forms/:id', authMiddleware, async (req, res) => {
  try {
    const data = await fullForm(req.params.id);
    if (!data) return res.status(404).json({ error: { message: 'Not found' } });
    res.json({ data });
  } catch (e) { console.error('[forms GET]', e.message); res.status(500).json({ error: { message: e.message } }); }
});
app.patch('/api/forms/:id', authMiddleware, async (req, res) => {
  try {
    const formId = req.params.id;
    const { name, branchId, pages, thumbnailUrl } = req.body;
    const F = [], V = [];
    if (name !== undefined) { F.push('name=?'); V.push(name); }
    if (branchId !== undefined) { F.push('branch_id=?'); V.push(branchId ?? null); }
    if (thumbnailUrl !== undefined) { F.push('thumbnail_url=?'); V.push(thumbnailUrl); }
    if (F.length) await db.query(`UPDATE forms SET ${F.join(',')} WHERE id=?`, [...V, formId]);
    if (pages !== undefined) {
      await db.query('DELETE FROM form_pages WHERE form_id=?', [formId]);
      for (let i = 0; i < pages.length; i++) {
        await db.query('INSERT INTO form_pages (form_id, page_index, image_url, fields) VALUES (?,?,?,?)',
          [formId, i, pages[i].imageUrl || pages[i].image_url || null,
           pages[i].fields ? JSON.stringify(pages[i].fields) : null]);
      }
    }
    // Answer with the saved row: the renderer maps result.data into its own
    // form shape, so a bare {success:true} left it with nothing to show.
    res.json({ success: true, data: await fullForm(formId) });
  } catch (e) { console.error('[forms PATCH]', e.message); res.status(500).json({ error: { message: e.message } }); }
});
app.delete('/api/forms/:id', authMiddleware, async (req, res) => {
  try {
    await db.query('DELETE FROM form_pages WHERE form_id=?', [req.params.id]);
    await db.query('DELETE FROM forms WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch { res.json({ success: true }); }
});

// â”€â”€â”€ BANK ACCOUNTS / PAYMENT SUBMISSIONS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/bank-accounts', authMiddleware, (req, res) => res.json({ data: [] }));
app.get('/api/clinics/me/payment-submissions', authMiddleware, (req, res) => res.json(EMPTY));
app.post('/api/clinics/me/payment-submissions', authMiddleware, (req, res) => res.json({ success: true }));

// â”€â”€â”€ BOARDING â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const STAY_SELECT = `SELECT s.*, p.pet_name, p.species, p.breed, p.is_neutered, c.client_name, c.contact_number,
  cu.unit_label, cu.cage_type_id, ct.type_name, ct.is_free_area, sv.name as service_name, sv.base_rate as service_rate
  FROM boarding_stays s
  LEFT JOIN pets p ON s.pet_id=p.id
  LEFT JOIN clients c ON s.client_id=c.id
  LEFT JOIN cage_units cu ON s.cage_unit_id=cu.id
  LEFT JOIN cage_types ct ON cu.cage_type_id=ct.id
  LEFT JOIN services sv ON s.service_id=sv.id`;

function boardingStay(row) {
  if (!row) return null;
  return toCamel(row);
}
function unitRowsWithStatus() {
  return db.query(`SELECT cu.id as id, cu.cage_type_id, cu.unit_label, cu.is_active, ct.type_name, ct.is_free_area,
    st.id as stay_id, st.date_in, st.expected_checkout_date, st.requires_monitoring, st.needs_vaccination, st.needs_deworming,
    st.owner_provides_food,
    CASE WHEN st.expected_checkout_date = CURDATE() THEN 1 ELSE 0 END as active_checkout_today,
    p.id as pet_id, p.pet_name, p.species, p.is_neutered, c.client_name, c.contact_number
    FROM cage_units cu
    JOIN cage_types ct ON cu.cage_type_id=ct.id
    LEFT JOIN boarding_stays st ON cu.id=st.cage_unit_id AND st.status='ACTIVE'
    LEFT JOIN pets p ON st.pet_id=p.id
    LEFT JOIN clients c ON st.client_id=c.id
    WHERE cu.is_active=1 ORDER BY CAST(cu.unit_label AS SIGNED), cu.id`);
}

app.get('/api/boarding/space-types', authMiddleware, async (req, res) => {
  try {
    const [types] = await db.query('SELECT ct.*, (SELECT COUNT(*) FROM cage_units u WHERE u.cage_type_id=ct.id AND u.is_active=1) as active_unit_count FROM cage_types ct ORDER BY ct.id');
    res.json({ data: toCamel(types) });
  } catch { res.json({ data: [] }); }
});
app.post('/api/boarding/space-types', authMiddleware, async (req, res) => {
  try {
    const d = req.body;
    const isFree = !!(d.isFreeArea ?? d.is_free_area);
    const typeName = d.typeName || d.type_name || '';
    const qty = isFree ? 0 : (Math.max(0, Number(d.quantity) || 0));
    const [r] = await db.query('INSERT INTO cage_types (branch_id,type_name,is_free_area,quantity) VALUES (?,?,?,?)', [d.branchId || d.branch_id || null, typeName, isFree ? 1 : 0, isFree ? 1 : qty]);
    const units = isFree ? 1 : qty;
    for (let i = 1; i <= units; i++) {
      await db.query('INSERT INTO cage_units (cage_type_id,unit_label) VALUES (?,?)', [r.insertId, isFree ? (typeName || 'Free') : String(i)]);
    }
    const [types] = await db.query('SELECT ct.*, (SELECT COUNT(*) FROM cage_units u WHERE u.cage_type_id=ct.id AND u.is_active=1) as active_unit_count FROM cage_types ct WHERE ct.id=?', [r.insertId]);
    res.json({ data: toCamel(types[0]) });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.patch('/api/boarding/space-types/:id', authMiddleware, async (req, res) => {
  try {
    const d = req.body;
    const tName = d.typeName ?? d.type_name;
    if (tName !== undefined) await db.query('UPDATE cage_types SET type_name=? WHERE id=?', [tName, req.params.id]);
    const qRaw = d.quantity ?? d.quantity_num;
    if (qRaw !== undefined) {
      const qty = Math.max(0, Number(qRaw) || 0);
      await db.query('UPDATE cage_types SET quantity=? WHERE id=?', [qty, req.params.id]);
      await db.query('UPDATE cage_units SET is_active = CASE WHEN CAST(unit_label AS SIGNED) <= ? THEN 1 ELSE 0 END WHERE cage_type_id=? AND unit_label REGEXP "^(0|[1-9][0-9]*)$"', [qty, req.params.id]);
      const [cnt] = await db.query('SELECT COUNT(*) as n FROM cage_units WHERE cage_type_id=? AND is_active=1', [req.params.id]);
      for (let i = cnt[0].n + 1; i <= qty; i++) {
        await db.query('INSERT INTO cage_units (cage_type_id,unit_label) VALUES (?,?)', [req.params.id, String(i)]);
      }
    }
    const [types] = await db.query('SELECT ct.*, (SELECT COUNT(*) FROM cage_units u WHERE u.cage_type_id=ct.id AND u.is_active=1) as active_unit_count FROM cage_types ct WHERE ct.id=?', [req.params.id]);
    res.json({ data: toCamel(types[0]) });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.delete('/api/boarding/space-types/:id', authMiddleware, async (req, res) => {
  try {
    await db.query('DELETE FROM cage_units WHERE cage_type_id=?', [req.params.id]);
    await db.query('DELETE FROM cage_types WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch { res.json({ success: true }); }
});
app.get('/api/boarding/space-units', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query('SELECT cu.id, cu.cage_type_id, cu.unit_label, ct.type_name, ct.is_free_area FROM cage_units cu JOIN cage_types ct ON cu.cage_type_id=ct.id WHERE cu.is_active=1 ORDER BY CAST(cu.unit_label AS SIGNED), cu.id'); res.json({ data: toCamel(rows) }); }
  catch { res.json({ data: [] }); }
});
app.get('/api/boarding/space-units/free', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query('SELECT cu.id, cu.cage_type_id, cu.unit_label, ct.type_name, ct.is_free_area FROM cage_units cu JOIN cage_types ct ON cu.cage_type_id=ct.id WHERE cu.is_active=1 AND cu.id NOT IN (SELECT cage_unit_id FROM boarding_stays WHERE status="ACTIVE" AND cage_unit_id IS NOT NULL) ORDER BY CAST(cu.unit_label AS SIGNED), cu.id'); res.json({ data: toCamel(rows) }); }
  catch { res.json({ data: [] }); }
});
app.get('/api/boarding/space-units/with-status', authMiddleware, async (req, res) => {
  try { const [rows] = await unitRowsWithStatus(); res.json({ data: toCamel(rows) }); }
  catch { res.json({ data: [] }); }
});
app.get('/api/boarding/settings', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query('SELECT * FROM boarding_settings ORDER BY id LIMIT 1');
    const s = rows[0] || {};
    res.json({ data: { defaultFeedingIntervalMinutes: s.feeding_interval_minutes ?? 360, defaultMonitoringIntervalMinutes: s.monitoring_interval_minutes ?? 60 } });
  } catch { res.json({ data: { defaultFeedingIntervalMinutes: 360, defaultMonitoringIntervalMinutes: 60 } }); }
});
app.patch('/api/boarding/settings', authMiddleware, async (req, res) => {
  try {
    const d = req.body;
    const [rows] = await db.query('SELECT * FROM boarding_settings ORDER BY id LIMIT 1');
    if (rows.length) await db.query('UPDATE boarding_settings SET feeding_interval_minutes=?,monitoring_interval_minutes=? WHERE id=?', [d.defaultFeedingIntervalMinutes ?? 360, d.defaultMonitoringIntervalMinutes ?? 60, rows[0].id]);
    else await db.query('INSERT INTO boarding_settings (feeding_interval_minutes,monitoring_interval_minutes) VALUES (?,?)', [d.defaultFeedingIntervalMinutes ?? 360, d.defaultMonitoringIntervalMinutes ?? 60]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.post('/api/boarding/stays', authMiddleware, async (req, res) => {
  try {
    const d = req.body;
    const [pets] = await db.query('SELECT client_id FROM pets WHERE id=?', [d.petId || 0]);
    const clientId = d.clientId || pets[0]?.client_id || null;
    const purpose = d.purposeText || 'BOARDING';
    const [r] = await db.query('INSERT INTO boarding_stays (branch_id,pet_id,client_id,cage_unit_id,service_id,date_in,expected_checkout_date,status,purpose,hospitalization_purpose,requires_monitoring,notes,needs_vaccination,needs_deworming,owner_provides_food,feeding_interval_minutes,monitoring_interval_minutes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [d.branchId || null, d.petId || null, clientId, d.cageUnitId || null, d.serviceId || null, d.dateIn || null, d.expectedCheckoutDate || null, 'ACTIVE', purpose, purpose === 'HOSPITALIZATION' ? purpose : null, d.requiresMonitoring ? 1 : 0, d.notes || null, d.needsVaccination ? 1 : 0, d.needsDeworming ? 1 : 0, d.ownerProvidesFood ? 1 : 0, d.feedingIntervalMinutes || null, d.monitoringIntervalMinutes || null]);
    const [rows] = await db.query(`${STAY_SELECT} WHERE s.id=?`, [r.insertId]);
    res.json({ data: boardingStay(rows[0]) });
    notify({ recipientAudience: 'STAFF', title: purpose === 'HOSPITALIZATION' ? 'Hospitalization admitted' : 'Boarding check-in', message: `${d.petName || rows[0]?.pet_name || 'A pet'} — ${purpose}`, category: 'boarding', priority: purpose === 'HOSPITALIZATION' ? 'high' : 'normal', relatedEntityType: 'boarding_stay', relatedEntityId: r.insertId, eventKey: `boarding-in-${r.insertId}` });
    if (clientId) notify({ recipientAudience: 'CLIENT', recipientClientId: clientId, title: purpose === 'HOSPITALIZATION' ? 'Your pet has been admitted' : 'Boarding confirmed', message: `${rows[0]?.pet_name || 'Your pet'} ${purpose === 'HOSPITALIZATION' ? 'is under our care' : 'is checked in'}${d.expectedCheckoutDate ? ' — expected out ' + d.expectedCheckoutDate : ''}.`, category: 'boarding', relatedEntityType: 'boarding_stay', relatedEntityId: r.insertId, actionUrl: '/portal/boarding', eventKey: `boarding-in-client-${r.insertId}` });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.get('/api/boarding/stays/active', authMiddleware, async (req, res) => {
  try {
    const { search, spaceTypeId, purpose } = req.query;
    let where = 's.status="ACTIVE"', params = [];
    if (search) { where += ' AND (p.pet_name LIKE ? OR c.client_name LIKE ? OR cu.unit_label LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
    if (spaceTypeId) { where += ' AND ct.id=?'; params.push(spaceTypeId); }
    if (purpose) { where += ' AND s.purpose=?'; params.push(purpose); }
    const [rows] = await db.query(`${STAY_SELECT} WHERE ${where} ORDER BY s.id DESC`, params);
    res.json({ data: rows.map(boardingStay) });
  } catch { res.json({ data: [] }); }
});
app.get('/api/boarding/stays/:id', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query(`${STAY_SELECT} WHERE s.id=?`, [req.params.id]); if (!rows.length) return res.status(404).json({ error: { message: 'Not found', code: 'NOT_FOUND' } }); res.json({ data: boardingStay(rows[0]) }); }
  catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.patch('/api/boarding/stays/:id', authMiddleware, async (req, res) => {
  try {
    const d = req.body;
    const F = [], V = [];
    if (d.dateIn !== undefined) { F.push('date_in=?'); V.push(d.dateIn); }
    if (d.expectedCheckoutDate !== undefined) { F.push('expected_checkout_date=?'); V.push(d.expectedCheckoutDate); }
    if (d.serviceId !== undefined) { F.push('service_id=?'); V.push(d.serviceId); }
    if (d.purposeText !== undefined) { F.push('purpose=?'); V.push(d.purposeText); }
    if (d.notes !== undefined) { F.push('notes=?'); V.push(d.notes); }
    if (d.needsVaccination !== undefined) { F.push('needs_vaccination=?'); V.push(d.needsVaccination ? 1 : 0); }
    if (d.needsDeworming !== undefined) { F.push('needs_deworming=?'); V.push(d.needsDeworming ? 1 : 0); }
    if (d.ownerProvidesFood !== undefined) { F.push('owner_provides_food=?'); V.push(d.ownerProvidesFood ? 1 : 0); }
    if (d.feedingIntervalMinutes !== undefined) { F.push('feeding_interval_minutes=?'); V.push(d.feedingIntervalMinutes); }
    if (d.monitoringIntervalMinutes !== undefined) { F.push('monitoring_interval_minutes=?'); V.push(d.monitoringIntervalMinutes); }
    if (F.length) { V.push(req.params.id); await db.query(`UPDATE boarding_stays SET ${F.join(',')} WHERE id=?`, V); }
    const [rows] = await db.query(`${STAY_SELECT} WHERE s.id=?`, [req.params.id]);
    res.json({ data: boardingStay(rows[0]) });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.delete('/api/boarding/stays/:id', authMiddleware, async (req, res) => {
  try {
    await db.query('DELETE FROM boarding_stays WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch { res.json({ success: true }); }
});
app.get('/api/boarding/stays/:id/checkout-preview', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query(`${STAY_SELECT} WHERE s.id=?`, [req.params.id]);
    if (!rows.length) return res.json({ data: { nights: 0, total: 0, items: [], serviceName: null, serviceRate: 0 } });
    const s = rows[0];
    const days = s.date_in ? Math.max(1, Math.round((Date.now() - new Date(s.date_in).getTime()) / 86400000)) : 1;
    res.json({ data: { nights: days, total: days * (Number(s.service_rate) || 0), items: [], serviceName: s.service_name || null, serviceRate: Number(s.service_rate) || 0 } });
  } catch { res.json({ data: { nights: 0, total: 0, items: [], serviceName: null, serviceRate: 0 } }); }
});
app.post('/api/boarding/stays/:id/checkout', authMiddleware, async (req, res) => {
  try {
    const d = req.body || {};
    await db.query('UPDATE boarding_stays SET date_out=?,status="CHECKED_OUT" WHERE id=?', [d.dateOut || new Date().toISOString().slice(0, 10), req.params.id]);
    const [rows] = await db.query(`${STAY_SELECT} WHERE s.id=?`, [req.params.id]);
    const s = rows[0] || {};
    const days = s.date_in ? Math.max(1, Math.round((Date.now() - new Date(s.date_in).getTime()) / 86400000)) : 1;
    res.json({ data: { nights: days, serviceName: s.service_name || null, serviceRate: Number(s.service_rate) || 0, branchId: s.branch_id || null } });
    notify({ recipientAudience: 'STAFF', title: 'Boarding checked out', message: `${s.pet_name || 'A pet'} checked out — ${days} night(s)`, category: 'boarding', relatedEntityType: 'boarding_stay', relatedEntityId: Number(req.params.id), eventKey: `boarding-out-${req.params.id}` });
    if (s.client_id) notify({ recipientAudience: 'CLIENT', recipientClientId: s.client_id, title: 'Your pet is ready', message: `${s.pet_name || 'Your pet'} has been checked out after ${days} night(s).`, category: 'boarding', relatedEntityType: 'boarding_stay', relatedEntityId: Number(req.params.id), actionUrl: '/portal/boarding', eventKey: `boarding-out-client-${req.params.id}` });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.post('/api/boarding/stays/:id/feeding', authMiddleware, async (req, res) => {
  try {
    const d = req.body;
    const [r] = await db.query('INSERT INTO boarding_care_log (stay_id,log_type,logged_by,notes,product_id,item_name,display_name,quantity,price) VALUES (?,?,?,?,?,?,?,?,?)',
      [req.params.id, 'FEEDING', d.loggedBy || null, d.notes || null, d.productId || null, d.itemName || null, d.itemName || null, d.quantity ?? null, d.price ?? null]);
    const [rows] = await db.query('SELECT * FROM boarding_care_log WHERE id=?', [r.insertId]);
    res.json({ data: toCamel(rows[0]) });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.get('/api/boarding/stays/:id/care-log', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT l.*, m.drug_name as medication_name, m.product_id as med_product_id FROM boarding_care_log l LEFT JOIN boarding_medications m ON l.medication_id=m.id WHERE l.stay_id=? ORDER BY l.logged_at DESC', [req.params.id]);
    res.json({ data: toCamel(rows).map(r => ({ ...r, medicationName: r.medicationName || null })) });
  } catch { res.json({ data: [] }); }
});
app.post('/api/boarding/stays/:id/medications', authMiddleware, async (req, res) => {
  try {
    const d = req.body;
    const [r] = await db.query('INSERT INTO boarding_medications (stay_id,drug_name,dose,interval_minutes,product_id,quantity,price,is_active,started_at) VALUES (?,?,?,?,?,?,?,1,NOW())',
      [req.params.id, d.drugName || '', d.dose || null, d.intervalMinutes || null, d.productId || null, d.quantity ?? null, d.price ?? null]);
    const [rows] = await db.query('SELECT * FROM boarding_medications WHERE id=?', [r.insertId]);
    res.json({ data: toCamel(rows[0]) });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.get('/api/boarding/stays/:id/medications', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query('SELECT * FROM boarding_medications WHERE stay_id=? AND is_active=1 ORDER BY id', [req.params.id]); res.json({ data: toCamel(rows) }); }
  catch { res.json({ data: [] }); }
});
app.post('/api/boarding/medications/:id/administer', authMiddleware, async (req, res) => {
  try {
    const [meds] = await db.query('SELECT * FROM boarding_medications WHERE id=?', [req.params.id]);
    const m = meds[0] || {};
    const [r] = await db.query('INSERT INTO boarding_care_log (stay_id,log_type,notes,medication_id,product_id,display_name,quantity,price) VALUES (?,?,?,?,?,?,?,?)',
      [m.stay_id || null, 'MEDICATION', req.body?.notes || null, req.params.id, m.product_id || null, m.drug_name || null, m.quantity ?? null, m.price ?? null]);
    const [rows] = await db.query('SELECT * FROM boarding_care_log WHERE id=?', [r.insertId]);
    res.json({ data: toCamel(rows[0]) });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.post('/api/boarding/medications/:id/discontinue', authMiddleware, async (req, res) => {
  try { await db.query('UPDATE boarding_medications SET is_active=0,discontinued_at=NOW() WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch { res.json({ success: true }); }
});
app.post('/api/boarding/stays/:id/payment', authMiddleware, async (req, res) => {
  try {
    const d = req.body;
    const [stays] = await db.query(`${STAY_SELECT} WHERE s.id=?`, [req.params.id]);
    const s = stays[0] || {};
    const cart = Array.isArray(d.productsCart) ? d.productsCart : [];
    const serviceTotal = (() => { const days = s.date_in ? Math.max(1, Math.round((Date.now() - new Date(s.date_in).getTime()) / 86400000)) : 1; return days * (Number(s.service_rate) || 0); })();
    const productTotal = cart.reduce((sum, c) => sum + (Number(c.total) || (Number(c.cartQty) || 1) * (Number(c.price) || 0)), 0);
    const subtotal = serviceTotal + productTotal;
    const percentDisc = Number(d.manualDiscountPercent) || 0;
    const fixedDisc = Number(d.manualDiscountFixed) || 0;
    const couponDisc = 0;
    const discount = Math.min(subtotal, (subtotal * percentDisc / 100) + fixedDisc + couponDisc);
    const finalTotal = Math.max(0, subtotal - discount);
    const amountPaid = Number(d.amount) || finalTotal;
    const paymentMode = d.paymentMode === 'CARD_PAYMENT' ? 'CARD' : (d.paymentMode === 'BANK_TRANSFER' ? 'BANK_TRANSFER' : 'CASH');
    const status = amountPaid >= finalTotal && finalTotal > 0 ? 'PAID' : (amountPaid > 0 ? 'PARTIALLY_PAID' : 'UNPAID');
    const [did] = await db.query('INSERT INTO billing (client_id,customer_name,subtotal,discount,final_total,amount_paid,status,payment_mode,invoice_no) VALUES (?,?,?,?,?,?,?,?,?)',
      [s.client_id || null, s.client_name || '', subtotal, discount, finalTotal, amountPaid, status, paymentMode, 'BRD-' + Date.now()]);
    await db.query('UPDATE boarding_stays SET billing_id=?,amount_paid=?,payment_mode=? WHERE id=?', [did.insertId, amountPaid, paymentMode, req.params.id]);
    res.json({ data: { stayId: Number(req.params.id), billingId: did.insertId, subtotal, discount, finalTotal, amountPaid, status } });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});
app.get('/api/boarding/stays/:id/consent-payload', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.query(`${STAY_SELECT} WHERE s.id=?`, [req.params.id]);
    const s = rows[0]; if (!s) return res.json({ data: {} });
    res.json({ data: { ownerName: s.client_name, ownerPhone: s.contact_number, ownerAddress: null, petName: s.pet_name, species: s.species, breed: s.breed, color: null, sex: null, isNeutered: s.is_neutered, dropOffDate: s.date_in, pickupDate: s.expected_checkout_date || s.date_out, needsVaccination: s.needs_vaccination, needsDeworming: s.needs_deworming } });
  } catch { res.json({ data: {} }); }
});
const boardingSummaryData = (s) => ({
  branchId: s.branch_id, cageLabel: s.unit_label, petName: s.pet_name, clientName: s.client_name,
  dateIn: s.date_in, dateOut: s.date_out || null, diagnosis: s.notes || null, conditionStatus: null,
  isDailySummary: false, summaryDateFrom: null, summaryDateTo: null,
  timeline: [], purpose: s.purpose, hospitalizationPurpose: s.hospitalization_purpose,
  requiresMonitoring: !!s.requires_monitoring, serviceName: s.service_name || null, serviceRate: s.service_rate != null ? Number(s.service_rate) : null,
});
app.get('/api/boarding/stays/:id/summary-payload', authMiddleware, async (req, res) => {
  try {
    const { dailyOnly, from, to } = req.query;
    const [rows] = await db.query(`${STAY_SELECT} WHERE s.id=?`, [req.params.id]);
    const s = rows[0]; if (!s) return res.json({ data: {} });
    const d = boardingSummaryData(s);
    d.isDailySummary =!!dailyOnly; d.summaryDateFrom = from || null; d.summaryDateTo = to || null;
    const [log] = await db.query('SELECT * FROM boarding_care_log WHERE stay_id=? ORDER BY logged_at DESC LIMIT 20', [req.params.id]);
    d.timeline = toCamel(log).map(l => ({ type: l.logType, timestamp: l.loggedAt, description: l.displayName || l.itemName || l.notes || '', loggedBy: l.loggedBy || null }));
    res.json({ data: d });
  } catch { res.json({ data: {} }); }
});
app.get('/api/boarding/pets/:petId/stays', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query(`${STAY_SELECT} WHERE s.pet_id=? ORDER BY s.id DESC`, [req.params.petId]); res.json({ data: rows.map(boardingStay) }); }
  catch { res.json({ data: [] }); }
});
app.get('/api/boarding/stays/:id/vitals-history', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query('SELECT * FROM soap_notes WHERE boarding_stay_id=? ORDER BY id DESC', [req.params.id]); res.json({ data: toCamel(rows) }); }
  catch { res.json({ data: [] }); }
});
app.get('/api/boarding/stays/:id/exists', authMiddleware, async (req, res) => {
  try { const [rows] = await db.query('SELECT id FROM soap_notes WHERE boarding_stay_id=? LIMIT 1', [req.params.id]); res.json({ exists: rows.length > 0 }); }
  catch { res.json({ exists: false }); }
});
app.post('/api/boarding/stays/:id/save-invoice', authMiddleware, (req, res) => res.json({ success: true }));
app.post('/api/boarding/preview-checkout-invoice', authMiddleware, (req, res) => res.json({ data: {} }));
app.post('/api/boarding/print-checkout-invoice', authMiddleware, (req, res) => res.json({ success: true }));
app.post('/api/boarding/preview-consent-form', authMiddleware, (req, res) => res.json({ data: {} }));
app.post('/api/boarding/print-consent-form', authMiddleware, (req, res) => res.json({ success: true }));
app.post('/api/boarding/preview-hospitalization-summary', authMiddleware, (req, res) => res.json({ data: {} }));
app.post('/api/boarding/print-hospitalization-summary', authMiddleware, (req, res) => res.json({ success: true }));
app.post('/api/boarding/preview-daily-summary', authMiddleware, (req, res) => res.json({ data: {} }));
app.post('/api/boarding/print-daily-summary', authMiddleware, (req, res) => res.json({ success: true }));

// â”€â”€â”€ AI â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post('/api/ai/refine-reminder-note', authMiddleware, (req, res) => res.json({ text: req.body.text }));
app.post('/api/ai/refine-soap-text', authMiddleware, (req, res) => res.json({ text: req.body.text }));
app.post('/api/ai/scan-product-image', authMiddleware, (req, res) => res.json({ products: [] }));

// â”€â”€â”€ DISCOUNT RANGE / TIME FORMAT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/discount-range', authMiddleware, (req, res) => res.json({ min: 0, max: 50 }));
app.get('/api/time-format', authMiddleware, (req, res) => res.json({ use12Hour: false }));

// ─── NOTIFICATION CENTRE (staff bell + Alerts page) ─────────────────────────
// Staff see every STAFF-audience row, plus any row addressed to them
// specifically. Client-audience rows never appear here.
app.get('/api/notifications', authMiddleware, async (req, res) => {
  try {
    const lim = Math.min(P(req.query.limit) || 30, 200);
    const conditions = ["recipient_audience='STAFF'", '(recipient_user_id IS NULL OR recipient_user_id=?)'];
    const params = [req.userId || 0];
    if (String(req.query.unreadOnly) === 'true' || String(req.query.unreadOnly) === '1') conditions.push('is_read=0');
    if (req.query.category) { conditions.push('category=?'); params.push(req.query.category); }
    const where = conditions.join(' AND ');
    const [rows] = await db.query(`SELECT * FROM notifications WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ?`, [...params, lim]);
    const [cnt] = await db.query('SELECT COUNT(*) AS total, SUM(is_read=0) AS unread FROM notifications WHERE recipient_audience=\'STAFF\' AND (recipient_user_id IS NULL OR recipient_user_id=?)', [req.userId || 0]);
    res.json({ data: toCamel(rows), total: Number(cnt[0].total) || 0, unread: Number(cnt[0].unread) || 0 });
  } catch { res.json({ data: [], total: 0, unread: 0 }); }
});
app.get('/api/notifications/count', authMiddleware, async (req, res) => {
  try {
    const [cnt] = await db.query('SELECT COUNT(*) AS total, SUM(is_read=0) AS unread FROM notifications WHERE recipient_audience=\'STAFF\' AND (recipient_user_id IS NULL OR recipient_user_id=?)', [req.userId || 0]);
    res.json({ data: { total: Number(cnt[0].total) || 0, unread: Number(cnt[0].unread) || 0 } });
  } catch { res.json({ data: { total: 0, unread: 0 } }); }
});
app.patch('/api/notifications/:id/read', authMiddleware, async (req, res) => {
  try { await db.query("UPDATE notifications SET is_read=1, read_at=IFNULL(read_at,NOW()) WHERE id=? AND recipient_audience='STAFF'", [req.params.id]); res.json({ success: true }); }
  catch { res.json({ success: false }); }
});
app.post('/api/notifications/read-all', authMiddleware, async (req, res) => {
  try {
    const [r] = await db.query("UPDATE notifications SET is_read=1, read_at=IFNULL(read_at,NOW()) WHERE is_read=0 AND recipient_audience='STAFF' AND (recipient_user_id IS NULL OR recipient_user_id=?)", [req.userId || 0]);
    try { sseSend('notifications-updated', { audience: 'STAFF' }); } catch (_) {}
    res.json({ success: true, updated: r.affectedRows || 0 });
  } catch { res.json({ success: false }); }
});
app.delete('/api/notifications/:id', authMiddleware, async (req, res) => {
  try { await db.query("DELETE FROM notifications WHERE id=? AND recipient_audience='STAFF'", [req.params.id]); res.json({ success: true }); }
  catch { res.json({ success: false }); }
});
// Manual "alert all staff" from the Alerts page.
app.post('/api/notifications', authMiddleware, async (req, res) => {
  try {
    const { title, message, category, priority, relatedEntityType, relatedEntityId, actionUrl } = req.body || {};
    if (!title) return res.status(400).json({ error: { message: 'title is required' } });
    await notify({ recipientAudience: 'STAFF', title, message, category, priority, relatedEntityType, relatedEntityId, actionUrl });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});

// Customers for the "send alert / offer" picker. Lists this clinic's clients and
// flags which already have a portal account (i.e. who can receive in-app).
app.get('/api/notifications/customers', authMiddleware, async (req, res) => {
  try {
    const lim = Math.min(P(req.query.limit) || 200, 1000);
    const search = String(req.query.search || '').trim();
    let where = '', params = [];
    if (search) { where = 'WHERE c.client_name LIKE ? OR c.contact_number LIKE ?'; params = [`%${search}%`, `%${search}%`]; }
    const [rows] = await db.query(
      `SELECT c.id, c.client_name, c.contact_number,
              (SELECT COUNT(*) FROM client_accounts ca WHERE ca.client_id=c.id AND ca.is_active=1) AS has_portal
         FROM clients c ${where} ORDER BY c.client_name LIMIT ?`, [...params, lim]);
    res.json({ data: rows.map((r) => ({ id: r.id, clientName: r.client_name, contactNumber: r.contact_number, hasPortal: Number(r.has_portal) > 0 })) });
  } catch { res.json({ data: [] }); }
});

// Send an alert / offer / message to one or many customers. Each recipient gets
// their own CLIENT notification, which appears in their customer-portal bell.
// `all:true` targets every customer that has an active portal account.
app.post('/api/notifications/send', authMiddleware, async (req, res) => {
  try {
    const b = req.body || {};
    const title = String(b.title || '').trim();
    if (!title) return res.status(400).json({ error: { message: 'title is required' } });
    const category = ['offer', 'alert', 'general', 'appointment', 'billing', 'medical'].includes(b.category) ? b.category : 'general';
    const priority = ['low', 'normal', 'high', 'urgent'].includes(b.priority) ? b.priority : 'normal';
    const message = b.message ? String(b.message).slice(0, 2000) : null;
    let ids = [];
    if (b.all) {
      const [rows] = await db.query('SELECT DISTINCT client_id FROM client_accounts WHERE is_active=1 AND client_id IS NOT NULL');
      ids = rows.map((r) => Number(r.client_id)).filter(Boolean);
    } else if (Array.isArray(b.clientIds)) {
      ids = b.clientIds.map(Number).filter(Boolean);
    }
    ids = [...new Set(ids)];
    if (!ids.length) return res.status(400).json({ error: { message: 'No recipients selected' } });
    let sent = 0;
    for (const cid of ids) {
      await notify({
        recipientAudience: 'CLIENT', recipientClientId: cid, title, message, category, priority,
        relatedEntityType: 'broadcast', actionUrl: b.actionUrl || '/portal/notifications',
      });
      sent++;
    }
    res.json({ success: true, sent });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});

// ─── CUSTOMER PORTAL API (registered before the /api catch-all) ─────────────
registerPortalApi(app, {
  db, platConn, clinicStore, bcrypt, getTokenSecret, toCamel, P,
  notify, getClinicConn, clinicBrandingFor, guardClinicSubscription,
});

// ─── CATCH-ALL ──────────────────────────────────────────────────────────────
// â”€â”€â”€ PLATFORM SUPER ADMIN (registered before the /api catch-all) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const superAdminApi = registerSuperAdmin(app, {
  platConn, getClinicConn, createClinicDatabase, bcrypt, makeToken, okClinicSession,
  DB_NAME, CLINIC_PREFIX, mysql, DB_OPTS, closeClinicConn,
});

// Extended console screens (subscriptions, billing, users, analytics, reports,
// storage, health, settings, logs, backups…). Reuses the base auth + helpers so
// every navigation item in the Super Admin console is backed by a real API.
registerSuperAdminExt(app, {
  platConn, getClinicConn, bcrypt, DB_NAME, CLINIC_PREFIX,
  superAuth: superAdminApi.superAuth,
  audit: superAdminApi.audit,
  collectStats: superAdminApi.collectStats,
  clinicCounts: superAdminApi.clinicCounts,
  toRow: superAdminApi.toRow,
  clinicRow: superAdminApi.clinicRow,
});

app.all('/api/{*splat}', (req, res) => {
  const m = req.method.toUpperCase();
  if (m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE') res.json({ success: true });
  else res.json({ data: [], total: 0 });
});

// â”€â”€â”€ START â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const PORT = 4000;

function startServer(port) {
  const p = port || PORT;
  initSubscriptionSweep();
  const listen = () => new Promise((resolve) => {
    const srv = app.listen(p, () => {
      console.log(`PodVet API server running on port ${p}`);
      resolve(true);
    });
    srv.on('error', (e) => {
      console.error(`PodVet API server listen error: ${e.message} â€” another server on port ${p} will be used`);
      resolve(true);
    });
  });
  let dbRetry = null;
  const keepRetryingDb = () => {
    if (dbRetry) return;
    dbRetry = setInterval(async () => {
      try {
        await connectDB();
        clearInterval(dbRetry);
        dbRetry = null;
        console.log('MySQL recovered; API is functional again');
      } catch (e) { /* still down, keep retrying */ }
    }, 3000);
    if (dbRetry.unref) dbRetry.unref();
  };
  return connectDB().then(listen).catch(e => {
    console.error('DB connection failed:', e.message);
    console.error('API will retry MySQL in the background and serve DB routes once it is reachable.');
    keepRetryingDb();
    return listen();
  });
}

// dedupeSeedRows is exported so the migration can be exercised directly
// (against a throwaway copy of the data) without starting the whole server.
module.exports = { app, startServer, dedupeSeedRows, DEDUPE_PLANS };

// Auto-start when run directly (not required as module)
if (require.main === module && !process.versions.electron) {
  startServer();
}
