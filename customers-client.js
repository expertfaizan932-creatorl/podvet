// PodVet staff "Customers" page, injected at runtime next to the compiled React
// bundle (same technique as alerts-client.js).
//
//   * A "Customers" item is added to the sidebar <nav>, styled by cloning a real
//     nav item. It is only added for clinic owners / admins / platform admins.
//   * Clicking it opens a full page (not a drawer) inside the app shell where the
//     clinic manages its own customers end to end:
//       - list + search + pagination
//       - create / edit / delete a customer
//       - create or reset the customer's portal login and copy the credentials
//       - view the customer's pets, payment history and outstanding balance
//       - add a pet
//   * Every request goes to the existing /api/clients* endpoints with the same
//     Bearer token the app already keeps, so a clinic only ever sees its own
//     customers (the server scopes everything to the clinic in the token).
(function () {
  'use strict';
  if (window.__pvCustomersLoaded) return;
  window.__pvCustomersLoaded = true;

  var SESS_KEY = 'podvet_session';
  var PAGE_SIZE = 20;

  function token() {
    try {
      var s = JSON.parse(localStorage.getItem(SESS_KEY) || 'null');
      return (s && s.tokens && s.tokens.accessToken) || null;
    } catch (_) { return null; }
  }

  function api(path, opts) {
    opts = opts || {};
    var t = token();
    var headers = { 'Content-Type': 'application/json' };
    if (t) headers.Authorization = 'Bearer ' + t;
    return fetch(path, {
      method: opts.method || 'GET', headers: headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (j) {
        if (!r.ok) { var e = new Error((j && j.error && j.error.message) || 'Request failed'); e.status = r.status; throw e; }
        return j;
      });
    });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function svg(inner, size) {
    return '<svg viewBox="0 0 24 24" width="' + (size || 18) + '" height="' + (size || 18) + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
  }
  var ICONS = {
    users: '<circle cx="9" cy="8" r="3.2"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 5.2A3 3 0 0 1 16 11"/><path d="M17.5 20a6 6 0 0 0-2.2-4.6"/> ',
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
    key: '<circle cx="7.5" cy="15.5" r="3.5"/><path d="m10 13 8-8"/><path d="m17 4 2 2"/><path d="m19 8 2-2"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    pet: '<circle cx="11" cy="4" r="2"/><circle cx="18" cy="8" r="2"/><circle cx="4" cy="8" r="2"/><path d="M11 12c-3 0-6 2-6 5a3 3 0 0 0 6 0c0-3 3-3 6 0a3 3 0 0 0 6 0c0-3-3-5-6-5"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
  };

  // ── styles ──
  var css = [
    '.pvc-nav-badge{display:inline-flex;align-items:center;justify-content:center;}',
    '.pvc-page{position:fixed;top:0;right:0;bottom:0;z-index:99980;background:#f8fafc;display:flex;flex-direction:column;font-family:inherit;color:#0f172a;overflow:hidden;box-shadow:-14px 0 40px rgba(15,23,42,.06);}',
    '.pvc-page[hidden]{display:none !important;}',
    '.pvc-head{display:flex;align-items:center;gap:12px;padding:16px 22px;background:#fff;border-bottom:1px solid #eef2f6;flex:0 0 auto;}',
    '.pvc-head h2{margin:0;font-size:19px;font-weight:700;display:flex;align-items:center;gap:9px;flex:1;}',
    '.pvc-head h2 svg{color:#0d9488;}',
    '.pvc-head .pvc-sub{font-size:12px;font-weight:500;color:#64748b;}',
    '.pvc-actions{display:flex;align-items:center;gap:8px;}',
    '.pvc-btn{border:1px solid #d7dee6;background:#fff;color:#334155;border-radius:9px;padding:8px 13px;font-size:13px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:7px;font-family:inherit;}',
    '.pvc-btn:hover{background:#f8fafc;}',
    '.pvc-btn.primary{background:#0d9488;border-color:#0d9488;color:#fff;}',
    '.pvc-btn.primary:hover{background:#0b7f74;}',
    '.pvc-btn.danger{color:#dc2626;border-color:#fecaca;}',
    '.pvc-btn.danger:hover{background:#fef2f2;}',
    '.pvc-btn.icon{padding:8px 9px;}',
    '.pvc-btn:disabled{opacity:.55;cursor:default;}',
    '.pvc-toolbar{display:flex;align-items:center;gap:12px;padding:14px 22px;background:#fff;border-bottom:1px solid #eef2f6;flex:0 0 auto;}',
    '.pvc-search{position:relative;flex:1;max-width:420px;}',
    '.pvc-search svg{position:absolute;left:11px;top:50%;transform:translateY(-50%);color:#94a3b8;}',
    '.pvc-search input{width:100%;box-sizing:border-box;border:1px solid #d7dee6;border-radius:10px;padding:9px 12px 9px 36px;font-size:13.5px;font-family:inherit;color:#0f172a;background:#fff;}',
    '.pvc-search input:focus{outline:none;border-color:#0d9488;box-shadow:0 0 0 3px rgba(13,148,136,.14);}',
    '.pvc-count{font-size:12.5px;color:#64748b;margin-left:auto;}',
    '.pvc-scroll{flex:1;overflow:auto;padding:18px 22px 40px;}',
    '.pvc-card{background:#fff;border:1px solid #eef2f6;border-radius:14px;overflow:hidden;box-shadow:0 1px 2px rgba(15,23,42,.03);}',
    'table.pvc-table{width:100%;border-collapse:collapse;font-size:13.5px;}',
    'table.pvc-table thead th{text-align:left;padding:12px 14px;background:#eef6fd;color:#4e93c9;font-weight:600;font-size:12.5px;white-space:nowrap;}',
    'table.pvc-table tbody td{padding:13px 14px;border-top:1px solid #f1f5f9;vertical-align:middle;}',
    'table.pvc-table tbody tr:hover{background:#f8fafc;}',
    '.pvc-name{font-weight:600;color:#0f172a;}',
    '.pvc-id{font-size:11px;color:#94a3b8;background:#f1f5f9;border-radius:6px;padding:1px 6px;display:inline-block;margin-top:3px;}',
    '.pvc-pets{display:flex;flex-wrap:wrap;gap:5px;}',
    '.pvc-chip{font-size:11.5px;background:#f1f5f9;color:#475569;border-radius:999px;padding:2px 9px;}',
    '.pvc-tag{font-size:11px;font-weight:700;border-radius:999px;padding:3px 9px;background:#f1f5f9;color:#64748b;}',
    '.pvc-tag.on{background:#ccfbf1;color:#0d9488;}',
    '.pvc-row-actions{display:flex;gap:6px;justify-content:flex-end;}',
    '.pvc-muted{color:#94a3b8;}',
    '.pvc-empty{padding:56px 20px;text-align:center;color:#94a3b8;font-size:14px;}',
    '.pvc-empty svg{width:40px;height:40px;margin-bottom:10px;color:#cbd5e1;}',
    '.pvc-loading{padding:48px;text-align:center;color:#94a3b8;}',
    '.pvc-error{padding:40px;text-align:center;color:#dc2626;}',
    '.pvc-pager{display:flex;align-items:center;justify-content:flex-end;gap:10px;padding:12px 22px;background:#fff;border-top:1px solid #eef2f6;flex:0 0 auto;font-size:13px;color:#475569;}',
    '.pvc-pager button{border:1px solid #d7dee6;background:#fff;border-radius:8px;padding:6px 12px;font-weight:600;cursor:pointer;color:#334155;font-family:inherit;}',
    '.pvc-pager button:disabled{opacity:.5;cursor:default;}',
    // modal
    '.pvc-ov{position:fixed;inset:0;z-index:99995;background:rgba(15,23,42,.45);backdrop-filter:blur(2px);display:flex;align-items:center;justify-content:center;padding:20px;}',
    '.pvc-ov[hidden]{display:none !important;}',
    '.pvc-modal{background:#fff;border-radius:16px;width:100%;max-width:520px;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 24px 60px rgba(15,23,42,.28);overflow:hidden;}',
    '.pvc-modal.wide{max-width:680px;}',
    '.pvc-modal-head{display:flex;align-items:center;gap:10px;padding:16px 20px;border-bottom:1px solid #eef2f6;}',
    '.pvc-modal-head h3{margin:0;font-size:16px;font-weight:700;flex:1;}',
    '.pvc-modal-body{padding:18px 20px;overflow:auto;}',
    '.pvc-modal-foot{display:flex;gap:10px;justify-content:flex-end;padding:14px 20px;border-top:1px solid #eef2f6;background:#fbfdfe;}',
    '.pvc-field{display:flex;flex-direction:column;gap:6px;margin-bottom:14px;}',
    '.pvc-field>label{font-size:12.5px;font-weight:600;color:#475569;}',
    '.pvc-field input,.pvc-field select{width:100%;box-sizing:border-box;border:1px solid #d7dee6;border-radius:9px;padding:9px 11px;font-size:13.5px;font-family:inherit;color:#0f172a;}',
    '.pvc-field input:focus,.pvc-field select:focus{outline:none;border-color:#0d9488;box-shadow:0 0 0 3px rgba(13,148,136,.14);}',
    '.pvc-grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px;}',
    '.pvc-inline-note{font-size:12px;color:#64748b;background:#f8fafc;border:1px solid #eef2f6;border-radius:9px;padding:9px 11px;margin-bottom:14px;}',
    '.pvc-danger-note{font-size:12.5px;color:#b91c1c;background:#fef2f2;border:1px solid #fecaca;border-radius:9px;padding:10px 12px;}',
    '.pvc-creds{background:#f0fdfa;border:1px solid #99f6e4;border-radius:11px;padding:14px;margin-top:6px;}',
    '.pvc-cred-row{display:flex;align-items:center;gap:10px;padding:5px 0;font-size:13.5px;}',
    '.pvc-cred-row span{flex:0 0 78px;color:#0f766e;font-weight:600;}',
    '.pvc-cred-row code{flex:1;background:#fff;border:1px solid #ccfbf1;border-radius:7px;padding:6px 9px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;word-break:break-all;}',
    '.pvc-sum{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px;}',
    '.pvc-sumcard{background:#f8fafc;border:1px solid #eef2f6;border-radius:11px;padding:11px 13px;}',
    '.pvc-sumcard b{display:block;font-size:17px;margin-top:2px;}',
    '.pvc-sumcard span{font-size:11.5px;color:#64748b;text-transform:uppercase;letter-spacing:.03em;}',
    '.pvc-sec-title{font-size:13px;font-weight:700;color:#334155;margin:18px 0 8px;}',
    '.pvc-mini{width:100%;border-collapse:collapse;font-size:12.5px;}',
    '.pvc-mini th{text-align:left;color:#94a3b8;font-weight:600;padding:6px 8px;border-bottom:1px solid #eef2f6;}',
    '.pvc-mini td{padding:7px 8px;border-bottom:1px solid #f1f5f9;}',
    '.pvc-msg{font-size:12.5px;font-weight:600;margin-top:8px;}',
    '.pvc-msg.err{color:#dc2626;}',
    '.pvc-msg.ok{color:#16a34a;}',
  ].join('\n');

  function ensureStyle() {
    if (document.getElementById('pv-customers-style')) return;
    var s = document.createElement('style');
    s.id = 'pv-customers-style';
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }

  // ── state ──
  var st = {
    open: false, page: 1, totalPages: 1, total: 0, search: '',
    items: [], hasPortal: {}, loading: false, error: null,
    editing: null, detail: null,
  };

  function sidebarWidth() {
    var el = findSidebar();
    if (!el) return 0;
    var w = el.getBoundingClientRect().width;
    return w > 0 ? Math.round(w) : 0;
  }

  function positionPage() {
    var page = document.getElementById('pv-customers-page');
    if (page) page.style.left = sidebarWidth() + 'px';
  }

  // ── page shell ──
  function ensurePage() {
    var page = document.getElementById('pv-customers-page');
    if (page) return page;
    page = document.createElement('div');
    page.id = 'pv-customers-page';
    page.className = 'pvc-page';
    page.hidden = true;
    page.style.left = sidebarWidth() + 'px';
    page.innerHTML =
      '<div class="pvc-head">' +
        '<h2>' + svg(ICONS.users, 20) + ' Customers <span class="pvc-sub" id="pvc-head-count"></span></h2>' +
        '<div class="pvc-actions">' +
          '<button class="pvc-btn icon" id="pvc-refresh" type="button" title="Refresh">' + svg(ICONS.refresh, 16) + '</button>' +
          '<button class="pvc-btn primary" id="pvc-add" type="button">' + svg(ICONS.plus, 16) + ' Add Customer</button>' +
          '<button class="pvc-btn icon" id="pvc-close" type="button" title="Close">' + svg(ICONS.close, 16) + '</button>' +
        '</div>' +
      '</div>' +
      '<div class="pvc-toolbar">' +
        '<div class="pvc-search">' + svg(ICONS.search, 16) + '<input type="text" id="pvc-search" placeholder="Search customers by name or phone…"></div>' +
        '<span class="pvc-count" id="pvc-count"></span>' +
      '</div>' +
      '<div class="pvc-scroll" id="pvc-scroll"></div>' +
      '<div class="pvc-pager">' +
        '<span id="pvc-page-info"></span>' +
        '<button id="pvc-prev" type="button">Prev</button>' +
        '<button id="pvc-next" type="button">Next</button>' +
      '</div>';
    document.body.appendChild(page);

    page.querySelector('#pvc-close').addEventListener('click', closePage);
    page.querySelector('#pvc-refresh').addEventListener('click', function () { loadList(); });
    page.querySelector('#pvc-add').addEventListener('click', function () { openForm(null); });
    page.querySelector('#pvc-prev').addEventListener('click', function () { if (st.page > 1) { st.page--; loadList(); } });
    page.querySelector('#pvc-next').addEventListener('click', function () { if (st.page < st.totalPages) { st.page++; loadList(); } });
    var box = page.querySelector('#pvc-search');
    var deb = null;
    box.addEventListener('input', function () {
      clearTimeout(deb);
      var v = box.value;
      deb = setTimeout(function () { st.search = v.trim(); st.page = 1; loadList(); }, 300);
    });
    return page;
  }

  function openPage() {
    ensureStyle();
    ensurePage();
    positionPage();
    document.getElementById('pv-customers-page').hidden = false;
    st.open = true;
    loadList();
  }
  function closePage() {
    var p = document.getElementById('pv-customers-page');
    if (p) p.hidden = true;
    st.open = false;
  }

  function setScroll(html) {
    var sc = document.getElementById('pvc-scroll');
    if (sc) sc.innerHTML = html;
  }

  // ── list ──
  function loadList() {
    var page = document.getElementById('pv-customers-page');
    if (!page || page.hidden) return;
    st.loading = true; st.error = null;
    setScroll('<div class="pvc-loading">Loading customers…</div>');
    var qs = '/api/clients?page=' + st.page + '&pageSize=' + PAGE_SIZE + (st.search ? '&search=' + encodeURIComponent(st.search) : '');
    var portalP = api('/api/notifications/customers?limit=1000').then(function (r) {
      var m = {};
      ((r && r.data) || []).forEach(function (c) { m[c.id] = !!c.hasPortal; });
      st.hasPortal = m;
    }).catch(function () { st.hasPortal = {}; });

    Promise.all([api(qs), portalP]).then(function (res) {
      var r = res[0] || {};
      st.items = r.data || [];
      st.total = r.total || 0;
      st.totalPages = r.totalPages || 1;
      st.loading = false;
      renderList();
    }).catch(function (e) {
      st.loading = false; st.error = e.message;
      setScroll('<div class="pvc-error">Could not load customers.<br><span style="font-size:12px">' + escapeHtml(e.message) + '</span></div>');
      renderPager();
    });
  }

  function renderList() {
    var hc = document.getElementById('pvc-head-count');
    if (hc) hc.textContent = st.total ? '(' + st.total + ')' : '';
    var cnt = document.getElementById('pvc-count');
    if (cnt) cnt.textContent = st.total + ' customer' + (st.total === 1 ? '' : 's');

    if (st.error) { setScroll('<div class="pvc-error">' + escapeHtml(st.error) + '</div>'); renderPager(); return; }
    if (!st.items.length) {
      setScroll('<div class="pvc-card"><div class="pvc-empty">' + svg(ICONS.users, 40) + '<div>' +
        (st.search ? 'No customers match “' + escapeHtml(st.search) + '”' : 'No customers yet. Click “Add Customer” to create one.') +
        '</div></div></div>');
      renderPager(); return;
    }

    var rows = st.items.map(function (c) {
      var pets = c.pets || [];
      var petChips = pets.length
        ? '<div class="pvc-pets">' + pets.slice(0, 3).map(function (p) { return '<span class="pvc-chip">' + escapeHtml(p.petName || p.pet_name || 'Pet') + '</span>'; }).join('') + (pets.length > 3 ? '<span class="pvc-chip">+' + (pets.length - 3) + '</span>' : '') + '</div>'
        : '<span class="pvc-muted">—</span>';
      var portal = st.hasPortal[c.id] ? '<span class="pvc-tag on">Active</span>' : '<span class="pvc-tag">No login</span>';
      return '<tr data-id="' + c.id + '">' +
        '<td><div class="pvc-name">' + escapeHtml(c.clientName || '—') + '</div><span class="pvc-id">CLT-' + c.id + '</span></td>' +
        '<td>' + (c.contactNumber ? escapeHtml(c.contactNumber) : '<span class="pvc-muted">—</span>') + '</td>' +
        '<td>' + (c.address ? escapeHtml(c.address) : '<span class="pvc-muted">—</span>') + '</td>' +
        '<td>' + petChips + '</td>' +
        '<td>' + portal + '</td>' +
        '<td><div class="pvc-row-actions">' +
          '<button class="pvc-btn icon" data-act="detail" title="View" type="button">' + svg(ICONS.eye, 15) + '</button>' +
          '<button class="pvc-btn icon" data-act="portal" title="Portal access" type="button">' + svg(ICONS.key, 15) + '</button>' +
          '<button class="pvc-btn icon" data-act="edit" title="Edit" type="button">' + svg(ICONS.edit, 15) + '</button>' +
          '<button class="pvc-btn icon danger" data-act="delete" title="Delete" type="button">' + svg(ICONS.trash, 15) + '</button>' +
        '</div></td>' +
      '</tr>';
    }).join('');

    setScroll('<div class="pvc-card"><table class="pvc-table"><thead><tr>' +
      '<th>Customer</th><th>Contact</th><th>Address</th><th>Pets</th><th>Portal</th><th style="text-align:right">Actions</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>');

    var sc = document.getElementById('pvc-scroll');
    sc.querySelectorAll('tr[data-id]').forEach(function (tr) {
      var id = Number(tr.getAttribute('data-id'));
      var client = st.items.filter(function (x) { return x.id === id; })[0];
      tr.querySelectorAll('button[data-act]').forEach(function (b) {
        b.addEventListener('click', function () {
          var act = b.getAttribute('data-act');
          if (act === 'edit') openForm(client);
          else if (act === 'delete') confirmDelete(client);
          else if (act === 'portal') openPortal(client);
          else if (act === 'detail') openDetail(client);
        });
      });
    });
    renderPager();
  }

  function renderPager() {
    var info = document.getElementById('pvc-page-info');
    var prev = document.getElementById('pvc-prev');
    var next = document.getElementById('pvc-next');
    if (!info) return;
    info.textContent = 'Page ' + st.page + ' of ' + (st.totalPages || 1);
    if (prev) prev.disabled = st.page <= 1;
    if (next) next.disabled = st.page >= (st.totalPages || 1);
  }

  // ── modal helpers ──
  function modal(id, cls) {
    var m = document.getElementById(id);
    if (m) return m;
    m = document.createElement('div');
    m.id = id;
    m.className = 'pvc-ov';
    m.hidden = true;
    m.innerHTML = '<div class="pvc-modal ' + (cls || '') + '" role="dialog"></div>';
    m.addEventListener('click', function (e) { if (e.target === m) m.hidden = true; });
    document.body.appendChild(m);
    return m;
  }

  function openForm(client) {
    st.editing = client || null;
    var m = modal('pv-customers-form');
    var isEdit = !!client;
    m.querySelector('.pvc-modal').innerHTML =
      '<div class="pvc-modal-head"><h3>' + (isEdit ? 'Edit customer' : 'New customer') + '</h3>' +
        '<button class="pvc-btn icon" data-close type="button">' + svg(ICONS.close, 16) + '</button></div>' +
      '<div class="pvc-modal-body">' +
        '<div class="pvc-field"><label>Full name *</label><input type="text" id="pvc-f-name" placeholder="e.g. Ali Raza" value="' + escapeHtml(client ? (client.clientName || '') : '') + '"></div>' +
        '<div class="pvc-field"><label>Contact number</label><input type="text" id="pvc-f-contact" placeholder="e.g. 0300 1234567" value="' + escapeHtml(client ? (client.contactNumber || '') : '') + '"></div>' +
        '<div class="pvc-field"><label>Address</label><input type="text" id="pvc-f-address" placeholder="Optional" value="' + escapeHtml(client ? (client.address || '') : '') + '"></div>' +
        '<div class="pvc-msg" id="pvc-f-msg"></div>' +
      '</div>' +
      '<div class="pvc-modal-foot">' +
        '<button class="pvc-btn" data-close type="button">Cancel</button>' +
        '<button class="pvc-btn primary" id="pvc-f-save" type="button">' + (isEdit ? 'Save changes' : 'Create customer') + '</button>' +
      '</div>';
    m.querySelectorAll('[data-close]').forEach(function (b) { b.addEventListener('click', function () { m.hidden = true; }); });
    m.querySelector('#pvc-f-save').addEventListener('click', saveForm);
    m.hidden = false;
    setTimeout(function () { var i = m.querySelector('#pvc-f-name'); if (i) i.focus(); }, 30);
  }

  function saveForm() {
    var m = document.getElementById('pv-customers-form');
    var name = (m.querySelector('#pvc-f-name').value || '').trim();
    var contact = (m.querySelector('#pvc-f-contact').value || '').trim();
    var address = (m.querySelector('#pvc-f-address').value || '').trim();
    var msg = m.querySelector('#pvc-f-msg');
    if (!name) { msg.className = 'pvc-msg err'; msg.textContent = 'Name is required'; return; }
    var body = { clientName: name, contactNumber: contact, address: address };
    var btn = m.querySelector('#pvc-f-save');
    btn.disabled = true; msg.className = 'pvc-msg'; msg.textContent = 'Saving…';
    var req = st.editing
      ? api('/api/clients/' + st.editing.id, { method: 'PATCH', body: body })
      : api('/api/clients', { method: 'POST', body: body });
    req.then(function () {
      btn.disabled = false;
      m.hidden = true;
      loadList();
    }).catch(function (e) {
      btn.disabled = false; msg.className = 'pvc-msg err'; msg.textContent = e.message || 'Could not save';
    });
  }

  function confirmDelete(client) {
    var m = modal('pv-customers-del');
    m.querySelector('.pvc-modal').innerHTML =
      '<div class="pvc-modal-head"><h3>Delete customer</h3><button class="pvc-btn icon" data-close type="button">' + svg(ICONS.close, 16) + '</button></div>' +
      '<div class="pvc-modal-body"><div class="pvc-danger-note">Delete <b>' + escapeHtml(client.clientName || 'this customer') + '</b> and all their pets? This cannot be undone.</div>' +
        '<div class="pvc-msg" id="pvc-del-msg"></div></div>' +
      '<div class="pvc-modal-foot"><button class="pvc-btn" data-close type="button">Cancel</button>' +
        '<button class="pvc-btn danger" id="pvc-del-go" type="button">Delete</button></div>';
    m.querySelectorAll('[data-close]').forEach(function (b) { b.addEventListener('click', function () { m.hidden = true; }); });
    m.querySelector('#pvc-del-go').addEventListener('click', function () {
      var btn = m.querySelector('#pvc-del-go'); var msg = m.querySelector('#pvc-del-msg');
      btn.disabled = true; msg.className = 'pvc-msg'; msg.textContent = 'Deleting…';
      api('/api/clients/' + client.id, { method: 'DELETE' }).then(function () {
        m.hidden = true; loadList();
      }).catch(function (e) { btn.disabled = false; msg.className = 'pvc-msg err'; msg.textContent = e.message || 'Could not delete'; });
    });
    m.hidden = false;
  }

  // ── portal access ──
  function openPortal(client) {
    var m = modal('pv-customers-portal');
    m.querySelector('.pvc-modal').innerHTML =
      '<div class="pvc-modal-head"><h3>' + svg(ICONS.key, 18) + ' Portal access — ' + escapeHtml(client.clientName || '') + '</h3>' +
        '<button class="pvc-btn icon" data-close type="button">' + svg(ICONS.close, 16) + '</button></div>' +
      '<div class="pvc-modal-body">' +
        '<div class="pvc-inline-note" id="pvc-p-status">Checking existing login…</div>' +
        '<div class="pvc-field"><label>Login email *</label><input type="text" id="pvc-p-email" placeholder="customer@example.com"></div>' +
        '<div class="pvc-field"><label>Password</label><input type="text" id="pvc-p-pass" placeholder="Leave blank to auto-generate"></div>' +
        '<div id="pvc-p-result"></div>' +
        '<div class="pvc-msg" id="pvc-p-msg"></div>' +
      '</div>' +
      '<div class="pvc-modal-foot">' +
        '<button class="pvc-btn" data-close type="button">Close</button>' +
        '<button class="pvc-btn primary" id="pvc-p-go" type="button">Create / reset login</button>' +
      '</div>';
    m.querySelectorAll('[data-close]').forEach(function (b) { b.addEventListener('click', function () { m.hidden = true; }); });
    m.hidden = false;
    api('/api/clients/' + client.id + '/portal-account').then(function (r) {
      var d = (r && r.data) || {};
      var status = m.querySelector('#pvc-p-status');
      var emailI = m.querySelector('#pvc-p-email');
      if (d.hasAccount) {
        status.innerHTML = 'Existing login: <b>' + escapeHtml(d.email) + '</b> · ' + (d.isActive ? 'active' : 'inactive') + '. Reset the password below if needed.';
        emailI.value = d.email || '';
      } else {
        status.textContent = 'No portal login yet. Create one and share the credentials with the customer.';
      }
    }).catch(function () { m.querySelector('#pvc-p-status').textContent = 'Could not read existing login.'; });
    m.querySelector('#pvc-p-go').addEventListener('click', function () { doPortal(client, m); });
  }

  function doPortal(client, m) {
    var email = (m.querySelector('#pvc-p-email').value || '').trim();
    var pass = (m.querySelector('#pvc-p-pass').value || '').trim();
    var msg = m.querySelector('#pvc-p-msg');
    if (!email) { msg.className = 'pvc-msg err'; msg.textContent = 'Email is required'; return; }
    var btn = m.querySelector('#pvc-p-go');
    btn.disabled = true; msg.className = 'pvc-msg'; msg.textContent = 'Saving…';
    api('/api/clients/' + client.id + '/portal-account', { method: 'POST', body: { email: email, password: pass || undefined } }).then(function (r) {
      btn.disabled = false; msg.className = 'pvc-msg'; msg.textContent = '';
      var d = (r && r.data) || {};
      m.querySelector('#pvc-p-pass').value = '';
      m.querySelector('#pvc-p-result').innerHTML =
        '<div class="pvc-creds">' +
          '<div style="font-weight:700;color:#0f766e;margin-bottom:6px">' + svg(ICONS.check, 15) + ' Login ready — share these with the customer</div>' +
          credRow('Email', d.email) + credRow('Password', d.password) + credRow('Portal', d.portalPath || '/portal') +
          '<button class="pvc-btn" id="pvc-p-copy" type="button" style="margin-top:8px">' + svg(ICONS.copy, 15) + ' Copy details</button>' +
        '</div>';
      var copy = m.querySelector('#pvc-p-copy');
      if (copy) copy.addEventListener('click', function () {
        var text = 'Customer portal login\nEmail: ' + d.email + '\nPassword: ' + d.password + '\nPortal: ' + location.origin + (d.portalPath || '/portal');
        copyText(text);
        copy.innerHTML = svg(ICONS.check, 15) + ' Copied!';
      });
      var status = m.querySelector('#pvc-p-status');
      if (status) status.innerHTML = 'Existing login: <b>' + escapeHtml(d.email) + '</b> · active.';
      st.hasPortal[client.id] = true;
      renderList();
    }).catch(function (e) {
      btn.disabled = false; msg.className = 'pvc-msg err'; msg.textContent = e.message || 'Could not save login';
    });
  }

  function credRow(label, value) {
    return '<div class="pvc-cred-row"><span>' + escapeHtml(label) + '</span><code>' + escapeHtml(value || '') + '</code></div>';
  }

  function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text); return; }
    } catch (_) {}
    var ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (_) {}
    document.body.removeChild(ta);
  }

  // ── detail ──
  function openDetail(client) {
    var m = modal('pv-customers-detail', 'wide');
    m.querySelector('.pvc-modal').innerHTML =
      '<div class="pvc-modal-head"><h3>' + svg(ICONS.users, 18) + ' ' + escapeHtml(client.clientName || 'Customer') + '</h3>' +
        '<button class="pvc-btn icon" data-close type="button">' + svg(ICONS.close, 16) + '</button></div>' +
      '<div class="pvc-modal-body" id="pvc-d-body"><div class="pvc-loading">Loading…</div></div>' +
      '<div class="pvc-modal-foot"><button class="pvc-btn" data-close type="button">Close</button>' +
        '<button class="pvc-btn" id="pvc-d-edit" type="button">' + svg(ICONS.edit, 15) + ' Edit</button>' +
        '<button class="pvc-btn primary" id="pvc-d-portal" type="button">' + svg(ICONS.key, 15) + ' Portal access</button></div>';
    m.querySelectorAll('[data-close]').forEach(function (b) { b.addEventListener('click', function () { m.hidden = true; }); });
    m.querySelector('#pvc-d-edit').addEventListener('click', function () { m.hidden = true; openForm(client); });
    m.querySelector('#pvc-d-portal').addEventListener('click', function () { m.hidden = true; openPortal(client); });
    m.hidden = false;
    renderDetailBody(client);
  }

  function renderDetailBody(client) {
    var body = document.getElementById('pvc-d-body');
    var pets = client.pets || [];
    Promise.all([
      api('/api/clients/' + client.id + '/payment-history').catch(function () { return {}; }),
      api('/api/clients/' + client.id + '/unpaid-ledger').catch(function () { return {}; }),
      api('/api/clients/' + client.id + '/portal-account').catch(function () { return {}; }),
    ]).then(function (res) {
      var pay = res[0] || {}, led = res[1] || {}, port = res[2] || {};
      var summary = pay.summary || {};
      var due = (led.data && led.data.totalDue) || 0;
      var portal = (port.data && port.data.hasAccount) ? ('<span class="pvc-tag on">' + escapeHtml(port.data.email || 'Active') + '</span>') : '<span class="pvc-tag">No login</span>';
      var bills = (pay.data || []).slice(0, 6);
      body.innerHTML =
        '<div class="pvc-sum">' +
          '<div class="pvc-sumcard"><span>Billed</span><b>Rs ' + fmt(summary.billed) + '</b></div>' +
          '<div class="pvc-sumcard"><span>Paid</span><b>Rs ' + fmt(summary.paid) + '</b></div>' +
          '<div class="pvc-sumcard"><span>Outstanding</span><b style="color:' + (due > 0 ? '#dc2626' : '#16a34a') + '">Rs ' + fmt(due) + '</b></div>' +
        '</div>' +
        '<div class="pvc-field" style="margin-bottom:6px"><label>Contact</label><div>' + (client.contactNumber ? escapeHtml(client.contactNumber) : '<span class="pvc-muted">—</span>') + '</div></div>' +
        '<div class="pvc-field" style="margin-bottom:6px"><label>Address</label><div>' + (client.address ? escapeHtml(client.address) : '<span class="pvc-muted">—</span>') + '</div></div>' +
        '<div class="pvc-field" style="margin-bottom:6px"><label>Portal</label><div>' + portal + '</div></div>' +
        '<div class="pvc-sec-title">Pets (' + pets.length + ')</div>' +
        (pets.length
          ? '<table class="pvc-mini"><thead><tr><th>Name</th><th>Species</th><th>Sex</th><th>Breed</th></tr></thead><tbody>' +
            pets.map(function (p) { return '<tr><td>' + escapeHtml(p.petName || '') + '</td><td>' + escapeHtml(p.species || '') + '</td><td>' + escapeHtml(p.sex || '') + '</td><td>' + escapeHtml(p.breed || '—') + '</td></tr>'; }).join('') +
            '</tbody></table>'
          : '<div class="pvc-muted">No pets yet.</div>' +
            '<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">' +
              '<input type="text" id="pvc-newpet-name" placeholder="Pet name" style="flex:1;min-width:130px;border:1px solid #d7dee6;border-radius:9px;padding:8px 10px;font-family:inherit">' +
              '<select id="pvc-newpet-species" style="border:1px solid #d7dee6;border-radius:9px;padding:8px 10px;font-family:inherit"><option>Dog</option><option>Cat</option><option>Bird</option><option>Rabbit</option><option>Other</option></select>' +
              '<button class="pvc-btn primary" id="pvc-newpet-add" type="button">Add pet</button>' +
            '</div>' +
            '<div class="pvc-msg" id="pvc-newpet-msg"></div>') +
        '<div class="pvc-sec-title">Recent bills</div>' +
        (bills.length
          ? '<table class="pvc-mini"><thead><tr><th>Invoice</th><th>Total</th><th>Paid</th><th>Status</th><th>Date</th></tr></thead><tbody>' +
            bills.map(function (b) { return '<tr><td>' + escapeHtml(b.invoiceNo || ('#' + b.id)) + '</td><td>Rs ' + fmt(b.finalTotal) + '</td><td>Rs ' + fmt(b.amountPaid) + '</td><td>' + escapeHtml(b.status || '') + '</td><td>' + fmtDate(b.createdAt) + '</td></tr>'; }).join('') +
            '</tbody></table>'
          : '<div class="pvc-muted">No bills yet.</div>');
      var addBtn = document.getElementById('pvc-newpet-add');
      if (addBtn) addBtn.addEventListener('click', function () { addPet(client, body); });
    }).catch(function (e) {
      body.innerHTML = '<div class="pvc-error">' + escapeHtml(e.message) + '</div>';
    });
  }

  function addPet(client, body) {
    var nameEl = document.getElementById('pvc-newpet-name');
    var spEl = document.getElementById('pvc-newpet-species');
    var msg = document.getElementById('pvc-newpet-msg');
    var name = (nameEl.value || '').trim();
    if (!name) { msg.className = 'pvc-msg err'; msg.textContent = 'Pet name is required'; return; }
    msg.className = 'pvc-msg'; msg.textContent = 'Adding…';
    api('/api/clients/' + client.id + '/pets', { method: 'POST', body: { petName: name, species: spEl.value, sex: 'Unknown' } }).then(function () {
      api('/api/clients/' + client.id).then(function (r) {
        var d = (r && r.data) || {};
        client.pets = d.pets || [];
        renderDetailBody(client);
        loadList();
      }).catch(function () { renderDetailBody(client); loadList(); });
    }).catch(function (e) { msg.className = 'pvc-msg err'; msg.textContent = e.message || 'Could not add pet'; });
  }

  function fmt(n) {
    var v = Number(n) || 0;
    return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  }
  function fmtDate(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    return isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
  }

  // ── role gate ──
  var canSee = false;
  function resolveRole(cb) {
    try {
      Promise.resolve(window.electronAPI.getSession()).then(function (s) {
        var role = String((s && s.role) || '').toUpperCase();
        var mr = String((s && s.membership_role) || '').toUpperCase();
        cb(!!(s && (s.isPlatformAdmin || role === 'ADMIN' || role === 'OWNER' || mr === 'ADMIN' || mr === 'OWNER')));
      }).catch(function () { cb(false); });
    } catch (_) { cb(false); }
  }

  // ── sidebar injection ──
  function findSidebar() {
    var el = document.querySelector('.pv-sidebar');
    if (el) return el;
    var cands = document.querySelectorAll('div.fixed');
    for (var i = 0; i < cands.length; i++) {
      var cls = cands[i].className || '';
      if (cls.indexOf('h-screen') !== -1 && cls.indexOf('left-0') !== -1 && cls.indexOf('flex-col') !== -1) return cands[i];
    }
    return null;
  }

  function makeNavItem(sampleClass) {
    var a = document.createElement('a');
    a.id = 'pv-customers-nav';
    a.href = '#';
    a.title = 'Customers';
    if (sampleClass) a.className = sampleClass;
    a.style.cursor = 'pointer';
    a.innerHTML = '<span class="pvc-nav-badge">' + svg(ICONS.users, 15) + '</span><span class="pvc-nav-label">Customers</span>';
    a.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); openPage(); });
    return a;
  }

  function syncNav() {
    if (!canSee) return;
    var sidebar = findSidebar();
    if (!sidebar) return;
    var nav = sidebar.querySelector('nav');
    if (!nav) return;

    var sample = nav.querySelector('a[href]:not(#pv-alerts-nav):not(#pv-customers-nav)');
    var sampleClass = sample ? sample.className : '';
    var anchor = nav.querySelector('#pv-alerts-nav') || sample;

    var existing = nav.querySelector('#pv-customers-nav');
    if (existing && existing.parentNode === nav) {
      if (sampleClass && existing.className !== sampleClass) existing.className = sampleClass;
      if (anchor && existing.previousElementSibling !== anchor) {
        nav.insertBefore(existing, anchor.nextSibling);
      }
      var lbl = existing.querySelector('.pvc-nav-label');
      var collapsed = !!sampleClass && sampleClass.indexOf('justify-center') !== -1;
      if (lbl) lbl.style.display = collapsed ? 'none' : '';
      return;
    }
    var item = makeNavItem(sampleClass || '');
    if (anchor) nav.insertBefore(item, anchor.nextSibling);
    else nav.insertBefore(item, nav.firstChild);
  }

  function boot() {
    ensureStyle();
    resolveRole(function (ok) {
      canSee = ok;
      if (!canSee) return;
      ensurePage();
      syncNav();
    });

    setInterval(function () {
      if (canSee && !document.getElementById('pv-customers-nav')) syncNav();
    }, 20000);

    var pending = false;
    function schedule() {
      if (pending) return; pending = true;
      requestAnimationFrame(function () { pending = false; syncNav(); });
    }
    try {
      var mo = new MutationObserver(schedule);
      mo.observe(document.documentElement, { childList: true, subtree: true });
    } catch (_) {}

    window.addEventListener('resize', function () { if (st.open) positionPage(); });
    window.addEventListener('load', function () { ensureStyle(); syncNav(); });

    // Close the page when the user navigates elsewhere in the app.
    document.addEventListener('click', function (e) {
      if (!st.open) return;
      var a = e.target.closest && e.target.closest('nav a[href]');
      if (a && a.id !== 'pv-customers-nav') closePage();
    }, true);
    document.addEventListener('keydown', function (e) {
      if ((e.key === 'Escape' || e.key === 'Esc') && st.open) closePage();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
