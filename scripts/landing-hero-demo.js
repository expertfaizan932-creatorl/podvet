        // Interactive demo simulator of the real PodVet software (sidebar + pages).
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
            { key: 'referral', label: 'Referral', icon: 'fa-share-nodes' },
            { key: 'settings', label: 'Settings', icon: 'fa-gear' },
        ];

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

        function chip(text, cls) {
            return '<span class="inline-flex items-center text-[10px] font-semibold px-2 py-0.5 rounded-full ' + cls + '">' + text + '</span>';
        }
        const C_PAID = 'bg-emerald-100 text-emerald-700';
        const C_UNPAID = 'bg-amber-100 text-amber-700';
        const C_INFO = 'bg-teal-50 text-teal-700';
        const C_GREY = 'bg-gray-100 text-gray-500';
        const C_RED = 'bg-red-100 text-red-700';

        function pageHead(title, sub) {
            return '<div class="pb-3 mb-4 border-b border-gray-200 flex items-center justify-between gap-2">'
                + '<div><h3 class="text-base font-bold text-gray-900">' + title + '</h3>'
                + (sub ? '<p class="text-[11px] text-gray-500">' + sub + '</p>' : '') + '</div>'
                + '<button class="text-[11px] font-semibold bg-teal-600 text-white px-3 py-1.5 rounded-md whitespace-nowrap"><i class="fa-solid fa-plus mr-1"></i>New</button>'
                + '</div>';
        }
        function statCard(label, value, foot, footCls) {
            return '<div class="bg-white border border-gray-200 rounded-xl p-3 shadow-sm">'
                + '<span class="text-gray-400 block text-[10px]">' + label + '</span>'
                + '<span class="text-xl font-extrabold text-gray-900">' + value + '</span>'
                + (foot ? '<span class="block text-[10px] ' + (footCls || 'text-gray-400') + '">' + foot + '</span>' : '')
                + '</div>';
        }
        function bars(heights, cls) {
            return heights.map(function (h) { return '<div class="' + (cls || 'bg-teal-200') + ' rounded-t" style="height:' + h + '%"></div>'; }).join('');
        }
        function tableCard(headers, rows) {
            var th = headers.map(function (h) { return '<th class="text-left font-semibold text-gray-500 px-3 py-2 whitespace-nowrap">' + h + '</th>'; }).join('');
            var body = rows.map(function (r) {
                return '<tr class="border-t border-gray-100">' + r.map(function (c) { return '<td class="px-3 py-2 text-gray-700">' + c + '</td>'; }).join('') + '</tr>';
            }).join('');
            return '<div class="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden overflow-x-auto">'
                + '<table class="w-full text-[11px]"><thead class="bg-gray-50"><tr>' + th + '</tr></thead><tbody>' + body + '</tbody></table></div>';
        }
        function listCard(items) {
            return '<div class="bg-white border border-gray-200 rounded-xl shadow-sm divide-y divide-gray-100 text-[11px]">'
                + items.map(function (it) { return '<div class="flex items-center justify-between px-3 py-2.5 gap-3">' + it + '</div>'; }).join('')
                + '</div>';
        }

        const DEMO_PAGES = {
            dashboard:
                '<div class="flex items-center justify-between pb-3 mb-4 border-b border-gray-200">'
                + '<div><h3 class="text-base font-bold text-gray-900">Good morning, Rehan</h3><p class="text-[11px] text-gray-500">Wednesday, October 8 2026 &middot; Main Clinic</p></div>'
                + chip('Clinic on track', 'bg-teal-50 text-teal-700') + '</div>'
                + '<div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">'
                + statCard("Today's Appointments", '14', '3 pending', 'text-amber-600')
                + statCard('Revenue Today', 'Rs 42,500', '+12% vs yesterday', 'text-emerald-600')
                + statCard('Patients', '318', '24 new this week')
                + statCard('Boarding Pets', '4', '1 due checkout', 'text-teal-600')
                + '</div>'
                + '<div class="bg-white border border-gray-200 rounded-xl p-3 shadow-sm mb-4">'
                + '<div class="flex items-center justify-between mb-2"><span class="text-[11px] font-semibold text-gray-700">Daily income - last 10 days</span><span class="text-[10px] text-gray-400">Rs 3,12,400 this month</span></div>'
                + '<div class="grid grid-cols-10 gap-1.5 items-end h-24">' + bars([35, 50, 40, 65, 45, 70, 60, 80, 72, 95]) + '</div></div>'
                + '<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">'
                + '<div><p class="text-[11px] font-semibold text-gray-700 mb-2">Today\'s appointments</p>'
                + listCard([
                    '<div class="min-w-0"><span class="font-semibold text-gray-800">Leo</span> <span class="text-gray-400">Golden Retriever</span><div class="text-[10px] text-gray-500">09:00 &middot; Dr. Eli Vile</div></div>' + chip('Confirmed', C_PAID),
                    '<div class="min-w-0"><span class="font-semibold text-gray-800">Mia</span> <span class="text-gray-400">Siamese</span><div class="text-[10px] text-gray-500">10:30 &middot; Dr. Eli Vile</div></div>' + chip('Unpaid', C_UNPAID),
                    '<div class="min-w-0"><span class="font-semibold text-gray-800">Bella</span> <span class="text-gray-400">Poodle</span><div class="text-[10px] text-gray-500">15:00 &middot; Dr. Noor</div></div>' + chip('Grooming', C_INFO),
                ]) + '</div>'
                + '<div><p class="text-[11px] font-semibold text-gray-700 mb-2">Reminders due</p>'
                + listCard([
                    '<div class="min-w-0"><span class="font-semibold text-gray-800">Rabies booster</span><div class="text-[10px] text-gray-500">Leo &middot; owner Adam Jansone</div></div>' + chip('Due today', C_UNPAID),
                    '<div class="min-w-0"><span class="font-semibold text-gray-800">Deworming</span><div class="text-[10px] text-gray-500">Bella &middot; due in 3 days</div></div>' + chip('Upcoming', C_INFO),
                    '<div class="min-w-0"><span class="font-semibold text-gray-800">Invoice INV-1041</span><div class="text-[10px] text-gray-500">Rs 2,950 unpaid</div></div>' + chip('Overdue', C_RED),
                ]) + '</div>'
                + '</div>',

            appointments:
                pageHead('Appointments', 'Per-vet calendar, bookings and due vaccinations')
                + '<div class="grid grid-cols-7 gap-1.5 mb-4 text-center text-[10px]">'
                + ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(function (d) {
                    return '<div class="rounded py-1.5 font-semibold ' + (d === 'Thu' ? 'bg-teal-600 text-white shadow' : 'bg-slate-100 text-gray-500') + '">' + d + '</div>';
                }).join('')
                + '<div class="border border-gray-200 rounded-lg py-3 bg-white text-center text-gray-500">15</div>'
                + '<div class="border border-gray-200 rounded-lg py-3 bg-white text-center text-gray-500">16</div>'
                + '<div class="border border-gray-200 rounded-lg py-3 bg-white text-center text-gray-500">17</div>'
                + '<div class="border border-teal-300 rounded-lg py-3 bg-teal-50 text-center font-bold text-teal-800 shadow-sm">18<div class="text-[9px] font-medium text-teal-600">5 book</div></div>'
                + '<div class="border border-gray-200 rounded-lg py-3 bg-white text-center text-gray-500">19</div>'
                + '<div class="border border-gray-200 rounded-lg py-3 bg-white text-center text-gray-500">20</div>'
                + '<div class="border border-gray-200 rounded-lg py-3 bg-white text-center text-gray-500">21</div>'
                + '</div>'
                + tableCard(['Time', 'Patient', 'Owner', 'Vet', 'Type', 'Status'], [
                    ['09:00', 'Leo (Golden Retriever)', 'Adam Jansone', 'Dr. Eli Vile', 'OPD', chip('Confirmed', C_PAID)],
                    ['10:30', 'Mia (Siamese)', 'Sara Khan', 'Dr. Eli Vile', 'Vaccination', chip('Unpaid', C_UNPAID)],
                    ['11:15', 'Rocky (Labrador)', 'Bilal Ahmed', 'Dr. Noor', 'Preventive', chip('Confirmed', C_PAID)],
                    ['15:00', 'Bella (Poodle)', 'Hina Ali', 'Dr. Noor', 'Grooming', chip('Pending', C_GREY)],
                ]),

            clients:
                pageHead('Clients', 'Owners, contact details and their pets')
                + tableCard(['Client Name', 'Pets', 'Contact', 'Last Visit'], [
                    ['Adam Jansone', 'Leo, Mia', '+92 300 0000000', 'Oct 6 2026'],
                    ['Sara Khan', 'Bella', '+92 301 1111111', 'Oct 4 2026'],
                    ['Bilal Ahmed', 'Rocky', '+92 302 2222222', 'Sep 28 2026'],
                    ['Hina Ali', 'Coco', '+92 303 3333333', 'Sep 21 2026'],
                ]),

            records:
                pageHead('Medical Records', 'SOAP exam notes, prescriptions and patient history')
                + '<div class="bg-white border border-gray-200 rounded-xl p-4 shadow-sm space-y-3 text-[11px]">'
                + '<div class="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-slate-50 p-3 rounded-lg">'
                + '<div><span class="text-gray-400 block text-[10px]">Date</span><span class="font-semibold text-gray-800">Jun 20 2026 13:30</span></div>'
                + '<div><span class="text-gray-400 block text-[10px]">Reasons</span><span class="flex gap-1">' + chip('Loss of appetite', C_INFO) + chip('Lethargy', C_INFO) + '</span></div>'
                + '<div><span class="text-gray-400 block text-[10px]">Veterinarian</span><span class="font-semibold text-gray-800">Dr. Eli Vile</span></div>'
                + '<div><span class="text-gray-400 block text-[10px]">Patient</span><span class="font-semibold text-gray-800">Leo (Golden Retriever)</span></div>'
                + '</div>'
                + '<div class="space-y-2">'
                + '<div><h4 class="font-bold text-gray-900"><i class="fa-solid fa-stethoscope text-teal-600 mr-1"></i>Chief Complaint</h4><p class="text-gray-600">Loss of appetite and lethargy for about 2 days, with mild vomiting since last night.</p></div>'
                + '<div><h4 class="font-bold text-gray-900">Clinical Findings</h4><p class="text-gray-600">Mucous membrane color normal, CRT 2 sec. Mild dehydration signs present.</p></div>'
                + '<div><h4 class="font-bold text-gray-900">Assessment &amp; Diagnosis</h4><p class="text-gray-600">Suspected acute gastroenteritis.</p></div>'
                + '<div class="p-3 bg-teal-50/60 rounded-lg border border-teal-100"><h4 class="font-bold text-gray-900">Treatment Plan &amp; Prescriptions</h4><ul class="list-disc list-inside text-gray-700 space-y-0.5"><li>Withhold food for 24 hours.</li><li>Maropitant 10mg/ml injection S.C.</li><li>Gastrointestinal diet food for 5 days.</li></ul></div>'
                + '</div></div>',

            patients:
                pageHead('Patients', 'Every pet registered at the clinic')
                + tableCard(['Pet', 'Owner', 'Species / Breed', 'Age', 'Sex'], [
                    ['Leo', 'Adam Jansone', 'Dog / Golden Retriever', '3 yrs', 'Male'],
                    ['Mia', 'Adam Jansone', 'Cat / Siamese', '2 yrs', 'Female'],
                    ['Bella', 'Sara Khan', 'Dog / Poodle', '4 yrs', 'Female'],
                    ['Rocky', 'Bilal Ahmed', 'Dog / Labrador', '5 yrs', 'Male'],
                ]),

            boarding:
                pageHead('Boarding', 'Cages, feeding and medication schedules')
                + '<div class="grid grid-cols-1 sm:grid-cols-3 gap-3 text-[11px]">'
                + ['A-01|Leo|Golden Retriever|In: Oct 6|Out: Oct 10|Checked in', 'B-04|Bella|Poodle|In: Oct 7|Out: Oct 9|Feeding due', 'C-02|Rocky|Labrador|In: Oct 8|Out: Oct 12|Checked in'].map(function (row) {
                    var p = row.split('|');
                    return '<div class="bg-white border border-gray-200 rounded-xl p-3 shadow-sm"><div class="font-bold text-gray-700 flex items-center justify-between">Cage ' + p[0] + chip(p[5], C_INFO) + '</div><div class="mt-1"><span class="font-semibold text-gray-800">' + p[1] + '</span> <span class="text-gray-400">' + p[2] + '</span></div><div class="text-[10px] text-gray-500 mt-0.5">' + p[3] + ' &middot; ' + p[4] + '</div></div>';
                }).join('')
                + '</div>',

            'quick-bill':
                pageHead('Quick Bill', 'Fast counter checkout for products and services')
                + listCard([
                    '<div class="min-w-0"><span class="font-semibold text-gray-800">Maropitant 10mg/ml</span><div class="text-[10px] text-gray-500">Medicine &times; 1</div></div><span class="font-bold text-gray-900">Rs 850</span>',
                    '<div class="min-w-0"><span class="font-semibold text-gray-800">Gastro diet food 2kg</span><div class="text-[10px] text-gray-500">Food &times; 2</div></div><span class="font-bold text-gray-900">Rs 3,400</span>',
                    '<div class="min-w-0"><span class="font-semibold text-gray-800">Rabies vaccine</span><div class="text-[10px] text-gray-500">Vaccine &times; 1</div></div><span class="font-bold text-gray-900">Rs 1,200</span>',
                ])
                + '<div class="bg-teal-50 border border-teal-100 rounded-xl p-3 text-[11px] mt-3 flex items-center justify-between"><span class="font-semibold text-teal-900">Total</span><span class="font-extrabold text-teal-900 text-base">Rs 5,450</span></div>'
                + '<div class="flex gap-2 mt-3"><button class="flex-1 bg-teal-600 text-white text-[11px] font-semibold py-2 rounded-lg">Pay by Cash</button><button class="flex-1 bg-gray-100 text-gray-700 text-[11px] font-semibold py-2 rounded-lg">Pay by Card</button></div>',

            employees:
                pageHead('Employees', 'Vets, staff and their access roles')
                + tableCard(['Name', 'Role', 'Contact', 'Status'], [
                    ['Dr. Eli Vile', 'Veterinarian', '+92 300 1111111', chip('Active', C_PAID)],
                    ['Dr. Noor', 'Veterinarian', '+92 300 2222222', chip('Active', C_PAID)],
                    ['Gurkan Uzunca', 'Staff', '+92 300 3333333', chip('Active', C_PAID)],
                    ['Ayesha Malik', 'Front Desk', '+92 300 4444444', chip('Inactive', C_GREY)],
                ]),

            services:
                pageHead('Services', 'The treatments and prices you offer')
                + tableCard(['Service', 'Category', 'Price', 'Duration'], [
                    ['General Consultation', 'OPD', 'Rs 1,500', '20 min'],
                    ['Vaccination', 'Preventive', 'Rs 1,200', '10 min'],
                    ['Deworming', 'Preventive', 'Rs 800', '10 min'],
                    ['Full Grooming', 'Grooming', 'Rs 3,000', '60 min'],
                    ['Spay / Neuter', 'Surgery', 'Rs 15,000', '90 min'],
                ]),

            grooming:
                pageHead('Grooming', 'Grooming appointments and grooming team')
                + tableCard(['Time', 'Pet', 'Service', 'Groomer', 'Status'], [
                    ['11:00', 'Bella (Poodle)', 'Full Grooming', 'Ayesha', chip('Confirmed', C_PAID)],
                    ['13:30', 'Coco (Shih Tzu)', 'Bath & Trim', 'Ayesha', chip('In progress', C_INFO)],
                    ['16:00', 'Rocky (Labrador)', 'De-shedding', 'Sana', chip('Pending', C_GREY)],
                ]),

            inventory:
                pageHead('Inventory', 'Stock levels and profit per product')
                + tableCard(['Product', 'Category', 'Stock', 'Price'], [
                    ['Maropitant 10mg/ml', 'Medicine', chip('In stock', C_PAID), 'Rs 850'],
                    ['Gastro diet food 2kg', 'Food', chip('Low stock', C_UNPAID), 'Rs 1,700'],
                    ['Rabies vaccine', 'Vaccine', chip('In stock', C_PAID), 'Rs 1,200'],
                    ['Dewormer tablets', 'Medicine', chip('Reorder', C_RED), 'Rs 350'],
                ]),

            vendors:
                pageHead('Vendors', 'Products supplied, purchase price and settlements')
                + tableCard(['Vendor', 'Products', 'Purchase Price', 'Vendor Share', 'Remaining', 'Status'], [
                    ['PetPharm', 'Maropitant', 'Rs 12,000', 'Rs 3,600', 'Rs 0', chip('Settled', C_PAID)],
                    ['VetSupply Co', 'Rabies vaccine', 'Rs 8,500', 'Rs 2,100', 'Rs 2,100', chip('Unpaid', C_UNPAID)],
                    ['PetFood Ltd', 'Gastro diet', 'Rs 5,000', 'Rs 1,000', 'Rs 0', chip('Settled', C_PAID)],
                ]),

            expenses:
                pageHead('Expenses', 'Daily costs, categories and totals')
                + tableCard(['Date', 'Category', 'Description', 'Amount'], [
                    ['Oct 8 2026', 'Salaries', 'Staff salary advance', 'Rs 50,000'],
                    ['Oct 7 2026', 'Utilities', 'Electricity bill', 'Rs 12,400'],
                    ['Oct 6 2026', 'Supplies', 'Syringes and gloves', 'Rs 3,200'],
                ])
                + '<div class="bg-white border border-gray-200 rounded-xl p-3 text-[11px] mt-3 flex items-center justify-between"><span class="font-semibold text-gray-700">Monthly expenses</span><span class="font-extrabold text-red-500 text-base">Rs 58,000</span></div>',

            billing:
                pageHead('Product Billing', 'Product invoices and sales')
                + tableCard(['Invoice', 'Client', 'Items', 'Total', 'Status'], [
                    ['PB-2042', 'Adam Jansone', 'Maropitant, diet food', 'Rs 4,250', chip('Paid', C_PAID)],
                    ['PB-2041', 'Sara Khan', 'Rabies vaccine', 'Rs 1,200', chip('Unpaid', C_UNPAID)],
                    ['PB-2040', 'Bilal Ahmed', 'Dewormer tablets', 'Rs 700', chip('Paid', C_PAID)],
                ]),

            payments:
                pageHead('Payments', 'Settle appointments, products, expenses and quick bills')
                + '<div class="flex flex-wrap gap-2 mb-3 text-[11px]">' + ['Appointments', 'Products', 'Expenses', 'Quick Bills'].map(function (t, i) { return '<span class="px-3 py-1 rounded-full font-semibold ' + (i === 0 ? 'bg-teal-600 text-white' : 'bg-white border border-gray-200 text-gray-600') + '">' + t + '</span>'; }).join('') + '</div>'
                + tableCard(['Date', 'Client', 'Type', 'Amount', 'Status'], [
                    ['Oct 8 2026', 'Adam Jansone', 'Appointment', 'Rs 4,200', chip('Paid', C_PAID)],
                    ['Oct 8 2026', 'Sara Khan', 'Appointment', 'Rs 2,950', chip('Partially Paid', C_UNPAID)],
                    ['Oct 7 2026', 'Bilal Ahmed', 'Product sale', 'Rs 1,150', chip('Unpaid', C_RED)],
                ])
                + '<div class="bg-white border border-gray-200 rounded-xl p-3 text-[11px] mt-3 flex items-center justify-between"><span class="font-semibold text-gray-700">Total Due</span><span class="font-extrabold text-gray-900 text-base">Rs 4,100</span></div>',

            coupons:
                pageHead('Coupons', 'Discount codes and their usage')
                + tableCard(['Code', 'Discount', 'Type', 'Expiry', 'Status'], [
                    ['WELCOME10', '10%', 'Percentage', 'Dec 31 2026', chip('Active', C_PAID)],
                    ['FLAT500', 'Rs 500', 'Fixed', 'Nov 30 2026', chip('Active', C_PAID)],
                    ['SUMMER', '15%', 'Percentage', 'Sep 30 2026', chip('Expired', C_GREY)],
                ]),

            forms:
                pageHead('Forms', 'Consent and intake templates')
                + listCard([
                    '<div class="min-w-0 flex items-center gap-2"><i class="fa-solid fa-file-lines text-teal-600"></i><span class="font-semibold text-gray-800">Surgery Consent Form</span></div>' + chip('Active', C_PAID),
                    '<div class="min-w-0 flex items-center gap-2"><i class="fa-solid fa-file-lines text-teal-600"></i><span class="font-semibold text-gray-800">New Client Intake</span></div>' + chip('Active', C_PAID),
                    '<div class="min-w-0 flex items-center gap-2"><i class="fa-solid fa-file-lines text-teal-600"></i><span class="font-semibold text-gray-800">Boarding Agreement</span></div>' + chip('Active', C_PAID),
                ]),

            reports:
                pageHead('Reports', 'Income, expense and profit analysis')
                + '<div class="grid grid-cols-3 gap-3 mb-4 text-[11px]">'
                + statCard('Income (Mo)', 'Rs 1.2L', '', 'text-emerald-600')
                + statCard('Expense (Mo)', 'Rs 58K', '', 'text-red-500')
                + statCard('Profit (Mo)', 'Rs 62K', '', 'text-gray-900')
                + '</div>'
                + '<div class="bg-white border border-gray-200 rounded-xl p-3 shadow-sm"><div class="text-[11px] font-semibold text-gray-700 mb-2">Income vs expenses - last 8 weeks</div>'
                + '<div class="flex items-end gap-1.5 h-28">' + bars([40, 55, 48, 70, 60, 78, 52, 66], 'bg-emerald-200') + '</div></div>',

            referral:
                pageHead('Referral', 'Invite clinics and earn rewards')
                + '<div class="bg-white border border-gray-200 rounded-xl p-4 shadow-sm text-[11px]">'
                + '<p class="text-gray-600 mb-3">Share your referral link. When a clinic signs up and subscribes, you earn a reward on your next bill.</p>'
                + '<div class="flex items-center gap-2"><input readonly value="https://podvet.biztrack.uk/?ref=PODVET-CLINIC" class="flex-1 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-gray-700"><button class="bg-teal-600 text-white font-semibold px-3 py-2 rounded-lg">Copy</button></div>'
                + '<div class="grid grid-cols-2 gap-3 mt-4">' + statCard('Referrals', '3', 'this year', 'text-teal-600') + statCard('Rewards earned', 'Rs 9,000', 'credit', 'text-emerald-600') + '</div>'
                + '</div>',

            settings:
                pageHead('Settings', 'Clinic profile, branding and preferences')
                + '<div class="bg-white border border-gray-200 rounded-xl p-4 shadow-sm grid grid-cols-1 sm:grid-cols-2 gap-3 text-[11px]">'
                + ['Clinic Name|PodVet Main Clinic', 'Contact Number|+92 300 0000000', 'Email|clinic@podvet.example', 'Address|Main Road, Lahore'].map(function (f) {
                    var p = f.split('|');
                    return '<div><span class="text-gray-500 block mb-1">' + p[0] + '</span><div class="border border-gray-200 rounded-lg px-3 py-2 text-gray-700">' + p[1] + '</div></div>';
                }).join('')
                + '<div class="sm:col-span-2 flex justify-end"><button class="bg-teal-600 text-white font-semibold px-4 py-2 rounded-lg">Save Changes</button></div>'
                + '</div>',
        };

        function buildSidebar() {
            const nav = document.getElementById('demo-sidebar');
            if (!nav) return;
            nav.innerHTML = DEMO_NAV.map(function (item) {
                return '<a href="#" onclick="setScreen(\'' + item.key + '\'); return false;" data-screen="' + item.key + '" class="flex items-center gap-2.5 px-3 py-2 rounded-lg text-gray-600 hover:bg-gray-50"><i class="fa-solid ' + item.icon + ' w-4 text-teal-600"></i><span>' + item.label + '</span></a>';
            }).join('');
        }

        function setScreen(key) {
            const item = DEMO_NAV.filter(function (n) { return n.key === key; })[0] || DEMO_NAV[0];
            const container = document.getElementById('tab-content-container');
            if (container) container.innerHTML = DEMO_PAGES[key] || DEMO_PAGES.dashboard;
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
