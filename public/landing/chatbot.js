(function () {
  'use strict';
  var win = document.getElementById('chat-window');
  if (!win) return;
  var toggle = document.getElementById('chat-toggle');
  var closeBtn = document.getElementById('chat-close');
  var msgs = document.getElementById('chat-messages');
  var chipsWrap = document.getElementById('chat-chips');
  var input = document.getElementById('chat-input');
  var sendBtn = document.getElementById('chat-send');
  if (!toggle || !closeBtn || !msgs || !input || !sendBtn) return;

  var OPEN_CHIPS = [
    { label: 'What is PodVet?', q: 'what is podvet' },
    { label: 'New clinic', q: 'clinic kaise banaye' },
    { label: 'Clinic setup', q: 'clinic setup steps' },
    { label: 'Pricing', q: 'pricing kya hai' },
    { label: 'All features', q: 'features batao' },
    { label: 'Free trial', q: 'free trial kese' },
    { label: 'Appointments', q: 'appointments kese karein' },
    { label: 'Contact', q: 'contact number' }
  ];

  function norm(s) {
    s = String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    var map = {
      'kis tarah': 'how', 'kis tarha': 'how', 'kis tara': 'how', 'kis tartah': 'how',
      'kya': 'what', 'kyun': 'why', 'kyu': 'why', 'kyoon': 'why', 'kion': 'why',
      'kahan': 'where', 'kaha': 'where', 'kab': 'when',
      'kaise': 'how', 'kese': 'how', 'kaisay': 'how', 'kaysay': 'how', 'keise': 'how', 'kase': 'how',
      'kitna': 'howmuch', 'kitne': 'howmuch', 'kittna': 'howmuch', 'ketna': 'howmuch', 'ktna': 'howmuch',
      'chahiye': 'want', 'chahta': 'want', 'chahti': 'want', 'chahie': 'want',
      'batao': 'tell', 'bataen': 'tell', 'bataiye': 'tell', 'batayein': 'tell', 'bata': 'tell',
      'kaunsa': 'which', 'konsa': 'which', 'konse': 'which',
      'karo': 'do', 'karein': 'do', 'kren': 'do', 'kro': 'do',
      'mujhe': 'me', 'mera': 'my', 'apna': 'my',
      'kaam': 'work', 'kam': 'work', 'sakte': 'can', 'sakta': 'can', 'sakti': 'can',
      'hai': ' is', 'hein': ' is', 'haen': ' is', 'hota': ' is'
    };
    for (var k in map) s = s.split(k).join(map[k]);
    return s;
  }

  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function hit(text, kw) { return new RegExp('\\b' + escRe(kw) + '\\b').test(text); }

  // Keywords are authored with punctuation ("first-time fee", "50%") but norm()
  // strips punctuation out of what the user types, so those keywords could never
  // match anything. Run keywords through the same punctuation/whitespace pass to
  // keep both sides of the comparison identical.
  //
  // Deliberately NOT the full norm(): its Roman-Urdu map rewrites "hai" to " is",
  // which would turn a common filler word into a keyword and match almost every
  // message. norm() maps user input *into* English, so keywords are already in the
  // target language and must not be translated.
  function kwNorm(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // Knowledge about creating and standing up a new clinic. Defined first so that
  // "clinic kaise banaye" is not stolen by a generic "clinic ..." intent.
  //
  // NOTE on keywords: they are compared against norm()'s *output*, not raw user
  // text. norm() rewrites Roman-Urdu fillers (kaise -> how, kya -> what, hai -> is),
  // which inserts a word and breaks adjacency. So "clinic kaise banaye" can never
  // match, and keywords must be written in the post-normalisation language.
  var CLINIC_INTENTS = [
    {
      id: 'clinic-create',
      k: ['create clinic', 'new clinic', 'start my clinic', 'start a clinic', 'open a clinic',
        'register clinic', 'clinic register', 'add new clinic', 'new clinic register',
        'clinic sign up',         'clinic banao', 'clinic banaye', 'clinic banani', 'clinic banane',
        'clinic banane ka tareeqa', 'clinic banane ke liye',
        'how create clinic', 'how start clinic', 'how register clinic', 'how to create clinic',
        'how to start clinic', 'how to register clinic', 'banaye', 'banani', 'banane', 'banata',
        'vet clinic', 'clinic creation', 'new practice', 'start my practice'],
      a: 'Creating your clinic on PodVet:<br>1. Go to the <b>signup</b> form on the site and enter your <b>Clinic Name</b>.<br>2. Enter the owner details: <b>Full Name</b>, a unique <b>Username</b>, your <b>Email</b> and a <b>Password</b>.<br>3. Add a <b>Referral Code</b> only if you have one - it gives 50% off your first invoice.<br>4. Submit. Your clinic is created instantly and you sign straight in as the <b>Owner</b>.<br>The trial is <b>30 days</b> for a self-signup clinic, <b>14 days</b> when a Super Admin creates it for you. There is no setup fee and <b>no credit card is needed</b> to start.<br>After you sign in, complete the setup checklist in Settings so your clinic, branches and services are ready to use.',
      c: ['Clinic setup steps', 'Clinic banane ke baad kya banta hai', 'Free trial kitne din']
    },
    {
      id: 'clinic-create-req',
      k: ['clinic banane ke liye kya', 'clinic register karne ke liye', 'what need for clinic',
        'clinic signup form', 'signup form fields', 'clinic required fields', 'referral code',
        'unique username', 'clinic email', 'clinic password', 'owner account'],
      a: 'To register a clinic you only need:<br>- <b>Clinic Name</b> - the name shown on invoices and reports.<br>- <b>Owner Full Name</b> - the person who owns the account.<br>- <b>Username</b> - must be unique across the platform.<br>- <b>Email</b> - used for login and receipts.<br>- <b>Password</b> - for the owner account.<br>- <b>Referral Code</b> - optional, only if you were given one.<br>There is no payment method or card required to create the clinic and start the trial.',
      c: ['Clinic kaise banaye', 'Clinic setup steps', 'Referral code kya hai']
    },
    {
      id: 'clinic-after-create',
      k: ['clinic banane ke baad', 'clinic banne ke baad', 'what created with clinic',
        'new clinic database', 'podvet clinic database', 'main branch', 'default branch',
        'clinic settings created', 'owner login', 'clinic created automatically', 'auto created',
        'seed data', 'clinic se pehle kya kare', 'first login clinic', 'new clinic login'],
      a: 'The moment you register, PodVet automatically:<br>- Creates a <b>separate private database</b> for your clinic, named <b>podvet_clinic_&lt;id&gt;</b>, so your data stays isolated from every other clinic.<br>- Creates your <b>Owner login</b> - you are already signed in as the owner.<br>- Creates the default <b>clinic settings</b> (clinic name, logo, address, contact).<br>- Creates your first branch, called <b>"Main Branch"</b>, so billing and stock always have a branch to work with.<br>What is <b>not</b> created for you: services, products, expense categories, coupons and cage types. Add those in Setup during your first session - that is why the first login asks you to complete the setup checklist.',
      c: ['Clinic setup steps', 'Branches kaise add karein', 'Services kaise add karein']
    },
    {
      id: 'clinic-setup-steps',
      k: ['clinic setup steps', 'setup checklist', 'first time setup', 'onboard clinic',
        'clinic onboard', 'getting started setup', 'new clinic kya kare',
        'setup wizard', 'clinic ready kaise kare', 'start using podvet', 'pehle kya kare'],
      a: 'Recommended first-session setup, in this order:<br>1. <b>Clinic Settings</b> - clinic name, logo, address, phone, email, tax/currency details.<br>2. <b>Branches</b> - "Main Branch" is already there; add more if you run multiple locations.<br>3. <b>Services</b> - add your consultation and treatment services with prices and durations.<br>4. <b>Products / Inventory</b> - add medicines and retail items with stock levels.<br>5. <b>Expense categories</b> - the categories you use for clinic expenses.<br>6. <b>Employees and roles</b> - add your staff and give each one a role and permissions.<br>7. <b>Appointment categories</b> - tailor the categories your clinic books into.<br>8. <b>Coupons and cages</b> - only if you use them.<br>Finish this and the clinic is ready to take real appointments.',
      c: ['Clinic kaise banaye', 'Services kaise add karein', 'Employees aur roles']
    }
  ];

  var SYS_INTENTS = [
    {
      id: 'sys-loginroles',
      k: ['how to login', 'how do i login', 'log in to', 'login screen', 'username', 'password', 'forgot password', 'reset password', 'access blocked', 'roles', 'owner', 'admin role', 'admin and user', 'permission', 'permissions', 'role own', 'membership role', 'branch selector', 'sign in kese', 'login karna', 'pending account', 'suspended clinic'],
      a: 'To log in, open the app at <a class="text-brand-700 font-bold underline" href="/app">/app</a> and enter your <b>username or email</b> plus your <b>password</b>.<br>Roles in PodVet:<br>- <b>OWNER</b> and <b>ADMIN</b>: full access to every module<br>- <b>USER</b>: a limited staff account<br>Reports are Owner-only, and the branch selector at the top of the Dashboard is shown to admins only. If you forget your password, use the reset option on the login screen. A &quot;Pending&quot; account must be activated by an admin (or via the invite), and a suspended or disabled clinic is blocked with a message asking you to contact support.',
      c: ['How to book an appointment', 'Roles kya hain', 'Plans kya hain']
    },
    {
      id: 'sys-appt-workflow',
      k: ['book an appointment', 'how to book', 'book appointment kese', 'new appointment', 'appointment categories', 'confirmed', 'appointment status', 'check in', 'print invoice', 'print pos', 'pos slip', 'deduct from stock', 'deduct stock', 'complete payment', 'custom reminder', 'appointment filters', 'appointment doctor', 'add service to appointment', 'appointment reprint', 'pre discount', 'appointment discount'],
      a: 'Booking an appointment in the internal app:<br>1. Go to <b>Appointments</b> and press new appointment.<br>2. Either find an existing patient or add a new client + pet. Pick the pet, doctor, date and time.<br>3. Add services and/or products, notes - the status defaults to <b>Confirmed</b>.<br>Appointments are grouped into categories: Consultation &amp; General Care, Preventive Care, Diagnostics, Specialized Care, Surgery, Grooming, Boarding and Other.<br>On each row you can: edit, cancel, open the Medical Record, preview/reprint the invoice, <b>Complete Payment</b>, print the POS slip, <b>Deduct from stock</b> (with qty to deduct), add Custom Reminders or open WhatsApp. Payments filter by Paid / Partially Paid / Unpaid / Billed, and discounts can be percent or fixed plus a coupon.',
      c: ['Complete a payment', 'Print invoice', 'Deduct from stock', 'Appointments demo']
    },
    {
      id: 'sys-addclient',
      k: ['add client', 'add a client', 'new client', 'create client', 'add client and pet', 'client and pet', 'search client', 'client active', 'inactive client', 'active or inactive', 'lab slip', 'print lab slip', 'client phone', 'add pet', 'new pet', 'pet species', 'species dog', 'breed', 'microchipped', 'neutered', 'spayed', 'deceased'],
      a: 'In the <b>Clients</b> module you manage owners and their pets. Search by client name, phone, pet name or even pet ID. Fields for a client: name, contact number, address, and Active/Inactive status. For each pet: Name, <b>Species (Dog, Cat, Bird, Rabbit, Other)</b>, Breed, Sex, Age, Date of Birth, Color, Microchipped, Neutered/Spayed, Deceased, and Order. You can add a client and pet at once, and print a Lab Slip for lab tests.',
      c: ['Add a vaccination', 'Patient overview', 'Medical records']
    },
    {
      id: 'sys-patient-all',
      k: ['patient overview', 'patient records kese', 'add vaccination', 'vaccination give', 'deworming', 'add deworming', 'add prescription', 'owner payment history', 'outstanding amount', 'currently outstanding', 'total paid', 'vaccination batch', 'administered by', 'prescribed by', 'vaccine next due'],
      a: 'The <b>Patients</b> module shows a full pet file with sections: Overview, Vaccinations, Dewormings, Prescriptions, Owner Details and Owner Payment History (payments received, total paid all time, currently outstanding). Inline you can add the first vaccination, deworming or prescription. Vaccination rows carry: vaccine, administered date, next due, duration, frequency, batch and administered-by. Prescriptions carry product, dose, frequency, duration, prescribed-on and prescribed-by.',
      c: ['SOAP note fields', 'Add a client', 'Prescription PDF']
    },
    {
      id: 'sys-soap-detail',
      k: ['soap note fields', 'soap modal', 'subjective', 'objective', 'assessment', 'plan', 'bcs', 'body condition score', 'hydration', 'mentation', 'mucous membrane', 'pulse quality', 'exam systems', 'tests advised', 'soap vitals', 'ai refine', 'refine soap', 'diagnosis', 'prognosis', 'ddx', 'clinical note fields'],
      a: 'A <b>SOAP note</b> has the classic Subjective / Objective / Assessment / Plan structure, plus vitals and exam data: body systems (eyes, ears, oral cavity, skin/coat, lymph nodes, cardiovascular, respiratory, gastrointestinal, musculoskeletal, neurological, urogenital), <b>Body Condition Score</b> (1 emaciated to 9 severely obese), hydration, mentation, mucous membrane and pulse quality (Good / Poor / Moribund), temperature, heart rate, weight, pregnancy/anemia flags, diagnosis / DDx / prognosis, client notes, medications, vaccination/deworming entries, next visit and <b>Tests Advised</b>. You can <b>AI-refine</b> your dictated text into clean structure, and generate a prescription PDF.',
      c: ['Record types', 'Medical records demo', 'Prescriptions']
    },
    {
      id: 'sys-record-types',
      k: ['record types', 'lab result', 'lab results', 'labs what', 'what are labs', 'procedure', 'body weight', 'body weight record', 'lab report', 'upload report', 'file upload', 'prescription pdf', 'pdf prescription', 'record keter', 'add lab'],
      a: 'The <b>Medical Records</b> module stores every record type a clinic needs: <b>SOAP Notes, Vaccinations, Dewormings, Prescriptions, Lab Results, Procedures, Body Weight records and Lab Reports/files</b>. Each lives on the patient\'s record; files can be uploaded and opened, and prescriptions can be exported as PDF.',
      c: ['SOAP fields', 'Add vaccination', 'Labs kya hain']
    },
    {
      id: 'sys-boarding',
      k: ['boarding', 'check in', 'checkout', 'cage', 'cage type', 'free area', 'feeding log', 'mark fed', 'dose log', 'medication', 'mark given', 'check vitals', 'vitals check', 'consent form', 'boarding consent', 'expected checkout', 'nights', 'routine stay', 'hospitalization', 'healthy boarding', 'boarding summary', 'daily summary', 'hospitalization summary', 'search cage'],
      a: '<b>Boarding</b> manages pets staying at the clinic. Set up <b>Cage Types and Free Areas</b>, then Check In a pet with: date in, expected checkout, nights, a service type (<b>Routine stay / Hospitalization / Healthy Boarding</b>), purpose, free cage unit, feeding and vitals intervals, owner notes, WhatsApp and the <b>Boarding Consent Form</b>.<br>During the stay: <b>Feeding log</b> (mark fed, log feeding), <b>Dose log</b> (medications - mark given, discontinue), and <b>Check Vitals</b> (temperature, heart rate, respiratory rate, weight, mucous membrane, hydration, mentation, pulse quality, condition).<br>At <b>Check Out</b> you preview the invoice, apply a coupon, take payment in any mode, and print the Boarding / Daily / Hospitalization summary.',
      c: ['Boarding demo', 'Check vitals kese', 'Invoice preview']
    },
    {
      id: 'sys-inventory-detail',
      k: ['barcode', 'product category', 'categories', 'csv import', 'import csv', 'scan product', 'ai scan', 'low stock', 'out of stock', 'stock status', 'consignment', 'commission percent', 'fixed per unit', 'vendor share', 'clinic share', 'deduct on sale', 'stock left', 'quantity', 'product price', 'add product', 'edit product'],
      a: 'The <b>Inventory (Products)</b> screen lists: product, barcode, category, price, quantity, vendor, branch and status (<b>In Stock / Low Stock / Out of Stock</b>). You can add/edit/delete products, import by CSV (with an AI barcode/label scan option), and set <b>vendor consignment</b> terms - commission percentage of the sale line or a fixed PKR amount per unit sold (the clinic keeps the rest). Stock is deducted automatically when a product is sold or added at appointment checkout; low-stock is flagged when quantity drops below the minimum level.',
      c: ['Vendors', 'Product billing', 'Inventory demo']
    },
    {
      id: 'sys-vendors',
      k: ['vendor settlement', 'settlements', 'pay vendor', 'record settlement', 'vendor payout', 'gross sales', 'vendor share', 'clinic profit', 'clinic earnings', 'sales this period', 'units sold'],
      a: 'The <b>Vendors</b> module tracks supplier sales, settlements and payouts. For each vendor you see <b>Gross Sales, Sales (this period), Units sold, Vendor share owed, Clinic Earnings and Clinic Profit</b>. You pick a consignment period and hit <b>Calculate</b>, then record the vendor settlement / pay the vendor with start date, end date and notes.',
      c: ['Inventory', 'Product billing', 'Expenses']
    },
    {
      id: 'sys-billing',
      k: ['product billing', 'billing screen', 'scan barcode', 'sell products', 'manual discount', 'split payment', 'bank transfer', 'cash', 'card payment', 'payment modes', 'invoice preview', 'confirm payment', 'save invoice', 'pos slip print', 'quick bill'],
      a: '<b>Product Billing</b> is a dedicated POS-style screen: &quot;Create a bill for products and services&quot;. Scan a barcode or type a product, set qty and unit price, add a coupon and/or manual discount (with a warning if it exceeds the total), then <b>split the payment across Cash / Card / Bank Transfer</b> and confirm. You get an invoice preview and a printable POS slip.<br><br><b>Quick Bill</b> is the fast invoice: line items from services or products plus custom items, client name/phone/pet, discount + coupon, amount received and payment mode.',
      c: ['Payments screen', 'Invoice preview', 'POS slip']
    },
    {
      id: 'sys-payments',
      k: ['payments screen', 'outstanding balance', 'pay all', 'pay remaining', 'record payment', 'payment details', 'appointment breakdown', 'quick bill breakdown', 'product sale breakdown', 'transaction breakdown', 'outstanding statement', 'net amount due', 'grand total', 'fully paid', 'partially paid', 'invoice no'],
      a: 'The <b>Payments</b> module has tabs: Appointments, Quick Bills, Product Sales, Transactions and Expenses. Search by client name/phone and filter payment status (All / Paid / Partially Paid / Fully Paid). For any unpaid client you can open an <b>Outstanding Balance Statement</b>, view the appointment/quick bill/product-sale breakdown, <b>Pay All</b> or <b>Pay Remaining</b>, and record a payment. Each line shows appt fee, new-client fee, products total, discount, gross total, total paid, net amount due, balance, GRAND TOTAL, invoice no, payment mode and notes. Products sold at appointment checkout are marked and cannot be re-edited as standalone sales.',
      c: ['Record a payment', 'Quick Bill', 'Outstanding statement']
    },
    {
      id: 'sys-services-grooming',
      k: ['add service', 'service category', 'consultation category', 'preventive care', 'specialized care', 'base rate', 'grooming service', 'add grooming', 'grooming type', 'services screen', 'service price'],
      a: '<b>Services</b> keeps your price list: name, category and base rate, plus purchase price, with categories like Consultation &amp; General Care, Preventive Care, Diagnostics and Specialized Care. <b>Grooming</b> is simply the service category Grooming - add a grooming service with its base rate (a duplicate grooming type name is rejected). These services appear in appointments and Quick Bill for fast invoicing.',
      c: ['Quick Bill', 'Appointments', 'Coupons']
    },
    {
      id: 'sys-employees-users',
      k: ['add employee', 'staff record', 'position', 'designation', 'salary', 'joined on', 'invite user', 'invitation', 'revoke invitation', 'resend invitation', 'pending user', 'active user', 'username', 'create user', 'add user', 'user role', 'employee screen'],
      a: 'The <b>Employees / Users</b> screen holds two things: <b>Employees</b> (staff records - name, position, designation, salary, contact, joined on) and <b>Users</b> (login accounts - name, username, email, role <b>OWNER / ADMIN / USER</b>, branch, Active/Pending status). Admins can invite users by email (resend or revoke the invitation), set roles, and let them reset their own password.',
      c: ['Roles kya hain', 'Add employee', 'Settings']
    },
    {
      id: 'sys-expenses',
      k: ['daily expense', 'add expense', 'expense category', 'expense amount', 'expense description', 'expense pdf', 'expense date', 'expense branch', 'add category', 'expense name'],
      a: '<b>Expenses</b> tracks daily spending. First create <b>Expense Categories</b>, then add entries with name, category, amount (Rs), date, description/notes and an optional branch (or clinic-wide). You can print/download the expense list as a PDF.',
      c: ['Reports', 'Vendors', 'Product billing']
    },
    {
      id: 'sys-coupons',
      k: ['add coupon', 'coupon code', 'coupon percent', 'coupon fixed', 'discount type', 'usage limit', 'times used', 'coupon active', 'coupon expiry', 'create coupon'],
      a: '<b>Coupons</b> are discount vouchers with: code, discount type (<b>PERCENT or FIXED amount</b>), discount value (percent capped at 100), start date, expiry date, usage limit, times used and an Active switch. Apply them at appointment checkout, Quick Bill or Product Billing.',
      c: ['Payments', 'Referral code', 'Quick Bill']
    },
    {
      id: 'sys-forms',
      k: ['form builder', 'create form', 'form page', 'upload pdf', 'fillable field', 'signature', 'checkbox', 'text field', 'date field', 'map field', 'owner name', 'form print', 'preview and print', 'search client form', 'which pet', 'forms screen'],
      a: 'The <b>Forms</b> module is a fillable form builder for PDFs. Upload one PDF per form page, drop fillable fields (<b>Text, Checkbox, Date, Signature</b>), and map them to data - owner name, address, phone, pet name, species, age, breed, color, sex or today\'s date. To fill: search the client by name/phone, choose the pet, then Preview &amp; Print (sign after printing).',
      c: ['Add a client', 'Medical records', 'Settings']
    },
    {
      id: 'sys-reports-deep',
      k: ['reports screen', 'last 8 months', 'quarterly reports', 'yearly report', 'total revenue', 'total expenses', 'total transactions', 'appointment revenue', 'clinic product revenue', 'revenue trend', 'client growth', 'service breakdown', 'recent transactions', 'custom date range', 'all branches'],
      a: '<b>Reports</b> (available to the clinic Owner) gives the big picture. Choose a period - <b>Last 8 Months, Monthly, Quarterly, Yearly or a custom start/end date</b> - and a branch or &quot;All branches (collective)&quot;. The cards show <b>Total Revenue, Total Expenses, Total Transactions, Appointment Revenue and Clinic Product Revenue</b>, with charts for monthly revenue trend, revenue breakdown, services breakdown, and client growth, plus a recent-transactions list. Reports drive daily, weekly and monthly profit/loss decisions.',
      c: ['How do I export data', 'Dashboard', 'Request an Owner account']
    },
    {
      id: 'sys-settings',
      k: ['settings screen', 'receipt branding', 'clinic logo', 'accent colour', 'receipt accent', 'clinic name', 'clinic address', 'pos slip options', 'bank details', 'bank name', 'show logo', 'show phone', 'show address', 'time format', '12 hour', '24 hour', 'manual discount range', 'clinic settings tab', 'branches settings', 'current plan', 'data management tab', 'profile tab', 'change password', 'update profile'],
      a: '<b>Settings</b> has five tabs:<br>- <b>Profile</b>: username, update profile, change password.<br>- <b>Receipt Branding</b>: clinic name, address, phone, logo (with cropping) and the receipt accent colour (presets and custom hex).<br>- <b>Clinic Settings</b>: bank details for slips, POS slip options (show logo/phone/address/client phone/bank details/vet name), grouping invoice line items by category, <b>Time format (12/24 hour)</b>, manual discount range (%), and the <b>First-Time Customer Fee</b> (default Rs 1,050, charged on a new client\'s first appointment).<br>- <b>Branches</b>: add/edit/delete branches with address and phone.<br>- <b>Current Plan</b>: plan, status, trial/period end, cancel-at-end, payment proofs.<br>- <b>Data Management</b>: export and import (see below).',
      c: ['How do I export data', 'First-time fee kya hai', 'Plans kya hain']
    },
    {
      id: 'sys-export-import',
      k: ['export data', 'export all', 'export clients', 'export appointments', 'xlsx', 'excel', 'import data', 'import clients', 'import services', 'import products', 'data import', 'backup file', 'desktop backup', 'podvet backup', 'data export kese', 'import kese'],
      a: '<b>Data Management</b> in Settings handles your data:<br>- <b>Export</b>: &quot;Export All Data&quot;, &quot;Export Clients &amp; Pets Data&quot; or &quot;Export Appointments &amp; Employees Data&quot; as Excel (XLSX). Files are saved to your computer\'s Desktop/PodVet-Backup folder.<br>- <b>Import</b>: upload .json, .xlsx or .xls to bring in Clients, Users, Employees, Services, Products, Coupons and Pets. Migration help is also available - our team can move data from your current software for you.',
      c: ['Data migration', 'Security kya hai', 'Settings']
    },
    {
      id: 'sys-plans',
      k: ['free trial plan', 'standard plan', 'plan details', '3000', '3,000', '36000', '36,000', 'trial days', 'free trial features', 'plan features', 'switch plan', 'plan active', 'trial ends', 'period ends', 'set to cancel', 'payment proof', 'submit payment proof', 'select plan'],
      a: 'PodVet has two plans:<br>- <b>Free Trial</b>: Rs 0 - 1 month free, no card required. Includes everything in Standard, unlimited clients and pets, appointments &amp; billing, products &amp; inventory, and reports &amp; analytics.<br>- <b>Standard</b>: <b>Rs 3,000/month or Rs 36,000/year</b>.<br>In Settings &gt; Current Plan you see your plan, status, when the trial or current period ends, an option to set to cancel at period end, and your payment history / submitted payment proofs.',
      c: ['How do I pay', 'Referral code', 'Free trial kese']
    },
    {
      id: 'sys-loyalty-ref',
      k: ['loyalty card', 'loyalty card details', 'stamps', '5th visit', 'free treatment', 'extra 30', 'card valid', '30 days', 'referral card', 'card scan', 'qr scan', 'referral scan', 'loyalty-card', '5 visits', 'visit stamps'],
      a: 'The <b>Referral &amp; Loyalty Card</b> works like a punch card: it gives <b>50% off the first paid invoice</b> when a new client signs up with the referral code (about Rs 1,500 off), and the card collects <b>five completed-visit stamps</b> - the 5th visit earns a <b>free treatment</b>, or an extra <b>30% discount / free grooming</b> instead. A referral card is valid for <b>30 days</b>; codes are entered at signup (a QR camera scan is supported too via the referral scanner).',
      c: ['Referral code', 'Free trial', 'Billing options']
    },
    {
      id: 'sys-reminders-inner',
      k: ['reminder list', 'reminder bell', 'reminder notification', 'dismiss reminder', 'delete reminder', 'custom reminders', 'remind on', 'lead time', 'due date', 'reminder for appointment', 'reminder for pet', 'reminder doctor', 'notification tab', 'mark read'],
      a: 'Reminders inside the app are tracked per appointment or per pet, with a <b>remind-on lead-in</b> and a <b>due date</b> - so a vaccination reminder can start a few days before it is due and stay until done. Each reminder carries the pet, client, doctor and contact number. A notification bell shows your newest (e.g. the latest 5) with mark-as-read, and the system can fire daily native notifications. From any appointment you can also add <b>Custom Reminders</b>, and dismiss/delete them once handled.',
      c: ['SMS & WhatsApp', 'Vaccination reminder', 'Dashboard']
    },
    {
      id: 'sys-printdocs',
      k: ['print invoice', 'print pos', 'print slip', 'print lab', 'print consent', 'print summary', 'print prescription', 'prescription pdf', 'print report', 'print expense', 'reprint invoice', 'download pdf', 'print boarding'],
      a: 'Printing is everywhere in PodVet:<br>- Appointments: invoice, <b>POS slip</b>, reprint.<br>- Labs: <b>lab slip</b> for patients.<br>- Prescriptions: export as <b>PDF</b>.<br>- Boarding: <b>consent form</b>, boarding/daily/hospitalization summaries, checkout invoice.<br>- Expenses: monthly expense list PDF.<br>- Reports: exportable statements. Every printed document follows your own receipt branding (logo, accent colour, bank details).',
      c: ['Receipt branding', 'Product billing', 'Boarding checkout']
    },
    {
      id: 'sys-terms',
      k: ['invoice number', 'invoice no', 'invoice format', 'inv-', 'qb-', 'currency', 'pkr', 'rs', 'first time fee', 'new client fee', 'first appointment fee', 'bank transfer mode', 'card payment mode', 'payment mode'],
      a: 'PodVet works in <b>Pakistani Rupees (Rs / PKR)</b>. Invoice numbers: appointments and walk-ins use INV- plus a timestamp, Quick Bills use QB- plus the bill id. Payment modes are <b>Cash, Card and Bank Transfer</b>, and payments can be split across modes on one bill. A <b>First-Time Customer Fee</b> (default Rs 1,050) is charged when a new client makes their first appointment.',
      c: ['Payments screen', 'Quick Bill', 'First-time fee']
    },
    {
      id: 'sys-how-complete-payment',
      k: ['how to get paid', 'how to receive payment', 'complete a payment', 'finish invoice', 'take payment', 'collect money'],
      a: 'Collecting payment is quick: on the <b>Appointment</b>, press <b>Complete Payment</b> - review the fee, products total, discounts, apply any coupon, and record the amount. Or use <b>Quick Bill</b> to invoice services/products on the spot with any payment mode (Cash / Card / Bank Transfer). Unpaid balances can then be chased with <b>Pay All / Pay Remaining</b> from the Payments module and an online payment link to the client.',
      c: ['Payments screen', 'Quick Bill', 'Outstanding balance']
    }
  ];

  var INTENTS = CLINIC_INTENTS.concat(SYS_INTENTS).concat([
    {
      id: 'greeting',
      k: ['hello', 'hi', 'hey', 'salam', 'assalam', 'alikum', 'salamualikum', 'namaste', 'good morning', 'good afternoon', 'good evening', 'adaab'],
      a: 'Welcome to PodVet! I am your assistant. I can answer anything about the platform - features, pricing, the free trial, appointments, vaccination tracking, client & medical records, inventory, reporting, SMS/WhatsApp reminders, our contact details, and more. Just ask in English or Roman Urdu, for example "pricing kya hai?" or "appointments kese karein?"',
      c: ['What is PodVet?', 'Pricing kya hai?', 'All features', 'Free trial']
    },
    {
      id: 'goodbye',
      k: ['bye', 'goodbye', 'see you', 'khuda hafiz', 'allah hafiz', 'phir milte', 'ta ta'],
      a: 'Goodbye! If you need us again, just open this chat. You can also email support@podvet.com or visit /contact anytime.',
      c: ['Pricing', 'Contact', 'Live demo']
    },
    {
      id: 'thanks',
      k: ['thanks', 'thank you', 'thankyou', 'shukriya', 'meharbani', 'great', 'awesome', 'nice', 'well done'],
      a: 'You are most welcome! If you want to explore more, try the live demo at /demo or start your 1-month free trial at /signup.',
      c: ['Open live demo', 'Free trial', 'Contact support']
    },
    {
      id: 'identity',
      k: ['who are you', 'your name', 'name kya', 'tum kaun', 'aap kaun', 'kya naam', 'are you bot', 'real person', 'human', 'assistant kya', 'bot ho', 'ai chatbot'],
      a: 'I am the PodVet Assistant - an AI chatbot trained on the complete PodVet website knowledge base. I understand English and Roman Urdu, and I can answer questions about every feature, page, plan and setting on the site. For anything I cannot answer, you can reach our team at support@podvet.com or +90 552 895 30 15.',
      c: ['What is PodVet?', 'Features', 'Pricing']
    },
    {
      id: 'whatispodvet',
      k: ['what is podvet', 'podvet kya', 'podvet hai', 'what is this', 'about podvet', 'podvet meaning', 'yeh kya', 'software kya', 'app kya hai'],
      a: 'PodVet is an AI-driven veterinary clinic management platform built for veterinary practices. It brings your whole clinic into one place: appointments & flowboard, client and patient records, medical records with SOAP notes, vaccination tracking, inventory & stock alerts, invoicing & quick billing, payments, reporting, and automatic SMS / WhatsApp / email / push reminders.<br><br>It was founded in 2018 in Izmir, Turkiye and is used by 400+ veterinarians. See the whole thing in action on the <a class="text-brand-700 font-bold underline" href="/demo">live demo</a> or read our story on <a class="text-brand-700 font-bold underline" href="/about">the About page</a>.',
      c: ['Show me the demo', 'Features batao', 'Pricing kya hai', 'Free trial kese']
    },
    {
      id: 'howworks',
      k: ['how does it work', 'how it works', 'kaise kaam', 'kese kaam', 'work kaise', 'system kese', 'how to use', 'use kese', 'phir kya', 'demo chahiye', 'demo dikhao', 'show me', 'sanpne ka tarika', 'chalata kese'],
      a: 'Using PodVet is simple - it runs in your browser at <a class="text-brand-700 font-bold underline" href="/app">/app</a>. Sign up for a free account, invite your vets and staff, add your clients and pets, then start booking appointments, doing check-ups with SOAP notes, tracking vaccinations and inventory, sending automatic reminders by SMS/WhatsApp, and generating invoices and reports.<br><br>For a visual tour, watch the animated demo on the <a class="text-brand-700 font-bold underline" href="/">homepage</a> or explore each module on our <a class="text-brand-700 font-bold underline" href="/demo">live demo page</a>.',
      c: ['Free trial kese', 'Appointments kese', 'Live demo']
    },
    {
      id: 'features',
      k: ['features', 'feature', 'options', 'functionality', 'capabilities', 'kya kya kar sakta', 'all features', 'features list', 'modules', 'modul', 'unit', 'kya kya option'],
      a: 'PodVet covers every part of running a clinic. Main modules:<br>- Appointments & daily flowboard<br>- Client & patient records<br>- Medical records (SOAP notes, prescriptions, history)<br>- Vaccination tracker & auto-reminders<br>- Inventory & stock alerts<br>- Invoicing / Quick Bill (POS) & payments<br>- Services & product catalog, coupons<br>- Reporting & profit/loss analytics<br>- SMS, WhatsApp, email & push reminders<br>- Boarding, grooming, daily expenses, vendors<br>- Pet-owner mobile app & online booking<br><br>Each module has its own demo page under <a class="text-brand-700 font-bold underline" href="/demo">/demo</a>, for example <a class="text-brand-700 font-bold underline" href="/features/appointments">Appointments</a>, <a class="text-brand-700 font-bold underline" href="/features/vaccinations">Vaccinations</a> or <a class="text-brand-700 font-bold underline" href="/features/inventory">Inventory</a>. What would you like to know about?',
      c: ['Appointments', 'Vaccinations', 'Client records', 'Medical records', 'Inventory', 'Reporting', 'SMS & WhatsApp']
    },
    {
      id: 'appointments',
      k: ['appointment', 'appointments', 'booking', 'book appointment', 'schedule', 'calendar', 'flowboard', 'slot', 'visit', 'per vet', 'check in', 'reschedule', 'book visit', 'appointment book', 'time slot', 'vet calendar', 'muqarrar'],
      a: 'Appointments in PodVet work as a per-vet daily flowboard. You see every slot, every vet and every patient on one screen. You can book, reschedule, check patients in/out, attach vaccinations, products and services to any visit, and the auto-scheduler fills empty slots for you. Automatic SMS/WhatsApp reminders go out before each visit, which cuts no-shows.<br><br>Try the interactive demo: <a class="text-brand-700 font-bold underline" href="/features/appointments">Appointments demo</a>.',
      c: ['Vaccination reminder kese', 'Reminders setup', 'No-show kaise handle', 'Online booking']
    },
    {
      id: 'vaccinations',
      k: ['vaccination', 'vaccinations', 'vaccine', 'vaccines', 'booster', 'boosters', 'rabies', 'dhpp', 'fvrp', 'anti rabies', 'teeka', 'tipka', 'vaccine due', 'bimaari'],
      a: 'PodVet\'s vaccination tracker looks after your whole patient list. It records every vaccine given, works out when each booster is due, flags overdue pets (e.g. rabies overdue by 9 days), and sends automatic SMS & WhatsApp reminders at 08:00 every day. Clinics see reminder success rates of about 94%.<br><br>Interactive demo: <a class="text-brand-700 font-bold underline" href="/features/vaccinations">Vaccinations demo</a>.',
      c: ['SMS reminder kese', 'WhatsApp reminders', 'Features list']
    },
    {
      id: 'clientrecords',
      k: ['client record', 'client records', 'clients', 'client', 'patient record', 'patient records', 'patients', 'directory', 'owner', 'profiles', 'family profile', 'balance', 'client list', 'pet list', 'records of clients', 'client file'],
      a: 'Client Records keep one profile per owner with every pet, contact details, invoice balance and complete visit history. You can see which clients have unpaid balances (e.g. Rs 2,400 pending), which pets each family has, and re-engage old clients who have not visited in months - all in one click.<br><br>Interactive demo: <a class="text-brand-700 font-bold underline" href="/features/client-records">Client Records demo</a>.',
      c: ['Add client kese', 'Medical records', 'Payments']
    },
    {
      id: 'medicalrecords',
      k: ['medical record', 'medical records', 'soap', 'soap note', 'soap notes', 'prescription', 'prescriptions', 'patient chart', 'health record', 'treatment history', 'visit history', 'vitals', 'chart', 'dictate', 'clinical notes', 'tazkara'],
      a: 'Medical Records is the complete patient chart. Every visit stores a SOAP note (Subjective, Objective, Assessment, Plan), vitals like temperature and heart rate, prescriptions, and full treatment history. Any vet can open a pet\'s file and pick up exactly where the last visit left off.<br><br>You can even dictate your notes and PodVet\'s AI turns the voice into a structured SOAP note automatically, with drug-interaction and dosage warnings while prescribing.<br><br>Interactive demo: <a class="text-brand-700 font-bold underline" href="/features/medical-records">Medical Records demo</a>.',
      c: ['AI se SOAP kese', 'Prescriptions', 'Vaccinations']
    },
    {
      id: 'inventory',
      k: ['inventory', 'stock', 'products', 'product', 'low stock', 'expiry', 'expiring', 'stock level', 'purchase order', 'supplies', 'medication stock', 'store', 'stocks', 'saman', 'items'],
      a: 'Inventory in PodVet tracks everything in real time. Stock reduces automatically after every treatment and sale, you get an alert the moment an item hits its minimum level (e.g. Bravecto 20-40kg with only 3 left), and you can see which products are expiring soon and which make you the most profit per sale. Purchase orders and stock-export are one click away.<br><br>Interactive demo: <a class="text-brand-700 font-bold underline" href="/features/inventory">Inventory demo</a>.',
      c: ['Purchase order kese', 'Reporting', 'Pricing']
    },
    {
      id: 'reporting',
      k: ['reporting', 'reports', 'report', 'analytics', 'profit', 'loss', 'profit and loss', 'revenue', 'income', 'expense', 'expenses', 'earning', 'earnings', 'charts', 'dashboard numbers', 'p&l', 'p and l', 'audit', 'kpi'],
      a: 'Reporting gives you daily, weekly and monthly income vs expense analysis on a single screen - which service earns the most (e.g. vaccinations 96 this month), which vet is most efficient, which hours go empty. Monthly revenue, top services, new patients, average per day - all exportable to bank-ready reports in one click.<br><br>Interactive demo: <a class="text-brand-700 font-bold underline" href="/features/reporting">Reporting demo</a>.',
      c: ['Monthly income report', 'Inventory', 'Expenses']
    },
    {
      id: 'messages',
      k: ['sms', 'whatsapp', 'messaging', 'message', 'messages', 'reminder', 'reminders', 'notification', 'notifications', 'send sms', 'send whatsapp', 'whatsapp business', 'automated message', 'bulk sms', 'text', 'push', 'email reminder', 'opt out', 'template', 'sms kese', 'whatsapp kese', 'msg'],
      a: 'PodVet messages your clients on every channel: SMS, WhatsApp, email and mobile push. Reminders for vaccinations, appointments and unpaid invoices are sent automatically. You write once, and PodVet picks the channel - it sends reminders at 08:00 daily, tracks delivery receipts, handles opt-outs, and clients can reply straight back; the whole conversation stays attached to their file.<br><br>Interactive demo: <a class="text-brand-700 font-bold underline" href="/features/messaging">SMS & WhatsApp demo</a>.',
      c: ['Reminder setup kese', 'Invoice follow-up', 'Contact support']
    },
    {
      id: 'channels',
      k: ['email', 'push', 'mobile push', 'notification channel', 'channels', 'voicemail', 'via email', 'via sms', 'via whatsapp', 'email notifications'],
      a: 'PodVet supports four reminder channels: SMS, WhatsApp, email and mobile push notifications. You can enable them all or per client - for example "send vaccination reminders by SMS, and invoice follow-ups by WhatsApp". Delivery receipts and opt-out handling are automatic on every channel.',
      c: ['SMS & WhatsApp demo', 'Vaccination reminder', 'Pricing']
    },
    {
      id: 'pricing',
      k: ['pricing', 'price', 'plans', 'plan', 'cost', 'costs', 'charges', 'fee', 'fees', 'rates', 'rate', 'monthly', 'per month', 'per vet', 'tariff', 'subscription', 'billing plan', 'package', 'amount', 'price list'],
      a: 'PodVet starts with a <b>1-month free trial - no card required</b>. When you sign up and use a referral code, you get <b>50% off your first invoice</b>. Final plan pricing depends on the size of your practice (solo practitioner, mid-sized clinic or hospital) - talk to our sales team and get a quote that fits you.<br><br>Start free at <a class="text-brand-700 font-bold underline" href="/signup">/signup</a> or ask for a price list at support@podvet.com / +90 552 895 30 15.',
      c: ['Free trial kese', 'Referral code', 'Contact sales']
    },
    {
      id: 'trial',
      k: ['free trial', 'trial', 'signup', 'sign up', 'register', 'create account', 'join', 'get started', 'start free', 'no card', 'trial kese', 'signup kese', 'account banao', 'membership', 'subscribe', 'register karna'],
      a: 'Getting started takes 2 minutes: open <a class="text-brand-700 font-bold underline" href="/signup">/signup</a>, create your clinic account, and you get a <b>1-month free trial with no card required</b>. Use a referral code on the signup form to get <b>50% off your first invoice</b>. Your data stays fully safe and you can invite your whole team right away.',
      c: ['Pricing kya hai', 'Referral code', 'Login kese']
    },
    {
      id: 'login',
      k: ['login', 'log in', 'log in', 'sign in', 'signin', 'app open', 'open app', 'app mein', 'account open', 'login kese', 'access account', 'my account', 'dashboard kholen', 'app kahan'],
      a: 'Open the live app at <a class="text-brand-700 font-bold underline" href="/app">/app</a>. Log in with the email and password you chose at signup. From the dashboard you reach every module - appointments, clients, medical records, inventory, billing, reports and settings.',
      c: ['Free trial kese', 'What is PodVet?', 'Support']
    },
    {
      id: 'contact',
      k: ['contact', 'support', 'help', 'reach', 'phone', 'number', 'email', 'mail', 'call', 'complaint', 'problem', 'issue', 'customer care', 'team se bat', 'contact kese', 'contact number', 'email address', 'info', 'enquiry', 'inquiry', 'salunka', 'raabta'],
      a: 'We are always happy to help. Reach our support team Monday-Friday 09:00-19:00 (UTC+3):<br>- Email: <a class="text-brand-700 font-bold underline" href="mailto:support@podvet.com">support@podvet.com</a><br>- Phone / WhatsApp: <a class="text-brand-700 font-bold underline" href="tel:+905528953015">+90 552 895 30 15</a><br>- Contact page: <a class="text-brand-700 font-bold underline" href="/contact">/contact</a>',
      c: ['Office location', 'Business hours', 'Book a demo']
    },
    {
      id: 'location',
      k: ['location', 'address', 'office', 'where are you', 'kahan ho', 'address kya', 'office kahan', 'maps', 'directions', 'registered office', 'head office', 'headquarters', 'paigaam', 'pata'],
      a: 'PodVet is based in Izmir, Turkiye:<br><b>Mithatpasa Mah. 503 Sokak No:10/2, Menderes, Izmir, Turkiye</b><br><br>Get directions on <a class="text-brand-700 font-bold underline" href="https://www.google.com/maps?q=Mithatpa%C5%9Fa%20Mahallesi%20503%20Sokak%20No%3A10%2F2%2C%20Menderes%2C%20%C4%B0zmir%2C%20T%C3%BCrkiye" target="_blank" rel="noopener" class="text-brand-700 font-bold underline">Google Maps</a> or see the <a class="text-brand-700 font-bold underline" href="/contact">contact page</a>.',
      c: ['Business hours', 'Contact support', 'About PodVet']
    },
    {
      id: 'hours',
      k: ['hours', 'timing', 'timings', 'time', 'open', 'closed', 'close', 'working hours', 'khulne ka time', 'business hours', 'so called 24', '24 7', 'kab khulte'],
      a: 'Our support hours are:<br>- Monday to Friday: 09:00 - 19:00 (UTC+3)<br>- Saturday: 10:00 - 17:00 (UTC+3)<br>- Sunday: Closed (but our systems are monitored 24/7 and email support@podvet.com is always watched).',
      c: ['Contact support', 'Email us', 'Office location']
    },
    {
      id: 'about',
      k: ['about', 'about us', 'company', 'who founded', 'who owns', 'our story', 'story', 'mission', 'founded', 'since when', 'history', 'how old', 'team', 'about podvet', 'company kya'],
      a: 'PodVet was founded in 2018 in Izmir, Turkiye. Today 400+ veterinarians use PodVet to run their clinics, and the practice generates 35,000+ invoices a year. Our mission is simple: give vets more time with patients and less time on paperwork - appointments, records, invoicing and reminders all in one AI-driven platform.<br><br>Read the full story, stats and meet the team on <a class="text-brand-700 font-bold underline" href="/about">the About page</a>.',
      c: ['What is PodVet?', 'Features', 'Contact']
    },
    {
      id: 'demo',
      k: ['demo', 'demo kese', 'preview', 'live demo', 'see how', 'show', 'try it', 'example', 'sample', 'pehle dekhna', 'pressigish'],
      a: 'You can explore every module without creating an account. Open the full interactive demo at <a class="text-brand-700 font-bold underline" href="/demo">/demo</a> - it shows real PodVet screens for Appointments, Vaccinations, Client Records, Medical Records, Inventory, Reporting and SMS/WhatsApp. Each module also has its own page, for example <a class="text-brand-700 font-bold underline" href="/features/vaccinations">Vaccinations</a>.<br><br>And the homepage <a class="text-brand-700 font-bold underline" href="/">/</a> shows live, clickable phone mockups of the app.',
      c: ['Get a free trial', 'Appointments demo', 'Contact sales']
    },
    {
      id: 'blog',
      k: ['blog', 'articles', 'article', 'posts', 'post', 'news', 'tips', 'advice', 'vet articles', 'blog kya', 'read', 'guides', 'guide', 'writings'],
      a: 'The PodVet blog has practical, vet-written articles for pet clinics and pet owners:<br>- <a class="text-brand-700 font-bold underline" href="/blog/vaccinations-matter">Why annual vaccinations still matter</a><br>- <a class="text-brand-700 font-bold underline" href="/blog/puppy-care-guide">First 30 days with a puppy</a><br>- <a class="text-brand-700 font-bold underline" href="/blog/dental-health">Pet dental health</a><br>- <a class="text-brand-700 font-bold underline" href="/blog/nutrition-myths">Pet nutrition myths</a><br><br>See all at <a class="text-brand-700 font-bold underline" href="/blog">/blog</a>.',
      c: ['Vaccination article', 'Puppy care article', 'Blog home']
    },
    {
      id: 'site-docs',
      k: ['documentation', 'documentation page', 'documentation kya', 'docs', 'docs page', 'docs kahan', 'user guide', 'user manual', 'manual', 'how to use', 'how to use podvet', 'tutorial', 'learn podvet', 'guides page'],
      a: 'The <b>Documentation</b> page is now at <a class="text-brand-700 font-bold underline" href="/docs">/docs</a>, linked under the header <b>Resources</b> menu. It has step-by-step guides for every module: getting started &amp; the free trial, appointments &amp; the daily flowboard, clients &amp; patient profiles, SOAP medical records, the vaccination tracker, inventory &amp; vendors, billing &amp; payments, SMS/WhatsApp, reports, and settings &amp; data (including export/import). Each section has quick "jump to" cards so you can go straight to a topic.',
      c: ['Pricing kya hai', 'How to book an appointment', 'Help Center kya hai']
    },
    {
      id: 'site-helpcenter',
      k: ['help center', 'help centre', 'helpcenter', 'help center kya', 'help center page', 'help page', 'helpdesk', 'support page', 'where do i get help', 'assistance page'],
      a: 'The <b>Help Center</b> is at <a class="text-brand-700 font-bold underline" href="/help">/help</a>, linked under the header <b>Resources</b> menu. It lists our contact channels - email support@podvet.com, phone/WhatsApp +90 552 895 30 15 - and opening hours (Mon-Fri 09:00-19:00 UTC+3, Sat 10:00-17:00, Sun closed), plus popular-topic shortcuts into the <a class="text-brand-700 font-bold underline" href="/docs">Documentation</a>, onboarding assistance and free data migration.',
      c: ['Contact support', 'What is documentation', 'FAQ']
    },
    {
      id: 'blogvacc',
      k: ['annual vaccination', 'vaccinations still matter', 'why vaccinations', 'booster article', 'blog vaccination'],
      a: '"Why annual vaccinations still matter" explains how core vaccines (like DHPP and rabies) teach the immune system to fight disease, why booster timing matters, and what happens when protection lapses. Written by Dr. Sana Malik. Read it at <a class="text-brand-700 font-bold underline" href="/blog/vaccinations-matter">/blog/vaccinations-matter</a>.',
      c: ['Puppy care article', 'All blog posts']
    },
    {
      id: 'blogpuppy',
      k: ['puppy', 'puppies', 'new puppy', 'puppy care', '30 days', 'first 30 days', 'puppy guide', 'kutta bacha'],
      a: '"First 30 days with a puppy: a vet\'s guide" covers the essentials: vet check-ups, core vaccines, deworming, feeding schedule, socialization and house-training - a week-by-week plan for a healthy start. Read it at <a class="text-brand-700 font-bold underline" href="/blog/puppy-care-guide">/blog/puppy-care-guide</a>.',
      c: ['Vaccination article', 'Dental health article', 'All blog posts']
    },
    {
      id: 'blogdental',
      k: ['dental', 'teeth', 'tooth', 'dental health', 'fresh breath', 'plaque', 'tartar', 'brush teeth', 'daat'],
      a: '"Pet dental health: more than fresh breath" explains why dental disease affects the whole body, how to spot plaque and tartar, and daily brushing tips - plus why regular professional cleaning matters. Read it at <a class="text-brand-700 font-bold underline" href="/blog/dental-health">/blog/dental-health</a>.',
      c: ['Nutrition article', 'All blog posts']
    },
    {
      id: 'blognutrition',
      k: ['nutrition', 'food', 'diet', 'myths', 'feeding', 'cat food', 'dog food', 'kibble', 'pet food', 'grain free', 'raw diet', 'ghiza'],
      a: '"Pet nutrition myths to stop believing" busts common myths - like whether grain-free is always better or raw is safer - with simple, evidence-based feeding advice. Read it at <a class="text-brand-700 font-bold underline" href="/blog/nutrition-myths">/blog/nutrition-myths</a>.',
      c: ['Puppy care article', 'Dental health article', 'All blog posts']
    },
    {
      id: 'faq',
      k: ['faq', 'question', 'questions', 'frequently asked', 'common questions', 'doubts', 'queries', 'sawal'],
      a: 'We have a full FAQ covering the most common questions about PodVet - features, data, onboarding, support and more. See it at <a class="text-brand-700 font-bold underline" href="/faq">/faq</a>. Or just ask me anything right here!',
      c: ['Pricing kya hai', 'Free trial', 'Data security']
    },
    {
      id: 'privacy',
      k: ['privacy', 'privacy policy', 'personal data', 'data policy', 'gdpr', 'your data', 'khazana', 'privacy'],
      a: 'Your data is yours. PodVet\'s privacy policy explains exactly what we collect, why, and how it is protected - see <a class="text-brand-700 font-bold underline" href="/privacy">/privacy</a>. Short version: clinic and client data is stored securely, access is controlled, and we never sell your data.',
      c: ['Security kese', 'Data migration', 'Terms of use']
    },
    {
      id: 'terms',
      k: ['terms', 'terms of use', 'terms and conditions', 'conditions', 'agreement', 'license', 'legal', 'shartein', 'rules'],
      a: 'The complete terms of use for PodVet are at <a class="text-brand-700 font-bold underline" href="/terms">/terms</a>. It covers using the platform, your responsibilities as a clinic, billing and acceptable use.',
      c: ['Privacy policy', 'Pricing', 'Contact support']
    },
    {
      id: 'migration',
      k: ['migration', 'migrate', 'import', 'export data', 'switch from', 'data transfer', 'move from', 'previous software', 'old software', 'another software', 'transfer data', 'data import', 'onboarding data', 'taawan shuda'],
      a: 'Switching is painless. PodVet offers free data migration support - we help you bring in your clients, patients, medical records, appointments and inventory from your current software so nothing is lost. Just tell our team what system you use and we will plan the move with you.<br><br>Get started via <a class="text-brand-700 font-bold underline" href="/contact">/contact</a> or email support@podvet.com.',
      c: ['Free trial kese', 'Contact migration team', 'Pricing']
    },
    {
      id: 'referral',
      k: ['referral', 'referral code', 'refer', 'friend', 'discount', '50', '50%', 'invite', 'code', 'coupon code', 'refer friend', 'promo', 'dost ko bulana', 'discount code'],
      a: 'Referral codes give you <b>50% off your first invoice</b>. When you sign up at <a class="text-brand-700 font-bold underline" href="/signup">/signup</a>, simply enter a friend\'s referral code in the optional field on the form and your first invoice is half price. A great reason to invite fellow vets!',
      c: ['Pricing kya hai', 'Free trial kese', 'Contact support']
    },
    {
      id: 'employees',
      k: ['employees', 'employee', 'staff', 'team', 'users', 'user', 'vets', 'veterinarian', 'veterinarians', 'roles', 'role', 'permissions', 'access level', 'receptionist', 'add staff', 'team member', 'multi user', 'multiple vets', 'malak'],
      a: 'You can invite your whole team - vets, nurses, receptionists and managers. Each staff member gets a role and permission level (who can view, edit or approve what). The flowboard shows every appointment per vet, and the reporting dashboard tracks which vet is most efficient. Managing users lives under Settings / Users in the app.',
      c: ['Appointments flowboard', 'Reporting', 'Free trial']
    },
    {
      id: 'boarding',
      k: ['boarding', 'pet boarding', 'boarding kya', 'kennel', 'stay', 'residential'],
      a: 'PodVet has a complete boarding module to manage pets staying at your clinic or kennel - check-in and check-out, daily care notes, feeding, medications and owner billing, all in one screen inside the app.',
      c: ['Features list', 'Grooming module', 'Live demo']
    },
    {
      id: 'grooming',
      k: ['grooming', 'groom', 'bath', 'nail trim', 'styling', 'groomers'],
      a: 'The grooming module lets you schedule grooming appointments, log services like baths, nail trims and styling, and bill them - right from the same calendar and client file as every other visit.',
      c: ['Appointments', 'Billing methods', 'Features list']
    },
    {
      id: 'billing',
      k: ['billing', 'invoice', 'invoicing', 'bill', 'bills', 'quick bill', 'pos', 'point of sale', 'invoice kese', 'invoice banao', 'receipt', 'gst', 'tax', 'cash register', 'sale', 'payment bill'],
      a: 'Billing is built into every screen. The Quick Bill (POS) screen lets you add services and products and generate an invoice in seconds; stock deducts automatically from inventory on sale. You can add products to any appointment, apply coupons, print or send the invoice, and track what is still unpaid. Referral / loyalty credit can be applied too.',
      c: ['Payments online', 'Coupons', 'Inventory']
    },
    {
      id: 'payments',
      k: ['payments', 'payment', 'pay', 'pay online', 'payment link', 'card', 'debit', 'credit', 'online payment', 'rupay', 'mastercard', 'visa', 'pending balance', 'due balance', 'follow up invoice', 'pay kese', 'client pay', 'charge'],
      a: 'With PodVet you can send clients an online payment link for any invoice (SMS, WhatsApp or email). They tap the link and pay by card, the payment is recorded, and the balance clears automatically. For pending balances you can send automatic follow-up reminders - no more awkward phone calls.',
      c: ['Invoice follow-up', 'SMS & WhatsApp', 'Billing methods']
    },
    {
      id: 'services',
      k: ['services', 'service', 'price list', 'catalog', 'catalogue', 'rate card', 'service catalog', 'add service', 'fee list', 'consultation fee', 'khidmat'],
      a: 'You keep your own service and product catalog - consultations, vaccinations, surgeries, grooming, lab panels, food and meds - each with its own price. Services appear when booking appointments and on the Quick Bill screen, so invoicing is always fast and consistent.',
      c: ['Quick Bill', 'Inventory', 'Pricing']
    },
    {
      id: 'coupons',
      k: ['coupon', 'coupons', 'discount', 'promo code', 'voucher', 'campaign', 'kharcha cad'],
      a: 'The coupons module lets you create discount vouchers for clients - percentage or fixed amount - and apply them when billing. Great for reactivating old clients or rewarding loyalty.',
      c: ['Referral code', 'Billing methods', 'Payments']
    },
    {
      id: 'vendors',
      k: ['vendors', 'vendor', 'supplier', 'suppliers', 'wholesaler', 'distributor', 'purchase', 'purchases'],
      a: 'Keep all your suppliers in one list. Link purchase orders and stock intake to each vendor so you always know what you bought, from whom and at what cost - important for accurate profit on every product.',
      c: ['Inventory', 'Purchase order', 'Reporting']
    },
    {
      id: 'expenses',
      k: ['expense', 'expenses', 'daily expense', 'cost tracking', 'spending', 'expense entry', 'kharcha', 'roz marra'],
      a: 'Track daily expenses - rent, utilities, staff, supplies - alongside your income. Expenses feed straight into your reporting dashboards, so your daily, weekly and monthly profit/loss is always up to date.',
      c: ['Reporting', 'Profit and loss', 'Features list']
    },
    {
      id: 'loyalty',
      k: ['loyalty', 'loyalty card', 'reward', 'rewards', 'points', 'loyalty program', 'referral loyalty', 'vafadar'],
      a: 'PodVet\'s referral & loyalty module rewards clients who bring new pet parents to your clinic. You can apply loyalty credit or referral rewards directly on invoices at billing time.',
      c: ['Referral code', 'Billing methods', 'Coupons']
    },
    {
      id: 'settings',
      k: ['settings', 'setting', 'theme', 'color', 'brand color', 'clinic profile', 'profile', 'logo', 'customize', 'language setting', 'timezone', 'configure', 'preferences', 'setting kese'],
      a: 'Settings is where you customize everything: your clinic profile and logo, the brand color used across the app (the whole site follows it), staff and permissions, notification preferences, timezone and more. You can even see the saved brand color applied to the marketing site.',
      c: ['Employees', 'Notifications', 'Free trial']
    },
    {
      id: 'superadmin',
      k: ['super admin', 'superadmin', 'platform admin', 'multi clinic', 'multiclinic', 'multi branch', 'branches', 'chain', 'corporate', 'group practice', 'clinic network', 'admin panel'],
      a: 'PodVet also powers large groups. The Super Admin console (at <a class="text-brand-700 font-bold underline" href="/super-admin">/super-admin</a>) lets platform administrators manage multiple clinics, branches and users from one dashboard - feature flags, plan availability, clinic stats and engagement.',
      c: ['Multi user', 'Pricing', 'Contact sales']
    },
    {
      id: 'security',
      k: ['security', 'secure', 'data safe', 'protected', 'encrypted', 'backup', 'backups', 'hacked', 'safe hai', 'secure hai', 'data loss', 'privacy data'],
      a: 'Keeping your data safe is our priority. PodVet stores data securely with controlled access, role-based permissions, and 24/7 system monitoring (even on Sundays when the office is closed). For the full details, see <a class="text-brand-700 font-bold underline" href="/privacy">our privacy policy</a>.',
      c: ['Privacy policy', 'Data migration', 'Contact support']
    },
    {
      id: 'mobile',
      k: ['mobile app', 'app store', 'google play', 'play store', 'is there an app', 'mobile', 'phone app', 'download', 'iphone', 'android', 'pet owner app', 'client app', 'online booking app', 'app download'],
      a: 'Yes! The pet-owner mobile app lets your clients book appointments online, see reminders, receive invoices and follow their pet\'s records - appointment show-up rates improve noticeably. The marketing site shows clickable phone mockups of the app (iPhone and Android) on the homepage <a class="text-brand-700 font-bold underline" href="/#app">/</a>, with Google Play and App Store buttons. The web app itself works on any device browser at <a class="text-brand-700 font-bold underline" href="/app">/app</a>.',
      c: ['Online booking', 'SMS & WhatsApp', 'Live demo']
    },
    {
      id: 'onlinebooking',
      k: ['online booking', 'self booking', 'clients book', 'book online', 'booking link', 'self schedule', 'patient portal', 'khud book'],
      a: 'Clients can book their own appointments through the pet-owner app or a booking link you share - the new appointment appears straight on your flowboard, and the reminder system takes over from there. Fewer phone calls, fewer missed slots.',
      c: ['Mobile app', 'Appointments', 'Reminders']
    },
    {
      id: 'ai',
      k: ['ai', 'artificial intelligence', 'voice', 'dictation', 'voice notes', 'soap ai', 'auto soap', 'drug interaction', 'dosage warning', 'discharge summary', 'referral letter', 'automation', 'smart', 'zabani notes', 'dikhte fazer'],
      a: 'PodVet\'s AI is built for one thing: less paperwork, more care. Dictate your exam notes and AI turns the voice into a structured SOAP note automatically. While prescribing you get drug-interaction and dosage warnings. Discharge summaries and referral letters are drafted in seconds, ready for you to review. AI reminders keep clients on schedule with zero effort from your team.',
      c: ['Medical records', 'Reminders', 'What is PodVet?']
    },
    {
      id: 'dashboard',
      k: ['dashboard', 'overview', 'home screen', 'main screen', 'today', 'todays summary', 'clinic on track', 'kpi cards'],
      a: 'The dashboard is your clinic today at a glance - today\'s visits (with a comparison vs yesterday), upcoming appointments, due vaccinations, pending balances, low-stock alerts and recent activity. Every number is clickable and takes you to that module.',
      c: ['Appointments', 'Reporting', 'Inventory']
    },
    {
      id: 'patients',
      k: ['patients module', 'patient screen', 'patient list screen', 'add pet', 'new patient', 'deceased', 'neutered', 'microchip', 'species',
        'add pet kese', 'pet add'],
      a: 'The Patients module manages every pet: species, breed, sex, color, neutered/spayed status, microchip status, weight, and deceased records when needed. Every patient is linked to their owner\'s client file, so the full family history is always one click away.',
      c: ['Client records', 'Medical records', 'Add client kese']
    },
    {
      id: 'noshow',
      k: ['no show', 'noshow', 'cancel', 'cancellation', 'missed', 'absent', 'reschedule', 'rearrange', 'postpone', 'taaleen', 'moved'],
      a: 'When a client cancels, reschedules or simply doesn\'t show up, you handle it right on the flowboard with one action - and the auto-scheduler can fill the freed slot. Better yet, automatic reminders before each visit cut no-shows dramatically in the first place.',
      c: ['Appointments', 'Reminders', 'Online booking']
    },
    {
      id: 'language',
      k: ['language', 'languages', 'urdu', 'hindi', 'roman urdu', 'english', 'multilingual', 'translate', 'zuban'],
      a: 'I understand English and Roman Urdu - so ask me in whichever you prefer (for example "vaccination reminder kese karein?" or "what is the free trial?"). The PodVet app itself supports your clinic\'s preferred language and timezone, configurable in Settings.',
      c: ['Pricing kya hai', 'Contact', 'Features']
    },
    {
      id: 'onboarding',
      k: ['onboarding', 'setup', 'set up', 'install', 'get started', 'first steps', 'welcome call', 'training', 'setup call', 'start kese', 'shuru'],
      a: 'Onboarding is guided. After you sign up, our team helps you set up your clinic profile, import or add your clients and pets, configure services/prices, and turn on reminder templates. We even offer a setup call so you are fully comfortable before your trial ends.',
      c: ['Free trial kese', 'Data migration', 'Contact support']
    },
    {
      id: 'setupcost',
      k: ['setup cost', 'setup fee', 'installation cost', 'hidden fees', 'one time', 'one-time'],
      a: 'There is no setup or installation fee and no credit card needed for the trial. Your costs are the monthly plan you choose, and with a referral code your first invoice is 50% off. Ask sales for the exact plan pricing at support@podvet.com or +90 552 895 30 15.',
      c: ['Pricing kya hai', 'Free trial', 'Contact sales']
    }
  ]);

  // Normalise keywords once INTENTS exists (must run after assignment, not before).
  for (var ki = 0; ki < INTENTS.length; ki++) {
    var seen = [], normed = [];
    for (var kj = 0; kj < INTENTS[ki].k.length; kj++) {
      var nk = kwNorm(INTENTS[ki].k[kj]);
      if (nk && seen.indexOf(nk) < 0) { seen.push(nk); normed.push(nk); }
    }
    INTENTS[ki].k = normed;
  }

  function bestIntent(text) {
    var best = null, bestScore = 0;
    for (var i = 0; i < INTENTS.length; i++) {
      var it = INTENTS[i], score = 0;
      for (var j = 0; j < it.k.length; j++) {
        if (hit(text, it.k[j])) {
          // Weight by specificity: a longer phrase should outrank a sum of short
          // generic words, otherwise "clinic banane ke baad" (4 words) loses to
          // "clinic banane" + "banane" purely because it is checked first.
          score += it.k[j].split(' ').length;
        }
      }
      if (score > bestScore) { bestScore = score; best = it; }
    }
    return { intent: best, score: bestScore };
  }

  function fallback(text) {
    if (/(podvet|app|software)/.test(text)) {
      return {
        a: 'I want to make sure I help you correctly. I know all about PodVet - features, plans, demo, contact details and more. Could you rephrase, for example "pricing kya hai?" or "how do I book appointments?"?',
        c: ['What is PodVet?', 'Features', 'Pricing', 'Contact']
      };
    }
    return {
      a: 'Sorry, I did not understand that perfectly (I am learning!). You can ask me in English or Roman Urdu. I know about:<br>- Features & every module<br>- Pricing & the free trial<br>- Setups, migration & onboarding<br>- Appointment & reminder questions<br>- Contact details, location & hours<br><br>Try one of these:',
      c: ['Pricing kya hai', 'Features batao', 'Free trial kese', 'Contact number', 'Live demo']
    };
  }

  function respond(raw) {
    var text = norm(raw);
    var res = bestIntent(text);
    var out;
    if (res.intent) {
      var i = res.intent;
      out = { a: i.a, c: i.c, id: i.id, score: res.score, raw: raw };
    } else {
      out = fallback(text);
    }
    addUser(raw);
    typeAnswer(out);
  }

  function addUser(text) {
    var b = document.createElement('div');
    b.className = 'flex justify-end';
    var inner = document.createElement('div');
    inner.className = 'bg-brand-700 text-white p-2.5 rounded-2xl rounded-tr-none max-w-[85%] leading-relaxed';
    inner.textContent = text;
    b.appendChild(inner);
    msgs.appendChild(b);
    showChips([]);
    scrollBottom();
  }

  function typingBubble() {
    var b = document.createElement('div');
    b.className = 'flex justify-start';
    b.innerHTML = '<div class="bg-white border border-gray-100 p-3 rounded-2xl rounded-tl-none shadow-sm text-gray-400"><span id="chat-typing">Typing...</span></div>';
    msgs.appendChild(b);
    scrollBottom();
    return b;
  }

  function typeAnswer(out) {
    var tb = typingBubble();
    var delay = 450 + Math.min(900, (out.a || '').length / 3);
    setTimeout(function () {
      tb.remove();
      var b = document.createElement('div');
      b.className = 'flex justify-start';
      var inner = document.createElement('div');
      inner.className = 'bg-white border border-gray-100 p-2.5 rounded-2xl rounded-tl-none max-w-[92%] shadow-sm leading-relaxed text-gray-700';
      inner.innerHTML = out.a;
      b.appendChild(inner);
      msgs.appendChild(b);
      showChips(out.c || []);
      scrollBottom();
    }, delay);
  }

  function showChips(items) {
    chipsWrap.innerHTML = '';
    if (!items || !items.length) return;
    items.forEach(function (q) {
      if (typeof q !== 'string') return;
      var btn = document.createElement('button');
      btn.textContent = q;
      btn.className = 'text-[11px] bg-brand-50 hover:bg-brand-100 border border-brand-200 text-brand-800 px-3 py-1.5 rounded-full font-semibold transition text-left';
      btn.addEventListener('click', function () { respond(q); });
      chipsWrap.appendChild(btn);
    });
  }

  function scrollBottom() { msgs.scrollTop = msgs.scrollHeight; }

  function send() {
    var v = (input.value || '').trim();
    if (!v) return;
    input.value = '';
    respond(v);
  }

  function openChat() {
    win.classList.remove('hidden');
    if (chipsWrap && !chipsWrap.childElementCount) showChips(OPEN_CHIPS.map(function (c) { return c.label; }));
    setTimeout(function () { input && input.focus(); }, 100);
  }

  toggle.addEventListener('click', function () {
    if (win.classList.contains('hidden')) openChat(); else win.classList.add('hidden');
  });
  closeBtn.addEventListener('click', function () { win.classList.add('hidden'); });
  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') send(); });

  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !win.classList.contains('hidden')) win.classList.add('hidden');
  });
})();