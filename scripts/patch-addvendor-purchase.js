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
  if (hay.indexOf(oldStr, first + 1) !== -1) throw new Error(`${label}: anchor not unique`);
  return hay.slice(0, first) + newStr + hay.slice(first + oldStr.length);
}

src = replaceOnce(
  src,
  '[d,$]=r.useState(null);',
  '[d,$]=r.useState(null),[fl,setFl]=r.useState([VP_LINE()]),[fpr,setFpr]=r.useState([]);',
  'hooks',
);

const HELP = `r.useEffect(()=>{const a=window.electronAPI;a&&a.retrieveProducts&&a.retrieveProducts({page:1,pageSize:500}).then(t=>setFpr(Array.isArray(t&&t.data)?t.data:[])).catch(()=>{})},[]);
const fset=(i,k,v)=>setFl(ls=>ls.map((x,j)=>j===i?{...x,[k]:v}:x));
const fpick=(i,raw)=>{const p=fpr.find(x=>String(x.id)===raw);setFl(ls=>ls.map((x,j)=>j===i?(p?{...x,productId:String(p.id),itemName:p.name||"",unitPrice:x.unitPrice?x.unitPrice:(p.price??"")}:{...x,productId:"",itemName:""}):x))};
const ftot=fl.reduce((a,x)=>a+(Number(x.quantity)||0)*(Number(x.unitPrice)||0),0);
const PVFP=async vid=>{const items=fl.filter(x=>String(x.itemName||"").trim()&&Number(x.quantity)>0).map(x=>({productId:x.productId?Number(x.productId):null,itemName:String(x.itemName).trim(),quantity:Number(x.quantity)||1,unitPrice:Number(x.unitPrice)||0}));if(!items.length||!vid)return;try{await window.electronAPI?.addVendorPurchase({vendorId:vid,purchaseDate:et(),paymentStatus:"paid",items})}catch(e){console.error(e)}};
const Me=()=>{!j||!N||S()}`;
src = replaceOnce(src, 'const Me=()=>{!j||!N||S()}', HELP, 'helpers');

const UI = fs.readFileSync(path.join(__dirname, 'ui-snippet.txt'), 'utf8');
src = replaceOnce(
  src,
  ',"Active vendor"]}),e.jsxs("div",{className:"flex justify-end gap-2 pt-2"',
  UI.trimEnd() + ',e.jsxs("div",{className:"flex justify-end gap-2 pt-2"',
  'purchase-ui',
);

src = replaceOnce(
  src,
  'n?.success?(h.success(n.message),w(!1),B(!1),U(null),x(W),A(b,y),S()):h.error(n?.message||"Unable to save vendor")',
  'n?.success?(await PVFP(n.vendorId||Pe),h.success(n.message),w(!1),B(!1),U(null),x(W),A(b,y),S(),setFl([VP_LINE()])):h.error(n?.message||"Unable to save vendor")',
  'submit',
);

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
const p = path.join(os.tmpdir(), 'add-vp.mjs');
fs.writeFileSync(p, src);
try { execFileSync(process.execPath, ['--check', p]); } catch (e) { throw new Error('parse fail'); }
fs.writeFileSync(FILE, src);
console.log('ok', original.length, '->', src.length);
