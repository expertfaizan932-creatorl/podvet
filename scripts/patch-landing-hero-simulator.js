// Replaces the hero screenshot with an interactive demo simulator of the real
// PodVet software: the genuine sidebar menu (extracted from the app bundle),
// the real wordmark logo, and clickable pages. The frame is a simulator, not a
// single clickable image.
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'landing.html');
let html = fs.readFileSync(file, 'utf8');

function replaceBetween(src, startAnchor, endAnchor, newBlock, label) {
  const s = src.indexOf(startAnchor);
  if (s === -1) throw new Error('[' + label + '] start anchor not found');
  if (src.indexOf(startAnchor, s + startAnchor.length) !== -1) throw new Error('[' + label + '] start anchor not unique');
  const e = src.indexOf(endAnchor, s + startAnchor.length);
  if (e === -1) throw new Error('[' + label + '] end anchor not found');
  return src.slice(0, s + startAnchor.length) + newBlock + src.slice(e);
}

const NEW_HERO = `

        <div class="max-w-6xl mx-auto px-4 relative z-20">
            <div class="rounded-2xl border border-brand-500/30 bg-white/10 p-2 sm:p-3 shadow-2xl backdrop-blur-xl">
                <p id="hero-caption" class="text-center text-[11px] sm:text-xs font-medium text-brand-300 pb-2 pt-1 tracking-wide">Dashboard - today's visits, revenue and reminders at a glance</p>

                <!-- Interactive demo simulator of the real PodVet software -->
                <div id="dashboard-mockup" class="bg-white rounded-xl shadow-xl overflow-hidden text-gray-800 text-left border border-gray-100">
                    <div class="flex min-h-[440px]">
                        <!-- Sidebar (real PodVet menu) -->
                        <aside class="hidden sm:flex w-52 lg:w-56 shrink-0 flex-col bg-white border-r border-gray-200">
                            <div class="px-4 py-4 border-b border-gray-100 flex items-center gap-2">
                                <img src="/brand/logo-primary.png" alt="PodVet logo" class="h-7 w-auto object-contain">
                            </div>
                            <nav id="demo-sidebar" class="flex-1 py-3 px-3 space-y-0.5 overflow-y-auto max-h-[360px] text-[13px]"></nav>
                            <div class="px-4 py-3 border-t border-gray-100 text-gray-500 text-[13px] flex items-center gap-3"><i class="fa-solid fa-right-from-bracket w-4"></i> Logout</div>
                        </aside>
                        <!-- Main area -->
                        <div class="flex-1 min-w-0 flex flex-col bg-slate-50">
                            <div class="bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between gap-3">
                                <h3 id="demo-page-title" class="font-bold text-gray-900 text-sm">Dashboard</h3>
                                <div class="flex items-center gap-3">
                                    <div class="relative hidden md:block">
                                        <input type="text" placeholder="Search patients..." class="bg-gray-50 text-xs pl-3 pr-8 py-1.5 rounded-md text-gray-700 border border-gray-200 w-44 focus:outline-none">
                                        <i class="fa-solid fa-magnifying-glass absolute right-3 top-2 text-gray-400 text-xs"></i>
                                    </div>
                                    <div class="w-7 h-7 rounded-full bg-teal-600 text-white flex items-center justify-center font-bold text-[11px]">DR</div>
                                </div>
                            </div>
                            <div id="tab-content-container" class="p-4 sm:p-5 overflow-y-auto max-h-[420px]"></div>
                        </div>
                    </div>
                    <div class="text-center text-[10px] text-gray-400 py-1.5 border-t border-gray-100 bg-white pointer-events-none"><i class="fa-solid fa-hand-pointer text-teal-500 mr-1"></i> Demo simulator - click a menu item on the left to explore the screens</div>
                </div>
            </div>
        </div>
    </section>

    `;

const demoJs = fs.readFileSync(path.join(__dirname, 'landing-hero-demo.js'), 'utf8');
const NEW_JS = '\n' + demoJs.replace(/\s+$/, '') + '\n\n        ';

html = replaceBetween(html, '<!-- DASHBOARD PREVIEW WRAPPER -->', '<!-- TRUST STATS & RATING SECTION -->', NEW_HERO, 'hero');
html = replaceBetween(html, '// ===== PodVet demo simulator: real screenshots + real sidebar (auto-managed block) =====', '// Channel Selector Toggle', NEW_JS, 'hero-js');

if (html.includes('SCREEN_IMAGES') || html.includes('hero-screenshot') || html.includes('id="hero-screenshot-link"')) throw new Error('leftover screenshot code remains');
if (!html.includes('id="demo-sidebar"') || !html.includes('const DEMO_NAV')) throw new Error('simulator not injected');

fs.writeFileSync(file, html);
console.log('landing simulator patched (' + html.length + ' bytes)');
