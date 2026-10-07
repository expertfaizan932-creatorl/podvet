// The route guard painted a full-screen spinner while it checked the session,
// and that spinner replaced the whole app - sidebar included - on every guarded
// navigation. This makes the guard suspend instead of paint.
//
// Why suspending is the correct behaviour here
//
// The app is mounted as
//     <HashRouter><Routes/></HashRouter>
//     with ONE <Suspense> wrapping the routes.
//
// React Router 7.8.1 already wraps navigation in startTransition, and React's
// rule for a transition is that an already-mounted Suspense boundary keeps the
// previously committed screen instead of showing its fallback. So a guard that
// *suspends* is invisible during navigation: the user keeps looking at the page
// they came from until the new one is ready, and the sidebar is never torn down.
//
// The guard was not suspending - it was returning a rendered
// `h-screen` spinner. That is a successful render, not a suspension, so React
// committed it and the whole screen went blank while the check ran. Measured
// over a throttled link that was the entire remaining flash.
//
// On a genuine first load there is no previous screen to keep, and the outer
// boundary's branded fallback (r9) shows instead, which is what it is for.
//
// The pending check lives on the module, not in component state
//
// The first attempt at this used `useState` plus a setState from inside the
// suspending render, and it broke the app: setState from a render that React
// discards on suspension does not reliably reach the fiber, so the component
// re-rendered with the state still empty, suspended again, and the guard never
// resolved. 12 of 19 routes were stuck on the previous page. Holding the
// pending promise in a module-level record avoids the whole class of problem -
// there is no state update during render at all, only a throw.
//
// The record is keyed on window.__pvSessionEpoch, which the browser preload
// bumps whenever the signed-in user changes, so signing out or switching clinic
// forces a fresh check rather than trusting a stale "authorised".

const fs = require('fs');
const path = require('path');

const target = process.argv[2] || path.join(__dirname, '..', 'public', 'assets', 'index-DPVZ9-tL.js');
let src = fs.readFileSync(target, 'utf8');

const OLD =
  'oa=({children:n,requiredRole:l="admin"})=>{' +
  'const[i,s]=O.useState(!0),[u,f]=O.useState(!1),[d,m]=O.useState(!1);' +
  'return O.useEffect(()=>{(async()=>{try{' +
  'const p=await window.electronAPI.resumeSession();' +
  'if(!p){f(!1),m(!1);return}' +
  'f(!0),m(l==="owner"?p.membership_role==="OWNER":l==="admin"?p.role==="admin":!0)' +
  '}catch(p){console.error("Error checking authorization:",p),f(!1),m(!1)}finally{s(!1)}})()},[l]),' +
  'i?g.jsx("div",{className:"flex justify-center items-center h-screen",children:' +
  'g.jsx("div",{className:"animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-teal-600"})}):' +
  'u?d?n:g.jsx(go,{to:"/dashboard",replace:!0}):g.jsx(go,{to:"/",replace:!0})}';

// The pending record is held on window rather than in a new top-level
// declaration: the guard sits part-way through an existing `let`/`const`
// declarator list, so a fresh `let` there is a syntax error, and a comma
// declarator would be invisible to anyone reading the diff. window already
// carries app state (window.__pvBrand, window.__pvSessionEpoch), so this is
// consistent with the codebase and keeps the patch a pure function-body swap.
const NEW =
  'oa=({children:n,requiredRole:l="admin"})=>{' +
  'const i=window.__pvSessionEpoch||0;' +
  'let t=window.__pvGuard;' +
  'if(!t||t.e!==i){' +
  't={e:i,r:!1,s:null};' +
  'const p=(async()=>{try{t.s=await window.electronAPI.resumeSession()||null}' +
  'catch(u){console.error("Error checking authorization:",u);t.s=null}t.r=!0})();' +
  'p.status="pending";t.p=p;window.__pvGuard=t' +
  '}' +
  'if(!t.r)throw t.p;' +
  'const s=t.s,u=!!s,' +
  'd=u&&(l==="owner"?s.membership_role==="OWNER":l==="admin"?s.role==="admin":!0);' +
  'return u?d?n:g.jsx(go,{to:"/dashboard",replace:!0}):g.jsx(go,{to:"/",replace:!0})' +
  '}';

if (src.includes('const[i,s]=O.useState(null);') && !src.includes(OLD)) {
  console.log('already patched');
  process.exit(0);
}

const n = src.split(OLD).length - 1;
if (n !== 1) throw new Error('expected exactly 1 guard definition, found ' + n + '\n(rollback first if partially applied)');

src = src.replace(OLD, NEW);

// the guard must no longer paint a full-screen spinner
if (/flex justify-center items-center h-screen/.test(src.replace(OLD, ''))) {
  // there may legitimately be another such spinner elsewhere; only complain if
  // it is still adjacent to the guard
  const near = src.slice(src.indexOf('oa=({children:n,requiredRole'), src.indexOf('oa=({children:n,requiredRole') + 700);
  if (/h-screen/.test(near)) throw new Error('guard still contains a full-screen spinner');
}

// balance + parse checks
const bal = s => [(s.match(/[{[(]/g) || []).length, (s.match(/[}\])]/g) || []).length];
const [ob, oc] = bal(fs.readFileSync(target, 'utf8')), [nb, nc] = bal(src);
if (nb - nc !== ob - oc) throw new Error('brace balance drifted: ' + (ob - oc) + ' -> ' + (nb - nc));

const tmp = path.join(require('os').tmpdir(), 'pv-guard-' + path.basename(target) + '.mjs');
fs.writeFileSync(tmp, src);
require('child_process').execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });

fs.writeFileSync(target, src, 'utf8');
console.log('guard now suspends instead of painting a spinner');
console.log('  bytes ' + (Buffer.byteLength(src) - Buffer.byteLength(NEW) + Buffer.byteLength(OLD)) + ' -> ' + Buffer.byteLength(src));
console.log('  redirects preserved: /dashboard on role mismatch, / when signed out');
console.log('  parses OK as ES module');