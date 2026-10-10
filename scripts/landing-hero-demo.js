// Interactive demo simulator of the real PodVet software (real sidebar +
        // real screenshots of every page). Click a menu item to switch screens.
        const DEMO_NAV = [
            { key: 'dashboard', label: 'Dashboard', icon: 'fa-gauge-high' },
            { key: 'appointments', label: 'Appointments', icon: 'fa-calendar-check' },
            { key: 'clients', label: 'Clients', icon: 'fa-user-group' },
            { key: 'records', label: 'Medical Records', icon: 'fa-notes-medical' },
            { key: 'patients', label: 'Patients', icon: 'fa-dog' },
            { key: 'boarding', label: 'Boarding', icon: 'fa-house-chimney-window' },
            { key: 'quick-bill', label: 'Quick Bill', icon: 'fa-bolt' },
            { key: 'employees', label: 'Employees', icon: 'fa-user-tie' },
            { key: 'services', label: 'Services', icon: 'fa-briefcase-medical' },
            { key: 'grooming', label: 'Grooming', icon: 'fa-scissors' },
            { key: 'inventory', label: 'Inventory', icon: 'fa-boxes-stacked' },
            { key: 'vendors', label: 'Vendors', icon: 'fa-handshake' },
            { key: 'expenses', label: 'Expenses', icon: 'fa-money-bill-wave' },
            { key: 'billing', label: 'Product Billing', icon: 'fa-file-invoice-dollar' },
            { key: 'payments', label: 'Payments', icon: 'fa-credit-card' },
            { key: 'coupons', label: 'Coupons', icon: 'fa-tags' },
            { key: 'forms', label: 'Forms', icon: 'fa-file-lines' },
            { key: 'reports', label: 'Reports', icon: 'fa-chart-line' },
            { key: 'referral', label: 'Referral', icon: 'fa-share-nodes', href: '/loyalty-card.html' },
            { key: 'settings', label: 'Settings', icon: 'fa-gear' },
        ];

        // Nav key -> screenshot file (route names differ from a couple of labels)
        const SCREEN_FILE = {
            expenses: 'daily-expense',
        };

        const PILL_TO_SCREEN = {
            records: 'records', calendar: 'appointments', invoices: 'payments', reminders: 'dashboard',
        };

        const DEMO_CAPTIONS = {
            dashboard: 'Dashboard - today\'s visits, revenue and reminders at a glance',
            appointments: 'Appointments - per-vet calendar, bookings and due vaccinations',
            clients: 'Clients - owners, contact details and their pets',
            records: 'Medical Records - SOAP exam notes, prescriptions and patient history',
            patients: 'Patients - every pet registered at the clinic',
            boarding: 'Boarding - cages, feeding and medication schedules',
            'quick-bill': 'Quick Bill - fast counter checkout for products and services',
            employees: 'Employees - vets, staff and their access roles',
            services: 'Services - the treatments and prices you offer',
            grooming: 'Grooming - grooming appointments and grooming team',
            inventory: 'Inventory - stock levels and profit per product',
            vendors: 'Vendors - products supplied, purchase price and settlements',
            expenses: 'Expenses - daily costs, categories and totals',
            billing: 'Product Billing - product invoices and sales',
            payments: 'Payments - settle appointments, products, expenses and quick bills',
            coupons: 'Coupons - discount codes and their usage',
            forms: 'Forms - consent and intake templates',
            reports: 'Reports - income, expense and profit analysis',
            referral: 'Referral - invite clinics and earn rewards',
            settings: 'Settings - clinic profile, branding and preferences',
        };

        function screenImage(key) {
            const item = DEMO_NAV.filter(function (n) { return n.key === key; })[0] || DEMO_NAV[0];
            const img = document.createElement('img');
            img.className = 'w-full h-auto';
            img.alt = 'PodVet ' + item.label + ' screenshot';
            img.onerror = function () {
                const d = document.createElement('div');
                d.className = 'p-10 text-center text-gray-400 text-xs';
                d.textContent = 'Preview unavailable';
                if (img.parentNode) img.parentNode.replaceChild(d, img);
            };
            img.src = '/landing/demo/' + (SCREEN_FILE[key] || key) + '.png';
            return img;
        }

        function buildSidebar() {
            const nav = document.getElementById('demo-sidebar');
            if (!nav) return;
            nav.innerHTML = DEMO_NAV.map(function (item) {
                const go = item.href
                    ? 'window.open(\'' + item.href + '\', \'_blank\'); showDemo(\'' + item.label + '\');'
                    : 'setScreen(\'' + item.key + '\'); return false;';
                return '<a href="#" onclick="' + go + '" data-screen="' + item.key + '" class="flex items-center gap-2.5 px-3 py-2 rounded-lg text-gray-600 hover:bg-gray-50"><i class="fa-solid ' + item.icon + ' w-4 text-teal-600"></i><span>' + item.label + '</span></a>';
            }).join('');
        }

        function setScreen(key) {
            const item = DEMO_NAV.filter(function (n) { return n.key === key; })[0] || DEMO_NAV[0];
            const container = document.getElementById('tab-content-container');
            if (container) {
                container.innerHTML = '';
                container.appendChild(screenImage(key));
            }
            const title = document.getElementById('demo-page-title');
            if (title) title.textContent = item.label;

            document.querySelectorAll('#demo-sidebar a').forEach(function (a) {
                const active = a.getAttribute('data-screen') === key;
                a.className = 'flex items-center gap-2.5 px-3 py-2 rounded-lg ' + (active
                    ? 'bg-teal-50 text-teal-600 font-semibold'
                    : 'text-gray-600 hover:bg-gray-50');
            });

            document.querySelectorAll('.hero-tab-btn').forEach(function (btn) {
                const pillKey = PILL_TO_SCREEN[btn.id.slice(4)] || '';
                const active = pillKey === key;
                btn.className = 'hero-tab-btn px-5 py-2.5 rounded-full text-xs sm:text-sm flex items-center gap-2 transition-all' + (active
                    ? ' font-semibold bg-brand-800/90 text-white border border-brand-400/50 shadow-md'
                    : ' font-medium bg-brand-950/60 text-brand-200 hover:text-white border border-brand-800/60 hover:border-brand-500');
            });

            const caption = document.getElementById('hero-caption');
            if (caption && DEMO_CAPTIONS[key]) caption.textContent = DEMO_CAPTIONS[key];
            showDemo(item.label);
        }

        function switchTab(tabKey) {
            setScreen(PILL_TO_SCREEN[tabKey] || tabKey);
        }

        buildSidebar();
        setScreen('dashboard');