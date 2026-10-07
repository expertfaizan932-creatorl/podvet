// Adds social-media links (Instagram/Facebook/LinkedIn/Twitter/WhatsApp/
// Website) to the compiled Employees chunk: an editable block in the Add/Edit
// employee modal, favicon badges on the roster row, and the payload that goes
// to add-employee / edit-employee.
//
// The frontend ships as compiled bundles only, so this is minified surgery on
// the built chunk - same approach as patch-sidebar.js / patch-guard-suspend.js.
// Run against a pristine chunk: every replacement asserts a single match, and
// the output is verified (brace balance + parses as ESM) before it is written.
//
//   node scripts/patch-employee-social.js public/assets/Employees-<hash>.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const FILE = process.argv[2];
if (!FILE) {
  console.error('usage: node scripts/patch-employee-social.js public/assets/Employees-*.js');
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

// ── 1. default values for the six new registered fields ─────────────────────
src = replaceOnce(
  src,
  'B={employeeName:"",position:"",designation:"",salary:"",contactNumber:"",joined_on:""}',
  'B={employeeName:"",position:"",designation:"",salary:"",contactNumber:"",joined_on:"",social_instagram:"",social_facebook:"",social_linkedin:"",social_twitter:"",social_whatsapp:"",social_website:""}',
  'B-defaults',
);

// ── 2. submit: send the links with the employee ─────────────────────────────
// Read them off n.getValues() rather than off `s`: the yup schema does not
// list the social_* keys, so whether they survive validation must not decide
// whether the links get saved.
src = replaceOnce(
  src,
  'ys=async s=>{if(!I)try{P(!0);let t;if(M){const l={id:Ge,name:s.employeeName,position:s.position,designation:s.designation,salary:s.salary,contact:s.contactNumber,joined_on:s.joined_on};' +
    't=await window.electronAPI.editEmployee(l)}else t=await window.electronAPI.addEmployee(s);',
  'ys=async s=>{if(!I)try{P(!0);const socialLinks=PVSocialLinks(n.getValues());let t;if(M){const l={id:Ge,name:s.employeeName,position:s.position,designation:s.designation,salary:s.salary,contact:s.contactNumber,joined_on:s.joined_on,socialLinks:socialLinks};' +
    't=await window.electronAPI.editEmployee(l)}else t=await window.electronAPI.addEmployee({...s,socialLinks:socialLinks});',
  'submit',
);

// ── 3. edit: prefill the fields from the row ────────────────────────────────
src = replaceOnce(
  src,
  'n.reset({employeeName:t.name,position:t.position,designation:t.designation||"",salary:t.salary,contactNumber:t.contact,joined_on:l})',
  'n.reset({employeeName:t.name,position:t.position,designation:t.designation||"",salary:t.salary,contactNumber:t.contact,joined_on:l,...PVSocialValues(t.socialLinks)})',
  'edit-prefill',
);

// ── 4. modal: the block itself, right before the footer buttons ─────────────
src = replaceOnce(
  src,
  'n.formState.errors.joined_on&&e.jsx("p",{className:u,children:n.formState.errors.joined_on.message})]}),' +
    'e.jsxs("div",{className:"flex justify-end gap-3",children:[e.jsx("button",{type:"button",' +
    'className:"px-4 py-2 bg-gray-300 rounded-lg hover:bg-gray-400 text-sm font-medium",onClick:()=>{M&&(O(!1),D(0)),n.reset(B),v(!1)},children:"Cancel"})',
  'n.formState.errors.joined_on&&e.jsx("p",{className:u,children:n.formState.errors.joined_on.message})]}),' +
    'e.jsx(PVSocialFields,{form:n}),' +
    'e.jsxs("div",{className:"flex justify-end gap-3",children:[e.jsx("button",{type:"button",' +
    'className:"px-4 py-2 bg-gray-300 rounded-lg hover:bg-gray-400 text-sm font-medium",onClick:()=>{M&&(O(!1),D(0)),n.reset(B),v(!1)},children:"Cancel"})',
  'modal-fields',
);

// ── 5. roster row: clickable badges under the employee's name ───────────────
src = replaceOnce(
  src,
  'children:["EMP ",s.id]})]})',
  'children:["EMP ",s.id]}),e.jsx(PVSocialRow,{links:s.socialLinks})]})',
  'roster-row',
);

// ── 6. the components themselves ────────────────────────────────────────────
// Appended after the (comma-chained) const block and before the export, so
// nothing is added to that chain. Evaluated at render time only - no TDZ risk.
const HELPERS = `
const PV_PLATFORMS=[["instagram","Instagram","https://instagram.com"],["facebook","Facebook","https://facebook.com"],["linkedin","LinkedIn","https://linkedin.com"],["twitter","Twitter","https://twitter.com"],["whatsapp","WhatsApp","https://whatsapp.com"],["website","Website",null]];
const PV_HOST=m=>String(m||"").replace(/^[a-z][a-z0-9+.-]*:\\/\\//i,"").split("/")[0].split("@").pop().toLowerCase();
function PV_Favicon(t){const broken=r.useState(!1),setBroken=broken[1],host=PV_HOST(t.url);
if(!host||broken[0])return e.jsx("span",{className:"inline-flex items-center justify-center text-[8px] font-bold text-gray-500 uppercase",children:String(t.label||"??").slice(0,2)});
return e.jsx("img",{src:"https://icons.duckduckgo.com/ip3/"+host+".ico",alt:String(t.label||""),width:14,height:14,loading:"lazy",className:"w-3.5 h-3.5 object-contain",onError:()=>setBroken(!0)})}
function PVSocialRow(t){const links=(Array.isArray(t.links)?t.links:[]).filter(l=>l&&l.url);if(!links.length)return null;
return e.jsx("div",{className:"flex flex-wrap gap-1.5 mt-1",children:links.map(l=>e.jsx("a",{href:l.url,target:"_blank",rel:"noreferrer noopener",title:l.platform,className:"inline-flex items-center justify-center w-6 h-6 rounded-md border border-gray-200 bg-white hover:border-blue-400 transition",onClick:s=>s.stopPropagation(),children:e.jsx(PV_Favicon,{url:l.url,label:l.platform})},l.platform))})}
function PVSocialFields(t){const form=t.form;
return e.jsxs("div",{className:"border-t border-gray-100 pt-4 space-y-3",children:[e.jsxs("div",{className:"flex items-center gap-2",children:[e.jsx("h4",{className:"text-xs font-semibold text-gray-600 uppercase tracking-wide",children:"Social links"}),e.jsx("span",{className:"text-[11px] text-gray-400",children:"Optional"})]}),PV_PLATFORMS.map(p=>e.jsxs("div",{className:"flex items-center gap-2",children:[e.jsx("span",{className:"w-7 h-7 shrink-0 inline-flex items-center justify-center rounded-md border border-gray-200 bg-gray-50 overflow-hidden",children:p[2]?e.jsx(PV_Favicon,{url:p[2],label:p[1]}):e.jsx("span",{className:"text-[8px] font-bold text-gray-400",children:"WWW"})}),e.jsx("input",{type:"text",...form.register("social_"+p[0]),placeholder:p[1]+" URL",className:c})]},p[0]))]})}
const PVSocialValues=links=>{const out={};for(const p of PV_PLATFORMS)out["social_"+p[0]]="";for(const l of Array.isArray(links)?links:[]){const p=PV_PLATFORMS.find(x=>x[0]===String(l&&l.platform||"").toLowerCase());if(p&&l&&l.url)out["social_"+p[0]]=String(l.url)}return out};
const PVSocialLinks=values=>{const out=[];for(const p of PV_PLATFORMS){const v=String(values&&values["social_"+p[0]]||"").trim();if(v)out.push({platform:p[0],url:v})}return out};
`;
src = replaceOnce(src, 'export{Bs as default};', HELPERS + 'export{Bs as default};', 'helpers');

// ── verify before writing ───────────────────────────────────────────────────
(function verify() {
  const a = counts(original), b = counts(src);
  if (a.braces !== b.braces || a.parens !== b.parens) {
    throw new Error(`balance changed: braces ${a.braces}->${b.braces}, parens ${a.parens}->${b.parens}`);
  }
  const probe = path.join(os.tmpdir(), 'employee-social-patch-check.mjs');
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
