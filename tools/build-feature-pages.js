const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const demo = fs.readFileSync(path.join(ROOT, 'public', 'demo.html'), 'utf8');

const headerHtml = (demo.match(/<header[\s\S]*?<\/header>/) || [''])[0];
const footerHtml = (demo.match(/<footer[\s\S]*?<\/footer>/) || [''])[0];

const panels = {};
const panelRe = /<section id="tab-([a-z]+)" class="demo-panel[^"]*"[^>]*>([\s\S]*?)<\/section>/g;
let m;
while ((m = panelRe.exec(demo)) !== null) {
  panels[m[1]] = m[2];
}

for (const key of ['appointments', 'vaccinations', 'clients', 'medical', 'inventory', 'reporting', 'messaging']) {
  if (!panels[key]) throw new Error('missing panel ' + key);
}

const features = [
  {
    slug: 'appointments', label: 'Appointments', icon: 'fa-solid fa-calendar-check', img: 'blog-vet-exam.jpg',
    title: 'Appointments & Daily Flowboard',
    tagline: 'Every patient, every vet, every slot \u2014 in one glance.',
    desc: "Manage your clinic's schedule with a per-vet daily flowboard. Book, reschedule and check patients in, attach vaccinations and products to any visit, and let the auto-scheduler fill empty slots.",
  },
  {
    slug: 'vaccinations', label: 'Vaccinations', icon: 'fa-solid fa-syringe', img: 'about-dogs-running.jpg',
    title: 'Vaccination Tracker',
    tagline: 'Never miss a booster again.',
    desc: 'Track every vaccine across your whole patient list. PodVet computes when each booster is due, highlights overdue pets, and sends automatic SMS & WhatsApp reminders on schedule.',
  },
  {
    slug: 'client-records', label: 'Client Records', icon: 'fa-solid fa-address-book', img: 'blog-vet-dachshund.jpg',
    title: 'Client & Patient Records',
    tagline: 'Full family profiles at your fingertips.',
    desc: 'One profile per client with every pet, invoice balance, visit history and preferences. Spot clients who have not visited in months and re-engage them in one click.',
  },
  {
    slug: 'medical-records', label: 'Medical Records', icon: 'fa-solid fa-notes-medical', img: 'blog-teeth.jpg',
    title: 'Medical Records & SOAP Notes',
    tagline: 'The complete patient chart.',
    desc: 'SOAP exam notes, vitals, prescriptions and full visit history in one patient chart. Every treatment is recorded, so any vet can pick up exactly where the last one left off.',
  },
  {
    slug: 'inventory', label: 'Inventory', icon: 'fa-solid fa-boxes-stacked', img: 'blog-corgi.jpg',
    title: 'Inventory & Stock Alerts',
    tagline: 'Stock that counts itself.',
    desc: 'Track stock in real time. After every treatment and sale, quantities deduct automatically and you are alerted the moment stock hits minimum level or a medication nears expiry.',
  },
  {
    slug: 'reporting', label: 'Reporting', icon: 'fa-solid fa-chart-line', img: 'blog-dog-beach.jpg',
    title: 'Reporting & Analytics',
    tagline: 'Data-driven practice decisions.',
    desc: 'See your daily, weekly and monthly income and expense analysis on a single screen. Which service earns the most, which vet is most efficient, which hours go empty \u2014 decide where to invest with real numbers.',
  },
  {
    slug: 'messaging', label: 'SMS & WhatsApp', icon: 'fa-brands fa-whatsapp', img: 'blog-beagle.jpg',
    title: 'SMS & WhatsApp Messaging',
    tagline: 'Meet your clients where they already are.',
    desc: 'Send automatic reminders and invoice follow-ups by SMS or WhatsApp. Clients can reply, and the whole conversation stays attached to their file. Delivery receipts and opt-out handling are automatic.',
  },
];

