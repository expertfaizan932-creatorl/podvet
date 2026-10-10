// Adds two clinic-side controls to the prebuilt React bundles:
//   • Appointments: an "Approve" button on rows whose status is PENDING
//     (customer-portal requests now start pending).
//   • Clients: a "Portal Access" button that creates/shares a customer login.
// Both call window helpers defined in lib/web-preload.js. Re-runnable: if the
// marker is already present the file is left untouched.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function count(hay, needle) {
  let n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

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

function verify(file, before, after) {
  const a = counts(before), b = counts(after);
  if (a.braces !== b.braces || a.parens !== b.parens) throw new Error(`${file}: brace/paren imbalance`);
  const p = path.join(os.tmpdir(), 'pv-patch-check.mjs');
  fs.writeFileSync(p, after);
  execFileSync(process.execPath, ['--check', p]);
}

function patchOnce(file, oldStr, newStr, guard) {
  let src = fs.readFileSync(file, 'utf8');
  if (guard && src.indexOf(guard) !== -1) { console.log(`${file}: already patched, skipping`); return; }
  if (count(src, oldStr) !== 1) throw new Error(`${file}: anchor not unique (${count(src, oldStr)})`);
  const out = src.replace(oldStr, newStr);
  verify(file, src, out);
  fs.writeFileSync(file, out);
  console.log(`${file}: patched (${src.length} -> ${out.length})`);
}

// ── Appointments: Approve button on pending rows ────────────────────────────
const APPT_FILE = 'public/assets/Appointments-HM56TIJx.js';
const APPT_OLD = 'className:"flex items-center gap-4",children:[e.jsx("button",{className:"text-indigo-600 hover:text-indigo-800';
const APPT_APPROVE = 'c.status==="PENDING"&&e.jsx("button",{className:"px-2.5 py-1.5 border border-emerald-300 bg-emerald-50 text-emerald-700 text-[11px] font-semibold rounded-lg hover:bg-emerald-100 transition flex-shrink-0",title:"Approve appointment request",onClick:()=>window.__pvApproveAppointment(c.appointment_id),children:"Approve"}),';
const APPT_NEW = 'className:"flex items-center gap-4",children:[' + APPT_APPROVE + 'e.jsx("button",{className:"text-indigo-600 hover:text-indigo-800';
patchOnce(APPT_FILE, APPT_OLD, APPT_NEW, '__pvApproveAppointment');

// ── Clients: Portal Access button ───────────────────────────────────────────
const CLIENTS_FILE = 'public/assets/Clients-C4kgdnX3.js';
const CLIENTS_ANCHOR = 'e.jsx("button",{className:"text-blue-600 hover:text-blue-800 text-xs font-medium",onClick:()=>nt(t),children:"View Details"})';
const CLIENTS_BTN = ',W&&e.jsx("button",{className:"text-purple-600 hover:text-purple-800 text-xs font-medium",onClick:()=>window.__pvClientPortal(t.client_id,t.client_name),children:"Portal Access"})';
patchOnce(CLIENTS_FILE, CLIENTS_ANCHOR, CLIENTS_ANCHOR + CLIENTS_BTN, '__pvClientPortal');

console.log('done');
