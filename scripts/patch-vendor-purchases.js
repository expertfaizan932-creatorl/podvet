// Adds a "Purchase history" panel to the compiled Vendors chunk's vendor
// detail modal: list of recorded purchases, an inline entry form (date,
// product picker / custom item, qty, unit price, payment status) and delete.
// Saving calls add-vendor-purchase, which stocks in linked products.
//
// The frontend ships as compiled bundles only, so this is minified surgery on
// the built chunk - same approach as patch-employee-social.js / patch-sidebar.js.
// Run against a pristine chunk: every replacement asserts a single match, and
// the output is verified (brace balance + parses as ESM) before it is written.
//
//   node scripts/patch-vendor-purchases.js public/assets/Vendors-<hash>.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const FILE = process.argv[2];
if (!FILE) {
  console.error('usage: node scripts/patch-vendor-purchases.js public/assets/Vendors-*.js');
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

// ── 1. widen the detail modal: the panel needs the room ─────────────────────
src = replaceOnce(
  src,
  '"bg-white rounded-2xl w-full max-w-md shadow-xl overflow-hidden",onClick:I=>I.stopPropagation()',
  '"bg-white rounded-2xl w-full max-w-2xl shadow-xl overflow-hidden",onClick:I=>I.stopPropagation()',
  'modal-width',
);

// ── 2. make the modal body scroll: purchases push it past the viewport ──────
src = replaceOnce(
  src,
  'e.jsxs("div",{className:"p-6 space-y-4 text-xs",children:[',
  'e.jsxs("div",{className:"p-6 space-y-4 text-xs max-h-[75vh] overflow-y-auto",children:[',
  'modal-scroll',
);

// ── 3. the panel itself, between the period summary and the Close row ───────
// Runs inside the detail-modal IIFE, where `d` is the selected vendor row.
src = replaceOnce(
  src,
  'children:a(M)})]})]}),e.jsx("div",{className:"flex justify-end pt-2"',
  'children:a(M)})]})]}),e.jsx(VendorPurchases,{vendorId:d.vendor_id}),e.jsx("div",{className:"flex justify-end pt-2"',
  'panel-insert',
);

// ── 4. the component itself ─────────────────────────────────────────────────
// Appended before the export so nothing joins an existing const chain.
// Evaluated at render time only - no TDZ risk. No backticks / ${} allowed
// inside: HELPERS itself is a template literal in this script.
const HELPERS = `
const VP_FMT=n=>"Rs "+Number(n||0).toLocaleString("en-PK",{minimumFractionDigits:0,maximumFractionDigits:1});
const VP_BADGE=p=>p==="paid"?"bg-emerald-50 text-emerald-700":p==="partial"?"bg-amber-50 text-amber-700":"bg-red-50 text-red-600";
const VP_LINE=()=>({productId:"",itemName:"",quantity:1,unitPrice:""});
function VendorPurchases(t){
const vid=t.vendorId,[rows,setRows]=r.useState([]),[busy,setBusy]=r.useState(!1),[open,setOpen]=r.useState(!1),[saving,setSaving]=r.useState(!1),[products,setProducts]=r.useState([]),[date,setDate]=r.useState(et()),[pay,setPay]=r.useState("paid"),[lines,setLines]=r.useState([VP_LINE()]);
const reload=()=>{const a=window.electronAPI;if(!vid||!a||!a.retrieveVendorPurchases)return;setBusy(!0),a.retrieveVendorPurchases(vid).then(s=>setRows(Array.isArray(s&&s.data)?s.data:[])).catch(()=>{}).finally(()=>setBusy(!1))};
r.useEffect(()=>{reload()},[vid]);
const ensureProducts=()=>{const a=window.electronAPI;if(!a||!a.retrieveProducts||products.length)return;a.retrieveProducts({page:1,pageSize:500}).then(s=>setProducts(Array.isArray(s&&s.data)?s.data:[])).catch(()=>{})};
const toggle=()=>setOpen(o=>{o||(ensureProducts(),setDate(et()));return !o});
const setLine=(i,k,v)=>setLines(ls=>ls.map((x,j)=>j===i?{...x,[k]:v}:x));
const pick=(i,raw)=>{const p=products.find(x=>String(x.id)===raw);setLines(ls=>ls.map((x,j)=>j===i?(p?{...x,productId:String(p.id),itemName:p.name||""}:{...x,productId:"",itemName:""}):x))};
const total=lines.reduce((s,x)=>s+(Number(x.quantity)||0)*(Number(x.unitPrice)||0),0);
const save=async()=>{const a=window.electronAPI;if(saving)return;if(!a||!a.addVendorPurchase){h.error("Not available here");return}
const items=lines.filter(x=>String(x.itemName||"").trim()&&Number(x.quantity)>0).map(x=>({productId:x.productId?Number(x.productId):null,itemName:String(x.itemName).trim(),quantity:Number(x.quantity)||1,unitPrice:Number(x.unitPrice)||0}));
if(!items.length){h.error("Add at least one item first.");return}
setSaving(!0);try{const res=await a.addVendorPurchase({vendorId:vid,purchaseDate:date,paymentStatus:pay,items});
if(res&&res.success!==false){h.success(res.message||"Purchase recorded, stock updated");setOpen(!1),setLines([VP_LINE()]),setDate(et()),setPay("paid"),reload()}else h.error(res&&res.message||"Failed to save purchase")}catch(err){h.error(err&&err.message||"Failed to save purchase")}finally{setSaving(!1)}};
const remove=async id=>{const a=window.electronAPI;if(!a||!a.deleteVendorPurchase)return;
if(!window.confirm("Delete this purchase? Stock it added will be reverted."))return;
try{const res=await a.deleteVendorPurchase({vendorId:vid,purchaseId:id});
if(res&&res.success!==false){h.success(res.message||"Purchase removed");reload()}else h.error(res&&res.message||"Failed to delete")}catch(err){h.error(err&&err.message||"Failed to delete")}};
return e.jsxs("div",{className:"rounded-xl border border-gray-200 bg-white p-4 space-y-3",children:[e.jsxs("div",{className:"flex items-center justify-between gap-2",children:[e.jsx("p",{className:"text-[11px] font-semibold text-gray-400 uppercase tracking-wide",children:"Purchase history"}),e.jsx("button",{type:"button",onClick:toggle,className:"px-3 py-1.5 rounded-lg bg-[#3c77a8] text-white text-xs font-semibold hover:bg-[#2f5e88]",children:open?"Close":"+ Record purchase"})]}),
open&&e.jsxs("div",{className:"border border-dashed border-gray-200 rounded-lg p-3 space-y-2",children:[e.jsxs("div",{className:"flex gap-2",children:[e.jsxs("label",{className:"flex-1",children:[e.jsx("span",{className:"block text-[10px] text-gray-400 mb-0.5",children:"Date"}),e.jsx("input",{type:"date",value:date,onChange:s=>setDate(s.target.value),className:"w-full px-2 py-1.5 border border-gray-200 rounded-lg text-xs"})]}),e.jsxs("label",{className:"flex-1",children:[e.jsx("span",{className:"block text-[10px] text-gray-400 mb-0.5",children:"Payment"}),e.jsxs("select",{value:pay,onChange:s=>setPay(s.target.value),className:"w-full px-2 py-1.5 border border-gray-200 rounded-lg text-xs",children:[e.jsx("option",{value:"paid",children:"Paid"}),e.jsx("option",{value:"partial",children:"Partial"}),e.jsx("option",{value:"due",children:"Due"})]})]})]}),
lines.map((x,i)=>e.jsxs("div",{className:"flex gap-1.5 items-start",children:[e.jsxs("select",{value:x.productId,onChange:s=>pick(i,s.target.value),className:"flex-1 min-w-0 px-2 py-1.5 border border-gray-200 rounded-lg text-xs",children:[e.jsx("option",{value:"",children:"Custom item..."}),products.map(p=>e.jsx("option",{value:String(p.id),children:p.name||"Product "+p.id},p.id))]}),e.jsx("input",{type:"text",placeholder:"Item name",value:x.itemName,disabled:!!x.productId,onChange:s=>setLine(i,"itemName",s.target.value),className:"w-[36%] px-2 py-1.5 border border-gray-200 rounded-lg text-xs disabled:bg-gray-50 disabled:text-gray-400"}),e.jsx("input",{type:"number",min:"1",placeholder:"Qty",value:x.quantity,onChange:s=>setLine(i,"quantity",s.target.value),className:"w-14 px-1.5 py-1.5 border border-gray-200 rounded-lg text-xs"}),e.jsx("input",{type:"number",min:"0",step:"0.01",placeholder:"Price",value:x.unitPrice,onChange:s=>setLine(i,"unitPrice",s.target.value),className:"w-20 px-1.5 py-1.5 border border-gray-200 rounded-lg text-xs"}),lines.length>1&&e.jsx("button",{type:"button",onClick:()=>setLines(ls=>ls.filter((_,j)=>j!==i)),className:"px-1.5 py-1 text-red-400 hover:text-red-600 text-xs",children:"X"})]},i)),
e.jsxs("div",{className:"flex items-center justify-between",children:[e.jsx("button",{type:"button",onClick:()=>setLines(ls=>ls.concat([VP_LINE()])),className:"text-xs text-[#3c77a8] font-semibold hover:underline",children:"+ Add line"}),e.jsx("span",{className:"text-xs font-bold text-gray-800",children:["Total ",VP_FMT(total)]})]}),
e.jsxs("div",{className:"flex justify-end gap-2 pt-1",children:[e.jsx("button",{type:"button",onClick:()=>{setOpen(!1),setLines([VP_LINE()])},className:"px-3 py-1.5 rounded-lg border border-gray-200 text-xs text-gray-600 hover:bg-gray-50",children:"Cancel"}),e.jsx("button",{type:"button",onClick:save,disabled:saving,className:"px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-700 disabled:opacity-50",children:saving?"Saving...":"Save purchase"})]})]}),
busy&&e.jsx("p",{className:"text-xs text-gray-400",children:"Loading..."}),
!busy&&rows.length===0&&e.jsx("p",{className:"text-xs text-gray-400",children:"No purchases recorded yet."}),
rows.map(p=>e.jsxs("div",{className:"flex items-start justify-between gap-2 border-t border-gray-100 pt-2",children:[e.jsxs("div",{className:"min-w-0",children:[e.jsxs("div",{className:"flex items-center gap-1.5",children:[e.jsx("span",{className:"text-xs font-semibold text-gray-800",children:p.purchaseDate}),e.jsx("span",{className:"px-1.5 py-0.5 rounded-full text-[10px] font-semibold "+VP_BADGE(p.paymentStatus),children:p.paymentStatus})]}),e.jsx("p",{className:"text-[11px] text-gray-500 truncate",children:(p.items||[]).map(x=>x.itemName+" x"+x.quantity).join(", ")})]}),e.jsxs("div",{className:"flex items-center gap-2 shrink-0",children:[e.jsx("span",{className:"text-xs font-bold text-gray-800",children:VP_FMT(p.totalAmount)}),e.jsx("button",{type:"button",onClick:()=>remove(p.id),className:"text-red-400 hover:text-red-600 text-xs",title:"Delete purchase",children:"X"})]})]},p.id))
]})}
`;
src = replaceOnce(src, 'export{lt as default};', HELPERS + 'export{lt as default};', 'helpers');

// ── verify before writing ───────────────────────────────────────────────────
(function verify() {
  const a = counts(original), b = counts(src);
  if (a.braces !== b.braces || a.parens !== b.parens) {
    throw new Error(`balance changed: braces ${a.braces}->${b.braces}, parens ${a.parens}->${b.parens}`);
  }
  const probe = path.join(os.tmpdir(), 'vendor-purchases-patch-check.mjs');
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
