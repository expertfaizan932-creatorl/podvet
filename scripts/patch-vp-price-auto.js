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
  if (first === -1 ? false : hay.indexOf(oldStr, first + 1) !== -1) throw new Error(`${label}: not unique`);
  return hay.slice(0, first) + newStr + hay.slice(first + oldStr.length);
}

const PICK = 'setLines(ls=>ls.map((x,j)=>j===i?(p?{...x,productId:String(p.id),itemName:p.name||""}:{...x,productId:"",itemName:""}):x))';
const PICK_NEW = 'setLines(ls=>ls.map((x,j)=>j===i?(p?{...x,productId:String(p.id),itemName:p.name||"",unitPrice:x.unitPrice?x.unitPrice:(p.price??"")}:{...x,productId:"",itemName:""}):x))';

src = replaceOnce(src, PICK, PICK_NEW, 'pick-autofill');

function counts(s) {
  let braces = 0, parens = 0, inStr = false, sh = '';
  for (const c of s) {
    if (inStr) { if (c === sh) inStr = false; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = true; sh = c; continue; }
    if (c === '{') braces++; else if (c === '}') braces--;
    if (c === '(') parens++; if (c === ')') parens--;
  }
  return { braces, parens };
}
(function v() {
  const a = counts(original), b = counts(src);
  if (a.braces !== b.braces || a.parens !== b.parens) throw new Error('bal');
  const p = path.join(os.tmpdir(), 'vp-p.mjs');
  fs.writeFileSync(p, src);
  try { execFileSync(process.execPath, ['--check', p]); } catch (e) { throw new Error('parse'); }
  console.log('ok');
})();
fs.writeFileSync(FILE, src);
console.log(before, '->', src.length);
