// PodVet shared Alert / Notification client for the staff web app.
//
// The React bundle is compiled (no JSX source), so this layer adds the staff
// side of the shared notification system entirely at runtime:
//
//   * An "Alerts" item is injected into the existing sidebar <nav>, styled by
//     cloning a real nav item's classes, with a live unread badge.
//   * Clicking it opens a full-screen Alerts panel: all/unread tabs, category
//     icons, relative timestamps, mark-one / mark-all-read and delete.
//   * Data comes straight from /api/notifications using the same access token
//     the app already keeps in localStorage.podvet_session.
//   * Unread count is refreshed by polling, and pushed instantly over the same
//     /events SSE stream the app uses ('notifications-updated').
//
// It touches nothing the bundle owns: the injected node is re-added if React
// drops it, and every request is authorised server-side.
(function () {
  'use strict';
  if (window.__pvAlertsLoaded) return;
  window.__pvAlertsLoaded = true;

  var SESS_KEY = 'podvet_session';
  var POLL_MS = 20000;

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

  // ── icons ──
  function svg(inner) {
    return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
  }
  var ICONS = {
    bell: '<path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
    appointment: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M3 10h18M8 2v4M16 2v4"/>',
    billing: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
    boarding: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V10"/>',
    record: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 13h6M9 17h6"/>',
    pet: '<circle cx="11" cy="4" r="2"/><circle cx="18" cy="8" r="2"/><circle cx="4" cy="8" r="2"/><path d="M11 12c-3 0-6 2-6 5a3 3 0 0 0 6 0c0-3 3-3 6 0a3 3 0 0 0 6 0c0-3-3-5-6-5"/>',
    client: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>',
    offer: '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><circle cx="7" cy="7" r="1.5"/>',
    alert: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/>',
    general: '<path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7A8.5 8.5 0 0 1 12 3a8.38 8.38 0 0 1 9 8.5z"/>',
  };
  function iconFor(cat) {
    var map = { appointment: 'appointment', billing: 'billing', payment: 'billing', boarding: 'boarding', record: 'record', pet: 'pet', client: 'client', offer: 'offer', promotion: 'offer', alert: 'alert', general: 'general', message: 'general' };
    var k = map[cat] || 'bell';
    return ICONS[k] ? k : 'bell';
  }

  function timeAgo(iso) {
    if (!iso) return '';
    var t = new Date(iso).getTime();
    if (isNaN(t)) return '';
    var s = Math.floor((Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    var m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
    var d = Math.floor(h / 24); if (d < 7) return d + 'd ago';
    return new Date(t).toLocaleDateString();
  }

  // ── styles ──
  var css = [
    '.pva-nav-icon{display:inline-flex;align-items:center;justify-content:center;position:relative;}',
    '.pva-nav-badge{position:absolute;top:-6px;right:-8px;min-width:16px;height:16px;padding:0 4px;border-radius:9px;background:#ef4444;color:#fff;font-size:10px;font-weight:700;line-height:16px;text-align:center;box-shadow:0 0 0 2px #fff;}',
    '.pva-overlay{position:fixed;top:0;right:0;bottom:0;z-index:99990;display:flex;background:#f8fafc;font-family:inherit;color:#0f172a;}',
    '.pva-overlay[hidden]{display:none !important;}',
    '.pva-backdrop{display:none;}',
    '.pva-panel{position:relative;width:100%;max-width:none;height:100%;background:#f8fafc;display:flex;flex-direction:column;}',
    '.pva-head{display:flex;align-items:center;gap:10px;padding:16px 22px;background:#fff;border-bottom:1px solid #eef2f6;flex:0 0 auto;}',
    '.pva-head h3{margin:0;font-size:19px;font-weight:700;color:#0f172a;flex:1;display:flex;align-items:center;gap:9px;}',
    '.pva-head h3 svg{color:#0d9488;width:20px;height:20px;}',
    '.pva-head .pva-pill{background:#0d9488;color:#fff;font-size:11px;font-weight:700;border-radius:999px;padding:2px 8px;}',
    '.pva-tabs{display:flex;gap:4px;padding:10px 22px;border-bottom:1px solid #eef2f6;background:#fff;flex:0 0 auto;}',
    '.pva-tab{border:0;background:transparent;padding:7px 14px;border-radius:8px;font-size:13.5px;font-weight:600;color:#64748b;cursor:pointer;}',
    '.pva-tab.active{background:#f0fdfa;color:#0d9488;}',
    '.pva-list{flex:1;overflow-y:auto;padding:8px 12px 24px;width:100%;max-width:900px;margin:0 auto;box-sizing:border-box;}',
    '.pva-item{display:flex;gap:12px;padding:12px;border-radius:12px;cursor:pointer;transition:background .15s;}',
    '.pva-item:hover{background:#f8fafc;}',
    '.pva-item.unread{background:#f0fdfa;}',
    '.pva-item.unread:hover{background:#e6fffb;}',
    '.pva-ic{flex:0 0 36px;width:36px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;background:#e2e8f0;color:#475569;}',
    '.pva-ic.appointment{background:#dbeafe;color:#2563eb;}',
    '.pva-ic.billing,.pva-ic.payment{background:#dcfce7;color:#16a34a;}',
    '.pva-ic.boarding{background:#fef3c7;color:#d97706;}',
    '.pva-ic.record{background:#ede9fe;color:#7c3aed;}',
    '.pva-ic.pet{background:#ccfbf1;color:#0d9488;}',
    '.pva-ic.client{background:#fce7f3;color:#db2777;}',
    '.pva-ic.offer{background:#fef9c3;color:#ca8a04;}',
    '.pva-ic.alert{background:#fee2e2;color:#dc2626;}',
    '.pva-ic.general{background:#e0e7ff;color:#4f46e5;}',
    '.pva-body{flex:1;min-width:0;}',
    '.pva-title{font-size:14px;font-weight:600;color:#0f172a;}',
    '.pva-msg{font-size:13px;color:#475569;margin-top:2px;word-break:break-word;}',
    '.pva-meta{font-size:11.5px;color:#94a3b8;margin-top:5px;display:flex;gap:6px;align-items:center;}',
    '.pva-del{border:0;background:transparent;color:#cbd5e1;cursor:pointer;font-size:18px;line-height:1;padding:2px 6px;border-radius:6px;align-self:flex-start;}',
    '.pva-del:hover{background:#fef2f2;color:#ef4444;}',
    '.pva-empty{text-align:center;color:#94a3b8;padding:60px 20px;font-size:14px;}',
    '.pva-empty svg{width:44px;height:44px;margin-bottom:12px;color:#cbd5e1;}',
    '.pva-btn{border:0;border-radius:8px;padding:7px 12px;font-size:13px;font-weight:600;cursor:pointer;background:#f1f5f9;color:#334155;}',
    '.pva-btn.primary{background:#0d9488;color:#fff;}',
    '.pva-btn:disabled{opacity:.55;cursor:default;}',
    '.pva-close{border:0;background:transparent;font-size:24px;line-height:1;color:#94a3b8;cursor:pointer;padding:0 4px;}',
    '.pva-close:hover{color:#334155;}',
    '.pva-comp{flex:1;overflow-y:auto;padding:16px 18px 24px;display:flex;flex-direction:column;gap:14px;width:100%;max-width:640px;margin:0 auto;box-sizing:border-box;}',
    '.pva-comp[hidden]{display:none !important;}',
    '.pva-field{display:flex;flex-direction:column;gap:6px;}',
    '.pva-field>label{font-size:12.5px;font-weight:600;color:#475569;}',
    '.pva-field input[type=text],.pva-field textarea,.pva-field select,.pva-cust-search{width:100%;box-sizing:border-box;border:1px solid #d7dee6;border-radius:9px;padding:9px 11px;font-size:13.5px;color:#0f172a;font-family:inherit;background:#fff;}',
    '.pva-field textarea{resize:vertical;min-height:76px;}',
    '.pva-field input:focus,.pva-field textarea:focus,.pva-field select:focus{outline:none;border-color:#0d9488;box-shadow:0 0 0 3px rgba(13,148,136,.14);}',
    '.pva-seg{display:flex;gap:6px;background:#f1f5f9;border-radius:10px;padding:4px;}',
    '.pva-seg button{flex:1;border:0;background:transparent;border-radius:7px;padding:8px;font-size:13px;font-weight:600;color:#64748b;cursor:pointer;}',
    '.pva-seg button.active{background:#fff;color:#0d9488;box-shadow:0 1px 3px rgba(15,23,42,.12);}',
    '.pva-cust{max-height:190px;overflow-y:auto;border:1px solid #e2e8f0;border-radius:10px;padding:4px;}',
    '.pva-cust-row{display:flex;align-items:center;gap:10px;padding:7px 8px;border-radius:8px;cursor:pointer;}',
    '.pva-cust-row:hover{background:#f8fafc;}',
    '.pva-cust-row.on{background:#f0fdfa;}',
    '.pva-cust-row input{width:16px;height:16px;accent-color:#0d9488;flex:0 0 auto;}',
    '.pva-cust-name{font-size:13.5px;color:#0f172a;font-weight:500;}',
    '.pva-cust-sub{font-size:11.5px;color:#94a3b8;margin-left:auto;}',
    '.pva-tag{font-size:10.5px;font-weight:700;border-radius:999px;padding:2px 7px;background:#e2e8f0;color:#64748b;}',
    '.pva-tag.on{background:#ccfbf1;color:#0d9488;}',
    '.pva-hint{font-size:11.5px;color:#94a3b8;}',
    '.pva-foot{margin-top:auto;display:flex;align-items:center;gap:12px;padding-top:6px;}',
    '.pva-foot .pva-btn{padding:10px 18px;}',
    '.pva-sent{font-size:12.5px;font-weight:600;color:#16a34a;}',
    '.pva-sent.err{color:#ef4444;}',
    '.pva-cust-empty{padding:14px;text-align:center;color:#94a3b8;font-size:12.5px;}',
  ].join('\n');

  function ensureStyle() {
    if (document.getElementById('pv-alerts-style')) return;
    var s = document.createElement('style');
    s.id = 'pv-alerts-style';
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }

  // ── state ──
  var state = {
    items: [], unread: 0, tab: 'all', open: false, loading: false, error: null,
    customers: [], customersLoaded: false, customersLoading: false, customerSel: {}, recipMode: 'all', sending: false,
  };

  function paintBadge() {
    var b = document.getElementById('pva-nav-badge');
    if (b) { b.textContent = state.unread > 99 ? '99+' : String(state.unread); b.style.display = state.unread > 0 ? 'block' : 'none'; }
  }

  function loadCount() {
    if (!token()) { state.unread = 0; paintBadge(); return Promise.resolve(); }
    return api('/api/notifications/count').then(function (r) {
      state.unread = (r && r.data && r.data.unread) || 0; paintBadge();
    }).catch(function () {});
  }

  function load() {
    if (!token()) { state.items = []; state.unread = 0; return Promise.resolve(); }
    state.loading = true; state.error = null;
    return api('/api/notifications?limit=100').then(function (r) {
      state.items = (r && r.data) || [];
      state.unread = (r && r.unread) || 0;
      state.loading = false;
      paintBadge(); renderList();
    }).catch(function (e) {
      state.loading = false; state.error = e.message;
      renderList();
    });
  }

  // ── overlay ──
  function ensureOverlay() {
    var overlay = document.getElementById('pv-alerts-overlay');
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'pv-alerts-overlay';
    overlay.className = 'pva-overlay';
    overlay.hidden = true;
    overlay.innerHTML =
      '<div class="pva-backdrop"></div>' +
      '<aside class="pva-panel" role="dialog" aria-label="Alerts">' +
        '<div class="pva-head">' +
          '<h3>' + svg(ICONS.bell) + ' Alerts <span class="pva-pill" id="pva-head-count" style="display:none"></span></h3>' +
          '<button class="pva-btn" id="pva-read-all" type="button">Mark all read</button>' +
          '<button class="pva-close" id="pva-close" type="button" aria-label="Close">&times;</button>' +
        '</div>' +
        '<div class="pva-tabs">' +
          '<button class="pva-tab active" data-tab="all" type="button">All</button>' +
          '<button class="pva-tab" data-tab="unread" type="button">Unread</button>' +
          '<button class="pva-tab" data-tab="send" type="button">' + svg(ICONS.send) + ' Send</button>' +
        '</div>' +
        '<div class="pva-list" id="pva-list"></div>' +
        '<div class="pva-comp" id="pva-comp" hidden>' +
          '<div class="pva-field">' +
            '<label>Send to</label>' +
            '<div class="pva-seg" id="pva-seg">' +
              '<button type="button" data-mode="all" class="active">All portal customers</button>' +
              '<button type="button" data-mode="one">Specific customers</button>' +
            '</div>' +
          '</div>' +
          '<div class="pva-field" id="pva-cust-wrap" hidden>' +
            '<input type="text" class="pva-cust-search" id="pva-cust-search" placeholder="Search customer by name or phone…">' +
            '<div class="pva-cust" id="pva-cust"></div>' +
            '<div class="pva-hint" id="pva-cust-sel">None selected — customers without a portal login won\'t see it until they sign up.</div>' +
          '</div>' +
          '<div class="pva-field">' +
            '<label>Type</label>' +
            '<select id="pva-cat">' +
              '<option value="offer">Offer / Promotion</option>' +
              '<option value="alert">Alert</option>' +
              '<option value="general">General message</option>' +
            '</select>' +
          '</div>' +
          '<div class="pva-field">' +
            '<label>Priority</label>' +
            '<select id="pva-prio">' +
              '<option value="normal">Normal</option>' +
              '<option value="high">High</option>' +
              '<option value="urgent">Urgent</option>' +
              '<option value="low">Low</option>' +
            '</select>' +
          '</div>' +
          '<div class="pva-field">' +
            '<label>Title</label>' +
            '<input type="text" id="pva-t" maxlength="255" placeholder="e.g. 20% off vaccinations this week">' +
          '</div>' +
          '<div class="pva-field">' +
            '<label>Message</label>' +
            '<textarea id="pva-m" rows="4" maxlength="2000" placeholder="Write the offer or alert for your customers…"></textarea>' +
          '</div>' +
          '<div class="pva-foot">' +
            '<button class="pva-btn primary" id="pva-send" type="button">Send to customers</button>' +
            '<span class="pva-sent" id="pva-sent"></span>' +
          '</div>' +
        '</div>' +
      '</aside>';
    document.body.appendChild(overlay);
    overlay.querySelector('.pva-backdrop').addEventListener('click', closeOverlay);
    overlay.querySelector('#pva-close').addEventListener('click', closeOverlay);
    overlay.querySelector('#pva-read-all').addEventListener('click', markAll);
    overlay.querySelectorAll('.pva-tab').forEach(function (b) {
      b.addEventListener('click', function () { selectTab(b.dataset.tab); });
    });
    overlay.querySelector('#pva-seg').addEventListener('click', function (ev) {
      var b = ev.target.closest && ev.target.closest('button[data-mode]');
      if (!b) return;
      state.recipMode = b.dataset.mode;
      overlay.querySelectorAll('#pva-seg button').forEach(function (x) { x.classList.toggle('active', x === b); });
      var wrap = document.getElementById('pva-cust-wrap');
      if (wrap) wrap.hidden = state.recipMode !== 'one';
      if (state.recipMode === 'one') loadCustomers('');
      updateSelHint();
    });
    var search = overlay.querySelector('#pva-cust-search');
    var deb = null;
    search.addEventListener('input', function () {
      clearTimeout(deb);
      var v = search.value;
      deb = setTimeout(function () { loadCustomers(v); }, 250);
    });
    overlay.querySelector('#pva-send').addEventListener('click', sendMessage);
    return overlay;
  }

  function selectTab(tab) {
    state.tab = tab === 'unread' || tab === 'send' ? tab : 'all';
    var overlay = document.getElementById('pv-alerts-overlay');
    if (!overlay) return;
    overlay.querySelectorAll('.pva-tab').forEach(function (x) { x.classList.toggle('active', x.dataset.tab === state.tab); });
    var list = document.getElementById('pva-list');
    var comp = document.getElementById('pva-comp');
    var readAll = document.getElementById('pva-read-all');
    var isSend = state.tab === 'send';
    if (list) list.hidden = isSend;
    if (comp) comp.hidden = !isSend;
    if (readAll) readAll.style.display = isSend ? 'none' : '';
    if (isSend) {
      if (state.recipMode === 'one') loadCustomers(document.getElementById('pva-cust-search') ? document.getElementById('pva-cust-search').value : '');
      updateSelHint();
    } else {
      renderList();
    }
  }

  function sidebarWidth() {
    var el = findSidebar();
    if (!el) return 0;
    var w = el.getBoundingClientRect().width;
    return w > 0 ? Math.round(w) : 0;
  }

  function positionOverlay() {
    var o = document.getElementById('pv-alerts-overlay');
    if (o) o.style.left = sidebarWidth() + 'px';
  }

  function openOverlay() {
    ensureOverlay();
    positionOverlay();
    document.getElementById('pv-alerts-overlay').hidden = false;
    state.open = true;
    selectTab(state.tab);
    if (state.tab !== 'send') load();
  }
  function closeOverlay() {
    var o = document.getElementById('pv-alerts-overlay');
    if (o) o.hidden = true;
    state.open = false;
  }

  function renderList() {
    var list = document.getElementById('pva-list');
    if (!list) return;
    var headCount = document.getElementById('pva-head-count');
    if (headCount) { headCount.textContent = state.unread; headCount.style.display = state.unread > 0 ? 'inline-block' : 'none'; }
    list.innerHTML = '';

    if (state.loading) { list.innerHTML = '<div class="pva-empty">Loading…</div>'; return; }
    if (state.error) { list.innerHTML = '<div class="pva-empty">Could not load alerts.<br><span style="font-size:12px">' + escapeHtml(state.error) + '</span></div>'; return; }

    var items = state.items.filter(function (n) { return state.tab === 'all' ? true : !n.isRead; });
    if (!items.length) {
      list.innerHTML = '<div class="pva-empty">' + svg(ICONS.bell) + '<div>' + (state.tab === 'unread' ? 'No unread alerts' : 'No alerts yet') + '</div></div>';
      return;
    }

    items.forEach(function (n) {
      var el = document.createElement('div');
      el.className = 'pva-item' + (n.isRead ? '' : ' unread');
      var cat = iconFor(n.category);
      el.innerHTML =
        '<span class="pva-ic ' + cat + '">' + svg(ICONS[cat]) + '</span>' +
        '<div class="pva-body">' +
          '<div class="pva-title">' + escapeHtml(n.title || '') + '</div>' +
          (n.message ? '<div class="pva-msg">' + escapeHtml(n.message) + '</div>' : '') +
          '<div class="pva-meta">' + escapeHtml(timeAgo(n.createdAt)) + (n.category ? ' · ' + escapeHtml(String(n.category)) : '') + (n.priority && n.priority !== 'normal' ? ' · ' + escapeHtml(String(n.priority)) : '') + '</div>' +
        '</div>' +
        '<button class="pva-del" title="Delete" type="button">&times;</button>';
      el.addEventListener('click', function (ev) {
        if (ev.target.closest && ev.target.closest('.pva-del')) return;
        if (!n.isRead) {
          n.isRead = 1; state.unread = Math.max(0, state.unread - 1); paintBadge();
          el.classList.remove('unread'); renderList();
          api('/api/notifications/' + n.id + '/read', { method: 'PATCH' }).catch(function () {});
        }
      });
      el.querySelector('.pva-del').addEventListener('click', function (ev) {
        ev.stopPropagation();
        var wasUnread = !n.isRead;
        api('/api/notifications/' + n.id, { method: 'DELETE' }).then(function () {
          state.items = state.items.filter(function (x) { return x.id !== n.id; });
          if (wasUnread) state.unread = Math.max(0, state.unread - 1);
          paintBadge(); renderList();
        }).catch(function () {});
      });
      list.appendChild(el);
    });
  }

  function markAll() {
    api('/api/notifications/read-all', { method: 'POST' }).then(function () {
      state.items.forEach(function (n) { n.isRead = 1; });
      state.unread = 0; paintBadge(); renderList();
    }).catch(function () {});
  }

  // ── compose (send alert / offer to customers) ──
  function loadCustomers(search) {
    if (!token()) return;
    state.customersLoading = true;
    renderCustomers();
    var path = '/api/notifications/customers?limit=500';
    if (search) path += '&search=' + encodeURIComponent(search);
    return api(path).then(function (r) {
      state.customers = (r && r.data) || [];
      state.customersLoaded = true; state.customersLoading = false;
      renderCustomers();
    }).catch(function () { state.customersLoading = false; renderCustomers(); });
  }

  function renderCustomers() {
    var box = document.getElementById('pva-cust');
    if (!box) return;
    if (state.customersLoading && !state.customers.length) { box.innerHTML = '<div class="pva-cust-empty">Loading&hellip;</div>'; return; }
    if (!state.customers.length) { box.innerHTML = '<div class="pva-cust-empty">No customers found</div>'; return; }
    box.innerHTML = '';
    state.customers.forEach(function (c) {
      var on = !!state.customerSel[c.id];
      var row = document.createElement('label');
      row.className = 'pva-cust-row' + (on ? ' on' : '');
      row.innerHTML =
        '<input type="checkbox"' + (on ? ' checked' : '') + '>' +
        '<span class="pva-cust-name">' + escapeHtml(c.clientName || ('Customer #' + c.id)) + '</span>' +
        (c.hasPortal ? '<span class="pva-tag on">Portal</span>' : '<span class="pva-tag">No login</span>') +
        (c.contactNumber ? '<span class="pva-cust-sub">' + escapeHtml(c.contactNumber) + '</span>' : '');
      var cb = row.querySelector('input');
      cb.addEventListener('change', function () {
        if (cb.checked) state.customerSel[c.id] = true; else delete state.customerSel[c.id];
        row.classList.toggle('on', cb.checked);
        updateSelHint();
      });
      box.appendChild(row);
    });
  }

  function updateSelHint() {
    var el = document.getElementById('pva-cust-sel');
    if (!el) return;
    if (state.recipMode === 'all') {
      el.textContent = 'This sends to every customer that has a portal account.';
    } else {
      var n = Object.keys(state.customerSel).length;
      el.textContent = n + ' customer' + (n === 1 ? '' : 's') + ' selected. Customers without a portal login won\u2019t see it until they sign up.';
    }
  }

  function sendMessage() {
    if (state.sending) return;
    var title = (document.getElementById('pva-t').value || '').trim();
    var msg = (document.getElementById('pva-m').value || '').trim();
    var cat = document.getElementById('pva-cat').value;
    var prio = document.getElementById('pva-prio').value;
    var out = document.getElementById('pva-sent');
    if (!title) { out.className = 'pva-sent err'; out.textContent = 'Title is required'; return; }
    var body = { title: title, message: msg, category: cat, priority: prio };
    if (state.recipMode === 'all') {
      body.all = true;
    } else {
      var ids = Object.keys(state.customerSel).map(Number);
      if (!ids.length) { out.className = 'pva-sent err'; out.textContent = 'Select at least one customer'; return; }
      body.clientIds = ids;
    }
    state.sending = true;
    var btn = document.getElementById('pva-send');
    btn.disabled = true; out.className = 'pva-sent'; out.textContent = 'Sending\u2026';
    api('/api/notifications/send', { method: 'POST', body: body }).then(function (r) {
      state.sending = false; btn.disabled = false;
      var n = (r && r.sent) || 0;
      out.className = 'pva-sent'; out.textContent = 'Sent to ' + n + ' customer' + (n === 1 ? '' : 's');
      document.getElementById('pva-t').value = ''; document.getElementById('pva-m').value = '';
      state.customerSel = {}; renderCustomers(); updateSelHint();
    }).catch(function (e) {
      state.sending = false; btn.disabled = false;
      out.className = 'pva-sent err'; out.textContent = e.message || 'Could not send';
    });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
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
    a.id = 'pv-alerts-nav';
    a.href = '#';
    a.title = 'Alerts';
    if (sampleClass) a.className = sampleClass;
    a.style.cursor = 'pointer';
    a.innerHTML = '<span class="pva-nav-icon">' + svg(ICONS.bell) + '<span class="pva-nav-badge" id="pva-nav-badge" style="display:none"></span></span><span class="pva-nav-label">Alerts</span>';
    a.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); openOverlay(); });
    return a;
  }

  function syncNav() {
    var sidebar = findSidebar();
    if (!sidebar) return;
    var nav = sidebar.querySelector('nav');
    if (!nav) return;

    // A real route link gives us the exact classes for the current
    // (expanded / collapsed) sidebar state.
    var sample = nav.querySelector('a[href]:not(#pv-alerts-nav):not(#pv-customers-nav)');
    var sampleClass = sample ? sample.className : '';

    var existing = nav.querySelector('#pv-alerts-nav');
    if (existing && existing.parentNode === nav) {
      if (sampleClass && existing.className !== sampleClass) existing.className = sampleClass;
      // Keep it adjacent to the first real item (usually Dashboard).
      if (sample && existing.previousElementSibling !== sample) {
        nav.insertBefore(existing, sample.nextSibling);
      }
      var lbl = existing.querySelector('.pva-nav-label');
      var collapsed = sampleClass && /w-20|justify-center/.test(sampleClass) && sampleClass.indexOf('justify-center') !== -1;
      if (lbl) lbl.style.display = collapsed ? 'none' : '';
      // Re-attach the badge reference survived? paintBadge looks it up by id.
      paintBadge();
      return;
    }

    var item = makeNavItem(sampleClass || '');
    if (sample && sample.nextSibling) nav.insertBefore(item, sample.nextSibling);
    else nav.insertBefore(item, nav.firstChild);
    paintBadge();
  }

  // ── SSE + polling ──
  var es = null;
  function wireSSE() {
    try { if (es) { es.close(); es = null; } } catch (_) {}
    var t = token();
    if (!t) return;
    try {
      es = new EventSource('/events?t=' + encodeURIComponent(t));
      es.addEventListener('notifications-updated', function () {
        if (state.open) load(); else loadCount();
      });
      es.onerror = function () { try { es.close(); } catch (_) {} es = null; setTimeout(wireSSE, 30000); };
    } catch (_) {}
  }

  function boot() {
    ensureStyle();
    ensureOverlay();
    if (state.open) renderList();
    syncNav();
    loadCount();
    wireSSE();

    setInterval(function () {
      if (document.hidden) return;
      if (!document.getElementById('pv-alerts-nav')) syncNav();
      if (state.open) load(); else loadCount();
    }, POLL_MS);

    // React owns the sidebar <nav>; re-add our item whenever it re-renders.
    var pending = false;
    function schedule() {
      if (pending) return; pending = true;
      requestAnimationFrame(function () { pending = false; syncNav(); });
    }
    try {
      var mo = new MutationObserver(schedule);
      mo.observe(document.documentElement, { childList: true, subtree: true });
    } catch (_) {}
    window.addEventListener('load', function () { ensureStyle(); syncNav(); });
    window.addEventListener('resize', function () { if (state.open) positionOverlay(); });
    document.addEventListener('click', function (e) {
      if (!state.open) return;
      var a = e.target.closest && e.target.closest('nav a[href]');
      if (a && a.id !== 'pv-alerts-nav') closeOverlay();
    }, true);
    document.addEventListener('keydown', function (e) {
      if ((e.key === 'Escape' || e.key === 'Esc') && state.open) closeOverlay();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
