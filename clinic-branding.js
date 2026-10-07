// Per-clinic white-label branding for the logged-in app.
//
// Every clinic gets its own database but they all ran the same frontend, so the
// app shell painted the platform's own logo and name for everyone: the sidebar
// logo was a hardcoded /brand/icon-primary.png, the sidebar wordmark was the
// literal "PodVet", and the document title was "PodVet - Veterinary Management".
// The clinic's real name/logo/colour DID exist — in the session, on the
// clinic_settings row — but nothing in the UI read them.
//
// This script is the one place that turns that stored branding into what the
// browser actually shows. It runs before the app bundle (see index.js), so:
//
//   1. It publishes window.__pvBrand from a per-clinic localStorage cache
//      synchronously, so the very first paint is already in the clinic's brand
//      (no flash of the platform logo while a request is in flight).
//   2. It confirms that against the real session, and against the platform
//      defaults when nobody is signed in — the login/signup screens belong to
//      the platform, not to any one clinic.
//   3. It applies the title, the favicons and the --brand-* colour ramp, and
//      broadcasts every change on the window so the sidebar (which reads
//      window.__pvBrand at render time) repaints.
//
// The sidebar itself is a built bundle and cannot be rebuilt from source here,
// so it reads window.__pvBrand.name / .logo / .poweredBy directly.
(function () {
  if (window.__pvBrandingInit) return;
  window.__pvBrandingInit = true;

  var DEFAULT_PLATFORM = {
    name: 'PodVet',
    fullName: 'PodVet - Veterinary Management',
    logo: '/brand/icon-primary.png',
    color: '#92CAED',
    address: '',
    phone: '',
    tagline: '',
    poweredBy: '',
    clinicId: null,
  };

  // Cache is keyed by clinic id: the same browser can hold sessions for several
  // clinics, and painting clinic A's logo on clinic B's dashboard would be a
  // worse bug than the flash this cache is here to avoid.
  var POINTER_KEY = 'pvBrand:active';
  var cacheKey = function (clinicId) { return 'pvBrand:' + clinicId; };

  function readCache() {
    try {
      var id = localStorage.getItem(POINTER_KEY);
      if (!id) return null;
      var raw = localStorage.getItem(cacheKey(id));
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  function writeCache(brand) {
    if (!brand || !brand.clinicId) return;
    try {
      localStorage.setItem(cacheKey(brand.clinicId), JSON.stringify(brand));
      localStorage.setItem(POINTER_KEY, String(brand.clinicId));
    } catch (_) {
      /* private mode / quota: the cache is an optimisation, not a requirement */
    }
  }

  function clearCache() {
    try {
      var id = localStorage.getItem(POINTER_KEY);
      if (id) localStorage.removeItem(cacheKey(id));
      localStorage.removeItem(POINTER_KEY);
    } catch (_) {}
  }

  // ── colour ramp ────────────────────────────────────────────────────────────
  // Builds --brand-50..900 so a clinic's chosen colour lands on --brand-500.
  // Same shading offsets the CSS build uses, so recolouring the ramp keeps the
  // existing component contrast intact.
  var RAMP_SLOTS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900];
  var L_DELTA = { 50: 30, 100: 26, 200: 22, 300: 17, 400: 11, 500: 0, 600: -8, 700: -14, 800: -20, 900: -26 };

  function hexToHsl(hex) {
    hex = String(hex || '').replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(function (c) { return c + c; }).join('');
    if (hex.length !== 6 || /[^0-9a-f]/i.test(hex)) return null;
    var r = parseInt(hex.slice(0, 2), 16) / 255;
    var g = parseInt(hex.slice(2, 4), 16) / 255;
    var b = parseInt(hex.slice(4, 6), 16) / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h = 0, s = 0, l = (max + min) / 2;
    var d = max - min;
    if (d) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return { h: Math.round(h) % 360, s: Math.round(s * 100), l: Math.round(l * 100) };
  }

  function hslToRgb(h, s, l) {
    s /= 100; l /= 100;
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var hp = h / 60;
    var x = c * (1 - Math.abs((hp % 2) - 1));
    var rgb = [0, 0, 0];
    if (hp >= 0 && hp < 1) { rgb = [c, x, 0]; }
    else if (hp < 2) { rgb = [x, c, 0]; }
    else if (hp < 3) { rgb = [0, c, x]; }
    else if (hp < 4) { rgb = [0, x, c]; }
    else if (hp < 5) { rgb = [x, 0, c]; }
    else { rgb = [c, 0, x]; }
    var m = l - c / 2;
    return '#' + rgb.map(function (v) {
      return Math.round((v + m) * 255).toString(16).padStart(2, '0');
    }).join('');
  }

  function applyRamp(hex) {
    var hsl = hexToHsl(hex);
    if (!hsl) return;
    var root = document.documentElement;
    RAMP_SLOTS.forEach(function (slot) {
      var l = Math.max(6, Math.min(96, hsl.l + L_DELTA[slot]));
      root.style.setProperty('--brand-' + slot, hslToRgb(hsl.h, Math.max(55, hsl.s), l));
    });
    var meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'theme-color');
      document.head.appendChild(meta);
    }
    meta.setAttribute('content', hex);
  }

  // ── favicons ───────────────────────────────────────────────────────────────
  // Rewrites every <link rel~="icon">/apple-touch-icon at once. index.html
  // ships five PodVet favicon variants; leaving even one behind shows the
  // platform's mark in bookmarks, the tab strip and installed-app launchers.
  function applyFavicons(logo) {
    if (!logo) return;
    var links = document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"]');
    Array.prototype.forEach.call(links, function (link) {
      if (!link.getAttribute('href')) return;
      link.setAttribute('href', logo);
    });
  }

  function applyTitle(brand) {
    document.title = brand.name || DEFAULT_PLATFORM.fullName;
  }

  // ── apply ──────────────────────────────────────────────────────────────────
  var current = null;

  function normalise(input, fallbackName) {
    return {
      clinicId: input.clinicId ?? null,
      name: input.name || fallbackName || DEFAULT_PLATFORM.name,
      logo: input.logo || DEFAULT_PLATFORM.logo,
      color: input.color || DEFAULT_PLATFORM.color,
      address: input.address || '',
      phone: input.phone || '',
      tagline: input.tagline || '',
      poweredBy: input.poweredBy || '',
    };
  }

  function apply(next) {
    current = next;
    window.__pvBrand = next;
    applyTitle(next);
    applyFavicons(next.logo);
    applyRamp(next.color);
    writeCache(next);
    // Anything that renders the clinic's name/logo at React render time (the
    // sidebar) subscribes to this to repaint.
    window.dispatchEvent(new CustomEvent('pv:brand', { detail: next }));
    return next;
  }

  function brandFromSession(session) {
    if (!session || !session.clinic_id) return null;
    return normalise({
      clinicId: session.clinic_id,
      name: session.organization_name,
      logo: session.clinic_logo,
      color: session.clinic_color,
      address: session.clinic_address,
      phone: session.clinic_phone,
      tagline: session.clinic_tagline,
      poweredBy: session.clinic_powered_by,
    });
  }

  // ── boot ───────────────────────────────────────────────────────────────────
  // 1. Paint from the cache immediately — this runs before the app bundle, so
  //    the very first frame is already branded.
  var cached = readCache();
  apply(cached ? normalise(cached) : normalise({}));

  // 2. Then confirm against the actual session. Signed out (or on a cached
  //    session belonging to a different clinic) means the platform's own
  //    branding, which is what the login and signup screens are.
  function syncFromSession() {
    if (!window.electronAPI || !window.electronAPI.getSession) return Promise.resolve();
    return Promise.resolve(window.electronAPI.getSession())
      .then(function (session) {
        var fromSession = brandFromSession(session);
        if (!fromSession) {
          clearCache();
          apply(normalise({}));
          return;
        }
        if (!cached || String(cached.clinicId) !== String(fromSession.clinicId)) {
          apply(fromSession);
          return;
        }
        // Same clinic as the cache, but the session is authoritative and
        // fresher (a rename in another tab, a resume after a long sleep).
        apply(fromSession);
      })
      .catch(function () { /* offline: the cache we already painted stands */ });
  }

  syncFromSession();

  // Settings saves branding through branding-update, which refreshes the cached
  // session and then broadcasts 'branding-changed'. Re-read the session so a
  // rename or a new logo repaints the whole app without a reload.
  if (window.electronAPI && window.electronAPI.onBrandingChanged) {
    try { window.electronAPI.onBrandingChanged(syncFromSession); } catch (_) {}
  }
  window.addEventListener('pv:brand-refresh', syncFromSession);

  // The app routes by hash and signs in / signs up / picks a plan without ever
  // reloading the document, so the branding resolved at boot (while still
  // signed out, and therefore the platform's) would otherwise stay on screen
  // for the rest of the session -- a brand-new clinic would keep showing the
  // PodVet logo and name on the very first screens after creating itself.
  //
  // Only re-read the session when the app crosses the signed-out/signed-in
  // boundary, which is the only time the clinic identity can have changed.
  // Re-syncing on *every* route change would put a getSession round trip behind
  // every tab switch in the app for no benefit.
  var SIGNED_OUT_ROUTES = ['/', '/signup', '/forgot-password', '/verify-otp'];
  function isSignedOutRoute(hash) {
    // The app uses hash routing ("#/settings?tab=x") but tolerate a bare path
    // too. Strip the leading '#' and any query first -- stripping from the
    // first '#' or '?' would eat the hash itself and make every route look
    // like the login screen.
    var h = String(hash == null ? '' : hash).replace(/^#+/, '').split('?')[0].replace(/\/+$/, '');
    // The root is the login screen, i.e. always signed out.
    if (h === '') return true;
    return SIGNED_OUT_ROUTES.indexOf(h) !== -1;
  }

  var lastSignedOut = isSignedOutRoute(window.location.hash);
  window.addEventListener('hashchange', function () {
    var nowSignedOut = isSignedOutRoute(window.location.hash);
    if (nowSignedOut === lastSignedOut) return;
    lastSignedOut = nowSignedOut;
    syncFromSession();
  });

  // theme-picker.js owns the colour picker. It applies the ramp itself for
  // instant feedback while dragging; these two hooks keep the published brand
  // (and therefore the sidebar and the favicons) in step once it commits.
  window.addEventListener('pv:brand-color', function (e) {
    var hex = e.detail && e.detail.color;
    if (!hex || !current) return;
    if (hex === current.color) return;
    current.color = hex;
    window.__pvBrand = current;
    writeCache(current);
    window.dispatchEvent(new CustomEvent('pv:brand', { detail: current }));
  });
})();