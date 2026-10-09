// Replaces the hand-coded fake hero mockup on the public landing page with a
// real screenshot of the current PodVet software (real sidebar + logo), keeps
// the hero pills working by swapping real screen captures, and swaps the one
// stock/foreign image for a real PodVet screen.
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'landing.html');
let html = fs.readFileSync(file, 'utf8');
const before = html.length;

function replaceBetween(src, startAnchor, endAnchor, newBlock, label) {
  const s = src.indexOf(startAnchor);
  if (s === -1) throw new Error('[' + label + '] start anchor not found');
  if (src.indexOf(startAnchor, s + startAnchor.length) !== -1) {
    throw new Error('[' + label + '] start anchor is not unique');
  }
  const e = src.indexOf(endAnchor, s + startAnchor.length);
  if (e === -1) throw new Error('[' + label + '] end anchor not found');
  return src.slice(0, s + startAnchor.length) + newBlock + src.slice(e);
}

function replaceOnce(src, find, repl, label) {
  const i = src.indexOf(find);
  if (i === -1) throw new Error('[' + label + '] target not found');
  if (src.indexOf(find, i + find.length) !== -1) {
    throw new Error('[' + label + '] target is not unique');
  }
  return src.slice(0, i) + repl + src.slice(i + find.length);
}

const NEW_HERO = `

        <div class="max-w-6xl mx-auto px-4 relative z-20">
            <div class="rounded-2xl border border-brand-500/30 bg-white/10 p-2 sm:p-3 shadow-2xl backdrop-blur-xl">
                <p id="hero-caption" class="text-center text-[11px] sm:text-xs font-medium text-brand-300 pb-2 pt-1 tracking-wide">Overview - today's visits, revenue and daily income at a glance</p>

                <!-- Main Dashboard Frame (real PodVet software screenshot) -->
                <div id="dashboard-mockup" class="bg-white rounded-xl shadow-xl overflow-hidden text-gray-800 text-left border border-gray-100">
                    <a id="hero-screenshot-link" href="/app" title="Open the live PodVet app" aria-label="PodVet clinic management software - click to open the live app" class="group block relative">
                        <img id="hero-screenshot" src="/landing/dashboard.png" alt="PodVet clinic management software dashboard" class="w-full h-auto block">
                        <span class="absolute bottom-4 left-1/2 -translate-x-1/2 z-30 bg-brand-900/90 text-white text-[11px] sm:text-xs font-semibold px-3 sm:px-4 py-2 rounded-full inline-flex items-center gap-2 shadow-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                            <i class="fa-solid fa-hand-pointer text-brand-300"></i> Live demo - click to open PodVet
                        </span>
                    </a>
                </div>
            </div>
        </div>
    </section>

    `;

const NEW_JS = `
        const SCREEN_IMAGES = {
            dashboard: { src: '/landing/dashboard.png', alt: 'PodVet clinic management software dashboard', caption: 'Overview - today\\'s visits, revenue and daily income at a glance' },
            records: { src: '/landing/records.png', alt: 'PodVet medical records screen', caption: 'Medical Records - SOAP exam notes, prescriptions and patient history' },
            appointments: { src: '/landing/appointments.png', alt: 'PodVet vaccine and appointment calendar', caption: 'Vaccines & Appointments - per-vet calendar, bookings and due vaccinations' },
            invoices: { src: '/landing/payments.png', alt: 'PodVet invoices and payments screen', caption: 'Invoices & Payments - e-invoice, e-receipt and POS checkout' },
            reminders: { src: '/landing/dashboard.png', alt: 'PodVet automated reminders', caption: 'Reminders - automated SMS, WhatsApp, email and push notifications' },
        };

        const PILL_TO_SCREEN = {
            records: 'records', calendar: 'appointments', invoices: 'invoices', reminders: 'reminders',
        };

        function setScreen(key) {
            const screen = SCREEN_IMAGES[key];
            const img = document.getElementById('hero-screenshot');
            if (img && screen) { img.src = screen.src; img.alt = screen.alt; }

            document.querySelectorAll('.hero-tab-btn').forEach(btn => {
                const pillKey = PILL_TO_SCREEN[btn.id.slice(4)] || '';
                const active = pillKey === key;
                btn.className = 'hero-tab-btn px-5 py-2.5 rounded-full text-xs sm:text-sm flex items-center gap-2 transition-all' + (active
                    ? ' font-semibold bg-brand-800/90 text-white border border-brand-400/50 shadow-md'
                    : ' font-medium bg-brand-950/60 text-brand-200 hover:text-white border border-brand-800/60 hover:border-brand-500');
            });

            const caption = document.getElementById('hero-caption');
            if (caption && screen) caption.textContent = screen.caption;
            showDemo((screen && screen.alt) || 'PodVet');
        }

        function switchTab(tabKey) {
            setScreen(PILL_TO_SCREEN[tabKey] || tabKey);
        }

        `;

html = replaceBetween(html, '<!-- DASHBOARD PREVIEW WRAPPER -->', '<!-- TRUST STATS & RATING SECTION -->', NEW_HERO, 'hero');
html = replaceBetween(html, '// Demo screen content (compact, real-style HTML for each PodVet screen)', '// Channel Selector Toggle', NEW_JS, 'hero-js');

html = replaceOnce(
  html,
  'id="tab-records" class="hero-tab-btn active px-5 py-2.5 rounded-full text-xs sm:text-sm font-semibold bg-brand-800/90 text-white border border-brand-400/50 shadow-md transition-all flex items-center gap-2"',
  'id="tab-records" class="hero-tab-btn px-5 py-2.5 rounded-full text-xs sm:text-sm font-medium bg-brand-950/60 text-brand-200 hover:text-white border border-brand-800/60 hover:border-brand-500 transition-all flex items-center gap-2"',
  'records-pill'
);

html = replaceOnce(
  html,
  '<img src="https://images.unsplash.com/photo-1628009368231-7bb7cfcb0def?auto=format&fit=crop&w=800&q=80" alt="Veterinarian with golden retriever" class="w-full h-80 object-cover rounded-2xl">',
  '<img src="/landing/records.png" alt="PodVet medical records and AI SOAP notes screen" class="w-full h-80 object-cover object-top rounded-2xl">',
  'stock-photo'
);

if (html.includes('SCREEN_CONTENT') || html.includes('demo-sidebar') || html.includes('tab-content-container')) {
  throw new Error('leftover fake-mockup references remain');
}
if (html.includes('images.unsplash.com')) {
  throw new Error('foreign stock image still present');
}

fs.writeFileSync(file, html);
console.log('landing.html patched (' + before + ' -> ' + html.length + ' bytes)');
