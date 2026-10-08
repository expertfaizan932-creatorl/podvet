const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const FILE = 'public/assets/Employees-L23yi8OT.js';
let src = fs.readFileSync(FILE, 'utf8');
const original = src;

function replaceOnce(hay, oldStr, newStr, label) {
  const first = hay.indexOf(oldStr);
  if (first === -1) throw new Error(`${label}: anchor not found`);
  if (hay.indexOf(oldStr, first + 1) !== -1) throw new Error(`${label}: anchor not unique`);
  return hay.slice(0, first) + newStr + hay.slice(first + oldStr.length);
}

// 1. Replace PV_Favicon with brand-icon + favicon fallback chain
const start = src.indexOf('function PV_Favicon(t){');
if (start === -1) throw new Error('favicon start not found');
const end = src.indexOf('function PVSocialRow(t){');
if (end === -1 || end <= start) throw new Error('favicon end not found');
const NEW_FAV = 'function PV_Favicon(t){const slugs={instagram:["instagram"],facebook:["facebook"],linkedin:["linkedin"],twitter:["x","twitter"],whatsapp:["whatsapp"],github:["github"]},slug=String(t.label||"").toLowerCase(),brand=(slugs[slug]||[]).map(x=>"https://cdn.simpleicons.org/"+x),host=PV_HOST(t.url),c=brand.concat(host?["https://www.google.com/s2/favicons?domain="+host+"&sz=64"]:[]),st=r.useState(0),idx=st[0],setIdx=st[1];if(!c.length||idx>=c.length)return e.jsx("span",{className:"inline-flex items-center justify-center w-full h-full text-[8px] font-bold text-gray-500 uppercase",children:String(t.label||"??").slice(0,2)});return e.jsx("img",{src:c[idx],alt:String(t.label||""),width:14,height:14,loading:"lazy",className:"w-3.5 h-3.5 object-contain",onError:()=>setIdx(idx+1)})}\n';
src = src.slice(0, start) + NEW_FAV + src.slice(end);

// 2. Normalize href in the social row (junk urls like "khg" become relative links)
src = replaceOnce(
  src,
  'e.jsx("a",{href:l.url,target:"_blank"',
  'e.jsx("a",{href:/^[a-z][a-z0-9+.-]*:\\/\\//i.test(l.url)?l.url:"https://"+l.url,target:"_blank"',
  'normalize-href',
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
const p = path.join(os.tmpdir(), 'emp-soc.mjs');
fs.writeFileSync(p, src);
try { execFileSync(process.execPath, ['--check', p]); } catch (e) { throw new Error('parse fail'); }
fs.writeFileSync(FILE, src);
console.log('ok', original.length, '->', src.length);
