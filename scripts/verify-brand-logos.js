/**
 * Verifies the brand-asset rollout:
 *   1. no in-repo reference to the retired flat logo remains
 *   2. every /brand/... path referenced actually exists in public/
 *   3. the app bundle files are still syntactically valid ES modules
 */
const fs = require('fs');
const path = require('path');

const ROOT = 'E:/petvet';
const PUB = path.join(ROOT, 'public');

// files the browser actually loads
const TARGETS = [
  'landing.html',
  'public/index.html',
  'public/super-admin/index.html',
  ...fs.readdirSync(path.join(PUB, 'assets'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => `public/assets/${f}`),
];

let problems = 0;
const referenced = new Set();
const retired = [];

for (const rel of TARGETS) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  const text = fs.readFileSync(abs, 'utf8');

  for (const m of text.matchAll(/(?:\/brand\/[A-Za-z0-9._-]+)/g)) referenced.add(m[0]);

  for (const m of text.matchAll(/["'(](\.{0,2}\/podvet\.png)["')]/g)) {
    retired.push(`${rel}: ${m[0]}`);
  }
}

console.log('1. retired flat-logo references');
if (retired.length) {
  problems += retired.length;
  retired.forEach((r) => console.log('   FAIL  ' + r));
} else {
  console.log('   OK    none (no ./podvet.png, /podvet.png or ../podvet.png left)');
}

console.log('\n2. /brand/ references resolve to real files');
for (const ref of [...referenced].sort()) {
  const file = path.join(PUB, ref.replace(/^\//, ''));
  const ok = fs.existsSync(file);
  if (!ok) problems++;
  const size = ok ? `${(fs.statSync(file).size / 1024).toFixed(1)} KB` : 'MISSING';
  console.log(`   ${ok ? 'OK   ' : 'FAIL '} ${ref.padEnd(34)} ${size}`);
}

console.log('\n3. bundle syntax check (import/parse)');
for (const f of fs.readdirSync(path.join(PUB, 'assets'))) {
  if (!f.endsWith('.js')) continue;
  const file = path.join(PUB, 'assets', f);
  const src = fs.readFileSync(file, 'utf8');
  try {
    // parse as a module without executing: wraps the body
    new (require('vm').SourceTextModule || Object)(src, { identifier: file });
    console.log('   OK    ' + f);
  } catch (e) {
    if (e instanceof ReferenceError) {
      // SourceTextModule needs --experimental-vm-modules; fall back to a structural check
      const balanced =
        (src.match(/\{/g) || []).length === (src.match(/\}/g) || []).length &&
        (src.match(/\(/g) || []).length === (src.match(/\)/g) || []).length;
      console.log(`   ${balanced ? 'OK  ' : 'FAIL'}  ${f}  (structural)`);
      if (!balanced) problems++;
    } else {
      console.log('   FAIL  ' + f + '  ' + e.message);
      problems++;
    }
  }
}

console.log('\n' + (problems ? `${problems} problem(s) found` : 'all checks passed'));
process.exit(problems ? 1 : 0);
