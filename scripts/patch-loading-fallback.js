// Make the route-loading fallback read as deliberate loading, not a white page.
//
// The app has exactly one <Suspense>, wrapping the entire route tree, while
// every page chunk renders its own PageLayout (sidebar included). So whenever a
// route chunk is not already in the module registry that boundary replaces the
// whole shell and shows this fallback - which is what users were reporting as
// "white refresh".
//
// The fallback was a bare spinner on a default-white full-height div. Same
// spinner, but on the app's own background with a label, so the transition
// looks like the app is working rather than having crashed.
//
// Note: the sidebar genuinely does disappear for the duration; that part is a
// structural problem (the boundary has to sit below the sidebar, which means
// the layout has to be a nested parent route instead of being rendered by each
// page chunk) and needs the frontend source, which is not in this repo.
//
// Usage: node patch-loading-fallback.js <path-to-index-*.js>

const fs = require('fs');

const target = process.argv[2];
if (!target) throw new Error('usage: node patch-loading-fallback.js <index-*.js>');

let src = fs.readFileSync(target, 'utf8');

const OLD =
  'r9=()=>g.jsx("div",{className:"flex justify-center items-center h-screen",' +
  'children:g.jsx("div",{className:"animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-teal-600"})});';

const NEW =
  'r9=()=>g.jsx("div",{className:"flex flex-col justify-center items-center h-screen w-full ' +
  'bg-gray-50 text-gray-800",children:[' +
  'g.jsx("div",{className:"animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-teal-600"}),' +
  'g.jsx("p",{className:"mt-4 text-sm text-gray-400",children:"Loading..."})' +
  ']});';

if (src.includes(NEW)) {
  console.log('already patched');
  process.exit(0);
}

const parts = src.split(OLD);
if (parts.length !== 2) throw new Error('fallback pattern found ' + (parts.length - 1) + ' times, expected 1');

const out = parts.join(NEW);

const b = s => [(s.match(/[{[(]/g) || []).length, (s.match(/[}\])]/g) || []).length];
const [ob, oc] = b(src), [nb, nc] = b(out);
if (nb - nc !== ob - oc) throw new Error('brace balance drifted');

fs.writeFileSync(target, out, 'utf8');
console.log('patched route-loading fallback in ' + target.split(/[\\/]/).pop());
console.log('  bytes ' + Buffer.byteLength(src) + ' -> ' + Buffer.byteLength(out));