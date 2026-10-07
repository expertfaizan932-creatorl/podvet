// Adds the full vendor detail fields (email, website, city, category,
// address) to the compiled Vendors chunk: Add/Edit form, edit prefill, and
// the detail modal; also enriches the purchase-history row so each line shows
// item, quantity and unit price. Data is persisted via /api/vendors (see
// ensureFeatureSchema vendors.* columns in server.js).
//
// Same approach as the other patch-*.js scripts: run against a pristine
// chunk, every replacement asserts a single match, output verified (balance +
// parses as ESM) before it is written.
//
//   node scripts/patch-vendor-details.js public/assets/Vendors-<hash>.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const FILE = process.argv[2];
if (!FILE) {
  console.error('usage: node scripts/patch-vendor-details.js public/assets/Vendors-*.js');
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

const FIELD = (name, placeholder, type) =>
  `e.jsx("input",{className:"w-full p-2.5 border border-gray-200 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-teal-500/20 focus:border-teal-500"${type ? `,type:"${type}"` : ''},placeholder:"${placeholder}",value:l.${name},onChange:t=>x({...l,${name}:t.target.value})})`;

// ── 1. form defaults ────────────────────────────────────────────────────────
src = replaceOnce(
  src,
  'W={vendor_name:"",contact_person:"",contact_number:"",notes:"",is_active:!0}',
  'W={vendor_name:"",contact_person:"",contact_number:"",email:"",website:"",city:"",category:"",address:"",notes:"",is_active:!0}',
  'defaults',
);

// ── 2. modal: wider + scrollable (the form grew by five fields) ─────────────
src = replaceOnce(
  src,
  '"bg-white p-6 rounded-2xl w-full max-w-md shadow-xl",onClick:t=>t.stopPropagation(),children:[e.jsx("h3",',
  '"bg-white p-6 rounded-2xl w-full max-w-2xl shadow-xl max-h-[88vh] overflow-y-auto",onClick:t=>t.stopPropagation(),children:[e.jsx("h3",',
  'modal-size',
);

// ── 3. form: new fields between contact number and notes ────────────────────
const CATEGORY_SELECT =
  'e.jsxs("select",{className:"w-full p-2.5 border border-gray-200 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-teal-500/20 focus:border-teal-500",value:l.category,onChange:t=>x({...l,category:t.target.value}),children:[e.jsx("option",{value:"",children:"Category"}),e.jsx("option",{value:"Medicines",children:"Medicines"}),e.jsx("option",{value:"Equipment",children:"Equipment"}),e.jsx("option",{value:"Feed & Grooming",children:"Feed & Grooming"}),e.jsx("option",{value:"Services",children:"Services"}),e.jsx("option",{value:"Other",children:"Other"})]})';
const NEW_FIELDS =
  FIELD('email', 'Email (optional)', 'email') + ',' +
  FIELD('website', 'Website (optional)') + ',' +
  'e.jsxs("div",{className:"grid grid-cols-2 gap-2",children:[' +
  FIELD('city', 'City') + ',' + CATEGORY_SELECT +
  ']}),' +
  'e.jsx("textarea",{className:"w-full p-2.5 border border-gray-200 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-teal-500/20 focus:border-teal-500",rows:2,placeholder:"Address (optional)",value:l.address,onChange:t=>x({...l,address:t.target.value})})';

src = replaceOnce(
  src,
  'onChange:t=>x({...l,contact_number:t.target.value})}),e.jsx("textarea",',
  'onChange:t=>x({...l,contact_number:t.target.value})}),' + NEW_FIELDS + ',e.jsx("textarea",',
  'form-fields',
);

// ── 4. edit prefill carries the new values back into the form ───────────────
src = replaceOnce(
  src,
  'x({vendor_name:t.vendor_name||"",contact_person:t.contact_person||"",contact_number:t.contact_number||"",notes:t.notes||"",is_active:!!t.is_active})',
  'x({vendor_name:t.vendor_name||"",contact_person:t.contact_person||"",contact_number:t.contact_number||"",email:t.email||"",website:t.website||"",city:t.city||"",category:t.category||"",address:t.address||"",notes:t.notes||"",is_active:!!t.is_active})',
  'edit-prefill',
);

// ── 5. detail modal shows the new fields under the contact grid ─────────────
const detailField = (label, expr, extra) =>
  `e.jsxs("div",{${extra ? `className:"${extra}",` : ''}children:[e.jsx("p",{className:"text-gray-400 mb-0.5",children:"${label}"}),e.jsx("p",{className:"font-semibold text-gray-800",children:${expr}})]})`;
const NEW_DETAIL =
  'e.jsxs("div",{className:"grid grid-cols-2 gap-3",children:[' +
  detailField('Email', 'd.email||"—"') + ',' +
  detailField('City', 'd.city||"—"') + ',' +
  detailField('Website', 'd.website||"—"') + ',' +
  detailField('Category', 'd.category||"—"') + ',' +
  detailField('Address', 'd.address||"—"', 'col-span-2') +
  ']}),';

src = replaceOnce(
  src,
  'children:d.contact_number||"—"})]})]}),d.notes&&e.jsxs("div",',
  'children:d.contact_number||"—"})]})]}),' + NEW_DETAIL + 'd.notes&&e.jsxs("div",',
  'detail-fields',
);

// ── 6. purchase rows show item x qty @ unit price ───────────────────────────
src = replaceOnce(
  src,
  'children:(p.items||[]).map(x=>x.itemName+" x"+x.quantity).join(", ")',
  'children:(p.items||[]).map(x=>x.itemName+" ×"+x.quantity+" @ "+VP_FMT(x.unitPrice)).join(", ")',
  'purchase-lines',
);

// ── verify before writing ───────────────────────────────────────────────────
(function verify() {
  const a = counts(original), b = counts(src);
  if (a.braces !== b.braces || a.parens !== b.parens) {
    throw new Error(`balance changed: braces ${a.braces}->${b.braces}, parens ${a.parens}->${b.parens}`);
  }
  const probe = path.join(os.tmpdir(), 'vendor-details-patch-check.mjs');
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
