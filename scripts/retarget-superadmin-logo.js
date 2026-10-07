/**
 * Point the super-admin console at the real PodVet brand assets.
 *
 *  - the favicon was an inline paw drawn in the retired blue (#92CAED)
 *  - the branding panel shipped empty Logo/Favicon URL fields, so the platform
 *    operator had no hint of which asset to point them at
 */
const fs = require('fs');

const FILE = 'E:/petvet/public/super-admin/index.html';
let s = fs.readFileSync(FILE, 'utf8');
const crlf = s.includes('\r\n');
const eol = crlf ? '\r\n' : '\n';
let lines = s.split(/\r?\n/);
let changed = [];

// 1. favicon -> symbol-only brand icon
const favRe = /^\s*<link rel="icon"[^>]*>\s*$/;
const favIdx = lines.findIndex((l) => favRe.test(l) && l.includes('data:image/svg+xml'));
if (favIdx < 0) throw new Error('inline SVG favicon link not found');
lines.splice(favIdx, 1,
  '    <link rel="icon" href="/brand/favicon.ico" sizes="any" />',
  '    <link rel="icon" type="image/png" sizes="32x32" href="/brand/favicon-32.png" />',
  '    <link rel="apple-touch-icon" sizes="180x180" href="/brand/favicon-180.png" />');
changed.push('favicon: inline blue paw SVG -> /brand/favicon.ico (+32px, +apple-touch)');

// 2. branding defaults -> real asset paths
const before = lines.findIndex((l) => l.includes("k: 'logoUrl'"));
if (before < 0) throw new Error('logoUrl setting row not found');
lines[before] = lines[before].replace("d: '' }", "d: '/brand/logo-primary.png' }");
changed.push("branding.logoUrl   default: '' -> /brand/logo-primary.png");

const favRow = lines.findIndex((l) => l.includes("k: 'faviconUrl'"));
if (favRow < 0) throw new Error('faviconUrl setting row not found');
lines[favRow] = lines[favRow].replace("d: '' }", "d: '/brand/favicon-32.png' }");
changed.push("branding.faviconUrl default: '' -> /brand/favicon-32.png");

// sanity: no retired-blue favicon left
const joined = lines.join('\n');
if (joined.includes('data:image/svg+xml') && joined.includes('%2392CAED')) {
  throw new Error('retired blue favicon still present');
}

fs.writeFileSync(FILE, lines.join(eol));
console.log('super-admin/index.html updated:');
changed.forEach((c) => console.log('  - ' + c));
console.log('  (line endings preserved: ' + (crlf ? 'CRLF' : 'LF') + ')');
