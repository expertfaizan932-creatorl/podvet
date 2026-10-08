const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const FILE = 'public/assets/Vendors-ngHf9nIc.js';
let src = fs.readFileSync(FILE, 'utf8');
const original = src;

function replaceOnce(hay, oldStr, newStr, label) {
  const first = hay.indexOf(oldStr);
  if (first === -1) throw new Error(`${label}: anchor not found`);
  if (hay.indexOf(oldStr, first + 1) !== -1) throw new Error(`${label}: anchor is not unique`);
  return hay.slice(0, first) + newStr + hay.slice(first + oldStr.length);
}

const FIELD = 'e.jsx("input",{className:"w-full p-2.5 border border-gray-200 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-teal-500/20 focus:border-teal-500",placeholder:"Contact person",value:l.contact_person,onChange:t=>x({...l,contact_person:t.target.value})}),';

const PREFILL = 'contact_person:t.contact_person||"",';

const DETAIL = 'e.jsxs("div",{children:[e.jsx("p",{className:"text-gray-400 mb-0.5",children:"Contact person"}),e.jsx("p",{className:"font-semibold text-gray-800",children:d.contact_person||"—"})]}),';

const HEAD_ANCHOR = 'children:Z?"Edit vendor":"Add vendor"}),e.jsxs("form",{onSubmit:Ie,';
const HEAD_NEW = 'children:Z?"Edit vendor":"Add vendor"}),e.jsx("p",{className:"text-xs text-gray-500 mb-4",children:"In the Vendors module, we will add the vendor details. Record the products purchased from each vendor, including the product name, quantity, and purchase price."}),e.jsxs("form",{onSubmit:Ie,';

src = replaceOnce(src, FIELD, '', 'remove-contact-person-field');
src = replaceOnce(src, PREFILL, '', 'remove-contact-person-prefill');
src = replaceOnce(src, DETAIL, '', 'remove-contact-person-detail');
src = replaceOnce(src, HEAD_ANCHOR, HEAD_NEW, 'add-heading');

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
const a = counts(original), b = counts(src);
if (a.braces !== b.braces || a.parens !== b.parens) {
  throw new Error(`bal ${a.braces}/${a.parens} -> ${b.braces}/${b.parens}`);
}
const p = path.join(os.tmpdir(), 'vp-final.mjs');
fs.writeFileSync(p, src);
try { execFileSync(process.execPath, ['--check', p]); } catch (e) { throw new Error('parse fail'); }
fs.writeFileSync(FILE, src);
console.log('ok', original.length, '->', src.length);
