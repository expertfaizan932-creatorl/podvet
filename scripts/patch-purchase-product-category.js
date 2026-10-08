// Purchase entry (VendorPurchases): each line already has its own product,
// qty and unit price. This makes the product's category visible: the product
// dropdown options append it, and a category chip renders next to the selected
// product on the line. Requires products.category (already in db/schema.sql;
// GET /api/products returns p.*).
//
//   node scripts/patch-purchase-product-category.js public/assets/Vendors-*.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const FILE = process.argv[2];
if (!FILE) {
  console.error('usage: node scripts/patch-purchase-product-category.js public/assets/Vendors-*.js');
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

// 1. dropdown option shows "Name · category"
src = replaceOnce(
  src,
  'e.jsx("option",{value:String(p.id),children:p.name||"Product "+p.id},p.id)',
  'e.jsx("option",{value:String(p.id),children:(p.name||"Product "+p.id)+(p.category?" \u00b7 "+p.category:"")},p.id)',
  'option-label',
);

// 2. category chip beside the selected product (line scope: x = line, i = index)
src = replaceOnce(
  src,
  'disabled:text-gray-400"}),e.jsx("input",{type:"number",min:"1",placeholder:"Qty"',
  'disabled:text-gray-400"}),(()=>{const p=products.find(pp=>String(pp.id)===String(x.productId));return p&&p.category?e.jsx("span",{className:"text-[10px] px-1.5 py-0.5 rounded-md bg-slate-100 text-slate-500 border border-slate-200 shrink-0",children:p.category}):null})(),e.jsx("input",{type:"number",min:"1",placeholder:"Qty"',
  'line-chip',
);

// ── verify before writing ───────────────────────────────────────────────────
(function verify() {
  const a = counts(original), b = counts(src);
  if (a.braces !== b.braces || a.parens !== b.parens) {
    throw new Error(`balance changed: braces ${a.braces}->${b.braces}, parens ${a.parens}->${b.parens}`);
  }
  const probe = path.join(os.tmpdir(), 'purchase-cat-patch-check.mjs');
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
