'use strict';

// Bundled portable MySQL for the PodVet desktop build.
//
// The installer ships the winx64 MySQL ZIP under resources/mysql. On first run
// the engine is initialized into <userData>/mysql-data (a per-user data dir,
// no admin rights needed), started bound to 127.0.0.1 on a scanned port in
// 33160+, given a dedicated `podvet` MySQL account with a random password
// (stored in <userData>/mysql-runtime.json), and db/schema.sql is imported
// through the mysql.exe client. On later runs the existing data dir is reused
// and the schema is only re-imported when the schema file changes (the file is
// idempotent — safe to re-run).
//
// Pure Node on purpose: main.js wires it up before require('./index'), and it
// must be testable with plain `node` too.
const path = require('path');
const fs = require('fs');
const net = require('net');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const PORT_MIN = 33160;
const PORT_MAX = 33199;
const APP_USER = 'podvet';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Live managed instance (null when the engine isn't running under us).
let managed = null; // { proc }
let runtime = null; // { port, password }

function locateHome() {
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'mysql'));
  candidates.push(path.join(__dirname, '..', 'vendor', 'mysql'));
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(path.join(candidate, 'bin', 'mysqld.exe'))) return candidate;
    } catch (_) { /* keep looking */ }
  }
  return null;
}

function tailFile(file, lines = 20) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
  } catch (_) {
    return '';
  }
}

function pidImage(pid) {
  try {
    const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8', windowsHide: true, timeout: 10000,
    });
    const line = (r.stdout || '').trim();
    const m = /^"([^"]+)"/.exec(line);
    return m ? m[1] : null;
  } catch (_) {
    return null;
  }
}

// The pid file lives inside OUR data dir, so a live mysqld found there is our
// own orphaned instance — but verify the image name first: pids get recycled
// and we must never kill an unrelated process.
async function cleanupStalePid(dataDir) {
  const pidFile = path.join(dataDir, 'mysqld.pid');
  let pid = 0;
  try { pid = parseInt(fs.readFileSync(pidFile, 'utf8'), 10); } catch (_) { return; }
  if (pid > 0 && pidImage(pid) === 'mysqld.exe') {
    try { spawnSync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true, timeout: 10000 }); } catch (_) { /* ignore */ }
    for (let i = 0; i < 25 && pidImage(pid) === 'mysqld.exe'; i++) await sleep(200);
  }
  try { fs.rmSync(pidFile, { force: true }); } catch (_) { /* ignore */ }
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function findFreePort() {
  for (let port = PORT_MIN; port <= PORT_MAX; port++) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free TCP port available for the database (tried ${PORT_MIN}-${PORT_MAX}).`);
}

function runProcess(exe, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) { /* ignore */ }
      reject(new Error(`${path.basename(exe)} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${path.basename(exe)} exited with code ${code}\n${(err || out).trim()}`));
    });
  });
}

async function tryConnect({ port, user, password }) {
  try {
    const mysql2 = require('mysql2/promise');
    const conn = await mysql2.createConnection({
      host: '127.0.0.1', port, user, password, connectTimeout: 3000,
    });
    await conn.query('SELECT 1');
    return conn;
  } catch (_) {
    return null;
  }
}

// Whatever credentials we have a chance with: the stored app account first,
// then the empty-password root created by --initialize-insecure.
async function connectAny(port, cfg) {
  if (cfg && cfg.password) {
    const conn = await tryConnect({ port, user: APP_USER, password: cfg.password });
    if (conn) return { conn, user: APP_USER, password: cfg.password };
  }
  const conn = await tryConnect({ port, user: 'root', password: '' });
  if (conn) return { conn, user: 'root', password: '' };
  return null;
}

async function initialize(home, dataDir, logFile, log) {
  log('Initializing database (first run, about a minute)…');
  if (fs.existsSync(logFile)) { try { fs.rmSync(logFile, { force: true }); } catch (_) {} }
  try {
    await runProcess(path.join(home, 'bin', 'mysqld.exe'), [
      '--no-defaults',
      `--basedir=${home}`,
      `--datadir=${dataDir}`,
      '--initialize-insecure',
      `--log-error=${logFile}`,
    ], 300000);
  } catch (e) {
    throw new Error(`Database initialization failed:\n${tailFile(logFile, 30)}\n${e.message}`);
  }
  if (!fs.existsSync(path.join(dataDir, 'mysql'))) {
    throw new Error(`Database initialization did not complete:\n${tailFile(logFile, 30)}`);
  }
}

function spawnServer(home, dataDir, port, errFile, pidFile) {
  if (fs.existsSync(errFile)) {
    try { fs.renameSync(errFile, `${errFile}.1`); } catch (_) { /* ignore */ }
  }
  const proc = spawn(path.join(home, 'bin', 'mysqld.exe'), [
    '--no-defaults',
    `--basedir=${home}`,
    `--datadir=${dataDir}`,
    `--port=${port}`,
    '--bind-address=127.0.0.1',
    '--mysqlx=OFF',
    `--log-error=${errFile}`,
    `--pid-file=${pidFile}`,
    '--character-set-server=utf8mb4',
    '--collation-server=utf8mb4_unicode_ci',
  ], { windowsHide: true, stdio: 'ignore' });
  proc.on('error', (e) => { fs.appendFileSync(`${errFile}.spawn`, `${new Date().toISOString()} ${e.message}\n`); });
  return { proc };
}

const sqlQuote = (value) => `'${String(value).replace(/['\\]/g, (m) => '\\' + m)}'`;

