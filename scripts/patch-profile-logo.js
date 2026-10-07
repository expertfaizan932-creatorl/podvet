// Adds a "Clinic Logo" card to the Profile tab of the compiled Settings chunk.
//
// The Receipt Branding tab already owns the whole logo pipeline (pick ->
// crop -> upload -> Y pending logoUrl -> brandingUpdate), and the Profile
// tab's save handler (Nt) already forwards ...Y!==void 0?{logoUrl:Y}:{}. So
// the card only has to re-use the existing scope helpers: ft (pick), bt
// (remove), H (preview src), R (accent), G/_t (placeholder icon) and the crop
// modal renders off Fe anywhere in the component.
//
//   node scripts/patch-profile-logo.js public/assets/Settings-<hash>.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const FILE = process.argv[2];
if (!FILE) {
  console.error('usage: node scripts/patch-profile-logo.js public/assets/Settings-*.js');
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

const LOGO_CARD =
  'm&&e.jsxs("div",{className:"pt-8 border-t border-slate-100",children:[' +
  'e.jsx("h3",{className:"text-lg font-bold text-slate-800",children:"Clinic Logo"}),' +
  'e.jsx("p",{className:"text-xs text-slate-500 mt-0.5",children:"Shown on the website header and printed invoices. Pick or drop a logo, then click Update Profile to publish it."}),' +
  'e.jsxs("div",{className:"p-4 bg-slate-50/50 rounded-2xl border border-slate-200/60 mt-4",children:[' +
  'e.jsxs("div",{className:"flex items-center gap-5",children:[' +
  'e.jsx("div",{className:"w-20 h-20 rounded-xl border-2 border-dashed border-slate-300 flex items-center justify-center overflow-hidden bg-white flex-shrink-0 shadow-xs",style:H?{borderStyle:"solid",borderColor:R}:{},children:H?e.jsx("img",{src:H,alt:"Logo preview",className:"w-full h-full object-contain p-1.5"}):e.jsx(G,{icon:_t,className:"text-2xl text-slate-300"})}),' +
  'e.jsxs("div",{className:"flex flex-col gap-2",children:[' +
  'e.jsxs("div",{className:"flex gap-2",children:[' +
  'e.jsx("button",{type:"button",onClick:ft,className:"px-4 py-2 bg-teal-600 text-white text-xs font-medium rounded-lg hover:bg-teal-700 transition shadow-sm",children:H?"Change Logo":"Choose Logo"}),' +
  'H&&e.jsx("button",{type:"button",onClick:bt,className:"px-4 py-2 text-xs font-medium text-rose-600 border border-rose-200 bg-rose-50/50 rounded-lg hover:bg-rose-100 transition",children:"Remove"})' +
  ']}),' +
  'e.jsx("p",{className:"text-xs text-slate-400",children:"PNG or JPG recommended \u00b7 max 2 MB"})' +
  ']})' +
  ']})' +
  ']})' +
  ']}),';

// Insert between the Profile Information form and the Change Password block.
src = replaceOnce(
  src,
  'children:"Update Profile"})})]})]}),e.jsxs("div",{className:"pt-8 border-t border-slate-100",',
  'children:"Update Profile"})})]})]}),' + LOGO_CARD + 'e.jsxs("div",{className:"pt-8 border-t border-slate-100",',
  'profile-logo-card',
);

// ── verify before writing ───────────────────────────────────────────────────
(function verify() {
  const a = counts(original), b = counts(src);
  if (a.braces !== b.braces || a.parens !== b.parens) {
    throw new Error(`balance changed: braces ${a.braces}->${b.braces}, parens ${a.parens}->${b.parens}`);
  }
  const probe = path.join(os.tmpdir(), 'profile-logo-patch-check.mjs');
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
