// Moves employee social links out of the name cell into a dedicated "Social"
// table column with platform favicon icons (PVSocialRow). Also widens the
// employees-table colSpan (7 -> 8) for the loading and empty rows.
//
//   node scripts/patch-employee-social-column.js public/assets/Employees-*.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const FILE = process.argv[2];
if (!FILE) {
  console.error('usage: node scripts/patch-employee-social-column.js public/assets/Employees-*.js');
  process.exit(1);
}
let src = fs.readFileSync(FILE, 'utf8');
const before = src.length;
const original = src;

function replaceOnce(hay, oldStr, newStr, label) {
  const first = hay.indexOf(oldStr);
  if (first === -1) throw new Error(`${label}: anchor not found`);
  if (hay.indexOf(oldStr, first + 1) !== -1) throw new Error(`${label}: anchor is not unique`);
  return hay.slice(0, first) + newStr + hay.slice(first + oldStr.length);
}

// 1. header: Social th between Joined On and Actions
src = replaceOnce(
  src,
  'children:"Joined On"}),e.jsx("th",{className:"py-3.5 px-4 text-center",children:"Actions"})',
  'children:"Joined On"}),e.jsx("th",{className:"py-3.5 px-4 text-center",children:"Social"}),e.jsx("th",{className:"py-3.5 px-4 text-center",children:"Actions"})',
  'header',
);

// 2. name cell: drop the inline social row (moves to its own column)
src = replaceOnce(
  src,
  ',e.jsx(PVSocialRow,{links:s.socialLinks})',
  '',
  'name-cell',
);

// 3. row: new Social td between Joined On and Actions
src = replaceOnce(
  src,
  'children:re(s.joined_on)})]})}),e.jsx("td",{className:"py-3.5 px-4",children:e.jsxs("div",{className:"flex items-center justify-center gap-2"',
  'children:re(s.joined_on)})]})}),e.jsxs("td",{className:"py-3.5 px-4 text-center",children:[s.socialLinks&&s.socialLinks.length?e.jsx("div",{className:"flex justify-center",children:e.jsx(PVSocialRow,{links:s.socialLinks})}):e.jsx("span",{className:"text-gray-300 text-xs",children:"\u2014"})]}),e.jsx("td",{className:"py-3.5 px-4",children:e.jsxs("div",{className:"flex items-center justify-center gap-2"',
  'social-td',
);

// 4. loading + empty rows span the new column
src = replaceOnce(src, 'colSpan:7,className:"p-8 text-center"', 'colSpan:8,className:"p-8 text-center"', 'colspan-loading');
src = replaceOnce(
  src,
  'colSpan:7,className:"text-center py-8 text-gray-400",children:"No employees found"',
  'colSpan:8,className:"text-center py-8 text-gray-400",children:"No employees found"',
  'colspan-empty',
);

// ── verify before writing ───────────────────────────────────────────────────
(function verify() {
  const a = counts(original), b = counts(src);
  if (a.braces !== b.braces || a.parens !== b.parens) {
    throw new Error(`balance changed: braces ${a.braces}->${b.braces}, parens ${a.parens}->${b.parens}`);
  }
  const probe = path.join(os.tmpdir(), 'emp-social-col-patch-check.mjs');
  fs.writeFileSync(probe, src, 'utf8');
  try {
    execFileSync(process.execPath, ['--check', probe], { stdio: 'pipe' });
  } catch (e) {
    const m = /SyntaxError: (.+)/.exec((e.stderr && e.stderr.toString()) || '');
    throw new Error('patched output does not parse: ' + (m ? m[1] : 'unknown'));
  }
  console.log('  verified: brace/paren balance unchanged, output parses as ESM');
})();

function counts(s) {
  let braces = 0, parens = 0, inStr = false, sh = '';
  for (const c of s) {
    if (inStr) { if (c === sh) inStr = false; continue; }
    if (c === '"' || c === "'" || c === '\`') { inStr = true; sh = c; continue; }
    if (c === '{') braces++; else if (c === '}') braces--;
    else if (c === '(') parens++; else if (c === ')') parens--;
  }
  return { braces, parens };
}

fs.writeFileSync(FILE, src, 'utf8');
console.log(`patched ${FILE}`);
console.log(`  bytes ${before} -> ${src.length}`);
