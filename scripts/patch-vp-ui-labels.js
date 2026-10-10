const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const FILE = process.argv[2] || 'public/assets/Vendors-ngHf9nIc.js';
let src = fs.readFileSync(FILE, 'utf8');
const before = src.length;
const original = src;

function replaceOnce(hay, oldStr, newStr, label) {
  const first = hay.indexOf(oldStr);
  if (first === -1) throw new Error(`${label}: anchor not found`);
  if (hay.indexOf(oldStr, first + 1) !== -1) throw new Error(`${label}: anchor is not unique`);
  return hay.slice(0, first) + newStr + hay.slice(first + oldStr.length);
}

// Add heading + labels above the lines list in add purchase form
const anchor = 'e.jsx("div",{className:"space-y-2",children:lines.map(';
const heading = 'e.jsx("p",{className:"text-xs font-semibold text-gray-700 mb-1",children:"Purchase Items (Product & Price)"}),e.jsxs("div",{className:"flex items-center gap-2 px-0.5 text-[10px] text-gray-500 uppercase tracking-wide",children:[e.jsx("div",{className:"w-[28%]",children:"Product"}),e.jsx("div",{className:"w-[36%]",children:"Item Name"}),e.jsx("div",{className:"w-14 text-center",children:"Qty"}),e.jsx("div",{className:"w-20 text-center",children:"Unit Price (Rs)"}),e.jsx("div",{className:"w-6"})]}),';

src = replaceOnce(src, anchor, heading + anchor, 'add-purchase-heading');

function counts(s) {
  let braces = 0, parens = 0, inStr = false, sh = '';
  for (const c of s) {
    if (inStr) { if (c === sh) inStr = false; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = true; sh = c; continue; }
    if (c === '{') braces++; if (c === '}') braces--;
    if (c === '(') parens++; if (c === ')') parens--;
  }
  return { braces, parens };
}
(function v() {
  const a = counts(original), b = counts(src);
  if (a.braces !== b.braces || a.parens !== b.parens) throw new Error('bal');
  const p = path.join(os.tmpdir(), 'vp-ui.mjs');
  fs.writeFileSync(p, src);
  try { execFileSync(process.execPath, ['--check', p]); } catch (e) { throw new Error('parse'); }
  console.log('ok');
})();
fs.writeFileSync(FILE, src);
console.log(before, '->', src.length);
