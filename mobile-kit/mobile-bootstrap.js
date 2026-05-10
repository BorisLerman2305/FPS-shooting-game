// Mobile Web App Kit — vanilla JS bootstrap.
//
// Side-effect-only module. Load it once at the bottom of your entry HTML
// (or `import` it from your bundle's main file) and you get:
//
//   1. body.is-touch class on touch devices (so CSS can show/hide bits)
//   2. body.is-standalone class when running as an installed PWA
//   3. Reliable viewport-resize handling (fixes the "black bar" bug on
//      Android when the URL bar collapses)
//   4. Auto fullscreen on the first user gesture (Android only — iOS Safari
//      blocks programmatic fullscreen for browser pages)
//   5. One-time gold "Add to Home Screen" hint for iOS Safari users who
//      haven't installed the PWA yet
//   6. Pinch-zoom + pull-to-refresh suppression (good for app-like sites,
//      remove if your app needs them — see SETTINGS below)
//
// No dependencies. Safe to call multiple times — guards against double-init.

(() => {
  if (window.__mobileKitReady) return;
  window.__mobileKitReady = true;

  // ─── SETTINGS — tweak before deploying ─────────────────────────────────
  const SETTINGS = {
    // The Hebrew + English copy shown in the iOS install hint. Replace with
    // whatever language(s) your audience speaks.
    iosHintHTML: `
      📱 To play in fullscreen on iPhone:
      <div class="small">Tap <strong>Share</strong> at the bottom of Safari →
      <strong>Add to Home Screen</strong></div>
      <div class="close">(tap here to dismiss)</div>
    `,
    iosHintTimeoutMs: 12000,         // how long the hint stays before auto-dismissing
    iosHintShowOncePerSession: true, // false = show on every page load
    suppressPullToRefresh: true,     // disable iOS rubber-band pull-to-refresh during play
    suppressDoubleTapZoom: true,     // disable iOS double-tap zoom
    fullscreenOnAndroid: true,       // call requestFullscreen() on first gesture
  };

  // ─── Detection ─────────────────────────────────────────────────────────
  const isTouch =
    ('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0;
  const isiOS =
    /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  const isStandalone =
    window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches;

  if (isTouch)      document.body.classList.add('is-touch');
  if (isStandalone) document.body.classList.add('is-standalone');

  // ─── Viewport resize handling ──────────────────────────────────────────
  // Android Chrome animates the URL bar in/out, which changes the
  // visualViewport but NOT always window.innerHeight at the same instant.
  // Without this, fixed-height canvases / 100vh elements show a black strip.
  function pushViewportHeightVar() {
    const vv = window.visualViewport;
    const h = (vv && vv.height) || window.innerHeight || document.documentElement.clientHeight;
    const w = (vv && vv.width)  || window.innerWidth  || document.documentElement.clientWidth;
    if (h > 0) document.documentElement.style.setProperty('--viewport-h', h + 'px');
    if (w > 0) document.documentElement.style.setProperty('--viewport-w', w + 'px');
    // Let app code listen for this if it needs to resize a canvas etc.
    window.dispatchEvent(new CustomEvent('mobilekit:viewportresize', {
      detail: { width: w, height: h },
    }));
  }
  window.addEventListener('resize', pushViewportHeightVar);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', pushViewportHeightVar);
    window.visualViewport.addEventListener('scroll', pushViewportHeightVar);
  }
  window.addEventListener('orientationchange',         () => setTimeout(pushViewportHeightVar, 80));
  document.addEventListener('fullscreenchange',        () => setTimeout(pushViewportHeightVar, 80));
  document.addEventListener('webkitfullscreenchange',  () => setTimeout(pushViewportHeightVar, 80));
  setTimeout(pushViewportHeightVar, 400);
  setTimeout(pushViewportHeightVar, 1200);
  pushViewportHeightVar();

  // ─── Fullscreen on first user gesture (Android) ────────────────────────
  let _fullscreenTried = false;
  function tryFullscreen() {
    if (_fullscreenTried) return;
    if (!SETTINGS.fullscreenOnAndroid) return;
    if (!isTouch || isiOS || isStandalone) return; // iOS refuses, standalone already chrome-less
    _fullscreenTried = true;
    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!req) return;
    try {
      const r = req.call(el);
      if (r && r.catch) r.catch(() => {});
    } catch {}
  }
  document.addEventListener('click',    tryFullscreen, { capture: true });
  document.addEventListener('touchend', tryFullscreen, { capture: true, passive: true });

  // ─── iOS install hint ──────────────────────────────────────────────────
  if (isiOS && isTouch && !isStandalone) {
    const seenKey = 'mobile_kit_ios_hint_seen_v1';
    const alreadySeen = SETTINGS.iosHintShowOncePerSession && sessionStorage.getItem(seenKey);
    if (!alreadySeen) {
      if (SETTINGS.iosHintShowOncePerSession) sessionStorage.setItem(seenKey, '1');
      setTimeout(() => {
        const hint = document.createElement('div');
        hint.id = 'mobileKitIOSHint';
        hint.innerHTML = SETTINGS.iosHintHTML;
        hint.addEventListener('click', () => hint.remove());
        document.body.appendChild(hint);
        setTimeout(() => { if (hint.isConnected) hint.remove(); }, SETTINGS.iosHintTimeoutMs);
      }, 1200);
    }
  }

  // ─── Suppress iOS gestures that interfere with app-like sites ──────────
  if (SETTINGS.suppressDoubleTapZoom) {
    document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false });
  }
  if (SETTINGS.suppressPullToRefresh && isiOS) {
    // Only prevent pull-to-refresh while at the very top of the page
    let startY = 0;
    document.addEventListener('touchstart', (e) => {
      startY = e.touches[0].clientY;
    }, { passive: true });
    document.addEventListener('touchmove', (e) => {
      const y = e.touches[0].clientY;
      const scrolledTop = (document.scrollingElement || document.documentElement).scrollTop;
      if (scrolledTop <= 0 && y > startY) e.preventDefault();
    }, { passive: false });
  }

  console.log('[mobile-kit] ready · touch=%s ios=%s standalone=%s', isTouch, isiOS, isStandalone);
})();
