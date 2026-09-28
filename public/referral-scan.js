(function () {
  'use strict';

  // Only run on the signup page. The referral card's QR code now points at
  // /signup?ref=CODE, so this script pre-fills the code from the URL and, when
  // supported, lets the user scan a referral card QR with their camera instead
  // of typing the code. Manual entry stays fully supported.
  var path = window.location.pathname.replace(/\/+$/, '') || '/';
  if (path !== '/signup') return;

  function findRefField() {
    var fields = document.querySelectorAll('input');
    for (var i = 0; i < fields.length; i++) {
      var ph = fields[i].getAttribute('placeholder') || '';
      var name = (fields[i].getAttribute('name') || '') + ' ' + (fields[i].id || '');
      if (/REF-/i.test(ph) || /REF-/i.test(name) || /^referral/i.test(name.trim())) return fields[i];
    }
    return null;
  }

  // React owns these inputs; writing .value directly gets clobbered on the
  // next render, so use the native setter and dispatch a bubbling input event
  // the way a real keystroke would.
  function setFieldValue(el, value) {
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    if (setter) setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function extractRefFromText(text) {
    var m = String(text || '').match(/[?&]ref=([^&#]+)/);
    if (m) {
      try { return decodeURIComponent(m[1]).trim().toUpperCase(); } catch (_) { return m[1].trim().toUpperCase(); }
    }
    m = String(text || '').match(/\bREF-[A-Z0-9-]+/i);
    return m ? m[0].trim().toUpperCase() : null;
  }

  function refFromUrl() {
    try { return new URLSearchParams(window.location.search).get('ref'); } catch (_) { return null; }
  }

  function showToast(msg, ok) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:99999;' +
      'background:' + (ok === false ? '#dc2626' : '#059669') + ';color:#fff;padding:10px 18px;' +
      'border-radius:9999px;font:600 13px/1.4 "Plus Jakarta Sans",system-ui,sans-serif;' +
      'box-shadow:0 10px 30px rgba(0,0,0,.25);transition:opacity .3s;max-width:92vw';
    document.body.appendChild(t);
    setTimeout(function () { t.style.opacity = '0'; }, 3800);
    setTimeout(function () { t.remove(); }, 4200);
  }

  function makeButton() {
    var b = document.createElement('button');
    b.type = 'button';
    b.id = 'pv-ref-scan-btn';
    b.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><line x1="7" y1="12" x2="17" y2="12"/></svg> Scan Card QR';
    b.style.cssText = 'display:inline-flex;align-items:center;gap:6px;margin-top:6px;' +
      'background:#059669;color:#fff;border:0;border-radius:8px;padding:6px 12px;' +
      'font:600 12px/1 "Plus Jakarta Sans",system-ui,sans-serif;cursor:pointer;box-shadow:0 4px 12px rgba(5,150,105,.25)';
    return b;
  }

  var closing = false;
  function cleanupScan(stream, video, overlay, raf) {
    if (closing) return;
    closing = true;
    if (raf) cancelAnimationFrame(raf);
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    if (video) { video.srcObject = null; }
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
  }

  function startScan(el) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.BarcodeDetector) {
      showToast('QR scanning is not supported in this browser \u2014 please enter the code manually.', false);
      return;
    }
    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(2,6,23,.92);display:flex;' +
      'flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:24px;font:600 14px/1.4 "Plus Jakarta Sans",system-ui,sans-serif;color:#fff';
    overlay.innerHTML =
      '<p style="margin:0">Point the camera at the referral card\u2019s QR code</p>' +
      '<video playsinline muted style="max-width:min(420px,92vw);max-height:60vh;border-radius:16px;background:#000;width:100%;"></video>' +
      '<button type="button" style="background:#fff;color:#0f172a;border:0;border-radius:9999px;padding:10px 24px;font-weight:700;cursor:pointer;font:700 14px/1 system-ui,sans-serif">Cancel</button>';
    document.body.appendChild(overlay);
    var video = overlay.querySelector('video');
    var cancelBtn = overlay.querySelector('button');
    var stream = null, raf = null, detector = null;

    cancelBtn.addEventListener('click', function () { cleanupScan(stream, video, overlay, raf); });

    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      .then(function (s) {
        stream = s;
        video.srcObject = s;
        video.setAttribute('playsinline', '');
        return video.play();
      })
      .then(function () {
        detector = new BarcodeDetector({ formats: ['qr_code'] });
        raf = (function loop() {
          detector.detect(video).then(function (codes) {
            if (closing) return;
            for (var i = 0; i < codes.length; i++) {
              var ref = extractRefFromText(codes[i].rawValue);
              if (ref) {
                setFieldValue(el, ref);
                cleanupScan(stream, video, overlay, raf);
                showToast('Referral code applied: ' + ref);
                return;
              }
            }
            raf = requestAnimationFrame(loop);
          }).catch(function () { raf = requestAnimationFrame(loop); });
        })();
      })
      .catch(function () {
        cleanupScan(stream, video, overlay, raf);
        showToast('Could not access the camera. Please enter the code manually.', false);
      });
  }

  // Keep the field found + enhanced even if React re-renders the form.
  var attempts = 0;
  var timer = setInterval(function () {
    var el = findRefField();
    if (el) {
      var ref = refFromUrl();
      if (ref && !el.value) {
        setFieldValue(el, ref.trim().toUpperCase());
        showToast('Referral code applied: ' + ref.trim().toUpperCase());
      }
      var parent = el.parentNode;
      if (parent && !parent.querySelector('#pv-ref-scan-btn')) {
        var btn = makeButton();
        btn.addEventListener('click', function () { startScan(el); });
        parent.appendChild(btn);
      }
      attempts = 0; // keep watching in case React swaps the node
    } else if (++attempts > 100) {
      clearInterval(timer);
    }
  }, 250);
})();