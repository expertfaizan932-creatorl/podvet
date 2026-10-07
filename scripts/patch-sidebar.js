// Surgical fixes for the sidebar in the built bundle (useBackdropClose-*.js).
// Run from the pristine upstream copy of the chunk, not on an already-patched
// file - every replacement below asserts a single match, so re-running on a
// patched file fails loudly instead of silently corrupting it.
//
// ---------------------------------------------------------------------------
// FIX 1 - role gating hid 8 of the 20 sidebar items
//
//   t.useEffect(()=>{(async()=>{const u=await window.electronAPI.getSession();
//     u?.role==="admin"&&l(!0), o(u?.membership_role==="OWNER")})()},[])
//   const r = (s,u,w,B=!1,F=!1) => B&&!i||F&&!c ? null : <Link .../>
//
// `i` (isAdmin) and `c` (isOwner) start as false and are only filled in once
// the async getSession() above resolves. Until then `r()` returns null for
// every gated item, so the nav first paints 12 links and then grows to 20 when
// Employees / Services / Grooming / Vendors / Expenses / Coupons / Forms /
// Reports are spliced into the *middle* of the list. That is the "glitch":
// content under the cursor moves, so a click during that window lands on the
// wrong row. Driving the live app in headless Chrome over CDP reproduced it
// exactly - 12 links at 14s in one run, 20 links in another.
//
// Note the original checks were not actually wrong: the session this app
// returns has role:"admin" and membership_role:"OWNER", so they did match.
// What is wrong is that there is no .catch(), so the promise rejected
// unhandled whenever the session lookup failed.
//
// Fix: resolve role and membership_role independently instead of collapsing
// them into one value - a clinic staff member can be role:"admin" with
// membership_role:"USER", and preferring membership_role would hide the
// admin-gated items from them. Compare case-insensitively against the real
// enum, treat OWNER as admin-capable (which the adjacent `c?"Employees":
// "Users"` label already assumes), and add the missing .catch().
//
// ---------------------------------------------------------------------------
// FIX 2 - scroll-memory jumped the nav back to the top
//
//   const E = () => { m(null), d.current && sessionStorage.setItem("sidebarScrollTop", ...) }
//   e.jsxs("nav", { ref: d, onScroll: E, ... })
//
// `E` was bound to the nav's onScroll, so every scroll tick ran a setState
// (visible jank), rewrote sessionStorage, and on remount the restore did
// `scrollTop = parseInt(s,10)` after a fixed 50ms - before the route chunk had
// laid the nav out, so the value clamped to 0 and the nav jumped to the top.
// parseInt("null") === NaN lands on 0 the same way.
//
// Fix: save once on unmount instead of per scroll tick, and make the restore
// clamp to the real scrollable range and retry across a few frames (same
// technique public/index.html already uses for the page scroll memory).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const FILE = process.argv[2];
const OLD_REF = ',d=t.useRef(null);';
const NEW_REF = ',d=t.useRef(null),yt=t.useRef(0);';
let src = fs.readFileSync(FILE, 'utf8');
const before = src.length;

const OLD_ROLE =
  't.useEffect(()=>{(async()=>{const u=await window.electronAPI.getSession();' +
  'u?.role==="admin"&&l(!0),o(u?.membership_role==="OWNER")})()},[])';

const NEW_ROLE =
  't.useEffect(()=>{(async()=>{const u=await window.electronAPI.getSession().catch(()=>null);' +
  'if(!u)return;' +
  'const a=String(u.role||"").toUpperCase(),b=String(u.membership_role||"").toUpperCase();' +
  '("ADMIN"===a||"OWNER"===a||"ADMIN"===b||"OWNER"===b)&&l(!0);' +
  '("OWNER"===a||"OWNER"===b)&&o(!0)' +
  '})().catch(()=>{})},[])';

