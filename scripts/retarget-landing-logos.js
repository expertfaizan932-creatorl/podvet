/**
 * Retarget the landing page logo to the correct brand variant per placement.
 *
 * The choice is driven by the real background behind each slot, because every
 * landing slot is a fixed square that already sits next to a text wordmark:
 *   - dark / saturated fills  -> white icon  (a navy+teal mark disappears into
 *                               the blue brand-900 fill; the teal lands at
 *                               ~1.3:1 against it)
 *   - light fills             -> full-colour navy + teal icon
 *   - always the symbol, never the wordmark (a 32-40px slot cannot read one)
 */
const fs = require('fs');

const FILE = 'E:/petvet/landing.html';
const PLAN = [
  [7, '/brand/favicon.ico', 'favicon (symbol only)'],
  [222, '/brand/icon-reversed.png', 'header, bg-brand-900'],
  [358, '/brand/icon-reversed.png', 'app mockup header, bg-brand-900'],
  [660, '/brand/icon-reversed.png', 'phone mockup, bg-slate-800'],
  [892, '/brand/icon-primary.png', 'phone mockup, bg-white'],
  [1178, '/brand/icon-reversed.png', 'footer, bg-black'],
  [1284, '/brand/icon-reversed.png', 'chat window header, bg-brand-900'],
  [1315, '/brand/icon-primary.png', 'login modal, bg-brand-100'],
];

const lines = fs.readFileSync(FILE, 'utf8').split(/\r?\n/);
const seen = [];

for (const [ln, asset, why] of PLAN) {
  const i = ln - 1;
  const line = lines[i];
  if (!line) throw new Error(`line ${ln} does not exist`);
  if (!line.includes('./podvet.png')) {
    throw new Error(`line ${ln} has no ./podvet.png -> "${line.trim()}"`);
  }
  lines[i] = line.replace('./podvet.png', asset);
  seen.push(`  ${String(ln).padStart(5)}  ->  ${asset.padEnd(28)} (${why})`);
}

const leftover = lines.filter((l) => l.includes('./podvet.png')).length;
if (leftover !== 0) throw new Error(`${leftover} logo reference(s) left unassigned`);

// mirror the app's favicon set so iOS home-screen icons also use the symbol
const favIdx = lines.findIndex((l) => l.includes('/brand/favicon.ico'));
if (favIdx >= 0) {
  lines.splice(favIdx + 1, 0,
    '    <link rel="icon" type="image/png" sizes="32x32" href="/brand/favicon-32.png" />',
    '    <link rel="apple-touch-icon" sizes="180x180" href="/brand/favicon-180.png" />');
}

fs.writeFileSync(FILE, lines.join('\n'));
console.log('landing.html logo variants applied:');
seen.forEach((s) => console.log(s));
console.log('\nno ./podvet.png references remain.');
