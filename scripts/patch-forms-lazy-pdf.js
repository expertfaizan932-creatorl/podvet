// Makes the PDF libraries load on demand instead of with the Forms page.
//
// Forms is ~1.06 MB to open, and 733 KB of that is jspdf + html2canvas +
// a print shim - all pulled in eagerly because Forms has a single static
// `import {E as Ni}` of jspdf and uses it in exactly one place. So every visit
// to Forms paid for the PDF toolchain even though a PDF is only generated when
// the user actually exports one.
//
// The usage sits on the first line of an already-async function, so turning the
// static import into `await import(...)` is a one-line change with no change in
// control flow. MedicalSummaryModal in the same build already loads jspdf this
// way, so this is the pattern the codebase uses elsewhere.
//
// jspdf itself statically imports html2canvas and the print shim, so deferring
// this one import defers all 733 KB until a PDF is really generated.

const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'public', 'assets');
const formsFile = path.join(dir, 'Forms-BZOEwHoI.js');
const mainFile = path.join(dir, 'index-DPVZ9-tL.js');

const STATIC_IMPORT = 'import{E as Ni}from"./jspdf.es.min-DHksVS56.js";';
const STATIC_USE = 'new Ni({unit:"mm",format:"a4"})';
const LAZY_USE = 'new (await import("./jspdf.es.min-DHksVS56.js")).E({unit:"mm",format:"a4"})';

let forms = fs.readFileSync(formsFile, 'utf8');

if (forms.includes(LAZY_USE)) {
  console.log('Forms: already patched');
} else {
  const importCount = forms.split(STATIC_IMPORT).length - 1;
  const useCount = forms.split(STATIC_USE).length - 1;
  if (importCount !== 1) throw new Error('expected exactly 1 static jspdf import, found ' + importCount);
  if (useCount !== 1) throw new Error('expected exactly 1 usage, found ' + useCount);

  // the call site has to already be inside an async function for await to work
  const at = forms.indexOf(STATIC_USE);
  const before = forms.slice(Math.max(0, at - 400), at);
  const asyncPos = before.lastIndexOf('async');
  const fnPos = before.lastIndexOf('=>');
  if (asyncPos === -1 || asyncPos < fnPos) {
    throw new Error('call site is not inside an async function - cannot use await here');
  }

  forms = forms.replace(STATIC_IMPORT, '').replace(STATIC_USE, LAZY_USE);

  if (/(?<![A-Za-z0-9_$.])Ni(?![A-Za-z0-9_$])/.test(forms)) {
    throw new Error('a reference to Ni survived the patch');
  }
  fs.writeFileSync(formsFile, forms, 'utf8');
  console.log('Forms: jspdf import made lazy');
  console.log('  bytes ' + (forms.length - LAZY_USE.length + STATIC_USE.length + STATIC_IMPORT.length) + ' -> ' + forms.length);
}

// Now drop jspdf from the eager preload list. Once the static import is gone
// the browser no longer needs the hint, and keeping it would still fetch all
// 733 KB the moment Forms is opened.
let main = fs.readFileSync(mainFile, 'utf8');
if (!/import\w*\s*\{[^}]*Ni/.test(forms) && main.includes('__vite__mapDeps')) {
  const jspdfName = 'jspdf.es.min-DHksVS56.js';
  const m = /__vite__mapDeps\(\[([0-9,\s]+)\]\)/g;
  let hit, changed = 0;
  while ((hit = m.exec(main))) {
    const idxs = hit[1].split(',').map(s => parseInt(s, 10)).filter(n => !isNaN(n));
    if (!idxs.includes(22)) continue;
    const next = idxs.filter(i => i !== 22);
    if (next.length === idxs.length) continue;
    main = main.slice(0, hit.index) + '__vite__mapDeps([' + next.join(',') + '])' + main.slice(hit.index + hit[0].length);
    changed++;
    console.log('preload list: dropped jspdf index 22, ' + idxs.length + ' -> ' + next.length + ' deps');
    break;
  }
  if (changed) {
    fs.writeFileSync(mainFile, main, 'utf8');
    console.log('  (' + jspdfName + ' still loads on demand via the dynamic import)');
  } else {
    console.log('preload list: no jspdf index to drop');
  }
}

// guard: both files must still be valid ES modules
for (const f of [formsFile, mainFile]) {
  const tmp = path.join(require('os').tmpdir(), 'pv-parse-' + path.basename(f) + '.mjs');
  fs.copyFileSync(f, tmp);
  require('child_process').execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
  console.log('parses OK: ' + path.basename(f));
}