const headFragment = `
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="icon" href="/brand/favicon.ico" sizes="any" />
    <link rel="icon" type="image/png" sizes="32x32" href="/brand/favicon-32.png" />
    <link rel="apple-touch-icon" sizes="180x180" href="/brand/favicon-180.png" />
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
        tailwind.config = {
            theme: {
                extend: {
                    colors: {
                        brand: {
                            50: 'rgb(var(--brand-50) / <alpha-value>)',
                            100: 'rgb(var(--brand-100) / <alpha-value>)',
                            200: 'rgb(var(--brand-200) / <alpha-value>)',
                            300: 'rgb(var(--brand-300) / <alpha-value>)',
                            400: 'rgb(var(--brand-400) / <alpha-value>)',
                            500: 'rgb(var(--brand-500) / <alpha-value>)',
                            600: 'rgb(var(--brand-600) / <alpha-value>)',
                            700: 'rgb(var(--brand-700) / <alpha-value>)',
                            800: 'rgb(var(--brand-800) / <alpha-value>)',
                            900: 'rgb(var(--brand-900) / <alpha-value>)',
                            950: 'rgb(var(--brand-950) / <alpha-value>)',
                            dark: 'rgb(var(--brand-dark) / <alpha-value>)',
                            surface: 'rgb(var(--brand-surface) / <alpha-value>)'
                        },
                        accent: {
                            yellow: '#f8e327',
                            yellowHover: '#e5d119'
                        }
                    },
                    fontFamily: { sans: ['Inter', 'sans-serif'] }
                }
            }
        }
    </script>
    <style>
        :root {
            --brand-50: 246 251 254;
            --brand-100: 246 251 254;
            --brand-200: 242 249 253;
            --brand-300: 220 238 249;
            --brand-400: 194 225 245;
            --brand-500: 146 202 237;
            --brand-600: 111 185 231;
            --brand-700: 85 172 226;
            --brand-800: 59 159 222;
            --brand-900: 36 146 214;
            --brand-950: 31 125 183;
            --brand-dark: 27 110 161;
            --brand-surface: 242 249 253;
        }
        body { font-family: 'Inter', sans-serif; background: #fff; color: #1e1b26; overflow-x: hidden; }
        .hero-photo {
            background-image: linear-gradient(180deg, rgba(13, 46, 80, 0.92), rgba(27, 110, 161, 0.78)), url('/img/__IMG__');
            background-size: cover;
            background-position: center;
        }
    </style>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">`;

const chipsHtml = (current) =>
  '<div class="max-w-6xl mx-auto px-4 mt-14">' +
  '<h3 class="text-sm font-bold text-gray-900 mb-4 uppercase tracking-wider">Explore other modules</h3>' +
  '<div class="flex flex-wrap gap-2">' +
  features
    .filter((f) => f.slug !== current)
    .map(
      (f) =>
        `<a href="/features/${f.slug}" class="inline-flex items-center gap-2 text-xs bg-white border border-gray-200 hover:border-brand-400 text-gray-700 hover:text-brand-800 px-4 py-2 rounded-full font-semibold transition shadow-sm"><i class="${f.icon} text-brand-700"></i> ${f.label}</a>`
    )
    .join('\n        ') +
  '</div></div>';

const mobileMenuScript = `
    <script>
        document.getElementById('mobile-menu-btn')?.addEventListener('click', function () {
            document.getElementById('mobile-menu').classList.toggle('hidden');
        });
    </script>`;

const outDir = path.join(ROOT, 'public', 'features');
fs.mkdirSync(outDir, { recursive: true });

const panelKeyFor = {
  'client-records': 'clients',
  'medical-records': 'medical',
  appointments: 'appointments',
  vaccinations: 'vaccinations',
  inventory: 'inventory',
  reporting: 'reporting',
  messaging: 'messaging',
};