async function ensureAppUser(conn, password) {
  await conn.query(`CREATE USER IF NOT EXISTS '${APP_USER}'@'%' IDENTIFIED BY ${sqlQuote(password)}`);
  await conn.query(`ALTER USER '${APP_USER}'@'%' IDENTIFIED BY ${sqlQuote(password)}`);
  await conn.query(`GRANT ALL PRIVILEGES ON *.* TO '${APP_USER}'@'%'`);
  // The app streams SQL over the wire; it has no business reading server files.
  try { await conn.query(`REVOKE FILE ON *.* FROM '${APP_USER}'@'%'`); } catch (_) { /* older grants */ }
  await conn.query('FLUSH PRIVILEGES');
}

function importSchema(home, { port, user, password }, schemaFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(home, 'bin', 'mysql.exe'), [
      '--no-defaults',
      `-h127.0.0.1`,
      `-P${port}`,
      `-u${user}`,
      `-p${password}`,
      '--default-character-set=utf8mb4',
    ], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Schema import failed (mysql exited ${code}):\n${err.trim()}`));
    });
    const src = fs.createReadStream(schemaFile);
    src.on('error', reject);
    src.pipe(child.stdin);
  });
}

function readConfig(cfgPath) {
  try { return JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (_) { return null; }
}

function writeConfig(cfgPath, cfg) {
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
}

async function start({ userDataDir, schemaFile, log = () => {} }) {
  if (runtime) return { host: '127.0.0.1', ...runtime, user: APP_USER };

  const home = locateHome();
  if (!home) {
    throw new Error(
      'Bundled MySQL was not found (expected resources/mysql/bin/mysqld.exe). ' +
      'The installation may be incomplete — please reinstall PodVet.',
    );
  }

  const dataDir = path.join(userDataDir, 'mysql-data');
  const logsDir = path.join(userDataDir, 'mysql-logs');
  const cfgPath = path.join(userDataDir, 'mysql-runtime.json');
  const errFile = path.join(logsDir, 'mysqld.err');
  const initFile = path.join(logsDir, 'mysqld-init.err');
  const pidFile = path.join(dataDir, 'mysqld.pid');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  const cfg = readConfig(cfgPath) || {};

  log('Starting database…');
  let port = null;
  let session = null;

  // Already running (a previous instance left the engine up, or two starts
  // raced): reuse it instead of fighting over the data dir lock.
  if (cfg.port) session = await connectAny(cfg.port, cfg);

  if (session) {
    port = cfg.port;
  } else {
    await cleanupStalePid(dataDir);
    port = (cfg.port && (await isPortFree(cfg.port))) ? cfg.port : await findFreePort();
    const needsInit = !fs.existsSync(path.join(dataDir, 'mysql'));
    if (needsInit) await initialize(home, dataDir, initFile, log);
    log('Starting database engine…');
    managed = spawnServer(home, dataDir, port, errFile, pidFile);
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      if (managed.proc.exitCode !== null) {
        const exitCode = managed.proc.exitCode;
        managed = null;
        throw new Error(`Database engine exited during startup (code ${exitCode}):\n${tailFile(errFile, 30)}`);
      }
      session = await connectAny(port, cfg);
      if (session) break;
      await sleep(500);
    }
    if (!session) {
      throw new Error(`Database engine did not become ready in time:\n${tailFile(errFile, 30)}`);
    }
  }

  let { conn, user } = session;
  let password = session.password;

  if (user === 'root') {
    // First contact: mint (or re-sync) the app account with a stable password.
    password = cfg.password || crypto.randomBytes(16).toString('hex');
    await ensureAppUser(conn, password);
    conn.destroy();
    conn = await tryConnect({ port, user: APP_USER, password });
    if (!conn) throw new Error('Database account setup failed: the app account could not connect.');
    user = APP_USER;
  }

  log('Checking database schema…');
  let schemaHash = '';
  try { schemaHash = crypto.createHash('sha256').update(fs.readFileSync(schemaFile)).digest('hex'); } catch (_) {}
  let tables = 0;
  try {
    const [rows] = await conn.query(
      "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = 'podvet' AND table_name = 'clinics'",
    );
    tables = Number(rows[0] && rows[0].n) || 0;
  } catch (_) { /* schema check is best-effort; import below fixes it */ }

  if (tables === 0 || cfg.schemaHash !== schemaHash) {
    log(tables === 0 ? 'Creating database schema…' : 'Updating database schema…');
    await importSchema(home, { port, user, password }, schemaFile);
  }
  try { conn.destroy(); } catch (_) { /* ignore */ }

  writeConfig(cfgPath, { ...cfg, port, password, schemaHash });
  runtime = { port, password };
  log('Database ready.');
  return { host: '127.0.0.1', port, user: APP_USER, password };
}

async function stop() {
  const m = managed;
  const rt = runtime;
  managed = null;
  runtime = null;
  if (!m || m.proc.exitCode !== null) return;
  if (rt) {
    try {
      const conn = await tryConnect({ port: rt.port, user: APP_USER, password: rt.password });
      if (conn) {
        try { await conn.query('SHUTDOWN'); } catch (_) { /* connection dies as the server exits */ }
        try { conn.destroy(); } catch (_) { /* ignore */ }
      }
    } catch (_) { /* fall through to the kill below */ }
  }
  for (let i = 0; i < 30 && m.proc.exitCode === null; i++) await sleep(400);
  if (m.proc.exitCode === null) {
    try { m.proc.kill(); } catch (_) { /* ignore */ }
    try { spawnSync('taskkill', ['/PID', String(m.proc.pid), '/F'], { windowsHide: true, timeout: 8000 }); } catch (_) { /* ignore */ }
  }
}

module.exports = { start, stop, locateHome };
