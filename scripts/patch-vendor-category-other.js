// Add/Edit vendor: choosing "Other" in the category select now reveals a
// free-text input so the user can type any custom category. The submitted
// payload resolves to the typed value (falls back to "Other"), and the edit
// prefill maps unknown stored categories back to select="Other" + the stored
// text so reopening the form round-trips correctly.
//
//   node scripts/patch-vendor-category-other.js public/assets/Vendors-*.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const FILE = process.argv[2];
if (!FILE) {
  console.error('usage: node scripts/patch-vendor-category-other.js public/assets/Vendors-*.js');
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

const INPUT_CLASS = 'w-full p-2.5 border border-gray-200 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-teal-500/20 focus:border-teal-500';
const PRESET = '/^(Medicines|Equipment|Feed & Grooming|Services|Other)$/';

// 1. form defaults gain category_custom (UI-only, resolved in the submit)
src = replaceOnce(
  src,
  'W={vendor_name:"",contact_person:"",contact_number:"",email:"",website:"",city:"",category:"",address:"",notes:"",is_active:!0}',
  'W={vendor_name:"",contact_person:"",contact_number:"",email:"",website:"",city:"",category:"",category_custom:"",address:"",notes:"",is_active:!0}',
  'defaults',
);

// 2. free-text input appears right under the category grid when Other is chosen
src = replaceOnce(
  src,
  'e.jsx("option",{value:"Other",children:"Other"})]})]}),',
  'e.jsx("option",{value:"Other",children:"Other"})]})]}),l.category==="Other"&&e.jsx("input",{className:"' + INPUT_CLASS + '",placeholder:"Type your category",value:l.category_custom,onChange:t=>x({...l,category_custom:t.target.value})}),',
  'other-input',
);

// 3. edit prefill: preset stays a preset, anything else -> Other + raw text
src = replaceOnce(
  src,
  'city:t.city||"",category:t.category||"",address:t.address||""',
  'city:t.city||"",category:t.category&&' + PRESET + '.test(t.category)?t.category:t.category?"Other":"",category_custom:t.category&&!' + PRESET + '.test(t.category)?t.category:"",address:t.address||""',
  'prefill',
);

// 4. submit resolves Other -> typed custom value (max VARCHAR(100))
src = replaceOnce(
  src,
  'const s={...l,vendor_name:l.vendor_name.trim()}',
  'const s={...l,vendor_name:l.vendor_name.trim(),category:l.category==="Other"?(l.category_custom||"Other").slice(0,100):l.category}',
  'submit',
);

// ── verify before writing ───────────────────────────────────────────────────
(function verify() {
  const a = counts(original), b = counts(src);
  if (a.braces !== b.braces || a.parens !== b.parens) {
    throw new Error(`balance changed: braces ${a.braces}->${b.braces}, parens ${a.parens}->${b.parens}`);
  }
  const probe = path.join(os.tmpdir(), 'vendor-category-patch-check.mjs');
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
