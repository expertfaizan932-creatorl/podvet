// One-off: show the deployed app version right under the clinic name in the
// sidebar. The value comes from window.__pvVersion, which index.js injects into
// /app (see buildWebIndexHtml) so it always reflects the currently deployed
// version.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const FILE = path.join(__dirname, '..', 'public', 'assets', 'useBackdropClose-BUui1O1e.js');
let src = fs.readFileSync(FILE, 'utf8');

function replaceOnce(hay, needle, repl) {
  const n = hay.split(needle).length - 1;
  if (n !== 1) throw new Error(`anchor found ${n} times: ${needle.slice(0, 70)}`);
  return hay.replace(needle, repl);
}

function counts(s) {
  const c = {};
  for (const ch of '(){}[]') c[ch] = (s.match(new RegExp('\\' + ch, 'g')) || []).length;
  return c;
}

const before = counts(src);

const A = 'children:[e.jsx("h1",{className:';
const A2 = 'children:[e.jsxs("div",{className:"flex flex-col min-w-0",children:[e.jsx("h1",{className:';

const B = ',children:br&&br.name||"PodVet"}),e.jsx("span",{';
const B2 = ',children:br&&br.name||"PodVet"}),e.jsx("span",{className:"text-[10px] text-gray-400 font-medium leading-none mt-0.5 block",children:"v"+(window.__pvVersion||"")})]}),e.jsx("span",{';

src = replaceOnce(src, A, A2);
src = replaceOnce(src, B, B2);

const after = counts(src);
for (const [o, c] of [['(', ')'], ['{', '}'], ['[', ']']]) {
  if (after[o] !== after[c]) {
    throw new Error(`unbalanced ${o}${c}: ${after[o]} vs ${after[c]}`);
  }
}
console.log('counts before', JSON.stringify(before));
console.log('counts after ', JSON.stringify(after));

const probe = path.join(os.tmpdir(), `pv-sidebar-probe-${Date.now()}.mjs`);
fs.writeFileSync(probe, src, 'utf8');
try {
  execFileSync(process.execPath, ['--check', probe], { stdio: 'inherit' });
} finally {
  fs.unlinkSync(probe);
}

fs.writeFileSync(FILE, src, 'utf8');
console.log('patched', FILE, src.length);
