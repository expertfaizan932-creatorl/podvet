#!/usr/bin/env node
// Generates public/solutions/*.html — one page per solution audience.
//
// Each page keeps the hero (the first main section) that leads the equivalent
// page on the market reference site: audience eyebrow, single-sentence promise
// as the H1, one supporting paragraph, primary CTA. Everything below the hero
// reuses the landing page's own section vocabulary so the two stay in sync.
//
// Run: node scripts/build-solutions-pages.js
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'public', 'solutions');

const SOLUTIONS = [
  {
    slug: 'veterinary-ai',
    nav: 'Veterinary AI',
    eyebrow: 'Veterinary AI',
    icon: 'fa-solid fa-wand-magic-sparkles',
    h1: 'Cut the time your team spends writing medical records',
    lead: 'Dictate your findings during the consultation and PodVet turns them into a structured SOAP note. You review the draft, then save it to the patient record.',
    cta: 'Try for Free',
    image: '/img/blog-vet-exam.jpg',
    alt: 'Veterinarian writing a patient record during an examination',
    stats: [
      { value: '40%', label: 'Faster medical records' },
      { value: 'SOAP', label: 'Automatic formatting from voice' },
      { value: '3 steps', label: 'From exam to saved record' },
    ],
    intro: 'PodVet uses AI to turn dictated notes into a structured medical record. It runs inside the visit you already have open, and the rest of the platform works as it does today.',
    sections: [
      { icon: 'fa-solid fa-microphone-lines', title: 'Examine and dictate', body: 'Open the visit and dictate the history, your findings and your plan while you work.' },
      { icon: 'fa-solid fa-list-check', title: 'PodVet structures the note', body: 'What you dictated is split into the SOAP sections, with vitals and physical examination findings placed in their own fields.' },
      { icon: 'fa-solid fa-pen-to-square', title: 'Review and edit', body: 'The draft opens in a review form. Correct anything that is wrong and add anything missing. Nothing has been saved to the patient yet.' },
      { icon: 'fa-solid fa-floppy-disk', title: 'Save it to the patient record', body: 'Once the note is right, save it and it becomes part of the patient history.' },
    ],
  },
  {
    slug: 'solo-practitioners',
    nav: 'Solo Practitioners',
    eyebrow: 'For Solo Veterinary Practitioners',
    icon: 'fa-solid fa-user-doctor',
    h1: 'Take your clinic to the next level',
    lead: 'Switch to cloud-based clinic management software that simplifies scheduling, grows your revenue, and lets you actually go home when the day ends.',
    cta: 'Try for Free',
    image: '/img/blog-vet-dachshund.jpg',
    alt: 'Veterinarian using a tablet while talking with a pet owner in the clinic',
    stats: [
      { value: '4 channels', label: 'SMS, WhatsApp, email, and push' },
      { value: 'Automatic', label: 'Vaccine and appointment reminders' },
      { value: 'One click', label: 'From exam to invoice' },
    ],
    intro: 'PodVet brings online scheduling, medical records, billing, and more together in one place. It shortens onboarding, centralizes your data, and keeps your day in flow from start to finish.',
    sections: [
      { icon: 'fa-solid fa-calendar-check', title: 'Everything to power your clinic, on one platform', body: 'Online scheduling, medical records, vaccinations, billing and inventory in a single system. No server to maintain, no files to lose.' },
      { icon: 'fa-solid fa-bell', title: 'Bring your clients back', body: 'Fast check-in, personalized reminders, automatic visit summaries, and integrated billing make every visit smooth. Your clients stop forgetting appointments and keep coming back.' },
      { icon: 'fa-solid fa-receipt', title: "Grow your clinic's revenue", body: 'PodVet automatically adds every service you provide across exams, surgery, lab, and retail to the invoice. You get paid in full for your work, without extra admin load.' },
      { icon: 'fa-solid fa-chart-line', title: 'Run your business by the numbers', body: 'Real-time reports on finance, operations, inventory, and performance. Which service earns the most, which product sits on the shelf, what is in the till at day’s end — on one screen.' },
      { icon: 'fa-solid fa-cloud', title: 'Access from anywhere, your data always safe', body: 'PodVet lives in the cloud, so it comes with you. Your data is backed up automatically every day; even if your computer breaks, you pick up right where you left off.' },
    ],
  },
  {
    slug: 'midsized-clinics',
    nav: 'Midsized Clinics',
    eyebrow: 'For Small & Midsized Clinics',
    icon: 'fa-solid fa-hospital',
    h1: 'Keep your team in sync as your clinic grows',
    lead: 'Bring your entire clinic operation and your team together on one platform — from scheduling to treatment, from inventory to reporting. As you grow, gain order instead of chaos.',
    cta: 'Try for Free',
    image: '/img/blog-beagle.jpg',
    alt: 'Team working at the reception and exam area of a small veterinary clinic',
    stats: [
      { value: 'Role-based', label: 'Separate permissions per role' },
      { value: 'Live', label: 'Every action instantly on all screens' },
      { value: 'Per vet', label: 'Separate appointment calendars' },
    ],
    intro: 'More vets, staff, appointments, and patients mean more coordination. PodVet brings your team, appointments, medical records, inventory, billing, and reports together on one platform.',
    sections: [
      { icon: 'fa-solid fa-user-gear', title: 'Organize your team, run the clinic with data', body: 'Define different permissions for veterinarians, technicians, and front-desk staff. Everyone logs in at the same time, and every action appears instantly on other screens.' },
      { icon: 'fa-solid fa-calendar-days', title: "Each vet's own calendar, full visibility for the front desk", body: 'Let each vet manage their own appointment calendar; front-desk staff and vets see the same day on the same screen. On busy days, who is available and who is next is clear at a glance.' },
      { icon: 'fa-solid fa-notes-medical', title: 'Keep treatment history tidy for the whole team', body: 'Exam notes, treatments, SOAP records, and follow-up plans are gathered in one place. Whichever vet sees the patient, they grasp the history at a glance.' },
      { icon: 'fa-solid fa-boxes-stacked', title: 'Keep inventory and stock under team control', body: 'Track the stock of food, medicine, and all products in real time. Stock is deducted automatically with every sale and treatment, and you are alerted at the minimum level.' },
      { icon: 'fa-solid fa-comment-sms', title: "Don't lose the bond with your clients", body: 'Reach clients on every channel via SMS, WhatsApp, email, and mobile notifications. Send automatic vaccine and appointment reminders, or deliver campaigns to selected groups in bulk.' },
      { icon: 'fa-solid fa-wand-magic-sparkles', title: 'Write less and treat more with AI', body: 'Record by speaking with voice dictation, and let AI turn it into SOAP format automatically. Your team focuses on the patient, not on a paperwork marathon.' },
    ],
  },
  {
    slug: 'animal-hospitals',
    nav: 'Hospitals',
    eyebrow: 'For Animal Hospitals',
    icon: 'fa-solid fa-tower-broadcast',
    h1: 'Run your large clinic from one center, in flawless order',
    lead: 'Bring the entire operation of your multi-unit hospital together on one platform — from the Flowboard to financial reports, from inventory and accounts to staff shifts. Prevent chaos, institutionalize order.',
    cta: 'Try for Free',
    image: '/img/about-dogs-running.jpg',
    alt: 'Large veterinary team working across different units of an animal hospital',
    stats: [
      { value: 'Live', label: 'Real-time status of all patients' },
      { value: 'Per unit', label: 'Exam, surgery, and hospitalization' },
      { value: 'One file', label: 'Labs, imaging, and notes together' },
    ],
    intro: 'Many vets, technicians, and front-desk staff, hundreds of patients, and simultaneous transactions. PodVet brings all this activity into one center, running every unit with the same live information, in the same order.',
    sections: [
      { icon: 'fa-solid fa-table-columns', title: 'With the Flowboard, instantly see which patient is where', body: 'Track live from one screen which unit, which vet, and which stage of treatment every patient in the hospital is at. Waiting, in-treatment, and to-be-discharged patients are separated; no patient is missed.' },
      { icon: 'fa-solid fa-folder-open', title: 'The whole team easily accesses all medical records and treatments', body: 'Even when shifts change or a patient is handed off to another vet, the treatment process continues without interruption. Exam notes, lab results, imaging, SOAP records, and treatment plans come together in one patient file.' },
      { icon: 'fa-solid fa-comments', title: 'Maximum, recorded communication with your clients', body: 'Reach clients on every channel via SMS, WhatsApp, email, and mobile notifications; the entire correspondence history is stored in the patient file. What was discussed with which client is always recorded.' },
      { icon: 'fa-solid fa-warehouse', title: 'Manage stock, inventory, and accounts from one hand', body: 'Track medicine, consumables, and product stock in real time; let stock be deducted automatically with each use, and get an alert at critical levels. See supplier and client accounts and the receivables-payables balance on one screen.' },
      { icon: 'fa-solid fa-chart-pie', title: "Run your hospital's profitability by the numbers", body: 'See revenue-expense and profitability analysis by unit, vet, and service on one panel. Keep the receivables-payables balance, daily cash flow, top-earning services, and idle capacity clear.' },
      { icon: 'fa-solid fa-users-gear', title: 'Put your staff and shift system in order', body: 'Define role-based permissions for vets, technicians, and front-desk staff; manage shift and on-call plans from one calendar. Who works which shift, who is available, whose task is what — it is all clear.' },
    ],
  },
  {
    slug: 'mobile-vets',
    nav: 'Mobile Veterinarians',
    eyebrow: 'For Mobile Veterinarians',
    icon: 'fa-solid fa-van-shuttle',
    h1: 'Your clinic in your pocket, coming with you to every address',
    lead: 'With or without an office; while serving at homes and in the field, reach patient history, appointments, notes, invoices, and client communication from your phone or tablet. Wherever your work goes, your software is there too.',
    cta: 'Try for Free',
    image: '/img/blog-dog-beach.jpg',
    alt: 'Mobile veterinarian getting ready with a tablet for a home visit',
    stats: [
      { value: 'Any device', label: 'Phone, tablet, and computer' },
      { value: 'Instant', label: 'On-site SOAP note and record' },
      { value: 'One click', label: 'From visit to invoice' },
    ],
    intro: 'Mobile veterinary practice does not happen at a single clinic desk. You prepare before a visit, reach patient history during the exam, and complete notes, invoices, and reminders afterwards. PodVet fits this whole flow into your phone and tablet.',
    sections: [
      { icon: 'fa-solid fa-mobile-screen', title: 'Work from anywhere with your phone and tablet', body: 'PodVet lives in the cloud, so you log in to the same system from anywhere with internet. The interface is built for mobile, so appointments, the patient card, and notes stay usable on a small screen. No installation, server, or fixed desk.' },
      { icon: 'fa-solid fa-clipboard-list', title: 'See patient history at the visit, save before you leave', body: 'Before you knock on the door, have the client info, patient profile, previous exams, and vaccine history at your fingertips. Complete notes while the details are fresh, so nothing is left for the evening.' },
      { icon: 'fa-solid fa-comment-sms', title: 'Stay connected with your clients around every visit', body: 'Send appointment and vaccine reminders automatically, and deliver post-visit follow-up messages. All communication stays linked to the patient card, so you recall what you discussed with which client at a glance.' },
      { icon: 'fa-solid fa-receipt', title: 'Invoice on-site the moment the visit ends', body: 'Create an invoice from the services, products, and treatments you provided with a single click; take payment on the spot, and see collection and client balance instantly.' },
      { icon: 'fa-solid fa-syringe', title: "Don't let preventive care slip between visits", body: 'Track completed, upcoming, and overdue vaccinations for each patient. Let SMS and WhatsApp reminders go out automatically before important dates.' },
      { icon: 'fa-solid fa-wand-magic-sparkles', title: 'Fast records with AI, even in the car', body: 'Take notes by speaking with voice dictation, and let AI turn them into SOAP format automatically. As you move to the next address, discharge summaries are ready.' },
    ],
  },
  {
    slug: 'data-migration',
    nav: 'Data Migration',
    eyebrow: 'Data Migration',
    icon: 'fa-solid fa-arrow-right-arrow-left',
    h1: 'Move all your data to PodVet — for free',
    lead: 'From patient records and vaccination history to client balances and stock, we transfer everything for you. Our team manages the whole process, with no extra charge.',
    cta: 'Contact us',
    image: '/img/blog-corgi.jpg',
    alt: 'Veterinary patient record being transferred to a new system',
    stats: [
      { value: 'Free', label: 'No charge on any plan' },
      { value: 'Any software', label: 'Migrate from your current system' },
      { value: 'End-to-end', label: 'We handle the entire transfer' },
    ],
    intro: 'When you move to PodVet from another clinic software, we bring all of your data across without losing a thing. Our team handles the migration from start to finish, so you can stay focused on your clinic.',
    sections: [
      { icon: 'fa-solid fa-file-export', title: '01 — Share your current data', body: 'Send us the export files or the access details from the software you are using today.' },
      { icon: 'fa-solid fa-magnifying-glass-chart', title: '02 — We analyze the data', body: 'Our team reviews your data, plans the field mapping, and prepares everything for the transfer.' },
      { icon: 'fa-solid fa-right-left', title: '03 — We run the migration', body: 'We move your patient records, client balances, vaccination history, and stock data into PodVet without gaps.' },
      { icon: 'fa-solid fa-circle-check', title: '04 — We verify and hand over', body: 'We check the migrated data together; once everything is accurate and complete, your clinic is ready to go.' },
    ],
  },
];