for (const f of features) {
  const panel = panels[panelKeyFor[f.slug]];
  const html = [
    '<!DOCTYPE html>',
    '<html lang="en" class="scroll-smooth">',
    '<head>',
    `    <title>${f.title} | PodVet</title>`,
    `    <meta name="description" content="${f.desc}">`,
    headFragment.replace('__IMG__', f.img),
    '</head>',
    '<body class="antialiased text-gray-900">',
    '',
    headerHtml,
    '',
    '    <!-- HERO -->',
    '    <section class="relative hero-photo pt-16 pb-20 text-white overflow-hidden">',
    '        <div class="max-w-4xl mx-auto px-4 text-center relative z-10">',
    '            <nav class="text-xs text-brand-200 mb-5 flex items-center justify-center gap-2">',
    '                <a href="/" class="hover:text-white">Home</a><span class="opacity-60">/</span><a href="/demo" class="hover:text-white">Live Demo</a><span class="opacity-60">/</span><span class="text-white font-semibold">' + f.label + '</span>',
    '            </nav>',
    '            <div class="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-brand-900/60 border border-brand-400/30 text-xs font-medium text-brand-200 mb-5">',
    `                <i class="${f.icon}"></i> ${f.label}`,
    '            </div>',
    `            <h1 class="text-4xl sm:text-5xl md:text-6xl font-extrabold tracking-tight leading-[1.1] mb-4">${f.title}</h1>`,
    `            <p class="max-w-2xl mx-auto text-base sm:text-lg text-brand-200 leading-relaxed mb-8">${f.tagline} ${f.desc}</p>`,
    '            <div class="flex flex-wrap justify-center gap-3">',
    '                <a href="/app" class="bg-accent-yellow hover:bg-accent-yellowHover text-brand-dark font-bold text-sm px-6 py-3 rounded-full transition-all duration-200 shadow-md transform hover:-translate-y-0.5 active:translate-y-0"><i class="fa-solid fa-arrow-right-to-bracket mr-2"></i>Try it in the live app</a>',
    '                <a href="/demo" class="bg-white/10 hover:bg-white/20 text-white border border-white/30 font-bold text-sm px-6 py-3 rounded-full transition-all duration-200"><i class="fa-solid fa-shapes mr-2"></i>View all modules</a>',
    '            </div>',
    '        </div>',
    '    </section>',
    '',
    '    <main class="py-12 bg-brand-surface">',
    `        <section class="max-w-6xl mx-auto px-4">${panel.trim()}</section>`,
    '        ',
    chipsHtml(f.slug),
    '    </main>',
    '',
    '    <section class="py-12 bg-brand-900">',
    '        <div class="max-w-4xl mx-auto px-4 text-center">',
    `            <h2 class="text-2xl sm:text-3xl font-extrabold text-white mb-3">Ready to put ${f.label} to work in your clinic?</h2>`,
    '            <p class="text-brand-200 text-sm sm:text-base mb-6">Join 400+ veterinarians who switched to PodVet.</p>',
    '            <div class="flex flex-wrap justify-center gap-3">',
    '                <a href="/signup" class="bg-accent-yellow hover:bg-accent-yellowHover text-brand-dark font-bold text-sm px-6 py-3 rounded-full transition-all duration-200 shadow-md transform hover:-translate-y-0.5 active:translate-y-0"><i class="fa-solid fa-rocket mr-2"></i>Start your free trial</a>',
    '                <a href="/contact" class="bg-white/10 hover:bg-white/20 text-white border border-white/30 font-bold text-sm px-6 py-3 rounded-full transition-all duration-200">Book a demo</a>',
    '            </div>',
    '        </div>',
    '    </section>',
    '',
    footerHtml,
    '',
    mobileMenuScript,
    '',
    '</body>',
    '</html>',
    ''
  ].join('\n');

  fs.writeFileSync(path.join(outDir, `${f.slug}.html`), html);
  console.log('wrote', path.relative(ROOT, path.join(outDir, `${f.slug}.html`)));
}