// ---------------------------------------------------------------------------
// FIX 2 - keep the sidebar where the user left it
//
// The shell is torn down and rebuilt on every route change (the single app-wide
// <Suspense> boundary wraps the whole route tree, and every page chunk renders
// its own PageLayout with the sidebar inside it). So the nav node is recreated
// and starts at scrollTop 0 on every click.
//
// The first attempt at this fix moved the save from "every scroll event" to
// "on unmount" and made it strictly worse, which is worth writing down:
//   - on unmount the replacement nav already exists at scrollTop 0, so a save
//     reading d.current wrote 0 over the user's real position;
//   - the restore ran once at 60ms, when the freshly mounted nav is still empty
//     (scrollHeight - clientHeight === 0), so Math.min(v, 0) === 0, the
//     `if (a > 0)` guard skipped it, and there was no retry.
// Net effect: position was lost permanently after the first click.
//
// Track the position in a ref, updated by a passive scroll listener. That costs
// no re-render (the original handler also called m(null) on every tick) and,
// crucially, survives the DOM being swapped underneath it. On mount, restore
// only once the list is actually tall enough to scroll, and keep retrying until
// it is - the admin-gated items are appended asynchronously, so for the first
// second or so the list is genuinely shorter than the scroll target.
// ---------------------------------------------------------------------------

const OLD_EFFECT =
  't.useEffect(()=>{const s=sessionStorage.getItem("sidebarScrollTop");s&&d.current&&setTimeout(()=>{d.current&&(d.current.scrollTop=parseInt(s,10))},50)},[]);' +
  'const E=()=>{m(null),d.current&&sessionStorage.setItem("sidebarScrollTop",d.current.scrollTop)};';

const NEW_EFFECT =
  't.useEffect(()=>{' +
  'const v=parseInt(sessionStorage.getItem("sidebarScrollTop")||"0",10)||0;' +
  'yt.current=v;' +
  'let n=0;' +
  'const t=()=>{' +
  'const e=d.current;' +
  'if(!e)return;' +
  'const x=e.scrollHeight-e.clientHeight;' +
  'if(x<=2){if(n<180){n++;requestAnimationFrame(t)}return}' +
  'const y=Math.min(v,x);' +
  'e.scrollTop=y;' +
  'if(Math.abs(e.scrollTop-y)>2&&n<180){n++;requestAnimationFrame(t)}' +
  '};' +
  'if(Number.isFinite(v)&&v>0)requestAnimationFrame(t);' +
  'const e=d.current;' +
  'const w=()=>{if(d.current)yt.current=d.current.scrollTop};' +
  'e&&e.addEventListener("scroll",w,{passive:true});' +
  'return()=>{' +
  'e&&e.removeEventListener("scroll",w);' +
  'sessionStorage.setItem("sidebarScrollTop",String(yt.current))' +
  '}' +
  '},[]);' +
  'const E=()=>{m(null)};';

const OLD_NAV = 'e.jsxs("nav",{ref:d,onScroll:E,className:`';
const NEW_NAV = 'e.jsxs("nav",{ref:d,className:`';

// ---------------------------------------------------------------------------
// FIX 3 - "Referral" was the one sidebar item that still reloaded the whole app
//
//   e.jsxs("a",{href:"/loyalty-card.html", ...})
//
// Every other item renders through react-router's Link, so it is a client-side
// transition. Referral was a raw anchor pointing at a standalone document, so
// clicking it threw away the running SPA and booted a second copy of the app -
// the "full page refresh then the right page shows" behaviour. Verified by
// driving headless Chrome over CDP: 19/20 items caused no document request,
// Referral was the only one that did.
//
// It stays a standalone page on purpose: /loyalty-card.html is a public share
// artefact (it renders QR codes and must keep working for recipients who have
// no PodVet session, and it calls no /_rpc endpoint), and the deployed bundle
// has no loyalty-card route at all. So opening it in a new tab is the fix -
// the referral page still loads in full, but the app the user is working in is
// never torn down and rebuilt.
// ---------------------------------------------------------------------------

const OLD_REFERRAL = 'e.jsxs("a",{href:"/loyalty-card.html",onMouseEnter:';
const NEW_REFERRAL = 'e.jsxs("a",{href:"/loyalty-card.html",target:"_blank",rel:"noopener noreferrer",onMouseEnter:';

