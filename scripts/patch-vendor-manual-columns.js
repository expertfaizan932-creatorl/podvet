// Vendors table + Add Vendor form:
//   1. New "Products" and "Purchase Price" columns (from vendor purchases,
//      exposed by /api/vendors as products[] / purchaseTotal).
//   2. Six optional per-vendor manual fields entered in the Add/Edit vendor
//      form — Sales (Period), Vendor Share (Owed), Clinic Profit, Settled,
//      Remaining, Settlement Status — persisted via /api/vendors
//      (vendors.manual_* columns). When set they override the auto-computed
//      consignment/settlement value in the table; blank falls back to auto.
//
// Compiled-bundle surgery — run against the current chunk:
//   node scripts/patch-vendor-manual-columns.js public/assets/Vendors-*.js
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

// ── 1. table header: Products + Purchase Price after Vendor ────────────────
src = replaceOnce(
  src,
  'e.jsx("th",{className:"py-3.5 px-4",children:"Vendor"}),e.jsx("th",{className:"py-3.5 px-4 text-center",children:"Sales (Period)"})',
  'e.jsx("th",{className:"py-3.5 px-4",children:"Vendor"}),e.jsx("th",{className:"py-3.5 px-4 text-center",children:"Products"}),e.jsx("th",{className:"py-3.5 px-4 text-center",children:"Purchase Price"}),e.jsx("th",{className:"py-3.5 px-4 text-center",children:"Sales (Period)"})',
  'header',
);

// ── 2. row: manual values override the auto-computed ones ──────────────────
src = replaceOnce(
  src,
  'const s=E[t.vendor_id]||{},n=s.gross_sales??0,o=s.vendor_owed??0,D=s.clinic_amount??0,M=t.recorded_settlements_vendor_share??0,I=Math.max(0,o-M),me=I===0;',
  'const s=E[t.vendor_id]||{},nv=(v,d)=>v===""||v===null||v===void 0?Number(d||0):Number(v),n=nv(t.manual_sales,s.gross_sales??0),o=nv(t.manual_vendor_share,s.vendor_owed??0),D=nv(t.manual_clinic_profit,s.clinic_amount??0),M=nv(t.manual_settled,t.recorded_settlements_vendor_share??0),I=nv(t.manual_remaining,Math.max(0,o-M)),me=t.manual_settlement_status?t.manual_settlement_status==="Settled":I===0;',
  'row-vars',
);

// ── 3. row cells: Products + Purchase Price before the Sales cell ──────────
src = replaceOnce(
  src,
  ',e.jsx("td",{className:"py-3.5 px-4 text-center font-medium text-gray-800",children:a(n)})',
  ',e.jsx("td",{className:"py-3.5 px-4 text-center text-gray-700",children:t.products&&t.products.length?t.products.join(", "):"\u2014"}),e.jsx("td",{className:"py-3.5 px-4 text-center font-medium text-gray-800",children:a(t.purchase_total)}),e.jsx("td",{className:"py-3.5 px-4 text-center font-medium text-gray-800",children:a(n)})',
  'row-cells',
);

// ── 4. form defaults gain the six manual fields ────────────────────────────
src = replaceOnce(
  src,
  'W={vendor_name:"",contact_person:"",contact_number:"",email:"",website:"",city:"",category:"",category_custom:"",address:"",notes:"",is_active:!0}',
  'W={vendor_name:"",contact_person:"",contact_number:"",email:"",website:"",city:"",category:"",category_custom:"",address:"",notes:"",is_active:!0,manual_sales:"",manual_vendor_share:"",manual_clinic_profit:"",manual_settled:"",manual_remaining:"",manual_settlement_status:""}',
  'defaults',
);

// ── 5. edit prefill carries the manual fields back ─────────────────────────
src = replaceOnce(
  src,
  ',notes:t.notes||"",is_active:!!t.is_active})',
  ',notes:t.notes||"",manual_sales:t.manual_sales??"",manual_vendor_share:t.manual_vendor_share??"",manual_clinic_profit:t.manual_clinic_profit??"",manual_settled:t.manual_settled??"",manual_remaining:t.manual_remaining??"",manual_settlement_status:t.manual_settlement_status??"",is_active:!!t.is_active})',
  'prefill',
);

// ── 6. form UI: settlement-figures section before the submit row ───────────
const INPUT_CLASS = 'w-full p-2.5 border border-gray-200 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-teal-500/20 focus:border-teal-500';
const field = (label, name) =>
  'e.jsxs("label",{className:"block",children:[e.jsx("span",{className:"block text-[10px] text-gray-400 mb-0.5",children:"' + label + '"}),e.jsx("input",{type:"number",min:"0",step:"0.01",placeholder:"Optional",value:l.' + name + ',onChange:t=>x({...l,' + name + ':t.target.value}),className:"' + INPUT_CLASS + '"})]})';
const STATUS_SELECT =
  'e.jsxs("label",{className:"block",children:[e.jsx("span",{className:"block text-[10px] text-gray-400 mb-0.5",children:"Settlement Status"}),e.jsxs("select",{value:l.manual_settlement_status,onChange:t=>x({...l,manual_settlement_status:t.target.value}),className:"' + INPUT_CLASS + '",children:[e.jsx("option",{value:"",children:"Auto"}),e.jsx("option",{value:"Settled",children:"Settled"}),e.jsx("option",{value:"Unpaid",children:"Unpaid"})]})]})';
const SECTION =
  'e.jsxs("div",{className:"border-t border-gray-100 pt-3 space-y-2",children:[' +
  'e.jsx("p",{className:"text-xs font-semibold text-gray-700",children:"Settlement figures (optional)"}),' +
  'e.jsx("p",{className:"text-[10px] text-gray-400",children:"Leave blank to keep the auto-calculated values."}),' +
  'e.jsxs("div",{className:"grid grid-cols-2 gap-2",children:[' +
  field('Sales (Period)', 'manual_sales') + ',' +
  field('Vendor Share (Owed)', 'manual_vendor_share') + ',' +
  field('Clinic Profit', 'manual_clinic_profit') + ',' +
  field('Settled', 'manual_settled') + ',' +
  field('Remaining', 'manual_remaining') + ',' +
  STATUS_SELECT +
  ']})]}),';
src = replaceOnce(
  src,
  'e.jsxs("div",{className:"flex justify-end gap-2 pt-2"',
  SECTION + 'e.jsxs("div",{className:"flex justify-end gap-2 pt-2"',
  'form-ui',
);

// ── verify before writing ──────────────────────────────────────────────────
(function verify() {
  const a = counts(original), b = counts(src);
  if (a.braces !== b.braces || a.parens !== b.parens) {
    throw new Error(`balance changed: braces ${a.braces}->${b.braces}, parens ${a.parens}->${b.parens}`);
  }
  const probe = path.join(os.tmpdir(), 'vendor-manual-columns-check.mjs');
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
