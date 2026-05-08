// Touch controls for mobile / tablet — virtual joystick (left), drag-to-look
// area (right), fire button, plus jump / reload / grenade / sprint buttons.
//
// The module exposes:
//   - isTouch                : boolean — true if the device reports touch input
//   - touchState             : object  — read by the game loop each frame
//   - setupTouchControls(cb) : binds DOM events; call once after DOM is ready
//
// We intentionally drive the existing keyboard/mouse state inside main.js
// instead of forking the player-input code path. Joystick → keys.w/a/s/d,
// fire button → mouseDown, etc.

export const isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0;

export const touchState = {
  // Joystick — normalised to [-1, 1] in screen-space (Y-down).
  moveX: 0,
  moveY: 0,
  // Look — accumulated pixel delta since the last consumer read.
  lookDX: 0,
  lookDY: 0,
  // Held buttons
  firing: false,
  sprinting: false,
};

export function setupTouchControls({ onJump, onReload, onGrenade } = {}) {
  if (!isTouch) return;

  document.body.classList.add('is-touch');

  setupJoystick();
  setupLookArea();
  setupHoldButton('touchFire',   () => { touchState.firing = true; },   () => { touchState.firing = false; });
  setupHoldButton('touchSprint', () => { touchState.sprinting = true; }, () => { touchState.sprinting = false; });
  setupTapButton('touchJump',    onJump);
  setupTapButton('touchReload',  onReload);
  setupTapButton('touchGrenade', onGrenade);

  // Block iOS double-tap zoom / pull-to-refresh while playing
  document.addEventListener('gesturestart', e => e.preventDefault(), { passive: false });
}

// ─── Joystick ───────────────────────────────────────────────────────────
function setupJoystick() {
  const stick = document.getElementById('touchJoystick');
  const knob = stick.querySelector('.knob');
  if (!stick || !knob) return;

  const MAX_DIST = 50;
  let activeId = null;
  let baseX = 0, baseY = 0;

  const start = (e) => {
    const t = e.changedTouches[0];
    if (activeId !== null) return;
    activeId = t.identifier;
    const r = stick.getBoundingClientRect();
    baseX = r.left + r.width / 2;
    baseY = r.top + r.height / 2;
    e.preventDefault();
  };

  const move = (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier !== activeId) continue;
      const dx = t.clientX - baseX;
      const dy = t.clientY - baseY;
      const dist = Math.hypot(dx, dy);
      const clipped = Math.min(MAX_DIST, dist);
      const angle = Math.atan2(dy, dx);
      const cx = Math.cos(angle) * clipped;
      const cy = Math.sin(angle) * clipped;
      knob.style.transform = `translate(${cx}px, ${cy}px)`;
      touchState.moveX = (clipped / MAX_DIST) * Math.cos(angle);
      touchState.moveY = (clipped / MAX_DIST) * Math.sin(angle);
      e.preventDefault();
    }
  };

  const end = (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier !== activeId) continue;
      activeId = null;
      knob.style.transform = '';
      touchState.moveX = 0;
      touchState.moveY = 0;
    }
  };

  stick.addEventListener('touchstart',  start, { passive: false });
  document.addEventListener('touchmove', move,  { passive: false });
  document.addEventListener('touchend',  end);
  document.addEventListener('touchcancel', end);
}

// ─── Look area (right half of screen — drag to rotate camera) ───────────
function setupLookArea() {
  const area = document.getElementById('touchLookArea');
  if (!area) return;

  let activeId = null;
  let lastX = 0, lastY = 0;

  area.addEventListener('touchstart', (e) => {
    if (activeId !== null) return;
    const t = e.changedTouches[0];
    activeId = t.identifier;
    lastX = t.clientX;
    lastY = t.clientY;
    e.preventDefault();
  }, { passive: false });

  document.addEventListener('touchmove', (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier !== activeId) continue;
      touchState.lookDX += (t.clientX - lastX);
      touchState.lookDY += (t.clientY - lastY);
      lastX = t.clientX;
      lastY = t.clientY;
      e.preventDefault();
    }
  }, { passive: false });

  const end = (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier !== activeId) continue;
      activeId = null;
    }
  };
  document.addEventListener('touchend', end);
  document.addEventListener('touchcancel', end);
}

// ─── Buttons ────────────────────────────────────────────────────────────
function setupHoldButton(id, onPress, onRelease) {
  const el = document.getElementById(id);
  if (!el) return;
  let touchId = null;
  el.addEventListener('touchstart', (e) => {
    if (touchId !== null) return;
    touchId = e.changedTouches[0].identifier;
    el.classList.add('pressed');
    onPress?.();
    e.preventDefault();
  }, { passive: false });
  const end = (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier !== touchId) continue;
      touchId = null;
      el.classList.remove('pressed');
      onRelease?.();
    }
  };
  el.addEventListener('touchend', end);
  el.addEventListener('touchcancel', end);
}

function setupTapButton(id, onTap) {
  const el = document.getElementById(id);
  if (!el || !onTap) return;
  el.addEventListener('touchstart', (e) => {
    el.classList.add('pressed');
    onTap();
    e.preventDefault();
  }, { passive: false });
  const end = () => el.classList.remove('pressed');
  el.addEventListener('touchend', end);
  el.addEventListener('touchcancel', end);
}