function replaceOnce(haystack, needle, repl, label) {
  const first = haystack.indexOf(needle);
  if (first === -1) throw new Error(`${label}: pattern NOT found`);
  if (haystack.indexOf(needle, first + 1) !== -1) throw new Error(`${label}: pattern found more than once`);
  return haystack.slice(0, first) + repl + haystack.slice(first + needle.length);
}

// ---------------------------------------------------------------------------
// FIX 4 - prefetch the route chunk on hover so clicking never blanks the screen
//
// Every page is `O.lazy(() => import("./X.js"))`, and the app's only Suspense
// boundary sits outside the whole route tree. The sidebar lives inside each
// page (every page chunk imports PageLayout and renders it), so the boundary
// cannot catch a page's suspension from the inside - by the time PageLayout
// would render, the suspending page has not resolved yet. Net effect, measured
// in headless Chrome on the live site: clicking Forms blanked the entire app
// including the sidebar for 19188ms cold, and the sidebar returned scrolled to
// the top.
//
// Eagerly importing all 19 chunks was tried and reverted - 1068KB of background
// downloads starved the initial render on a slow link (nav stuck at 12 items).
//
// Instead, prefetch on intent. The pointer resting on a sidebar item is a
// reliable signal that the click is coming, and it costs nothing for items the
// user never reaches. Once the module is registered, react-router's lazy()
// resolves from cache in a microtask and the fallback never renders at all.
//
// The route -> chunk table is derived from the main bundle, so it always matches
// whatever build is being patched rather than being hardcoded here.
// ---------------------------------------------------------------------------

const mainBundle = process.argv[3];
let prefetch = { old: null, nu: null, inject: null };

