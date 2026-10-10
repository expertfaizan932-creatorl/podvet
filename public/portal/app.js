/* PodVet Customer Portal — self-contained SPA (no build step, no deps).
   Session lives in localStorage under `podvet_portal_session`; every API call
   hits /api/portal/* with the portal JWT. */
(function () {
  'use strict';

  var SESS_KEY = 'podvet_portal_session';
  var qs = new URLSearchParams(location.search);
  var state = {
    token: null,
    profile: null,
    clinic: null,
    clinicId: Number(qs.get('c') || qs.get('clinicId') || 0) || 0,
    navOpen: false,
    notif: { items: [], unread: 0 },
    pollTimer: null,
  };

  // ── session ──
  function loadSess() { try { return JSON.parse(localStorage.getItem(SESS_KEY) || 'null'); } catch (e) { return null; } }
  function saveSess(s) { try { localStorage.setItem(SESS_KEY, JSON.stringify(s)); } catch (e) {} }
  function clearSess() { try { localStorage.removeItem(SESS_KEY); } catch (e) {} }

  // ── api ──
  async function api(path, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    if (opts.auth !== false && state.token) headers.Authorization = 'Bearer ' + state.token;
    var res;
    try {
      res = await fetch(path, { method: opts.method || 'GET', headers: headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
    } catch (e) {
      throw new Error('Could not reach the clinic. Check your connection and try again.');
    }
    var data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) {
      if (res.status === 401 && opts.auth !== false) { signOutLocal(); }
      var msg = (data && data.error && data.error.message) || ('Request failed (' + res.status + ')');
      var err = new Error(msg); err.status = res.status; throw err;
    }
    return data;
  }

  // ── hyperscript ──
  function el(tag, props) {
    var node = document.createElement(tag);
    if (props) for (var k in props) {
      var v = props[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'dataset') { for (var d in v) node.dataset[d] = v[d]; }
      else if (k === 'style' && typeof v === 'object') { for (var s in v) node.style[s] = v[s]; }
      else if (k.indexOf('on') === 0 && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (var i = 2; i < arguments.length; i++) {
      var kid = arguments[i];
      if (kid === null || kid === undefined || kid === false) continue;
      if (Array.isArray(kid)) { kid.forEach(function (k2) { if (k2 !== null && k2 !== undefined && k2 !== false) node.appendChild(typeof k2 === 'string' ? document.createTextNode(k2) : k2); }); }
      else node.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    }
    return node;
  }
  function svg(inner) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>'; }
  var ICONS = {
    dashboard: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
    pets: '<circle cx="11" cy="4" r="2"/><circle cx="18" cy="8" r="2"/><circle cx="4" cy="8" r="2"/><path d="M11 12c-3 0-6 2-6 5a3 3 0 0 0 6 0c0-3 3-3 6 0a3 3 0 0 0 6 0c0-3-3-5-6-5"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M3 10h18M8 2v4M16 2v4"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 13h6M9 17h6"/>',
    home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V10"/>',
    card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
    bell: '<path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3-8.6A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.2a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    x: '<path d="M18 6L6 18M6 6l12 12"/>',
    paw: '<circle cx="11" cy="4" r="2"/><circle cx="18" cy="8" r="2"/><circle cx="4" cy="8" r="2"/><path d="M11 12c-3 0-6 2-6 5a3 3 0 0 0 6 0c0-3 3-3 6 0a3 3 0 0 0 6 0c0-3-3-5-6-5"/>',
    wallet: '<path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/>',
    tag: '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><circle cx="7" cy="7" r="1.5"/>',
    alert: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/>',
    message: '<path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7A8.5 8.5 0 0 1 12 3a8.38 8.38 0 0 1 9 8.5z"/>',
  };
  function icon(name, cls) { return el('span', { class: cls || 'ic', html: svg(ICONS[name] || '') }); }

  function logoUrl() { return (state.clinic && state.clinic.logoUrl) || '/brand/icon-primary.png'; }
  function clinicName() { return (state.clinic && state.clinic.clinicName) || 'PodVet'; }
  function fmtDate(d) { if (!d) return '—'; var x = new Date(d); if (isNaN(x)) return String(d); return x.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
  function fmtDateTime(d) { if (!d) return ''; var x = new Date(d); if (isNaN(x)) return String(d); return x.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  function money(n) { return 'Rs ' + Number(n || 0).toLocaleString(); }
  function initials(s) { s = (s || '?').trim(); return s ? s.slice(0, 1).toUpperCase() : '?'; }

  // ── toast + modal ──
  function toast(msg, kind) {
    var wrap = document.querySelector('.pv-toast-wrap');
    if (!wrap) { wrap = el('div', { class: 'pv-toast-wrap' }); document.body.appendChild(wrap); }
    var t = el('div', { class: 'pv-toast ' + (kind || ''), text: msg });
    wrap.appendChild(t);
    setTimeout(function () { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(function () { t.remove(); }, 300); }, 3200);
  }
  function openModal(title, bodyNode, footNodes) {
    var backdrop = document.getElementById('pv-portal-modal');
    backdrop.hidden = false;
    backdrop.innerHTML = '';
    function close() { backdrop.hidden = true; backdrop.innerHTML = ''; }
    var modal = el('div', { class: 'pv-modal' },
      el('div', { class: 'pv-modal-head' }, el('h3', { text: title }), el('button', { class: 'pv-x', type: 'button', onClick: close, html: '&times;' })),
      el('div', { class: 'pv-modal-body' }, bodyNode),
      footNodes ? el('div', { class: 'pv-modal-foot' }, footNodes) : null,
    );
    backdrop.appendChild(modal);
    backdrop.onclick = function (e) { if (e.target === backdrop) close(); };
    return close;
  }
  function confirmDialog(title, message, onYes) {
    var close = openModal(title, el('p', { class: 'pv-muted', style: { margin: '0' }, text: message }),
      [el('button', { class: 'pv-btn pv-btn-ghost', onClick: function () { close(); } }, 'Cancel'),
       el('button', { class: 'pv-btn pv-btn-danger', onClick: function () { close(); onYes(); } }, 'Confirm')]);
  }

  // ── field helper ──
  function field(label, input) { return el('div', { class: 'pv-field' }, el('label', { text: label }), input); }
  function input(props) { return el('input', props); }
  function select(props, options) {
    var s = el('select', props);
    options.forEach(function (o) { s.appendChild(el('option', { value: o.value, text: o.label, selected: o.selected })); });
    return s;
  }

  // ── routing ──
  var NAV = [
    { key: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
    { key: 'pets', label: 'My Pets', icon: 'pets' },
    { key: 'appointments', label: 'Appointments', icon: 'calendar' },
    { key: 'medical-records', label: 'Medical Records', icon: 'file' },
    { key: 'boarding', label: 'Boarding', icon: 'home' },
    { key: 'billing', label: 'Billing', icon: 'wallet' },
    { key: 'notifications', label: 'Notifications', icon: 'bell' },
    { key: 'profile', label: 'Profile', icon: 'user' },
    { key: 'contact', label: 'Contact Clinic', icon: 'phone' },
  ];
  function currentRoute() {
    var h = (location.hash || '').replace(/^#\/?/, '').split('?')[0];
    return h || 'dashboard';
  }
  function go(route) { location.hash = '#/' + route; state.navOpen = false; }

  // ── auth screens ──
  async function ensureClinic() {
    if (state.clinic && state.clinicId) return;
    var cid = state.clinicId || 1;
    try {
      var r = await api('/api/portal/clinic-info?c=' + cid, { auth: false });
      state.clinic = r.data; state.clinicId = r.data.clinicId || cid;
    } catch (e) { state.clinicId = state.clinicId || 1; }
  }

  function renderAuth(mode) {
    var root = document.getElementById('pv-portal-root');
    root.innerHTML = '';
    var errBox = el('div', { class: 'pv-alert pv-alert-error', style: { display: 'none' } });
    function fail(msg) { errBox.textContent = msg; errBox.style.display = 'block'; }

    var isLogin = mode === 'login';
    var form;
    if (isLogin) {
      var email = input({ type: 'email', placeholder: 'you@example.com', autocomplete: 'email' });
      var pass = input({ type: 'password', placeholder: 'Your password', autocomplete: 'current-password' });
      form = el('form', {
        onSubmit: async function (e) {
          e.preventDefault();
          var btn = form.querySelector('button[type=submit]'); btn.disabled = true;
          try {
            var r = await api('/api/portal/login', { method: 'POST', auth: false, body: { clinicId: state.clinicId || 1, email: email.value.trim(), password: pass.value } });
            adoptSession(r);
          } catch (ex) { fail(ex.message); btn.disabled = false; }
        }
      }, errBox, field('Email', email), field('Password', pass),
        el('button', { class: 'pv-btn pv-btn-primary pv-btn-block', type: 'submit' }, 'Sign in'));
    } else {
      var rname = input({ type: 'text', placeholder: 'Your full name' });
      var remail = input({ type: 'email', placeholder: 'you@example.com' });
      var rphone = input({ type: 'tel', placeholder: 'Phone number' });
      var raddr = input({ type: 'text', placeholder: 'Address (optional)' });
      var rpass = input({ type: 'password', placeholder: 'At least 6 characters' });
      var petName = input({ type: 'text', placeholder: "Your pet's name (optional)" });
      var petSpecies = select({}, [{ value: 'Dog', label: 'Dog' }, { value: 'Cat', label: 'Cat' }, { value: 'Bird', label: 'Bird' }, { value: 'Other', label: 'Other' }]);
      form = el('form', {
        onSubmit: async function (e) {
          e.preventDefault();
          var btn = form.querySelector('button[type=submit]'); btn.disabled = true;
          try {
            var body = { clinicId: state.clinicId || 1, fullName: rname.value.trim(), email: remail.value.trim(), phone: rphone.value.trim(), address: raddr.value.trim(), password: rpass.value };
            if (petName.value.trim()) body.pet = { petName: petName.value.trim(), species: petSpecies.value };
            var r = await api('/api/portal/register', { method: 'POST', auth: false, body: body });
            adoptSession(r);
            toast('Welcome! Your account is ready.', 'ok');
          } catch (ex) { fail(ex.message); btn.disabled = false; }
        }
      }, errBox,
        field('Full name', rname), field('Email', remail),
        el('div', { class: 'pv-row' }, field('Phone', rphone), field('Address', raddr)),
        field('Password', rpass),
        el('div', { class: 'pv-row' }, field('Pet name (optional)', petName), field('Species', petSpecies)),
        el('button', { class: 'pv-btn pv-btn-primary pv-btn-block', type: 'submit' }, 'Create account'));
    }

    var aside = el('aside', { class: 'pv-auth-aside' },
      el('div', { class: 'pv-auth-brand' }, el('img', { src: logoUrl(), alt: '' }), el('span', { text: clinicName() })),
      el('div', {},
        el('h1', { text: 'Everything about your pet, in one place.' }),
        el('p', { text: 'Book visits, follow medical records, manage boarding and settle bills — anytime, from any device.' }),
        el('ul', { class: 'pv-auth-features' },
          el('li', {}, icon('calendar', 'ic'), 'See upcoming appointments and request new ones'),
          el('li', {}, icon('file', 'ic'), 'Read your vet’s notes, vaccinations and lab results'),
          el('li', {}, icon('home', 'ic'), 'Track boarding stays and daily care'),
          el('li', {}, icon('wallet', 'ic'), 'View invoices and outstanding balance'))),
      el('div', { class: 'pv-muted', style: { fontSize: '12px', opacity: '.7' }, text: 'Powered by PodVet' }));

    var main = el('main', { class: 'pv-auth-main' },
      el('div', { class: 'pv-auth-card' },
        el('h2', { text: isLogin ? 'Welcome back' : 'Create your account' }),
        el('p', { class: 'sub', text: isLogin ? 'Sign in to ' + clinicName() : 'Set up your pet portal in a minute.' }),
        form,
        el('div', { class: 'pv-auth-switch' },
          isLogin ? 'New here? ' : 'Already have an account? ',
          el('a', { href: '#', onClick: function (e) { e.preventDefault(); renderAuth(isLogin ? 'register' : 'login'); } }, isLogin ? 'Create an account' : 'Sign in'))));

    root.appendChild(el('div', { class: 'pv-auth' }, aside, main));
  }

  function adoptSession(r) {
    state.token = r.accessToken;
    state.profile = r.profile;
    state.clinic = r.clinic || state.clinic;
    if (!state.clinicId) state.clinicId = 1;
    saveSess({ accessToken: r.accessToken, profile: r.profile, clinic: state.clinic, clinicId: state.clinicId });
    if (!location.hash) location.hash = '#/dashboard';
    startPolling();
    render();
  }
  function signOutLocal() {
    state.token = null; state.profile = null; clearSess();
    stopPolling();
    renderAuth('login');
  }

  // ── notifications ──
  async function refreshNotifications() {
    try {
      var r = await api('/api/portal/notifications?limit=30');
      state.notif.items = r.data || [];
      state.notif.unread = r.unread || 0;
      var badge = document.getElementById('pv-portal-bell-badge');
      if (badge) { badge.textContent = state.notif.unread; badge.style.display = state.notif.unread > 0 ? 'flex' : 'none'; }
      var panelList = document.getElementById('pv-portal-bell-list');
      if (panelList) renderBellList(panelList);
    } catch (e) {}
  }
  function startPolling() { stopPolling(); state.pollTimer = setInterval(refreshNotifications, 25000); refreshNotifications(); }
  function stopPolling() { if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; } }

  function notifIcon(cat) {
    var map = { appointment: 'calendar', payment: 'wallet', billing: 'wallet', boarding: 'home', record: 'file', pet: 'pets', client: 'user', inventory: 'pets', offer: 'tag', promotion: 'tag', alert: 'alert', general: 'message', message: 'message' };
    return map[cat] || 'bell';
  }
  function renderBellList(container) {
    container.innerHTML = '';
    if (!state.notif.items.length) {
      container.appendChild(el('div', { class: 'pv-empty', style: { padding: '30px 16px' } }, icon('bell', 'ic'), el('h3', { text: 'No notifications yet' })));
      return;
    }
    state.notif.items.slice(0, 12).forEach(function (n) {
      container.appendChild(el('div', { class: 'pv-list-item' + (n.isRead ? '' : ' unread') },
        icon(notifIcon(n.category)),
        el('div', { class: 'body' },
          el('div', { class: 'title', text: n.title }),
          n.message ? el('div', { class: 'msg', text: n.message }) : null,
          el('div', { class: 'meta', text: fmtDateTime(n.createdAt) }))));
    });
  }

  function bellButton() {
    var panel = el('div', { class: 'pv-bell-panel', hidden: true },
      el('div', { class: 'pv-bell-head' }, el('strong', { text: 'Notifications' }),
        el('button', { class: 'pv-btn pv-btn-sm pv-btn-ghost', onClick: async function () { try { await api('/api/portal/notifications/read-all', { method: 'POST' }); toast('Marked all as read', 'ok'); refreshNotifications(); } catch (e) {} } }, 'Mark all read')),
      el('div', { class: 'pv-bell-list', id: 'pv-portal-bell-list' }),
      el('div', { class: 'pv-bell-foot' }, el('a', { href: '#/notifications', onClick: function () { go('notifications'); panel.hidden = true; } }, 'View all')));
    renderBellList(panel.querySelector('#pv-portal-bell-list'));
    var btn = el('button', { class: 'pv-iconbtn', title: 'Notifications', onClick: function (e) { e.stopPropagation(); panel.hidden = !panel.hidden; } },
      icon('bell', 'ic'), el('span', { class: 'dot', id: 'pv-portal-bell-badge', text: state.notif.unread || '', style: { display: state.notif.unread > 0 ? 'flex' : 'none' } }));
    var wrap = el('div', { class: 'pv-bell-wrap' }, btn, panel);
    document.addEventListener('click', function closeP(e) { if (!wrap.contains(e.target)) panel.hidden = true; });
    return wrap;
  }

  // ── shell ──
  function shell(contentNode) {
    var root = document.getElementById('pv-portal-root');
    root.innerHTML = '';
    var route = currentRoute();
    var nav = el('nav', { class: 'pv-nav' });
    NAV.forEach(function (item) {
      var a = el('a', { href: '#/' + item.key, class: route === item.key ? 'active' : '', onClick: function (e) { e.preventDefault(); closeNav(); go(item.key); } },
        icon(item.icon), item.label,
        item.key === 'notifications' ? el('span', { class: 'badge', style: { display: state.notif.unread > 0 ? '' : 'none' }, text: state.notif.unread }) : null);
      nav.appendChild(a);
    });
    var sidebar = el('aside', { class: 'pv-sidebar' },
      el('div', { class: 'pv-side-brand' }, el('img', { src: logoUrl(), alt: '' }),
        el('div', {}, el('span', { text: clinicName() }), el('small', { text: 'Pet Portal' }))),
      nav,
      el('div', { class: 'pv-side-foot' },
        el('button', { class: 'pv-btn pv-btn-ghost pv-btn-sm pv-btn-block', onClick: signOut }, icon('logout'), 'Sign out')));
    var title = (NAV.find(function (n) { return n.key === route; }) || {}).label || 'Dashboard';
    var topbar = el('header', { class: 'pv-topbar' },
      el('button', { class: 'pv-menu-btn', onClick: toggleNav }, icon('dashboard', 'ic')),
      el('h2', { text: title }),
      bellButton());
    var shellEl = el('div', { class: 'pv-shell' + (state.navOpen ? ' nav-open' : '') },
      sidebar,
      el('main', { class: 'pv-main' }, topbar, el('div', { class: 'pv-content' }, contentNode)));
    root.appendChild(shellEl);
  }
  function toggleNav() { state.navOpen = !state.navOpen; var s = document.querySelector('.pv-shell'); if (s) s.classList.toggle('nav-open', state.navOpen); }
  function closeNav() { state.navOpen = false; var s = document.querySelector('.pv-shell'); if (s) s.classList.remove('nav-open'); }

  function signOut() {
    confirmDialog('Sign out', 'You will need to sign in again to access your pet portal.', function () {
      signOutLocal(); toast('Signed out');
    });
  }

  // ── pages ──
  async function render() {
    if (!state.token) { await ensureClinic(); renderAuth('login'); return; }
    var root = document.getElementById('pv-portal-root');
    root.innerHTML = '';
    root.appendChild(el('div', { class: 'pv-boot', style: { minHeight: '60vh' } }, el('div', { class: 'pv-spinner' })));
    await ensureClinic();
    var route = currentRoute();
    var builder = PAGES[route] || PAGES.dashboard;
    var node;
    try { node = await builder(); }
    catch (e) { node = el('div', { class: 'pv-empty' }, el('h3', { text: 'Could not load this page' }), el('p', { text: e.message })); }
    shell(node);
    if (route === 'notifications') refreshNotifications();
  }

  function pageHead(title, sub, actions) {
    return el('div', { class: 'pv-page-head' },
      el('div', {}, el('h1', { text: title }), sub ? el('p', { text: sub }) : null),
      actions ? el('div', { class: 'pv-flex pv-wrap' }, actions) : null);
  }
  function empty(iconName, title, msg) {
    return el('div', { class: 'pv-empty' }, icon(iconName, 'ic'), el('h3', { text: title }), msg ? el('p', { text: msg }) : null);
  }

  var PAGES = {};

  PAGES.dashboard = async function () {
    var r = await api('/api/portal/dashboard');
    var d = r.data;
    var stats = el('div', { class: 'pv-grid pv-grid-4' },
      statCard('teal', 'pets', d.pets, 'Pets'),
      statCard('blue', 'calendar', d.upcomingAppointments.length, 'Upcoming visits'),
      statCard('amber', 'home', d.activeBoarding, 'Boarding now'),
      statCard(d.outstandingDue > 0 ? 'red' : 'teal', 'wallet', money(d.outstandingDue), 'Outstanding'));
    var up = el('div', { class: 'pv-card pv-card-pad pv-mt-16' },
      el('div', { class: 'pv-between' }, el('h3', { class: 'pv-section-title', text: 'Upcoming appointments' }),
        el('a', { href: '#/appointments', onClick: function (e) { e.preventDefault(); go('appointments'); } }, 'View all')),
      d.upcomingAppointments.length ? el('div', { class: 'pv-list' }, d.upcomingAppointments.map(function (a) {
        return el('div', { class: 'pv-list-item' }, icon('calendar'),
          el('div', { class: 'body' }, el('div', { class: 'title', text: a.petName || 'Appointment' }),
            el('div', { class: 'meta', text: fmtDate(a.appointmentDate) + (a.appointmentTime ? ' · ' + a.appointmentTime : '') + (a.doctor ? ' · ' + a.doctor : '') })),
          el('span', { class: 'pv-pill green', text: a.status }));
      })) : empty('calendar', 'No upcoming visits', 'Book an appointment to see it here.'));
    return el('div', {}, pageHead('Dashboard', 'A quick look at ' + ((state.profile && state.profile.fullName) || 'your') + '\u2019s pets'),
      d.unreadNotifications > 0 ? el('div', { class: 'pv-alert pv-alert-ok', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
        el('span', { text: 'You have ' + d.unreadNotifications + ' unread notification(s).' }),
        el('button', { class: 'pv-btn pv-btn-sm pv-btn-ghost', onClick: function () { go('notifications'); } }, 'Open')) : null,
      stats, up);
  };
  function statCard(tone, iconName, value, label) {
    return el('div', { class: 'pv-card pv-card-pad pv-stat' },
      el('div', { class: 'ic ' + tone }, icon(iconName)),
      el('div', { class: 'n', text: String(value) }), el('div', { class: 'l', text: label }));
  }

  PAGES.pets = async function () {
    var r = await api('/api/portal/pets');
    var list = r.data || [];
    function petCard(p) {
      return el('div', { class: 'pv-card pv-card-pad' },
        el('div', { class: 'pv-pet-card' },
          el('div', { class: 'pv-avatar', text: initials(p.petName) }),
          el('div', { style: { flex: '1', minWidth: '0' } },
            el('div', { style: { fontWeight: '700', fontSize: '16px' }, text: p.petName }),
            el('div', { class: 'pv-muted', style: { fontSize: '13.5px' }, text: [p.species, p.breed, p.sex].filter(Boolean).join(' · ') }),
            el('div', { class: 'pv-muted', style: { fontSize: '12.5px', marginTop: '4px' }, text: p.dateOfBirth ? 'Born ' + fmtDate(p.dateOfBirth) : (p.age ? 'Age: ' + p.age : '') }))),
        el('div', { class: 'pv-flex', style: { marginTop: '12px', gap: '8px' } },
          el('button', { class: 'pv-btn pv-btn-sm pv-btn-ghost', onClick: function () { openPetForm(p); } }, 'Edit'),
          el('a', { class: 'pv-btn pv-btn-sm pv-btn-ghost', href: '#/medical-records', onClick: function (e) { e.preventDefault(); go('medical-records'); } }, 'Records')));
    }
    function openPetForm(p) {
      var name = input({ type: 'text', value: p ? p.petName : '' });
      var species = input({ type: 'text', value: p ? p.species : '', placeholder: 'Dog, Cat…' });
      var breed = input({ type: 'text', value: p ? p.breed : '' });
      var sex = select({}, [{ value: 'Male', label: 'Male', selected: p && p.sex === 'Male' }, { value: 'Female', label: 'Female', selected: p && p.sex === 'Female' }, { value: 'Unknown', label: 'Unknown', selected: !p || p.sex === 'Unknown' }]);
      var dob = input({ type: 'date', value: p && p.dateOfBirth ? String(p.dateOfBirth).slice(0, 10) : '' });
      var body = el('div', {}, field('Name', name), el('div', { class: 'pv-row' }, field('Species', species), field('Breed', breed)), el('div', { class: 'pv-row' }, field('Sex', sex), field('Date of birth', dob)));
      var saveBtn = el('button', { class: 'pv-btn pv-btn-primary' }, p ? 'Save changes' : 'Add pet');
      var close = openModal(p ? 'Edit pet' : 'Add a pet', body, [el('button', { class: 'pv-btn pv-btn-ghost', onClick: function () { close(); } }, 'Cancel'), saveBtn]);
      saveBtn.onclick = async function () {
        var payload = { petName: name.value.trim(), species: species.value.trim() || 'Dog', breed: breed.value.trim(), sex: sex.value, dateOfBirth: dob.value || null };
        if (!payload.petName) { toast('Pet name is required', 'err'); return; }
        try {
          if (p) await api('/api/portal/pets/' + p.id, { method: 'PATCH', body: payload });
          else await api('/api/portal/pets', { method: 'POST', body: payload });
          close(); toast(p ? 'Pet updated' : 'Pet added', 'ok'); render();
        } catch (e) { toast(e.message, 'err'); }
      };
    }
    return el('div', {}, pageHead('My Pets', 'Manage your furry, feathered and scaly family', el('button', { class: 'pv-btn pv-btn-primary', onClick: function () { openPetForm(null); } }, icon('plus'), 'Add pet')),
      list.length ? el('div', { class: 'pv-grid pv-grid-3' }, list.map(petCard)) : empty('pets', 'No pets yet', 'Add your first pet to get started.'));
  };

  PAGES.appointments = async function () {
    var r = await api('/api/portal/appointments');
    var pets = (await api('/api/portal/pets')).data || [];
    var list = r.data || [];
    function statusPill(s) {
      var map = { CONFIRMED: 'green', CANCELLED: 'red', COMPLETED: 'blue' };
      return el('span', { class: 'pv-pill ' + (map[s] || 'grey'), text: s });
    }
    function bookForm() {
      if (!pets.length) { toast('Add a pet first', 'err'); return; }
      var petSel = select({}, pets.map(function (p) { return { value: p.id, label: p.petName }; }));
      var date = input({ type: 'date', min: new Date().toISOString().slice(0, 10) });
      var time = input({ type: 'time' });
      var notes = el('textarea', { rows: '3', placeholder: 'Reason for visit (optional)' });
      var body = el('div', {}, field('Pet', petSel), el('div', { class: 'pv-row' }, field('Preferred date', date), field('Preferred time', time)), field('Notes', notes));
      var saveBtn = el('button', { class: 'pv-btn pv-btn-primary' }, 'Request appointment');
      var close = openModal('Request an appointment', body, [el('button', { class: 'pv-btn pv-btn-ghost', onClick: function () { close(); } }, 'Cancel'), saveBtn]);
      saveBtn.onclick = async function () {
        if (!date.value) { toast('Choose a date', 'err'); return; }
        saveBtn.disabled = true;
        try {
          await api('/api/portal/appointments', { method: 'POST', body: { petId: Number(petSel.value), appointmentDate: date.value, appointmentTime: time.value || null, notes: notes.value } });
          close(); toast('Appointment requested', 'ok'); render();
        } catch (e) { toast(e.message, 'err'); saveBtn.disabled = false; }
      };
    }
    return el('div', {}, pageHead('Appointments', 'Request visits and track their status', el('button', { class: 'pv-btn pv-btn-primary', onClick: bookForm }, icon('plus'), 'Book appointment')),
      list.length ? el('div', { class: 'pv-card' }, el('table', { class: 'pv-table' },
        el('thead', {}, el('tr', {}, el('th', { text: 'Pet' }), el('th', { text: 'Date' }), el('th', { text: 'Time' }), el('th', { text: 'Doctor' }), el('th', { text: 'Status' }), el('th', { text: '' }))),
        el('tbody', {}, list.map(function (a) {
          var canCancel = a.status === 'CONFIRMED' && String(a.appointmentDate).slice(0, 10) >= new Date().toISOString().slice(0, 10);
          return el('tr', {},
            el('td', { text: a.petName || '—' }), el('td', { text: fmtDate(a.appointmentDate) }), el('td', { text: a.appointmentTime || '—' }),
            el('td', { text: a.doctor || '—' }), el('td', {}, statusPill(a.status)),
            el('td', {}, canCancel ? el('button', { class: 'pv-btn pv-btn-sm pv-btn-danger', onClick: function () { confirmDialog('Cancel appointment', 'Cancel the visit on ' + fmtDate(a.appointmentDate) + '?', async function () { try { await api('/api/portal/appointments/' + a.id, { method: 'PATCH', body: { status: 'CANCELLED' } }); toast('Appointment cancelled', 'ok'); render(); } catch (e) { toast(e.message, 'err'); } }); } }, 'Cancel') : null));
        })))) : empty('calendar', 'No appointments yet', 'Tap “Book appointment” to request a visit.'));
  };

  PAGES['medical-records'] = async function () {
    var r = await api('/api/portal/medical-records');
    var d = r.data || { soapNotes: [], vaccinations: [], dewormings: [] };
    function noteCard(n) {
      return el('div', { class: 'pv-card pv-card-pad pv-mt-16' },
        el('div', { class: 'pv-between' }, el('strong', { text: (n.petName || '') + ' — ' + fmtDate(n.createdAt) }), n.doctor ? el('span', { class: 'pv-muted', style: { fontSize: '13px' }, text: 'Dr. ' + n.doctor }) : null),
        noteRow('Subjective', n.subjective), noteRow('Objective', n.objective), noteRow('Assessment', n.assessment), noteRow('Diagnosis', n.diagnosis), noteRow('Plan', n.plan));
    }
    function noteRow(label, val) { return val ? el('div', { style: { marginTop: '8px' } }, el('div', { class: 'pv-muted', style: { fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.03em' }, text: label }), el('div', { style: { fontSize: '14px' }, text: val })) : null; }
    function table(headers, rows) {
      return el('div', { class: 'pv-card pv-mt-16' }, el('table', { class: 'pv-table' }, el('thead', {}, el('tr', {}, headers.map(function (h) { return el('th', { text: h }); }))), el('tbody', {}, rows)));
    }
    return el('div', {}, pageHead('Medical Records', 'Your pets’ clinical history, vaccinations and deworming'),
      el('h3', { class: 'pv-section-title', text: 'Visit notes' }),
      d.soapNotes.length ? el('div', {}, d.soapNotes.map(noteCard)) : empty('file', 'No visit notes yet', 'Records added by your vet will appear here.'),
      el('h3', { class: 'pv-section-title pv-mt-16', text: 'Vaccinations' }),
      d.vaccinations.length ? table(['Pet', 'Vaccine', 'Given', 'Next due'], d.vaccinations.map(function (v) { return el('tr', {}, el('td', { text: v.petName }), el('td', { text: v.vaccineName || '—' }), el('td', { text: fmtDate(v.administeredOn) }), el('td', { text: v.nextDueDate ? fmtDate(v.nextDueDate) : '—' })); })) : empty('check', 'No vaccinations on file'),
      el('h3', { class: 'pv-section-title pv-mt-16', text: 'Deworming' }),
      d.dewormings.length ? table(['Pet', 'Product', 'Given', 'Next due'], d.dewormings.map(function (v) { return el('tr', {}, el('td', { text: v.petName }), el('td', { text: v.productName || '—' }), el('td', { text: fmtDate(v.administeredOn) }), el('td', { text: v.nextDueDate ? fmtDate(v.nextDueDate) : '—' })); })) : empty('check', 'No deworming records'));
  };

  PAGES.boarding = async function () {
    var r = await api('/api/portal/boarding');
    var pets = (await api('/api/portal/pets')).data || [];
    var list = r.data || [];
    function requestForm() {
      if (!pets.length) { toast('Add a pet first', 'err'); return; }
      var petSel = select({}, pets.map(function (p) { return { value: p.id, label: p.petName }; }));
      var from = input({ type: 'date', value: new Date().toISOString().slice(0, 10) });
      var to = input({ type: 'date' });
      var notes = el('textarea', { rows: '3', placeholder: 'Feeding notes, medication, temperament…' });
      var body = el('div', {}, field('Pet', petSel), el('div', { class: 'pv-row' }, field('From', from), field('Expected checkout', to)), field('Notes', notes));
      var saveBtn = el('button', { class: 'pv-btn pv-btn-primary' }, 'Send request');
      var close = openModal('Request boarding', body, [el('button', { class: 'pv-btn pv-btn-ghost', onClick: function () { close(); } }, 'Cancel'), saveBtn]);
      saveBtn.onclick = async function () {
        saveBtn.disabled = true;
        try { await api('/api/portal/boarding', { method: 'POST', body: { petId: Number(petSel.value), dateIn: from.value || null, expectedCheckoutDate: to.value || null, notes: notes.value } }); close(); toast('Boarding requested', 'ok'); render(); }
        catch (e) { toast(e.message, 'err'); saveBtn.disabled = false; }
      };
    }
    function pill(s) { var map = { ACTIVE: 'amber', CHECKED_OUT: 'gray', REQUESTED: 'teal' }; return el('span', { class: 'pv-pill ' + (map[s] || 'grey'), text: s }); }
    return el('div', {}, pageHead('Boarding', 'Request and follow your pet’s stays', el('button', { class: 'pv-btn pv-btn-primary', onClick: requestForm }, icon('plus'), 'Request boarding')),
      list.length ? el('div', { class: 'pv-card' }, el('table', { class: 'pv-table' },
        el('thead', {}, el('tr', {}, el('th', { text: 'Pet' }), el('th', { text: 'From' }), el('th', { text: 'Expected out' }), el('th', { text: 'Purpose' }), el('th', { text: 'Status' }))),
        el('tbody', {}, list.map(function (s) { return el('tr', {}, el('td', { text: s.petName }), el('td', { text: fmtDate(s.dateIn) }), el('td', { text: s.expectedCheckoutDate ? fmtDate(s.expectedCheckoutDate) : '—' }), el('td', { text: s.purpose || 'Boarding' }), el('td', {}, pill(s.status))); })))) :
        empty('home', 'No boarding stays', 'Request a stay and the clinic will confirm availability.'));
  };

  PAGES.billing = async function () {
    var r = await api('/api/portal/billing');
    var list = r.data || []; var sum = r.summary || {};
    function statusPill(s) { var map = { PAID: 'green', UNPAID: 'red', PARTIALLY_PAID: 'amber' }; return el('span', { class: 'pv-pill ' + (map[s] || 'grey'), text: s }); }
    async function openInvoice(id) {
      var r2 = await api('/api/portal/billing/' + id);
      var b = r2.data;
      var rows = (b.items || []).map(function (it) { return el('tr', {}, el('td', { text: it.name }), el('td', { text: String(it.quantity) }), el('td', { text: money(it.price) }), el('td', { text: money(it.total) })); });
      var body = el('div', {},
        el('div', { class: 'pv-between', style: { marginBottom: '10px' } }, el('strong', { text: b.invoiceNo || ('INV-' + b.id) }), statusPill(b.status)),
        el('div', { class: 'pv-muted', style: { fontSize: '13px', marginBottom: '12px' }, text: fmtDateTime(b.createdAt) + (b.paymentMode ? ' · ' + b.paymentMode : '') }),
        b.items && b.items.length ? el('table', { class: 'pv-table' }, el('thead', {}, el('tr', {}, el('th', { text: 'Item' }), el('th', { text: 'Qty' }), el('th', { text: 'Price' }), el('th', { text: 'Total' }))), el('tbody', {}, rows)) : null,
        el('div', { style: { marginTop: '14px', borderTop: '1px solid var(--line)', paddingTop: '12px' } },
          line('Subtotal', money(b.subtotal)), b.discount ? line('Discount', '-' + money(b.discount)) : null,
          line('Total', money(b.finalTotal), true), line('Paid', money(b.amountPaid)), line('Balance', money((b.finalTotal || 0) - (b.amountPaid || 0)), true)),
        (b.payment && (b.payment.bankName || b.payment.bankAccount)) ? el('div', { class: 'pv-alert pv-alert-ok', style: { marginTop: '12px', marginBottom: '0' } }, 'Pay by bank transfer — ' + [b.payment.bankName, b.payment.bankAccount].filter(Boolean).join(' · ')) : el('div', { class: 'pv-muted', style: { marginTop: '12px', fontSize: '13px' } }, 'Payment: pay at the clinic by cash or card.'));
      function line(l, v, bold) { return el('div', { class: 'pv-between', style: { fontSize: '14px', fontWeight: bold ? '700' : '400', margin: '3px 0' } }, el('span', { text: l }), el('span', { text: v })); }
      openModal('Invoice', body);
    }
    return el('div', {}, pageHead('Billing', 'Invoices and outstanding balance'),
      el('div', { class: 'pv-grid pv-grid-3' },
        statCard('blue', 'wallet', money(sum.billed), 'Total billed'),
        statCard('teal', 'check', money(sum.paid), 'Paid'),
        statCard((sum.due || 0) > 0 ? 'red' : 'teal', 'wallet', money(sum.due), 'Outstanding')),
      list.length ? el('div', { class: 'pv-card pv-mt-16' }, el('table', { class: 'pv-table' },
        el('thead', {}, el('tr', {}, el('th', { text: 'Invoice' }), el('th', { text: 'Date' }), el('th', { text: 'Total' }), el('th', { text: 'Paid' }), el('th', { text: 'Status' }), el('th', { text: '' }))),
        el('tbody', {}, list.map(function (b) {
          return el('tr', {}, el('td', { text: b.invoiceNo || ('INV-' + b.id) }), el('td', { text: fmtDate(b.createdAt) }), el('td', { text: money(b.finalTotal) }), el('td', { text: money(b.amountPaid) }), el('td', {}, statusPill(b.status)), el('td', {}, el('button', { class: 'pv-btn pv-btn-sm pv-btn-ghost', onClick: function () { openInvoice(b.id); } }, 'View')));
        })))) : empty('wallet', 'No invoices yet', 'Your bills will appear here after visits.'));
  };

  PAGES.notifications = async function () {
    var r = await api('/api/portal/notifications?limit=100');
    var list = r.data || [];
    function markRead(n, node) { if (n.isRead) return; api('/api/portal/notifications/' + n.id + '/read', { method: 'PATCH' }).then(function () { n.isRead = 1; node.classList.remove('unread'); state.notif.unread = Math.max(0, state.notif.unread - 1); var b = document.getElementById('pv-portal-bell-badge'); if (b) { b.textContent = state.notif.unread; b.style.display = state.notif.unread > 0 ? 'flex' : 'none'; } }).catch(function () {}); }
    return el('div', {}, pageHead('Notifications', 'Appointment updates, offers, records and billing alerts',
      r.unread > 0 ? el('button', { class: 'pv-btn pv-btn-ghost', onClick: async function () { try { await api('/api/portal/notifications/read-all', { method: 'POST' }); toast('Marked all as read', 'ok'); render(); } catch (e) {} } }, icon('check'), 'Mark all read') : null),
      list.length ? el('div', { class: 'pv-card pv-list' }, list.map(function (n) {
        var node = el('div', { class: 'pv-list-item' + (n.isRead ? '' : ' unread'), onClick: function () { markRead(n, node); } },
          icon(notifIcon(n.category)),
          el('div', { class: 'body' }, el('div', { class: 'title', text: n.title }),
            n.message ? el('div', { class: 'msg', text: n.message }) : null,
            el('div', { class: 'meta', text: fmtDateTime(n.createdAt) })));
        return node;
      })) : empty('bell', 'No notifications', 'You are all caught up.'));
  };

  PAGES.profile = async function () {
    var p = state.profile;
    var name = input({ type: 'text', value: p.fullName || '' });
    var email = input({ type: 'email', value: p.email || '', disabled: true });
    var phone = input({ type: 'tel', value: p.phone || '' });
    var address = input({ type: 'text', value: p.address || '' });
    var saveBtn = el('button', { class: 'pv-btn pv-btn-primary' }, 'Save profile');
    saveBtn.onclick = async function () {
      saveBtn.disabled = true;
      try {
        var r = await api('/api/portal/me', { method: 'PATCH', body: { fullName: name.value.trim(), phone: phone.value.trim(), address: address.value.trim() } });
        state.profile = r.data; saveSess({ accessToken: state.token, profile: r.data, clinic: state.clinic, clinicId: state.clinicId });
        toast('Profile saved', 'ok'); render();
      } catch (e) { toast(e.message, 'err'); saveBtn.disabled = false; }
    };
    var curPass = input({ type: 'password' }); var newPass = input({ type: 'password' });
    var passBtn = el('button', { class: 'pv-btn pv-btn-ghost' }, 'Change password');
    passBtn.onclick = async function () {
      if (newPass.value.length < 6) { toast('New password must be at least 6 characters', 'err'); return; }
      passBtn.disabled = true;
      try { await api('/api/portal/me/password', { method: 'POST', body: { currentPassword: curPass.value, newPassword: newPass.value } }); curPass.value = ''; newPass.value = ''; toast('Password changed', 'ok'); }
      catch (e) { toast(e.message, 'err'); }
      passBtn.disabled = false;
    };
    return el('div', {}, pageHead('Profile', 'Your account details'),
      el('div', { class: 'pv-grid pv-grid-2' },
        el('div', { class: 'pv-card pv-card-pad' }, el('h3', { class: 'pv-section-title', text: 'Personal details' }),
          field('Full name', name), field('Email', email), field('Phone', phone), field('Address', address), saveBtn),
        el('div', { class: 'pv-card pv-card-pad' }, el('h3', { class: 'pv-section-title', text: 'Change password' }),
          field('Current password', curPass), field('New password', newPass), passBtn,
          el('p', { class: 'pv-muted', style: { fontSize: '12.5px', marginTop: '10px' }, text: 'Email is used to sign in and cannot be changed here — contact the clinic to update it.' }))));
  };

  PAGES.contact = async function () {
    var r = await api('/api/portal/contact');
    var d = r.data || {}; var c = d.clinic || {};
    return el('div', {}, pageHead('Contact Clinic', 'Reach out to ' + clinicName()),
      el('div', { class: 'pv-card pv-card-pad', style: { maxWidth: '560px' } },
        el('div', { class: 'pv-list' },
          contactRow('phone', 'Phone', c.phone), contactRow('home', 'Address', c.address),
          contactRow('user', 'Clinic', c.clinicName),
          (d.bankName || d.bankAccount) ? contactRow('wallet', 'Bank transfer', [d.bankName, d.bankAccount].filter(Boolean).join(' · ')) : null)));
  };
  function contactRow(iconName, label, val) { if (!val) return null; return el('div', { class: 'pv-list-item' }, icon(iconName), el('div', { class: 'body' }, el('div', { class: 'title', text: label }), el('div', { class: 'msg', text: val }))); }

  // ── boot ──
  function boot() {
    var sess = loadSess();
    if (sess && sess.accessToken) {
      state.token = sess.accessToken; state.profile = sess.profile; state.clinic = sess.clinic; state.clinicId = sess.clinicId || state.clinicId;
      startPolling();
    }
    window.addEventListener('hashchange', function () { if (state.token) render(); });
    render();
  }
  boot();
})();
