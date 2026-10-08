const fs = require('fs');
let src = fs.readFileSync('public/assets/Vendors-ngHf9nIc.js','utf8');
const needle = '(()=>{const p=products.find(pp=>String(pp.id)===String(x.productId));return p&&p.category?e.jsx("span",{className:"text-[10px] px-1.5 py-0.5 rounded-md bg-slate-100 text-slate-500 border border-slate-200 shrink-0",children:p.category}):null})(),';
const PRICE_HINT = '(()=>{const p=products.find(pp=>String(pp.id)===String(x.productId));return p?e.jsx("span",{className:"text-[10px] px-1.5 py-0.5 rounded-md bg-teal-50 text-teal-700 border border-teal-200 shrink-0",title:"Product price",children:"Rs "+VP_FMT(p.price||0)}):null})(),';
if (src.includes(PRICE_HINT)) { console.log('exists'); process.exit(0); }
if (!src.includes(needle)) { console.log('missing'); process.exit(1); }
src = src.replace(needle, needle + PRICE_HINT);
fs.writeFileSync('public/assets/Vendors-ngHf9nIc.js', src);
console.log('patched', src.length);