if (mainBundle) {
  const main = fs.readFileSync(mainBundle, 'utf8');

  const lazy = {};
  for (const x of main.matchAll(/([A-Za-z0-9_$]+)\s*=\s*\w+\.lazy\(\(\)=>\w+\(\(\)=>import\("\.\/([^"]+\.js)"\)/g)) {
    lazy[x[1]] = x[2];
  }
  const lazyCount = (main.match(/\.lazy\(/g) || []).length;
  if (Object.keys(lazy).length !== lazyCount) {
    throw new Error(`lazy map incomplete: ${Object.keys(lazy).length} of ${lazyCount}`);
  }

  const map = {};
  for (const x of main.matchAll(/path:"([^"]+)",element:(?:\w+\.jsx\(([A-Za-z0-9_$]+),\{\}\)|\w+\.jsx\(\w+,\{[^}]*children:\w+\.jsx\(([A-Za-z0-9_$]+),\{\}\))/g)) {
    const v = x[2] || x[3];
    if (v && lazy[v]) map[x[1]] = lazy[v];
  }
  if (Object.keys(map).length !== Object.keys(lazy).length) {
    throw new Error(`route map incomplete: ${Object.keys(map).length} of ${Object.keys(lazy).length}`);
  }
  for (const c of Object.values(map)) {
    if (!fs.existsSync(path.join(path.dirname(path.resolve(FILE)), c))) {
      throw new Error('chunk missing on disk, prefetch would 404: ' + c);
    }
  }

  const MAP = JSON.stringify(map);
  // `Pf`/`Qf`/`Zf` must not collide with anything the chunk already binds.
  for (const id of ['Pf', 'Qf', 'Zf']) {
    if (new RegExp('\\b' + id + '\\b').test(src)) throw new Error('identifier collision: ' + id);
  }

  const helper =
    `const Pf={m:${MAP},s:new Set,y:!1},` +
    'Qf=s=>{const f=Pf.m[s];if(!f||Pf.s.has(f))return;Pf.s.add(f);return import("./"+f).catch(()=>{})},' +
    // Yield to the page while a route is still loading.
    //
    // The sweep below walks every route chunk in the background, which is what
    // keeps navigation instant on a slow connection. But "background" is only
    // true when the app is idle: measured over a throttled link, a navigation
    // issued while the sweep was still running sat waiting behind it for 18s.
    // The chunk that is actually needed right now has to win, so the sweep
    // holds off for as long as anything is spinning.
    'Zf=async()=>{for(let i=0;i<300;i++){if(!document.querySelector(".animate-spin"))return;await new Promise(r=>setTimeout(r,100))}},' +
    'Bf=()=>{' +
    'if(Pf.y)return;Pf.y=!0;' +
    'const c=navigator.connection;' +
    'if(c&&(c.saveData||/^(slow-)?2g$/i.test(c.effectiveType||"")))return;' +
    'let z=!1;' +
    'const g=async()=>{for(const k in Pf.m){await Zf();await Qf(k)}};' +
    'const r=()=>{if(z)return;z=!0;g()};' +
    'window.requestIdleCallback?window.requestIdleCallback(r,{timeout:4000}):0;' +
    'setTimeout(r,2500)' +
    '};';

  prefetch = {
    old: 'onMouseEnter:b=>{if(!n)return;const j=b.currentTarget.getBoundingClientRect();m({label:w,top:j.top+j.height/2})}',
    nu: 'onMouseEnter:b=>{Qf(s);if(!n)return;const j=b.currentTarget.getBoundingClientRect();m({label:w,top:j.top+j.height/2})},' +
        'onFocus:()=>{Qf(s)}',
    inject: ['const de=()=>{', helper + 'const de=()=>{'],
    sweep: 'const E=()=>{m(null)};',
    sweepTo: 'const E=()=>{m(null)};t.useEffect(()=>{Bf()},[]);',
  };
}

if (prefetch.old) {
  src = replaceOnce(src, prefetch.old, prefetch.nu, 'prefetch-on-hover');
  src = replaceOnce(src, prefetch.inject[0], prefetch.inject[1], 'prefetch-helper');
  console.log('  routes in prefetch table: ' + Object.keys(JSON.parse(prefetch.inject[1].match(/m:(\{.*?\}),s:new Set/)[1])).length);
} else {
  console.log('  skipped prefetch (main bundle not supplied)');
}

src = replaceOnce(src, OLD_ROLE, NEW_ROLE, 'role-gate');
src = replaceOnce(src, OLD_REF, NEW_REF, 'scroll-ref');
src = replaceOnce(src, OLD_EFFECT, NEW_EFFECT, 'scroll-effect');
if (prefetch.sweep) {
  src = replaceOnce(src, prefetch.sweep, prefetch.sweepTo, 'prefetch-sweep');
}
src = replaceOnce(src, OLD_NAV, NEW_NAV, 'nav');
src = replaceOnce(src, OLD_REFERRAL, NEW_REFERRAL, 'referral-newtab');

// Self-check. Minified-surgery edits are bracket-count edits, and a miscounted
// `}` only shows up as a parser error far away from the edit that caused it -
// which cost a full debugging cycle here. Verify before writing: the result
// must parse as an ES module and must be balance-neutral against the original.
(function verify(beforeSrc) {
  const before = { ...counts(beforeSrc) };
  const after = counts(src);
  if (before.braces !== after.braces || before.parens !== after.parens) {
    throw new Error(`balance changed: braces ${before.braces}->${after.braces}, ` +
      `parens ${before.parens}->${after.parens}`);
  }
  const probe = path.join(os.tmpdir(), 'sidebar-patch-check.mjs');
  fs.writeFileSync(probe, src, 'utf8');
  try {
    execFileSync(process.execPath, ['--check', probe], { stdio: 'pipe' });
  } catch (e) {
    const msg = /SyntaxError: (.+)/.exec(e.stderr.toString());
    throw new Error('patched output does not parse: ' + (msg ? msg[1] : 'unknown'));
  }
  console.log('  verified: brace/paren balance unchanged, output parses as ESM');
})(src);

function counts(s) {
  let braces = 0, parens = 0, inStr = false, sh = '';
  for (const c of s) {
    if (inStr) { if (c === sh) inStr = false; continue; }
    if (c === '"' || c === "'") { inStr = true; sh = c; continue; }
    if (c === '{') braces++; else if (c === '}') braces--;
    else if (c === '(') parens++; else if (c === ')') parens--;
  }
  return { braces, parens };
}

fs.writeFileSync(FILE, src, 'utf8');
console.log(`patched ${FILE}`);
console.log(`  bytes ${before} -> ${src.length}`);
