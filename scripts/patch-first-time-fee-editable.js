const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const NCP = 'public/assets/NewClientPetModal-C7Msdl_v.js';
const APP = 'public/assets/Appointments-HM56TIJx.js';

function replaceOnce(hay, oldStr, newStr, label) {
  const first = hay.indexOf(oldStr);
  if (first === -1) throw new Error(`${label}: anchor not found`);
  if (hay.indexOf(oldStr, first + 1) !== -1) throw new Error(`${label}: anchor is not unique`);
  return hay.slice(0, first) + newStr + hay.slice(first + oldStr.length);
}

const edit = {};

// ---- NewClientPetModal: make the First-Time Fee a real editable input ----
{
  let src = fs.readFileSync(NCP, 'utf8');

  // 1) local state for the fee
  src = replaceOnce(
    src,
    '[y,f]=p.useState(!1),b=()=>{g(w()),i(C()),j({})},',
    '[y,f]=p.useState(!1),[pvFee,setPvFee]=p.useState(d),b=()=>{g(w()),i(C()),j({})},',
    'ncpm-state'
  );

  // 2) keep the input in sync with the configured fee whenever the modal opens
  src = replaceOnce(
    src,
    '}finally{f(!1)}};return n?e.jsx("div",{className:"fixed inset-0 bg-black/40',
    '}finally{f(!1)}};p.useEffect(()=>{n&&setPvFee(d)},[n,d]);return n?e.jsx("div",{className:"fixed inset-0 bg-black/40',
    'ncpm-effect'
  );

  // 3) replace the read-only badge with a number input
  const oldBadge =
    'd>0&&e.jsxs("div",{children:[e.jsx("label",{className:"block text-xs font-medium text-gray-500 mb-1",children:"First-Time Fee"}),e.jsxs("div",{className:"w-full p-3 bg-blue-50 border border-blue-200 rounded-lg flex items-center justify-between",children:[e.jsxs("span",{className:"text-blue-800 font-medium",children:["Rs. ",d.toLocaleString("en-PK",{minimumFractionDigits:2})]}),e.jsx("span",{className:"text-xs text-blue-600 bg-blue-100 px-2 py-1 rounded-full",children:"New Client Fee"})]}),e.jsx("p",{className:"text-xs text-gray-500 mt-1",children:"Standard fee for first-time clients"})]}),';
  const newInput =
    'd>0&&e.jsxs("div",{children:[e.jsx("label",{className:"block text-xs font-medium text-gray-500 mb-1",children:"First-Time Fee"}),e.jsxs("div",{className:"w-full p-2 bg-blue-50 border border-blue-200 rounded-lg flex items-center gap-2",children:[e.jsx("span",{className:"text-blue-800 font-medium",children:"Rs."}),e.jsx("input",{type:"number",min:"0",step:"0.01",onWheel:s=>s.target.blur(),value:pvFee,onChange:s=>setPvFee(s.target.value),className:"flex-1 min-w-0 p-2 border border-blue-200 rounded-lg bg-white text-blue-900 font-medium focus:outline-none focus:ring-2 focus:ring-blue-400"}),e.jsx("span",{className:"text-xs text-blue-600 bg-blue-100 px-2 py-1 rounded-full whitespace-nowrap",children:"New Client Fee"})]}),e.jsx("p",{className:"text-xs text-gray-500 mt-1",children:"Standard fee for first-time clients (editable)"})]}),';
  src = replaceOnce(src, oldBadge, newInput, 'ncpm-input');

  // 4) hand the (possibly edited) fee back to the caller on success
  src = replaceOnce(
    src,
    'petAge:u,petColor:t.color})',
    'petAge:u,petColor:t.color,firstTimeFee:pvFee===""||pvFee==null?d:Number(pvFee)})',
    'ncpm-onsuccess'
  );

  edit[NCP] = src;
}

// ---- Appointments: wire the edited fee into appointment creation ----
{
  let src = fs.readFileSync(APP, 'utf8');

  // 1) Fr accepts the fee setter
  src = replaceOnce(
    src,
    'setFilteredServices:ne,firstTimeFee:re,appointmentForm:L,',
    'setFilteredServices:ne,firstTimeFee:re,setFirstTimeFee:pvSetFee,appointmentForm:L,',
    'app-fr-signature'
  );

  // 2) pass the parent setter into Fr
  src = replaceOnce(
    src,
    'firstTimeFee:ia,appointmentForm:me,',
    'firstTimeFee:ia,setFirstTimeFee:ds,appointmentForm:me,',
    'app-fr-callsite'
  );

  // 3) when the new client form succeeds, adopt its fee
  src = replaceOnce(
    src,
    'age:_.petAge,color:_.petColor}),E(!1),ne(R),Q(!0)},firstTimeFee:re,submitLabel:"Create & Continue"}),',
    'age:_.petAge,color:_.petColor}),_&&_.firstTimeFee!=null&&pvSetFee(_.firstTimeFee),E(!1),ne(R),Q(!0)},firstTimeFee:re,submitLabel:"Create & Continue"}),',
    'app-fr-newclient-success'
  );

  // 4) selecting an existing patient must not carry a first-time fee
  src = replaceOnce(
    src,
    'dn=async t=>{$t(t),await cn(t.client_id)}',
    'dn=async t=>{$t(t),ds(0),await cn(t.client_id)}',
    'app-existing-client-reset'
  );

  // 5) send the (default or edited) fee when creating the appointment
  src = replaceOnce(
    src,
    'firstTimeFee:t?ia:0,isBackfill:oa',
    'firstTimeFee:ia,isBackfill:oa',
    'app-create-fee'
  );

  edit[APP] = src;
}

// ---- validate + write ----
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

for (const file of Object.keys(edit)) {
  const original = fs.readFileSync(file, 'utf8');
  const src = edit[file];
  const a = counts(original), b = counts(src);
  if (a.braces !== b.braces || a.parens !== b.parens) {
    throw new Error(`${file}: unbalanced braces/parens (${JSON.stringify(a)} -> ${JSON.stringify(b)})`);
  }
  const p = path.join(os.tmpdir(), `pv-ftf-${path.basename(file)}.mjs`);
  fs.writeFileSync(p, src);
  try { execFileSync(process.execPath, ['--check', p]); } catch (e) { throw new Error(`${file}: parse error`); }
  fs.writeFileSync(file, src);
  console.log(`patched ${file} (${original.length} -> ${src.length})`);
}
console.log('ok');
