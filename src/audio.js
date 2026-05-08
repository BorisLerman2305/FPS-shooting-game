// Synthesized sound effects via WebAudio. No external assets — every sound
// is built from oscillators / filtered noise so the game ships self-contained.

let ctx = null;
let masterGain = null;
let muted = false;

// Browsers require a user gesture before AudioContext can play.
// We lazily build it on the first play attempt; if blocked we silently no-op.
function ensureCtx() {
  if (ctx) return ctx;
  try {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    ctx = new C();
    masterGain = ctx.createGain();
    masterGain.gain.value = 0.5;
    masterGain.connect(ctx.destination);
  } catch { ctx = null; }
  return ctx;
}

// Resume() must be called from a user gesture; we attach this to the first click.
export function unlockOnUserGesture() {
  const handler = () => {
    const c = ensureCtx();
    if (c && c.state === 'suspended') c.resume();
    window.removeEventListener('pointerdown', handler);
    window.removeEventListener('keydown', handler);
  };
  window.addEventListener('pointerdown', handler, { once: false });
  window.addEventListener('keydown', handler, { once: false });
}

export function setMuted(m) { muted = !!m; if (masterGain) masterGain.gain.value = muted ? 0 : 0.5; }
export function toggleMuted() { setMuted(!muted); return muted; }
export function isMuted() { return muted; }

// One-off noise buffer cached for re-use across short SFX
let noiseBuf = null;
function getNoiseBuffer() {
  if (!ctx) return null;
  if (noiseBuf) return noiseBuf;
  const len = ctx.sampleRate * 1.0;
  noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = noiseBuf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return noiseBuf;
}

// Helper: short envelope on a gain node (attack + decay)
function envelope(gain, t0, peak, attack, release) {
  gain.gain.cancelScheduledValues(t0);
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(peak, t0 + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + release);
}

// Generic noise burst with a band-pass filter — used for many gun sounds
function noiseBurst({ freq = 1200, q = 1, dur = 0.12, gain = 0.6, lowpass = 4000 }) {
  if (!ensureCtx() || muted) return;
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = getNoiseBuffer();
  src.loop = true;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = q;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = lowpass;
  const g = ctx.createGain();
  src.connect(bp); bp.connect(lp); lp.connect(g); g.connect(masterGain);
  envelope(g, t, gain, 0.005, dur);
  src.start(t);
  src.stop(t + dur + 0.05);
}

// A short tonal "thud" used in explosion / shotgun rumble
function tone({ freq = 80, dur = 0.3, gain = 0.5, type = 'sine', sweepTo = null }) {
  if (!ensureCtx() || muted) return;
  const t = ctx.currentTime;
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (sweepTo != null) o.frequency.exponentialRampToValueAtTime(Math.max(20, sweepTo), t + dur);
  const g = ctx.createGain();
  o.connect(g); g.connect(masterGain);
  envelope(g, t, gain, 0.005, dur);
  o.start(t);
  o.stop(t + dur + 0.05);
}

// ─── Specific sound effects ───────────────────────────────────────────────
export function shotPistol()  { noiseBurst({ freq: 1400, q: 1.2, dur: 0.10, gain: 0.55, lowpass: 5000 }); tone({ freq: 200, dur: 0.06, gain: 0.25, type: 'square', sweepTo: 60 }); }
export function shotRifle()   { noiseBurst({ freq: 1800, q: 1.4, dur: 0.07, gain: 0.45, lowpass: 6000 }); tone({ freq: 240, dur: 0.05, gain: 0.20, type: 'square', sweepTo: 80 }); }
export function shotSniper()  { noiseBurst({ freq: 900,  q: 0.7, dur: 0.18, gain: 0.7,  lowpass: 4500 }); tone({ freq: 90,  dur: 0.16, gain: 0.45, type: 'sine',   sweepTo: 30 }); }
export function shotShotgun() { noiseBurst({ freq: 700,  q: 0.6, dur: 0.18, gain: 0.7,  lowpass: 3500 }); tone({ freq: 70,  dur: 0.18, gain: 0.55, type: 'sine',   sweepTo: 30 }); }
export function swordSwing()  { noiseBurst({ freq: 2400, q: 4,   dur: 0.18, gain: 0.35, lowpass: 6000 }); tone({ freq: 600, dur: 0.18, gain: 0.10, type: 'sine',   sweepTo: 200 }); }
// Continuous flame loop — kept short and re-triggered each tick
export function flameTick()   { noiseBurst({ freq: 600,  q: 0.4, dur: 0.06, gain: 0.18, lowpass: 1800 }); }

export function explosion() {
  if (!ensureCtx() || muted) return;
  const t = ctx.currentTime;
  // Punch (low sweep)
  tone({ freq: 120, dur: 0.45, gain: 0.7, type: 'sine', sweepTo: 30 });
  // Crackle (filtered noise)
  noiseBurst({ freq: 800, q: 0.3, dur: 0.4, gain: 0.55, lowpass: 4000 });
  // Sub-bass thump
  setTimeout(() => tone({ freq: 60, dur: 0.6, gain: 0.5, type: 'sine', sweepTo: 25 }), 30);
}

export function hitConfirm() { tone({ freq: 1400, dur: 0.06, gain: 0.25, type: 'sine' }); tone({ freq: 1900, dur: 0.05, gain: 0.18, type: 'sine' }); }
export function botDeath()   { tone({ freq: 220, dur: 0.35, gain: 0.4, type: 'sawtooth', sweepTo: 60 }); }
export function reloadClick(){ tone({ freq: 1100, dur: 0.04, gain: 0.18, type: 'square' }); setTimeout(() => tone({ freq: 800, dur: 0.05, gain: 0.18, type: 'square' }), 80); }
export function pickupItem() { tone({ freq: 600,  dur: 0.10, gain: 0.3, type: 'sine' }); setTimeout(() => tone({ freq: 900,  dur: 0.10, gain: 0.3, type: 'sine' }), 70); setTimeout(() => tone({ freq: 1300, dur: 0.10, gain: 0.3, type: 'sine' }), 140); }
export function damageHurt() { noiseBurst({ freq: 250, q: 0.5, dur: 0.18, gain: 0.4, lowpass: 1200 }); }
export function emptyClick() { tone({ freq: 1000, dur: 0.04, gain: 0.15, type: 'square' }); }

// Footstep — a short filtered noise, alternating slightly to feel natural
let stepFlip = false;
export function footstep() {
  stepFlip = !stepFlip;
  noiseBurst({ freq: stepFlip ? 350 : 280, q: 1.5, dur: 0.07, gain: 0.18, lowpass: 1200 });
}