const SOLUTION_LINKS = SOLUTIONS.map(
  (s) => `<a href="/solutions/${s.slug}" class="block px-3 py-2 text-xs text-brand-200 hover:bg-brand-800/50 hover:text-white rounded-lg">${s.nav}</a>`,
).join('\n                                ');

const OTHER_LINKS = SOLUTIONS.map(
  (s) => `<a href="/solutions/${s.slug}" class="inline-flex items-center gap-2 text-xs bg-white border border-gray-200 hover:border-brand-400 text-gray-700 hover:text-brand-800 px-4 py-2 rounded-full font-semibold transition shadow-sm"><i class="${s.icon} text-brand-700"></i> ${s.nav}</a>`,
).join('\n        ');

function page({ nav, eyebrow, icon, h1, lead, cta, image, alt, stats, intro, sections }) {
  const ctaHref = cta === 'Contact us' ? '/contact' : '/signup';

  return `<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
    <title>${nav} | PodVet</title>
    <meta name="description" content="${lead.replace(/"/g, '&quot;')}">

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
            background-image: linear-gradient(180deg, rgba(13, 46, 80, 0.92), rgba(27, 110, 161, 0.78)), url('${image}');
            background-size: cover;
            background-position: center;
        }
    </style>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
</head>
<body class="antialiased text-gray-900">

<header class="sticky top-0 z-50 bg-brand-900 border-b border-brand-900/40 backdrop-blur-md">
        <div class="max-w-7xl mx-auto pr-4 sm:pr-6 lg:pr-8 pl-2 sm:pl-4 lg:pl-6">
            <div class="flex items-center justify-between h-20">

                <!-- Logo -->
                <div class="flex items-center space-x-3">
                    <a href="/" class="flex items-center group">
                        <img src="/brand/logo-reversed.png" alt="PodVet logo" class="h-10 w-auto object-contain group-hover:opacity-90 transition-opacity">
                    </a>

                    <!-- Nav Links -->
                    <nav class="hidden md:flex items-center space-x-8 ml-16 text-sm font-medium text-brand-200">
                        <div class="relative group cursor-pointer py-2">
                            <span class="hover:text-white transition flex items-center gap-1">
                                Solutions <i class="fa-solid fa-chevron-down text-[10px] opacity-70 group-hover:rotate-180 transition-transform"></i>
                            </span>
                            <div class="absolute left-0 top-full hidden group-hover:block w-52 bg-brand-900 border border-brand-800/80 rounded-xl shadow-2xl p-2 z-50">
                                ${SOLUTION_LINKS}
                            </div>
                        </div>
                        <a href="/#features" class="hover:text-white transition">Features</a>
                        <a href="/#pricing" class="hover:text-white transition">Pricing</a>
                        <a href="/blog" class="hover:text-white transition">Blog</a>
                        <a href="/faq" class="hover:text-white transition">FAQ</a>
                        <a href="/contact" class="hover:text-white transition">Contact</a>
                    </nav>
                </div>

                <!-- Right Actions -->
                <div class="flex items-center space-x-5">
                    <a href="/app" class="text-white hover:text-brand-200 text-sm font-semibold transition px-2">Log In</a>
                    <a href="/signup" class="bg-accent-yellow hover:bg-accent-yellowHover text-brand-dark font-bold text-xs sm:text-sm px-5 py-2.5 rounded-full transition-all duration-200 shadow-md transform hover:-translate-y-0.5 active:translate-y-0">Try for Free</a>

                    <!-- Mobile Hamburger -->
                    <button id="mobile-menu-btn" class="md:hidden text-brand-200 text-xl focus:outline-none">
                        <i class="fa-solid fa-bars"></i>
                    </button>
                </div>
            </div>
        </div>

        <!-- Mobile Menu Container -->
        <div id="mobile-menu" class="hidden md:hidden bg-brand-950 px-6 py-4 space-y-3 border-b border-brand-800/50">
            <a href="/" class="block text-brand-200 hover:text-white text-sm">Home</a>
            ${SOLUTIONS.map((s) => `<a href="/solutions/${s.slug}" class="block text-brand-200 hover:text-white text-sm">${s.nav}</a>`).join('\n            ')}
            <a href="/#features" class="block text-brand-200 hover:text-white text-sm">Features</a>
            <a href="/#pricing" class="block text-brand-200 hover:text-white text-sm">Pricing</a>
            <a href="/blog" class="block text-brand-200 hover:text-white text-sm">Blog</a>
            <a href="/faq" class="block text-brand-200 hover:text-white text-sm">FAQ</a>
            <a href="/contact" class="block text-brand-200 hover:text-white text-sm">Contact</a>
        </div>
    </header>

    <!-- HERO — the first main section: audience, promise, supporting line, CTA -->
    <section class="relative hero-photo pt-16 pb-20 text-white overflow-hidden">
        <div class="max-w-4xl mx-auto px-4 text-center relative z-10">
            <nav class="text-xs text-brand-200 mb-5 flex items-center justify-center gap-2">
                <a href="/" class="hover:text-white">Home</a><span class="opacity-60">/</span><span class="text-white font-semibold">${nav}</span>
            </nav>
            <div class="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-brand-900/60 border border-brand-400/30 text-xs font-medium text-brand-200 mb-5">
                <i class="${icon}"></i> ${eyebrow}
            </div>
            <h1 class="text-4xl sm:text-5xl md:text-6xl font-extrabold tracking-tight leading-[1.1] mb-4">${h1}</h1>
            <p class="max-w-2xl mx-auto text-base sm:text-lg text-brand-200 leading-relaxed mb-8">${lead}</p>
            <div class="flex flex-wrap justify-center gap-3">
                <a href="${ctaHref}" class="bg-accent-yellow hover:bg-accent-yellowHover text-brand-dark font-bold text-sm px-6 py-3 rounded-full transition-all duration-200 shadow-md transform hover:-translate-y-0.5 active:translate-y-0"><i class="fa-solid fa-rocket mr-2"></i>${cta}</a>
                <a href="/demo" class="bg-white/10 hover:bg-white/20 text-white border border-white/30 font-bold text-sm px-6 py-3 rounded-full transition-all duration-200"><i class="fa-solid fa-shapes mr-2"></i>View all modules</a>
            </div>
        </div>
    </section>

    <main class="py-12 bg-brand-surface">

        <!-- Opening statement -->
        <section class="max-w-3xl mx-auto px-4 text-center mb-14">
            <p class="text-lg sm:text-xl text-gray-700 leading-relaxed">${intro}</p>
        </section>

        <!-- Stats row -->
        <section class="max-w-6xl mx-auto px-4 mb-14">
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
                ${stats.map((s) => `<div class="bg-white rounded-2xl border border-gray-200 p-6 text-center">
                    <p class="text-3xl font-extrabold text-brand-900 mb-1">${s.value}</p>
                    <p class="text-sm text-gray-600">${s.label}</p>
                </div>`).join('\n                ')}
            </div>
        </section>

        <!-- Sections -->
        <section class="max-w-6xl mx-auto px-4 space-y-8">
            ${sections.map((s) => `<div class="bg-white rounded-2xl border border-gray-200 p-6 sm:p-8 shadow-sm">
                <div class="flex items-start gap-4">
                    <span class="shrink-0 w-11 h-11 rounded-xl bg-brand-100 text-brand-800 flex items-center justify-center text-lg"><i class="${s.icon}"></i></span>
                    <div>
                        <h2 class="text-lg sm:text-xl font-extrabold text-gray-900 mb-2">${s.title}</h2>
                        <p class="text-sm sm:text-base text-gray-600 leading-relaxed">${s.body}</p>
                    </div>
                </div>
            </div>`).join('\n            ')}
        </section>

        <!-- Other solutions -->
        <div class="max-w-6xl mx-auto px-4 mt-14"><h3 class="text-sm font-bold text-gray-900 mb-4 uppercase tracking-wider">Explore other solutions</h3><div class="flex flex-wrap gap-2">
        ${OTHER_LINKS}</div></div>
    </main>

    <section class="py-12 bg-brand-900">
        <div class="max-w-4xl mx-auto px-4 text-center">
            <h2 class="text-2xl sm:text-3xl font-extrabold text-white mb-3">Ready to put PodVet to work in your clinic?</h2>
            <p class="text-brand-200 text-sm sm:text-base mb-6">Join 400+ veterinarians who switched to PodVet.</p>
            <div class="flex flex-wrap justify-center gap-3">
                <a href="/signup" class="bg-accent-yellow hover:bg-accent-yellowHover text-brand-dark font-bold text-sm px-6 py-3 rounded-full transition-all duration-200 shadow-md transform hover:-translate-y-0.5 active:translate-y-0"><i class="fa-solid fa-rocket mr-2"></i>Start your free trial</a>
                <a href="/contact" class="bg-white/10 hover:bg-white/20 text-white border border-white/30 font-bold text-sm px-6 py-3 rounded-full transition-all duration-200">Book a demo</a>
            </div>
        </div>
    </section>

<footer class="bg-brand-950 text-brand-200">
        <div class="max-w-6xl mx-auto px-4 py-12">
            <div class="flex flex-col sm:flex-row justify-between gap-6 mb-8">
                <div class="max-w-sm">
                    <img src="/brand/logo-reversed.png" alt="PodVet" class="h-9 w-auto object-contain mb-3">
                    <p class="text-xs leading-relaxed text-brand-200/70">AI-driven veterinary clinic management &mdash; appointments, records, invoicing and reminders in one place.</p>
                </div>
                <div class="text-xs space-y-2">
                    <a href="/" class="block hover:text-white transition">Home</a>
                    <a href="/#pricing" class="block hover:text-white transition">Pricing</a>
                    <a href="/about" class="block hover:text-white transition">About</a>
                    <a href="/contact" class="block hover:text-white transition">Contact</a>
                </div>
                <div class="text-xs space-y-2">
                    <a href="/blog" class="block hover:text-white transition">Blog</a>
                    <a href="/docs" class="block hover:text-white transition">Documentation</a>
                    <a href="/help" class="block hover:text-white transition">Help Center</a>
                    <a href="/faq" class="block hover:text-white transition">FAQ</a>
                    <a href="/privacy" class="block hover:text-white transition">Privacy</a>
                    <a href="/terms" class="block hover:text-white transition">Terms</a>
                </div>
            </div>
            <div class="pt-8 text-xs text-brand-200/60 text-center sm:text-left flex flex-col sm:flex-row justify-between items-center gap-4 border-t border-brand-800/50">
                <p>Copyright &copy; 2018&ndash;2026 PodVet. All rights reserved.</p>
                <a href="/app" class="hover:text-white transition">Open the live app <i class="fa-solid fa-arrow-up-right-from-square ml-1"></i></a>
            </div>
        </div>
    </footer>

    <script>
        document.getElementById('mobile-menu-btn')?.addEventListener('click', function () {
            document.getElementById('mobile-menu').classList.toggle('hidden');
        });
    </script>

</body>
</html>
`;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const s of SOLUTIONS) {
  fs.writeFileSync(path.join(OUT_DIR, `${s.slug}.html`), page(s), 'utf8');
  console.log(`built /solutions/${s.slug}`);
}
console.log(`\n${SOLUTIONS.length} solution pages written to public/solutions/`);