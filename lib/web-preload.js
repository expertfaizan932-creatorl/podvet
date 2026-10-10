// Generates the browser preload served at /web-preload.js. The real Electron
// preload (preload.js) is kept verbatim; we wrap its contextBridge call with a
// browser shim so window.electronAPI.* calls become HTTP posts to /_rpc/*.
const fs = require('fs');
const path = require('path');

const BUFFER_MARKER = '__pdfBuffer';
const DATE_MARKER = '__date';

function serializeRpcResult(value) {
  if (Buffer.isBuffer(value)) return { [BUFFER_MARKER]: value.toString('base64') };
  if (value instanceof Date) return { [DATE_MARKER]: value.toISOString() };
  if (Array.isArray(value)) return value.map(serializeRpcResult);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = serializeRpcResult(value[k]);
    return out;
  }
  return value;
}

function generateWebPreload() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');

  const bootstrap = `
(function () {
  var __listenerMap = {};
  var __esHandlerMap = {};
  var __es = null;
  function __revive(value) {
    if (Array.isArray(value)) return value.map(__revive);
    if (value && typeof value === 'object') {
      if (typeof value.__pdfBuffer === 'string') {
        try {
          var bin = atob(value.__pdfBuffer);
          var bytes = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return bytes;
        } catch (_) { return value; }
      }
      if (typeof value.__date === 'string') {
        return new Date(value.__date);
      }
      for (var k in value) value[k] = __revive(value[k]);
    }
    return value;
  }
  function __wire() {
    if (__es) return;
    // /events is behind the same token check as /_rpc, and EventSource cannot
    // send an Authorization header, so the token rides in the query string.
    var t = null;
    try {
      var s = JSON.parse(localStorage.getItem(__SESS_KEY) || 'null');
      t = s && s.tokens && s.tokens.accessToken;
    } catch (_) {}
    __es = new EventSource('/events' + (t ? '?t=' + encodeURIComponent(t) : ''));
    __es.onmessage = function () {};
    // A brand-new EventSource starts with zero listeners. Re-attach every
    // channel the renderer already subscribed to — __wire runs again inside
    // __rewire on sign-in, and without this every session-expired /
    // subscription-blocked / branding-changed event stayed dead for the rest
    // of the session (which is exactly why a rename never repainted the app).
    Object.keys(__esHandlerMap).forEach(function (ch) {
      try { __es.addEventListener(ch, __esHandlerMap[ch]); } catch (_) {}
    });
  }
  // The shell registers its listeners on mount, which on a cold start happens
  // while nobody is signed in yet - so the first /events connection is always
  // unauthenticated and gets refused. Re-open it once a session exists,
  // otherwise session-expired and subscription-blocked would never reach a
  // clinic that signed in after the page loaded.
  function __rewire() {
    if (__es) { try { __es.close(); } catch (_) {} __es = null; }
    __wire();
  }
  function __dispatch(channel, payload) {
    (__listenerMap[channel] || []).slice().forEach(function (fn) { fn(null, payload); });
  }
  var contextBridge = {
    exposeInMainWorld: function (name, obj) { window[name] = obj; if (window.__electronApiReady) window.__electronApiReady(name, obj); }
  };
  var ipcRenderer = {
    invoke: function (channel) {
      var args = Array.prototype.slice.call(arguments, 1)
        .map(function (a) { return a === undefined ? null : a; });
      if (channel === 'open-file-dialog' || channel === 'scan-products-csv' ||
          channel === 'pick-logo-file-select') {
        return __pickAndUpload(channel).then(function (go) {
          if (!go) return channel === 'open-file-dialog'
            ? { success: false, message: 'No file selected' }
            : { success: false, canceled: true };
          return __invokeRpc(channel, args, go.path);
        });
      }
      return __invokeRpc(channel, args, null);
    },
    on: function (channel, listener) {
      __wire();
      if (!__listenerMap[channel]) __listenerMap[channel] = [];
      __listenerMap[channel].push(listener);
      // One wrapper per channel, kept in __esHandlerMap so __wire can put it
      // back on a fresh EventSource after __rewire — a wrapper created here
      // and not stored anywhere would be lost with the connection it was
      // attached to.
      if (!__esHandlerMap[channel]) {
        var handler = function (e) {
          var payload = null;
          try { payload = JSON.parse(e.data); } catch (_) {}
          (__listenerMap[channel] || []).slice().forEach(function (fn) { fn(null, payload); });
        };
        __esHandlerMap[channel] = handler;
        if (__es) __es.addEventListener(channel, handler);
      }
    },
    removeListener: function (channel) {
      __listenerMap[channel] = [];
    }
  };
  var __SESS_KEY = 'podvet_session';
  function __loadSession() {
    try { return JSON.parse(localStorage.getItem(__SESS_KEY) || 'null') || null; } catch (_) { return null; }
  }
  function __saveSession(user, tokens) {
    try { localStorage.setItem(__SESS_KEY, JSON.stringify({ user: user, tokens: tokens })); } catch (_) {}
  }
  function __clearSession() {
    try { localStorage.removeItem(__SESS_KEY); } catch (_) {}
  }
  // After login/switch-clinic/signup, capture the fresh user + tokens so the
  // session survives server restarts (Render wipes ~/.podvet on deploy; the
  // browser keeps the session and re-injects it on every RPC).
  function __captureSession(channel, result) {
    if (channel === 'logout') return __clearSession();
    // A branding save returns the refreshed user so the app shell can repaint
    // in the clinic's new name/logo straight away. The browser copy has to be
    // updated here as well as in the server's store: the /_rpc endpoint
    // re-injects this cached user into the store on every single request, so a
    // server-side-only refresh would be overwritten by the stale pre-save
    // branding on the very next call.
    if (channel === 'branding-update' && result && result.user) {
      var prev = __loadSession();
      if (prev) {
        __saveSession(result.user, prev.tokens);
        // The SSE 'branding-changed' broadcast lands *inside* the handler,
        // i.e. before this reply updated the copy above, so a repaint driven
        // by it alone served the pre-save name/logo. Drop the memoised reads
        // and repaint once the fresh user is actually in place.
        try { if (window.__pvDropSessionCache) window.__pvDropSessionCache(); } catch (_) {}
        try { window.dispatchEvent(new Event('pv:brand-refresh')); } catch (_) {}
      }
    }
    // One login page for everyone: a platform-staff login lands here, so stash
    // the Super Admin token and hand the browser over to /super-admin.
    if (channel === 'login' && result && result.superAdmin && result.token) {
      try { localStorage.setItem('podvet_super_token', result.token); } catch (_) {}
      location.replace('/super-admin');
      return;
    }
    if (channel === 'login' || channel === 'switch-clinic' || channel === 'clinic-signup') {
      if (result && result.user) {
        // The handlers hand the tokens straight back now. They used to be
        // fetched from the server over __get-tokens, but that channel returned
        // the live access + refresh tokens to anyone who asked, so the whole
        // clinic account could be walked off the wire by a stranger. The tokens
        // now travel only in the reply to the sign-in that produced them.
        if (result.tokens && result.tokens.accessToken) {
          __saveSession(result.user, {
            accessToken: result.tokens.accessToken,
            refreshToken: result.tokens.refreshToken,
          });
          __rewire();
        }
        // These three are the moments the clinic identity changes hands:
        // signing in, switching clinic, and creating a clinic with its own
        // logo and name. clinic-branding.js listens for this and re-reads the
        // session, so the sidebar/logo/title/colour repaint in the new
        // clinic's brand immediately. Without it the app kept the platform's
        // PodVet logo and name until a full page reload, which is exactly
        // what a brand-new clinic saw on its very first screen.
        try { window.dispatchEvent(new Event('pv:brand-refresh')); } catch (_) {}
      }
    }
  }
  // Render free tier sleeps after ~15 min idle; the wake-up cold boot can take
  // up to a minute. Retry transient network failures (not RPC errors) so a
  // normal cold start never surfaces as a generic "Failed to load..." toast.
  var __RETRY_DELAYS = [1500, 3000, 6000, 12000, 24000];
  function __fetchWithRetry(url, options, attempt) {
    attempt = attempt || 0;
    return fetch(url, options).then(function (r) {
      return r.json();
    }).catch(function () {
      if (attempt >= __RETRY_DELAYS.length) {
        throw new Error('Could not reach the server. Please try again.');
      }
      return new Promise(function (resolve) {
        setTimeout(function () { resolve(__fetchWithRetry(url, options, attempt + 1)); }, __RETRY_DELAYS[attempt]);
      });
    });
  }
  function __invokeRpc(channel, args, dialogFilePath) {
    var body = { args: args, dialogFilePath: dialogFilePath };
    var sess = __loadSession();
    if (sess && sess.tokens && sess.tokens.accessToken) body.session = sess;
    return __fetchWithRetry('/_rpc/' + encodeURIComponent(channel), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (json) {
      if (json.ok) {
        // The server exchanges an expired access token for a fresh pair and
        // hands the new one back here. Without copying it over, the browser
        // would keep presenting the dead token on every later call and get
        // bounced to the login screen mid-clinic.
        if (json.session && json.session.tokens && json.session.tokens.accessToken) {
          var cur = __loadSession();
          if (cur) __saveSession(cur.user, json.session.tokens);
        }
        __captureSession(channel, json.result);
        return __revive(json.result);
      }
      var err = new Error((json.error && json.error.message) || 'Request failed');
      err.code = (json.error && json.error.code) || undefined;
      throw err;
    });
  }
  function __pickAndUpload(channel) {
    return new Promise(function (resolve) {
      if (!window.__fileInput) {
        window.__fileInput = document.createElement('input');
        window.__fileInput.type = 'file';
        window.__fileInput.style.display = 'none';
        document.body.appendChild(window.__fileInput);
      }
      var input = window.__fileInput;
      // The products importer parses through XLSX.readFile, which already
      // handles .csv and .xlsx identically, but the picker was restricted to
      // '.csv' only. In a browser the accept attribute does not merely
      // validate — it hides every other file type from the OS file dialog, so
      // a user with the obvious .xlsx export of their product list could not
      // select it at all and the dialog just looked broken. Matches the Data
      // Management importer's list, which already allowed all three.
      var accepts = channel === 'scan-products-csv' ? '.csv,.xlsx,.xls'
        : channel === 'pick-logo-file-select' ? '.png,.jpg,.jpeg,.webp'
        : '.json,.xlsx,.xls';
      input.accept = accepts;
      var done = false;
      // Dismissing the OS file dialog fires no 'change' event, so the promise
      // below used to never settle: the importer's spinner stayed on forever
      // and the modal could not be used again. 'cancel' covers the browsers
      // that support it, and the focus fallback covers the rest — regaining
      // window focus with no change event means the user closed the picker.
      var onFocus = function () {
        setTimeout(function () {
          if (done) return;
          done = true;
          resolve(null);
        }, 500);
      };
      input.onchange = function () {
        if (done) return; done = true;
        window.removeEventListener('focus', onFocus);
        var file = input.files && input.files[0];
        if (!file) return resolve(null);
        fetch('/web-upload', { method: 'POST', headers: { 'X-Filename': encodeURIComponent(file.name) }, body: file })
          .then(function (r) { return r.json(); })
          .then(function (j) { return j.ok ? resolve({ path: j.path, name: j.fileName }) : resolve(null); })
          .catch(function () { resolve(null); });
      };
      input.oncancel = function () {
        if (done) return; done = true;
        window.removeEventListener('focus', onFocus);
        resolve(null);
      };
      window.addEventListener('focus', onFocus, { once: true });
      input.value = '';
      input.click();
    });
  }
  var invoke = function (channel) {
    var args = Array.prototype.slice.call(arguments, 1)
      .map(function (a) { return a === undefined ? null : a; });
    return ipcRenderer.invoke.apply(null, [channel].concat(args));
  };
`;

  const marker = 'contextBridge.exposeInMainWorld(';
  const idx = src.indexOf(marker);
  if (idx === -1) throw new Error('Could not locate exposeInMainWorld in preload.js');
  const body = src.slice(idx);

  const extra = `
  window.electronAPI.restartAppToUpdate = function () { return invoke('restart-app-to-update'); };
  window.electronAPI.openExternalLink = function (url) { window.open(url, '_blank'); return Promise.resolve(); };
  window.electronAPI.openWhatsApp = function (url) { window.open(url, '_blank'); return Promise.resolve(); };

  // Clinic-side helpers used by the buttons patched into the built bundle:
  // approve a customer's pending appointment request, and create a customer
  // portal login to share with them. Self-contained so the bundle itself only
  // needs a one-line onClick.
  window.__pvApproveAppointment = function (appointmentId) {
    if (!appointmentId) return;
    if (!window.confirm('Approve this appointment request?')) return;
    window.electronAPI.updateAppointmentStatus(appointmentId, 'Confirmed').then(function (result) {
      if (result && result.success) {
        window.location.reload();
      } else {
        window.alert((result && (result.error || result.message)) || 'Could not approve the appointment.');
      }
    }).catch(function (err) {
      window.alert((err && err.message) || 'Could not approve the appointment.');
    });
  };
  window.__pvClientPortal = function (clientId, clientName) {
    window.electronAPI.getClientPortalAccount(clientId).then(function (result) {
      var info = (result && result.data) || {};
      var label = clientName ? (' for ' + clientName) : '';
      var email = window.prompt('Portal login email' + label + ':', info.email || '');
      if (email === null) return;
      email = String(email).trim();
      if (!email) { window.alert('Email is required.'); return; }
      var password = window.prompt('Password to share with the customer (leave blank to auto-generate):', '');
      if (password === null) return;
      window.electronAPI.createClientPortalAccount(clientId, email, password ? password : undefined).then(function (res) {
        if (res && res.success) {
          var d = res.data || {};
          window.alert('Portal account ready.\\n\\nLogin email: ' + d.email + '\\nPassword: ' + d.password + '\\nPortal link: ' + (d.portalPath || '/portal') + '\\n\\nShare these details with the customer.');
        } else {
          window.alert((res && (res.message || res.error)) || 'Could not create the portal account.');
        }
      }).catch(function (err) {
        window.alert((err && err.message) || 'Could not create the portal account.');
      });
    }).catch(function (err) {
      window.alert((err && err.message) || 'Could not load the portal account.');
    });
  };

  // Data Management > Export. The handler builds the workbook and returns it
  // as base64; the Settings screen only reads result.message and never touches
  // filePath, so on its own the click produced a success toast and no file at
  // all. Turn the base64 into a real browser download here, in the preload,
  // rather than rebuilding the React bundle just for this.
  (function () {
    var original = window.electronAPI.exportData;
    if (!original) return;
    window.electronAPI.exportData = function (options) {
      return original.call(window.electronAPI, options).then(function (result) {
        if (!result || !result.success || !result.base64) return result;
        try {
          var bin = atob(result.base64);
          var bytes = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          var blob = new Blob([bytes], {
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          });
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url;
          a.download = result.fileName || ('podvet-data-export-' + Date.now() + '.xlsx');
          a.style.display = 'none';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
        } catch (err) {
          console.error('Data export download failed:', err);
        }
        // Don't keep a full copy of the workbook alive in the caller's result.
        try { delete result.base64; } catch (_) { result.base64 = undefined; }
        return result;
      });
    };
  })();
  // Session reads for the route guard and the sidebar.
  //
  // Both of these used to be HTTP round trips on every single call, and the
  // route guard mounts one of these around most pages and renders a full-screen
  // spinner until it resolves. That is why clicking through the app kept
  // flashing: the pages with no guard drew straight away, while Boarding and
  // everything below it - which are the guarded ones - tore the shell down and
  // rebuilt it once the round trip came back. The sidebar calls getSession()
  // too, so a single navigation could fire the same request several times over.
  //
  // Who is signed in changes rarely, and every way it can change already
  // passes through this file, so the read is cached in memory and dropped on
  // those events instead. Caching only affects what the UI decides to draw:
  // the server still authorises every real request, so a cached read can never
  // grant access the user would not have had anyway.
  (function () {
    var TTL = 15000;
    var cache = {};
    var inflight = {};

    function memoize(name) {
      var original = window.electronAPI[name];
      if (!original) return;
      window.electronAPI[name] = function () {
        var hit = cache[name];
        // Serve the recent copy immediately, and let the request already in
        // flight refresh it for the next caller.
        if (hit && Date.now() - hit.at < TTL) return Promise.resolve(hit.value);
        if (inflight[name]) return inflight[name];
        inflight[name] = original.apply(window.electronAPI, arguments).then(function (result) {
          cache[name] = { value: result, at: Date.now() };
          delete inflight[name];
          return result;
        }, function (err) {
          // Never keep a failed read: the caller must be able to retry.
          delete cache[name];
          delete inflight[name];
          throw err;
        });
        return inflight[name];
      };
    }
    ['getSession', 'resumeSession'].forEach(memoize);

    // Sign in, sign out and switching clinic all change the answer, so the
    // cache has to go with them - otherwise the guard would happily keep
    // authorising whoever was signed in a moment ago.
    //
    // The epoch is what the route guard watches. The guard holds its pending
    // session check on the module so that suspending it needs no state update
    // during render, which means it cannot notice a stale answer on its own -
    // it has to be told. Bumping the epoch here is that signal, and it also
    // covers a role change that arrives without a fresh login.
    function bumpEpoch() {
      try { window.__pvSessionEpoch = (window.__pvSessionEpoch || 0) + 1; } catch (_) {}
    }
    ['login', 'logout', 'switchClinic', 'clinicSignup', 'brandingUpdate'].forEach(function (name) {
      var original = window.electronAPI[name];
      if (!original) return;
      window.electronAPI[name] = function () {
        cache = {};
        inflight = {};
        bumpEpoch();
        var out = original.apply(window.electronAPI, arguments);
        // A concurrent read (the repaint an SSE event triggers, another tab's
        // guard) can re-fill the cache with the pre-change session while this
        // call is still in flight, and that stale copy would then outlive it.
        return Promise.resolve(out).then(function (r) {
          cache = {};
          inflight = {};
          bumpEpoch();
          return r;
        });
      };
    });

    // Publish the dropper so the RPC path in the bootstrap above can flush the
    // cache the moment it writes the fresh session to localStorage.
    window.__pvDropSessionCache = function () {
      cache = {};
      inflight = {};
      bumpEpoch();
    };
  })();

  // The branding save is broadcast from inside its own handler — before the RPC
  // reply has updated this tab's copy of the session — and in every other open
  // tab no reply arrives at all. Apply the user the handler broadcasts (so this
  // tab's later RPCs carry the new name/logo instead of the stale one), flush
  // the memoised session reads, then repaint.
  ipcRenderer.on('branding-changed', function (_evt, payload) {
    var fresh = payload && payload.user;
    if (fresh) {
      try {
        var prev = __loadSession();
        if (prev) __saveSession(fresh, prev.tokens);
      } catch (_) {}
    }
    if (window.__pvDropSessionCache) window.__pvDropSessionCache();
    try { window.dispatchEvent(new Event('pv:brand-refresh')); } catch (_) {}
  });
  window.electronAPI.printPdfFile = function (pdfPath) {
    if (pdfPath) window.open('/serve-file?path=' + encodeURIComponent(pdfPath) + '&inline=1', '_blank');
    return Promise.resolve({ success: true });
  };
  window.electronAPI.printPdfBuffer = function (payload) {
    try {
      var d = (payload && payload.data) || payload;
      var bytes = typeof d === 'string' ? atob(d) : null;
      if (payload && payload.data && typeof payload.data === 'object' && payload.data.data) {
        bytes = payload.data.data.map(function (b) { return String.fromCharCode(b); }).join('');
      }
      if (bytes) {
        var blob = new Blob([Uint8Array.from(bytes, function (c) { return c.charCodeAt(0); })], { type: 'application/pdf' });
        window.open(URL.createObjectURL(blob), '_blank');
      }
    } catch (_) {}
    return Promise.resolve({ success: true });
  };

  function __rewriteFileUris(root) {
    root = root || document;
    var els = root.querySelectorAll ? root.querySelectorAll('iframe[src^="file:"], img[src^="file:"], a[href^="file:"]') : [];
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var attr = el.tagName === 'A' ? 'href' : 'src';
      var val = el.getAttribute(attr);
      if (!val || val.indexOf('file:') !== 0) continue;
      var p = val;
      if (p.indexOf('file:///') === 0) p = p.substring(7);
      else if (p.indexOf('file://') === 0) p = p.substring(7);
      else if (p.indexOf('file:/') === 0) p = p.substring(6);
      else p = p.substring(5);
      p = p.split('\\\\').join('/');
      if (/^\\/[A-Za-z]:/.test(p)) p = p.substring(1);
      el.setAttribute(attr, '/serve-file?path=' + encodeURIComponent(p) + '&inline=1');
    }
  }
  __rewriteFileUris();
  var __mut = new MutationObserver(function () { __rewriteFileUris(document); });
  __mut.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'href'] });
  window.addEventListener('load', function () { __rewriteFileUris(document); });
})();
`;

  return { source: bootstrap + '\n' + body + '\n' + extra, serializeRpcResult, reviveRpcResult };
}

function reviveRpcResult(value) {
  if (Array.isArray(value)) return value.map(reviveRpcResult);
  if (value && typeof value === 'object') {
    if (typeof value[BUFFER_MARKER] === 'string') {
      try {
        const bin = atob(value[BUFFER_MARKER]);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes;
      } catch (_) { return value; }
    }
    if (typeof value[DATE_MARKER] === 'string') {
      return new Date(value[DATE_MARKER]);
    }
    for (const k of Object.keys(value)) value[k] = reviveRpcResult(value[k]);
  }
  return value;
}

module.exports = { generateWebPreload, serializeRpcResult, reviveRpcResult };