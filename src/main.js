import * as THREE from 'three';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import * as Auth from './auth.js';
import * as Sfx from './audio.js';
import { net } from './net.js';
import { isTouch, touchState, setupTouchControls } from './touch.js';
import { SHOP_ITEMS, SHOP_ORDER, isOwned } from './shop.js';

// ─── Scene, camera, renderer ──────────────────────────────────────────────
const scene = new THREE.Scene();
// Sky is sky-blue overall but with a subtle vertical gradient — overhead
// is a touch deeper, the horizon a touch lighter. Not enough to leave the
// "Minecraft" feel, just enough to stop the screen looking flat-painted.
const SKY_TOP     = new THREE.Color(0x6da9ec);
const SKY_HORIZON = new THREE.Color(0xb8dcff);
const SKY_COLOR   = SKY_HORIZON;       // legacy alias used elsewhere
scene.background  = SKY_HORIZON.clone();
// Fog tinted to the horizon colour so the world fades into the sky cleanly.
scene.fog = new THREE.Fog(0xb8dcff, 110, 360);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1200);
camera.position.set(0, 1.7, 0); // eye height ~1.7m

// Minecraft-flavoured but not flat: AA on, sharp shadows, mild ACES tone
// mapping for vibrant skies + sun glow. Textures still nearest-filtered
// for the blocky look; the tone curve only affects lighting.
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.getElementById('app').appendChild(renderer.domElement);

// Sky objects exposed at module scope so tickDayCycle can animate them.
let sunVisual = null;
let moonVisual = null;
let sunCoreMat = null, sunHaloMat = null;
let moonCoreMat = null, moonHaloMat = null;
let starsMesh = null;
let skyDomeMat = null;

function buildSkyDome() {
  // Gradient dome — top deep blue, horizon paler. Vertex colours are now
  // baked from neutral "day" tones at build time, and tinted at runtime
  // by tickDayCycle via the material's `color` property.
  const domeGeo = new THREE.SphereGeometry(700, 24, 16);
  const positions = domeGeo.attributes.position;
  const colors = new Float32Array(positions.count * 3);
  for (let i = 0; i < positions.count; i++) {
    const y = positions.getY(i);
    const t = THREE.MathUtils.clamp((y + 80) / 480, 0, 1);
    // Bake as relative tone: 1.0 horizon, 0.85 zenith. tickDayCycle multiplies.
    const tone = THREE.MathUtils.lerp(1.0, 0.78, t);
    colors[i * 3] = tone; colors[i * 3 + 1] = tone; colors[i * 3 + 2] = tone;
  }
  domeGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  skyDomeMat = new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false,
    color: 0xb8dcff,    // multiplied by per-vertex tone — gets tinted each frame
  });
  scene.add(new THREE.Mesh(domeGeo, skyDomeMat));

  // Sun
  sunCoreMat = new THREE.MeshBasicMaterial({ color: 0xfff7d2, fog: false, depthWrite: false });
  sunHaloMat = new THREE.MeshBasicMaterial({ color: 0xfff4a8, transparent: true, opacity: 0.35, fog: false, depthWrite: false });
  sunVisual = new THREE.Group();
  sunVisual.add(
    new THREE.Mesh(new THREE.SphereGeometry(40, 24, 24), sunHaloMat),
    new THREE.Mesh(new THREE.SphereGeometry(24, 24, 24), sunCoreMat),
  );
  scene.add(sunVisual);

  // Moon
  moonCoreMat = new THREE.MeshBasicMaterial({ color: 0xeef3ff, fog: false, depthWrite: false });
  moonHaloMat = new THREE.MeshBasicMaterial({ color: 0xc8d6ee, transparent: true, opacity: 0.25, fog: false, depthWrite: false });
  moonVisual = new THREE.Group();
  moonVisual.add(
    new THREE.Mesh(new THREE.SphereGeometry(22, 20, 20), moonHaloMat),
    new THREE.Mesh(new THREE.SphereGeometry(14, 20, 20), moonCoreMat),
  );
  scene.add(moonVisual);

  // Stars — a few hundred white points on a sphere, only visible at night.
  const starCount = 400;
  const starGeo = new THREE.BufferGeometry();
  const starPos = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount; i++) {
    // Distribute on upper hemisphere
    const u = Math.random(), v = 0.5 + Math.random() * 0.5;
    const theta = u * Math.PI * 2;
    const phi = Math.acos(v * 2 - 1);
    const r = 650;
    starPos[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
    starPos[i * 3 + 1] = r * Math.cos(phi);
    starPos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  const starMat = new THREE.PointsMaterial({
    color: 0xffffff, size: 2.5, sizeAttenuation: false,
    transparent: true, opacity: 0, depthWrite: false, fog: false,
  });
  starsMesh = new THREE.Points(starGeo, starMat);
  scene.add(starsMesh);

  // Clouds — same as before, but slightly brighter so they pop at noon
  const cloudMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.78, fog: false });
  for (let i = 0; i < 16; i++) {
    const cloud = new THREE.Group();
    const cubes = 5 + Math.floor(Math.random() * 5);
    let xOff = 0, zOff = 0;
    for (let j = 0; j < cubes; j++) {
      const w = 8 + Math.random() * 4;
      const d = 8 + Math.random() * 4;
      const cube = new THREE.Mesh(new THREE.BoxGeometry(w, 4, d), cloudMat);
      cube.position.set(xOff, (Math.random() - 0.5) * 1.5, zOff);
      cloud.add(cube);
      xOff += 5 + Math.random() * 5;
      zOff += (Math.random() - 0.5) * 6;
    }
    cloud.position.set(
      (Math.random() - 0.5) * 600,
      150 + Math.random() * 50,
      (Math.random() - 0.5) * 600
    );
    scene.add(cloud);
  }
}
buildSkyDome();

// ─── Day / night cycle ────────────────────────────────────────────────────
// One full day = `period` real-time seconds. The cycle keeps running even
// outside an active match so the menu looks alive too.
const dayCycle = {
  time:   90,    // seconds into the cycle at start (90 = morning)
  period: 480,   // 8 minutes per full day
  paused: false,
};
// Sun/moon orbit on a tilted ring around the scene
const SUN_ORBIT_RADIUS = 500;
const SUN_TILT_Z       = -120; // slight north/south offset so the sun isn't dead-centre

// Palette stops — each represents a phase of the cycle by `t` (0-1).
// Linearly blended each frame.
const SKY_PHASES = [
  // t,    skyTint,     fog,         hemiSky,     hemiGround,  hemiInt, sunInt, sunColor
  [0.00, 0x1a2a4a, 0x1a2a4a, 0x152540, 0x1a2410, 0.20, 0.05, 0x556088], // midnight
  [0.20, 0xffb060, 0xffb060, 0xffc9a0, 0x6f7a5a, 0.55, 0.95, 0xffcfa0], // dawn
  [0.30, 0xb8dcff, 0xb8dcff, 0xb8e0ff, 0x6f8a4a, 0.85, 1.40, 0xfff2cc], // morning
  [0.50, 0xb8dcff, 0xb8dcff, 0xb8e0ff, 0x6f8a4a, 0.85, 1.40, 0xfff2cc], // noon
  [0.70, 0xff8a3a, 0xff9c5c, 0xffc9a0, 0x7a6a4a, 0.55, 0.90, 0xff9a55], // dusk
  [0.85, 0x2a3158, 0x2a3158, 0x2a3850, 0x252040, 0.25, 0.10, 0x6080a8], // twilight
  [1.00, 0x1a2a4a, 0x1a2a4a, 0x152540, 0x1a2410, 0.20, 0.05, 0x556088], // midnight (wraps)
];

function lerpPhase(t) {
  // Find the two stops surrounding t
  for (let i = 0; i < SKY_PHASES.length - 1; i++) {
    const a = SKY_PHASES[i], b = SKY_PHASES[i + 1];
    if (t >= a[0] && t <= b[0]) {
      const k = (t - a[0]) / (b[0] - a[0]);
      return {
        skyTint:     new THREE.Color(a[1]).lerp(new THREE.Color(b[1]), k),
        fog:         new THREE.Color(a[2]).lerp(new THREE.Color(b[2]), k),
        hemiSky:     new THREE.Color(a[3]).lerp(new THREE.Color(b[3]), k),
        hemiGround:  new THREE.Color(a[4]).lerp(new THREE.Color(b[4]), k),
        hemiInt:     THREE.MathUtils.lerp(a[5], b[5], k),
        sunInt:      THREE.MathUtils.lerp(a[6], b[6], k),
        sunColor:    new THREE.Color(a[7]).lerp(new THREE.Color(b[7]), k),
      };
    }
  }
  // Fallback (shouldn't hit if 0 ≤ t ≤ 1)
  return null;
}

// ─── Weather (rain + snow) ────────────────────────────────────────────────
// Particle pool follows the player so the precipitation always lands near
// us. Weather rolls a die every ~30-90s to switch between clear / rain /
// snow. Tints sky + lights so the world looks heavier in bad weather.
const WEATHER_PARTICLES = 700;
const WEATHER_RADIUS    = 45;
const WEATHER_HEIGHT    = 28;

const weather = {
  type: 'clear',         // 'clear' | 'rain' | 'snow'
  // First roll fires fast so testers see weather almost immediately,
  // then re-rolls follow the regular cadence.
  changeTimer: 8,
  particles: null,
  positions: null,
  velocities: null,
  swirlPhase: 0,
};

function createWeatherSystem() {
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(WEATHER_PARTICLES * 3);
  const velocities = new Float32Array(WEATHER_PARTICLES * 3);
  for (let i = 0; i < WEATHER_PARTICLES; i++) {
    positions[i * 3]     = (Math.random() - 0.5) * WEATHER_RADIUS * 2;
    positions[i * 3 + 1] = Math.random() * WEATHER_HEIGHT;
    positions[i * 3 + 2] = (Math.random() - 0.5) * WEATHER_RADIUS * 2;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    color: 0xffffff,
    size: 0.4,
    transparent: true,
    opacity: 0,                // invisible while clear
    sizeAttenuation: true,
    depthWrite: false,
    fog: true,
  });
  weather.particles = new THREE.Points(geo, mat);
  weather.particles.frustumCulled = false; // pool moves with the player
  scene.add(weather.particles);
  weather.positions = positions;
  weather.velocities = velocities;
}

function setWeather(type) {
  if (!weather.particles) return;
  weather.type = type;
  const m = weather.particles.material;
  if (type === 'rain') {
    m.color.set(0x9eb8d4);
    m.size = 0.28;        // up from 0.18 — easier to see
    m.opacity = 0.80;     // up from 0.65
    for (let i = 0; i < WEATHER_PARTICLES; i++) {
      weather.velocities[i * 3]     = -1.5 + Math.random() * 0.4;
      weather.velocities[i * 3 + 1] = -22 - Math.random() * 6;
      weather.velocities[i * 3 + 2] = 0;
    }
  } else if (type === 'snow') {
    m.color.set(0xffffff);
    m.size = 0.55;
    m.opacity = 0.9;
    for (let i = 0; i < WEATHER_PARTICLES; i++) {
      weather.velocities[i * 3]     = (Math.random() - 0.5) * 1.2;
      weather.velocities[i * 3 + 1] = -1.4 - Math.random() * 0.6;
      weather.velocities[i * 3 + 2] = (Math.random() - 0.5) * 1.2;
    }
  } else {
    m.opacity = 0;
  }
}

function tickWeather(dt) {
  if (!weather.particles) return;
  // Random transitions — more frequent now so it actually shows up during play
  weather.changeTimer -= dt;
  if (weather.changeTimer <= 0) {
    if (weather.type === 'clear') {
      const r = Math.random();
      if (r < 0.40) setWeather('rain');         // up from 0.18
      else if (r < 0.65) setWeather('snow');    // up from 0.28
      weather.changeTimer = 25 + Math.random() * 35;   // re-roll faster
    } else {
      if (Math.random() < 0.55) setWeather('clear');
      weather.changeTimer = 25 + Math.random() * 35;
    }
  }
  if (weather.type === 'clear') return;

  const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
  const pos = weather.positions, vel = weather.velocities;
  weather.swirlPhase += dt;

  for (let i = 0; i < WEATHER_PARTICLES; i++) {
    const ix = i * 3;
    pos[ix]     += vel[ix]     * dt;
    pos[ix + 1] += vel[ix + 1] * dt;
    pos[ix + 2] += vel[ix + 2] * dt;
    if (weather.type === 'snow') {
      // Lazy sin-wave swirl so flakes wobble as they fall
      pos[ix]     += Math.sin(pos[ix + 1] * 0.4 + i) * 0.6 * dt;
      pos[ix + 2] += Math.cos(pos[ix + 1] * 0.4 + i * 0.5) * 0.6 * dt;
    }
    // Recycle when below ground or too far from the player
    const dx = pos[ix] - cx, dz = pos[ix + 2] - cz;
    const tooFar = dx * dx + dz * dz > WEATHER_RADIUS * WEATHER_RADIUS;
    if (pos[ix + 1] < cy - 6 || tooFar) {
      pos[ix]     = cx + (Math.random() - 0.5) * WEATHER_RADIUS * 2;
      pos[ix + 1] = cy + WEATHER_HEIGHT - Math.random() * 6;
      pos[ix + 2] = cz + (Math.random() - 0.5) * WEATHER_RADIUS * 2;
    }
  }
  weather.particles.geometry.attributes.position.needsUpdate = true;
}

// Initialise the particle system once at boot
createWeatherSystem();

function tickDayCycle(dt) {
  if (!dayCycle.paused) dayCycle.time = (dayCycle.time + dt) % dayCycle.period;
  const t = dayCycle.time / dayCycle.period;        // 0-1 across the day
  const phase = lerpPhase(t);
  if (!phase) return;

  // Sun + moon orbit. Sun at t=0.25 should be due east horizon (rising),
  // t=0.5 high noon, t=0.75 due west horizon (setting), t=0 midnight.
  // Translate t into an angle that crosses zenith at t=0.5.
  const sunAngle = (t - 0.25) * Math.PI * 2;        // 0 at sunrise, π at sunset
  const sunY     = Math.sin(sunAngle) * SUN_ORBIT_RADIUS;
  const sunX     = Math.cos(sunAngle) * SUN_ORBIT_RADIUS;
  if (sunVisual)  sunVisual.position.set(sunX, sunY, SUN_TILT_Z);
  if (moonVisual) moonVisual.position.set(-sunX, -sunY, -SUN_TILT_Z);

  // Sun/moon brightness fades when below horizon
  const aboveHorizon = THREE.MathUtils.clamp(sunY / 100, 0, 1);
  if (sunCoreMat) sunCoreMat.opacity = 0.2 + aboveHorizon * 0.8;
  if (sunHaloMat) sunHaloMat.opacity = aboveHorizon * 0.35;
  sunCoreMat.transparent = sunHaloMat.transparent = true;
  if (moonCoreMat) moonCoreMat.opacity = 0.2 + (1 - aboveHorizon) * 0.8;
  if (moonHaloMat) moonHaloMat.opacity = (1 - aboveHorizon) * 0.25;
  moonCoreMat.transparent = moonHaloMat.transparent = true;

  // Stars: only visible at night
  if (starsMesh) starsMesh.material.opacity = THREE.MathUtils.clamp((1 - aboveHorizon) - 0.2, 0, 0.9);

  // Sky tint + fog (multiplied by the active map theme so a Nether arena
  // looks crimson, snow looks washed-out, etc.)
  const theme = getTheme();
  const themeSky = new THREE.Color(theme.skyTint);
  const themeFog = new THREE.Color(theme.fogTint);
  if (skyDomeMat) skyDomeMat.color.copy(phase.skyTint).multiply(themeSky);
  scene.background.copy(phase.skyTint).multiply(themeSky);
  scene.fog.color.copy(phase.fog).multiply(themeFog);

  // Lights
  hemi.color.copy(phase.hemiSky);
  hemi.groundColor.copy(phase.hemiGround);
  hemi.intensity = phase.hemiInt;
  sun.color.copy(phase.sunColor);
  sun.intensity = phase.sunInt;

  // Weather tint applied on top of the day-cycle palette — stormy when
  // raining, washed-out when snowing.
  if (weather.type === 'rain') {
    const grey = new THREE.Color(0x5a6878);
    scene.background.lerp(grey, 0.45);
    scene.fog.color.lerp(grey, 0.45);
    if (skyDomeMat) skyDomeMat.color.lerp(grey, 0.45);
    hemi.intensity *= 0.68;
    sun.intensity  *= 0.55;
  } else if (weather.type === 'snow') {
    const pale = new THREE.Color(0xd6dde6);
    scene.background.lerp(pale, 0.30);
    scene.fog.color.lerp(pale, 0.30);
    if (skyDomeMat) skyDomeMat.color.lerp(pale, 0.30);
    hemi.intensity *= 0.85;
    sun.intensity  *= 0.80;
  }
  // Have the directional light come FROM the visual sun's direction so
  // shadows line up with where the sun is in the sky.
  if (sunY > 0) {
    sun.position.set(camera.position.x + sunX * 0.1, 40 + sunY * 0.1, camera.position.z + SUN_TILT_Z * 0.1);
  }
}

// Postprocessing: bloom for glowing sun, muzzle flashes, fire, explosions
const composer = new EffectComposer(renderer);
const renderPass = new RenderPass(scene, camera);
composer.addPass(renderPass);
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  // A bit of bloom so the sun, muzzle flashes, lightsaber and explosions
  // all glow — without softening the pixel-art world textures.
  0.35,  // strength
  0.40,  // radius
  0.85,  // threshold
);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

function handleResize() {
  // Prefer visualViewport on mobile — it reflects the area NOT covered by
  // the URL bar / system UI / virtual keyboard. window.innerWidth/Height
  // can lie on Android Chrome while the URL bar is animating away.
  const vv = window.visualViewport;
  const w = (vv && vv.width)  || window.innerWidth  || document.documentElement.clientWidth;
  const h = (vv && vv.height) || window.innerHeight || document.documentElement.clientHeight;
  if (w === 0 || h === 0) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
  bloomPass.setSize(w, h);
}
window.addEventListener('resize', handleResize);
new ResizeObserver(handleResize).observe(document.documentElement);
// Mobile-only events that fire when the URL bar collapses, the device rotates,
// or fullscreen toggles — desktops never hit any of these but touch devices
// hit them constantly during the first few seconds of gameplay.
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', handleResize);
  window.visualViewport.addEventListener('scroll', handleResize);
}
window.addEventListener('orientationchange',         () => setTimeout(handleResize, 80));
document.addEventListener('fullscreenchange',        () => setTimeout(handleResize, 80));
document.addEventListener('webkitfullscreenchange',  () => setTimeout(handleResize, 80));
// And one more "settle" pass shortly after load so a late URL-bar collapse
// doesn't leave a black strip at the bottom of the canvas.
setTimeout(handleResize, 400);
setTimeout(handleResize, 1200);
handleResize();

// Activate WebAudio on the first user gesture (browsers require this)
Sfx.unlockOnUserGesture();

// ─── Forward declarations for state read by the animate loop ─────────────
// (declared up-front so tickNetSync — invoked from animate() — doesn't hit
// the temporal dead zone before the multiplayer block at the bottom runs)
const remotePlayers = new Map();
let syncAccumulator = 0;

// Cached overlay elements, looked up once. Used in animate() to keep the
// `body.in-game` class in sync with whichever menu is currently visible.
const _menuEls = {
  start:    document.getElementById('overlay'),
  auth:     document.getElementById('authOverlay'),
  gameOver: document.getElementById('gameOver'),
  victory:  document.getElementById('victory'),
  admin:    document.getElementById('adminPanel'),
};

// ─── Procedural textures (Minecraft-style: 16×16 pixel art, no filtering) ─
// All textures are drawn into a 16×16 canvas and bound with NearestFilter
// + no mipmaps so they stay crisp at any distance/size — the trademark
// blocky look. Anisotropy disabled for the same reason.
function makePixelTexture(canvas, repeat = 1) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.anisotropy = 1;
  return tex;
}

// Tiny seedable RNG so each texture is reproducible regardless of when it's drawn
function makeTexRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = s + 0x6D2B79F5 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function pixelCanvas(seed, size, draw) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const x = c.getContext('2d');
  x.imageSmoothingEnabled = false;
  draw(x, makeTexRng(seed), size);
  return c;
}

// All textures are now 32×32 — quadruple the detail of the previous 16×16
// tier without losing the chunky pixel-art feel.
const TEX_SIZE = 32;

// Grass top — irregular green field with bright tufts and dark patches
function makeGrassTopTex() {
  return pixelCanvas(101, TEX_SIZE, (x, rng, S) => {
    x.fillStyle = '#5fa845'; x.fillRect(0, 0, S, S);
    // Larger soft patches first (the "biome variation" feel)
    for (let i = 0; i < 6; i++) {
      const cx = Math.floor(rng() * S), cy = Math.floor(rng() * S);
      const radius = 3 + Math.floor(rng() * 4);
      const dark = rng() > 0.5;
      for (let py = -radius; py <= radius; py++) {
        for (let px = -radius; px <= radius; px++) {
          if (px * px + py * py > radius * radius) continue;
          if (rng() > 0.5) continue;
          x.fillStyle = dark ? '#3e7826' : '#80c95a';
          x.fillRect((cx + px + S) % S, (cy + py + S) % S, 1, 1);
        }
      }
    }
    // Per-pixel speckle
    const palette = ['#4a8e34', '#6fb84e', '#80c95a', '#3e7826', '#5fa845', '#5fa845', '#5fa845'];
    for (let i = 0; i < 320; i++) {
      x.fillStyle = palette[Math.floor(rng() * palette.length)];
      x.fillRect(Math.floor(rng() * S), Math.floor(rng() * S), 1, 1);
    }
    // A few yellow flowers / dry patches
    for (let i = 0; i < 4; i++) {
      x.fillStyle = ['#e8c870', '#cf9d3a'][Math.floor(rng() * 2)];
      x.fillRect(Math.floor(rng() * S), Math.floor(rng() * S), 1, 1);
    }
  });
}

// Grass side — strip of grass on top, dirt below with a ragged transition
function makeGrassSideTex() {
  return pixelCanvas(102, TEX_SIZE, (x, rng, S) => {
    // Dirt body
    x.fillStyle = '#866043'; x.fillRect(0, 0, S, S);
    for (let i = 0; i < 380; i++) {
      const py = 6 + Math.floor(rng() * (S - 6));
      x.fillStyle = ['#6f4d33', '#9a7150', '#5e4128', '#866043', '#7a5638'][Math.floor(rng() * 5)];
      x.fillRect(Math.floor(rng() * S), py, 1, 1);
    }
    // Ragged grass overhang
    for (let px = 0; px < S; px++) {
      const drop = Math.floor(rng() * 5); // 0-4 px of irregular grass drip
      const stripH = 5 + drop;
      x.fillStyle = '#5fa845';
      x.fillRect(px, 0, 1, stripH);
      // Speckle the grass band
      if (rng() > 0.4) {
        x.fillStyle = ['#4a8e34', '#80c95a', '#3e7826'][Math.floor(rng() * 3)];
        x.fillRect(px, Math.floor(rng() * stripH), 1, 1);
      }
    }
  });
}

function makeDirtTex() {
  return pixelCanvas(103, TEX_SIZE, (x, rng, S) => {
    x.fillStyle = '#866043'; x.fillRect(0, 0, S, S);
    const pal = ['#6f4d33', '#9a7150', '#5e4128', '#7a5638', '#866043', '#9a7150', '#866043'];
    for (let i = 0; i < 460; i++) {
      x.fillStyle = pal[Math.floor(rng() * pal.length)];
      x.fillRect(Math.floor(rng() * S), Math.floor(rng() * S), 1, 1);
    }
    // A few tiny pebbles
    for (let i = 0; i < 8; i++) {
      x.fillStyle = '#3a2a14';
      x.fillRect(Math.floor(rng() * S), Math.floor(rng() * S), 1, 1);
    }
  });
}

// Oak log — vertical bark with deeper grooves
function makeLogSideTex() {
  return pixelCanvas(104, TEX_SIZE, (x, rng, S) => {
    x.fillStyle = '#5d4423'; x.fillRect(0, 0, S, S);
    for (let px = 0; px < S; px++) {
      const m = px % 8;
      x.fillStyle = (m === 0 || m === 1) ? '#3a2a14'
                : (m === 4 || m === 5)   ? '#6e5230'
                : '#5d4423';
      x.fillRect(px, 0, 1, S);
    }
    // Pixel knots + horizontal cracks
    for (let i = 0; i < 22; i++) {
      x.fillStyle = '#2c1f10';
      x.fillRect(Math.floor(rng() * S), Math.floor(rng() * S), 1, 1);
    }
    for (let i = 0; i < 5; i++) {
      const cy = Math.floor(rng() * S);
      const len = 4 + Math.floor(rng() * 8);
      x.fillStyle = '#3a2a14';
      x.fillRect(Math.floor(rng() * (S - len)), cy, len, 1);
    }
  });
}
function makeLogTopTex() {
  return pixelCanvas(105, TEX_SIZE, (x, rng, S) => {
    x.fillStyle = '#a17a48'; x.fillRect(0, 0, S, S);
    const cx = S / 2, cy = S / 2;
    for (let py = 0; py < S; py++) {
      for (let px = 0; px < S; px++) {
        const d = Math.round(Math.hypot(px - cx, py - cy));
        if (d % 4 === 0) { x.fillStyle = '#7a5832'; x.fillRect(px, py, 1, 1); }
        else if (d % 4 === 1 && rng() > 0.7) { x.fillStyle = '#8e6839'; x.fillRect(px, py, 1, 1); }
      }
    }
    // Centre dot
    x.fillStyle = '#3a2a14';
    x.fillRect(cx - 1, cy - 1, 2, 2);
  });
}

// Wood planks — 4 horizontal rows with kerf marks and grain
function makePlanksTex() {
  return pixelCanvas(106, TEX_SIZE, (x, rng, S) => {
    x.fillStyle = '#a07246'; x.fillRect(0, 0, S, S);
    const rowH = S / 4;
    const tones = ['#a07246', '#8e6438', '#a87a4e', '#956a3c'];
    for (let row = 0; row < 4; row++) {
      const y = row * rowH;
      x.fillStyle = tones[row];
      x.fillRect(0, y, S, rowH);
      x.fillStyle = '#5a3a1f';
      x.fillRect(0, y, S, 1);
      // Plank kerf cuts at staggered x positions
      const kerfX = ((row * 11) + 4) % S;
      x.fillStyle = '#5a3a1f';
      x.fillRect(kerfX, y, 1, rowH);
      // Grain wisps
      for (let i = 0; i < 14; i++) {
        x.fillStyle = '#7a4f24';
        const gx = Math.floor(rng() * S), gy = y + 1 + Math.floor(rng() * (rowH - 2));
        const len = 2 + Math.floor(rng() * 5);
        x.fillRect(gx, gy, len, 1);
      }
    }
  });
}

// Leaves — alpha-style stippled green with see-through gaps for depth
function makeLeavesTex() {
  return pixelCanvas(107, TEX_SIZE, (x, rng, S) => {
    x.fillStyle = '#3a8b2a'; x.fillRect(0, 0, S, S);
    const pal = ['#2c6b1f', '#4ea235', '#256818', '#3a8b2a', '#3a8b2a', '#558f3d'];
    for (let i = 0; i < 380; i++) {
      x.fillStyle = pal[Math.floor(rng() * pal.length)];
      x.fillRect(Math.floor(rng() * S), Math.floor(rng() * S), 1, 1);
    }
    // A handful of darker "shadow holes"
    for (let i = 0; i < 18; i++) {
      x.fillStyle = '#1a4012';
      x.fillRect(Math.floor(rng() * S), Math.floor(rng() * S), 1, 1);
    }
  });
}

// Stone — varied gray with cracks
function makeStoneTex() {
  return pixelCanvas(108, TEX_SIZE, (x, rng, S) => {
    x.fillStyle = '#7a7a7e'; x.fillRect(0, 0, S, S);
    const pal = ['#666669', '#8a8a8e', '#5d5d61', '#9a9a9e', '#7a7a7e', '#7a7a7e'];
    for (let i = 0; i < 480; i++) {
      x.fillStyle = pal[Math.floor(rng() * pal.length)];
      x.fillRect(Math.floor(rng() * S), Math.floor(rng() * S), 1, 1);
    }
    // Hairline cracks — pixel-stepped polylines
    x.fillStyle = '#3a3a3e';
    for (let i = 0; i < 4; i++) {
      let cx = Math.floor(rng() * S), cy = Math.floor(rng() * S);
      const len = 6 + Math.floor(rng() * 8);
      for (let s = 0; s < len; s++) {
        x.fillRect(cx, cy, 1, 1);
        cx += Math.random() > 0.5 ? 1 : -1;
        cy += Math.random() > 0.5 ? 1 : 0;
        cx = (cx + S) % S; cy = (cy + S) % S;
      }
    }
  });
}

// Cobblestone — chunky individually-stippled stones with mortar grout
function makeCobblestoneTex() {
  return pixelCanvas(109, TEX_SIZE, (x, rng, S) => {
    x.fillStyle = '#3a3a3e'; x.fillRect(0, 0, S, S); // mortar
    // Predefined block layout scaled to 32×32
    const blobs = [
      [0, 0, 12, 10], [13, 0, 10, 8], [24, 0, 8, 10],
      [0, 11, 8, 10], [9, 9, 12, 12], [22, 11, 10, 10],
      [0, 22, 14, 10], [15, 22, 9, 10], [25, 22, 7, 10],
    ];
    for (const [bx, by, bw, bh] of blobs) {
      x.fillStyle = '#7a7a7e'; x.fillRect(bx, by, bw, bh);
      for (let i = 0; i < 18; i++) {
        x.fillStyle = ['#666669', '#8a8a8e', '#5d5d61', '#9a9a9e'][Math.floor(rng() * 4)];
        x.fillRect(bx + Math.floor(rng() * bw), by + Math.floor(rng() * bh), 1, 1);
      }
      // 1-px highlight on the top edge for fake bevel
      x.fillStyle = '#a8a8ac';
      x.fillRect(bx, by, bw, 1);
    }
  });
}

// Fence-plank wall — vertical planks, deeper grooves
function makeWallPlanksTex() {
  return pixelCanvas(110, TEX_SIZE, (x, rng, S) => {
    x.fillStyle = '#7a5638'; x.fillRect(0, 0, S, S);
    for (let px = 0; px < S; px++) {
      const m = px % 8;
      x.fillStyle = (m === 0 || m === 1) ? '#3a2818'
                : (m === 4 || m === 5)   ? '#9a7150'
                : '#7a5638';
      x.fillRect(px, 0, 1, S);
    }
    // Random dark knots
    for (let i = 0; i < 24; i++) {
      x.fillStyle = '#3a2818';
      x.fillRect(Math.floor(rng() * S), Math.floor(rng() * S), 1, 1);
    }
  });
}

const TEX_GRASS_TOP   = makePixelTexture(makeGrassTopTex(), 1);
const TEX_GRASS_SIDE  = makePixelTexture(makeGrassSideTex(), 1);
const TEX_DIRT        = makePixelTexture(makeDirtTex(), 1);
const TEX_LOG_SIDE    = makePixelTexture(makeLogSideTex(), 1);
const TEX_LOG_TOP     = makePixelTexture(makeLogTopTex(), 1);
const TEX_PLANKS      = makePixelTexture(makePlanksTex(), 1);
const TEX_LEAVES      = makePixelTexture(makeLeavesTex(), 1);
const TEX_STONE       = makePixelTexture(makeStoneTex(), 1);
const TEX_COBBLE      = makePixelTexture(makeCobblestoneTex(), 1);
const TEX_WALL        = makePixelTexture(makeWallPlanksTex(), 1);

// Aliases for legacy code paths (textures referenced by name elsewhere)
const TEX_GRASS = TEX_GRASS_TOP;
const TEX_WOOD  = TEX_PLANKS;

// ─── Lights (cartoon-bright: hemisphere ambient + warm sun) ──────────────
const hemi = new THREE.HemisphereLight(0xb8e0ff, 0x6f8a4a, 0.85);
hemi.position.set(0, 50, 0);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xfff2cc, 1.4);
sun.position.set(40, 70, 30);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
// Shadow frustum stays compact and follows the player every frame, so
// shadows remain sharp on the bigger map without blowing up the GPU.
sun.shadow.camera.left = -70; sun.shadow.camera.right = 70;
sun.shadow.camera.top = 70;   sun.shadow.camera.bottom = -70;
sun.shadow.camera.near = 1;   sun.shadow.camera.far = 220;
sun.shadow.bias = -0.0008;
scene.add(sun);
scene.add(sun.target);

// Deterministic RNG so EVERY client lays out the same scenery in the same
// places. Without this, host and joiner each call Math.random() independently
// and end up wandering through visually different maps. We swap to a seeded
// generator only for world generation; runtime randomness (particles,
// AI jitter, etc.) stays on Math.random.
function makeSeededRng(seed) {
  let s = seed >>> 0;
  return function () {
    s = s + 0x6D2B79F5 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const _origRandom = Math.random;

// ─── World: textured ground + walls + varied scenery ─────────────────────
// Ground plane covers the entire arena with extra padding outside the walls
// so the horizon never reveals the void.
const groundGeo = new THREE.PlaneGeometry(1400, 1400, 64, 64);
const groundTex = TEX_GRASS.clone();
groundTex.wrapS = groundTex.wrapT = THREE.RepeatWrapping;
groundTex.repeat.set(140, 140);
const groundMat = new THREE.MeshStandardMaterial({ map: groundTex, roughness: 0.96, metalness: 0 });
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const colliders = []; // boxes the player & bullets must check against
// Track every mesh added during arena construction so we can wipe + rebuild
// the world when the player switches between PvP (small) and bots (big) modes.
const arenaMeshes = [];

function addArenaMesh(m) { arenaMeshes.push(m); }

function addBox(w, h, d, x, y, z, mat) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = true; m.receiveShadow = true;
  scene.add(m);
  const box = new THREE.Box3().setFromObject(m);
  colliders.push({ mesh: m, box });
  addArenaMesh(m);
  return m;
}

// Two map sizes the player can play on:
//   BIG_ARENA   — the open 450×450m field used in solo + co-op modes
//   SMALL_ARENA — original 100×100m playfield, used for PvP duels
const BIG_ARENA = 225;
const SMALL_ARENA = 50;
let ARENA = BIG_ARENA; // current arena, mutated by buildArena()

// ─── C: map themes ───────────────────────────────────────────────────────
// A theme repaints the same arena geometry with a different biome palette:
// ground tint, sky/fog tint, scenery type (oak/cactus/pine/dead), rock tint
// and whether flowers spawn. The arena layout (positions, counts) stays the
// same — only the visuals + scenery type change so PvP cover is consistent.
const MAP_THEMES = {
  forest: {
    label: '🌳 יער', groundTint: 0xffffff, skyTint: 0xffffff, fogTint: 0xffffff,
    rockTint: 0xffffff, treeKind: 'oak',    flowers: true,
  },
  desert: {
    label: '🏜️ מדבר', groundTint: 0xd9b87a, skyTint: 0xffe8b0, fogTint: 0xe8c898,
    rockTint: 0xc89868, treeKind: 'cactus', flowers: false,
  },
  snow: {
    label: '❄️ שלג',  groundTint: 0xe8f1ff, skyTint: 0xdce5f0, fogTint: 0xe6ecf2,
    rockTint: 0xcfd6e0, treeKind: 'pine',   flowers: false,
  },
  lava: {
    label: '🔥 לבה',  groundTint: 0x9a3a2a, skyTint: 0xff5030, fogTint: 0x6a1c0c,
    rockTint: 0x7a2a18, treeKind: 'dead',   flowers: false,
  },
};
const DEFAULT_THEME = 'forest';
let currentTheme = DEFAULT_THEME;
function getTheme() { return MAP_THEMES[currentTheme] || MAP_THEMES[DEFAULT_THEME]; }

const wallMat = new THREE.MeshStandardMaterial({ map: TEX_WALL.clone(), roughness: 0.85 });

// Object positions are tracked so scenery doesn't stack. Cleared on rebuild.
const placed = [];
function tryPlace(x, z, r) {
  for (const p of placed) {
    if (Math.hypot(p.x - x, p.z - z) < p.r + r) return false;
  }
  if (Math.hypot(x, z) < 6) return false;
  if (Math.abs(x) > ARENA - 2 || Math.abs(z) > ARENA - 2) return false;
  placed.push({ x, z, r });
  return true;
}

// ─── Block-style tree: log column + leaf cube cluster (Minecraft style) ──
// Uses 6 face materials per log so the top/bottom show ring texture while
// the sides show bark grain. Leaves are per-cube to randomise minor offsets.
const _logFaceMats = [
  new THREE.MeshLambertMaterial({ map: TEX_LOG_SIDE }),
  new THREE.MeshLambertMaterial({ map: TEX_LOG_SIDE }),
  new THREE.MeshLambertMaterial({ map: TEX_LOG_TOP }),
  new THREE.MeshLambertMaterial({ map: TEX_LOG_TOP }),
  new THREE.MeshLambertMaterial({ map: TEX_LOG_SIDE }),
  new THREE.MeshLambertMaterial({ map: TEX_LOG_SIDE }),
];
const _leafMat = new THREE.MeshLambertMaterial({ map: TEX_LEAVES });
const _stoneBlockMat = new THREE.MeshLambertMaterial({ map: TEX_STONE });
const _cobbleBlockMat = new THREE.MeshLambertMaterial({ map: TEX_COBBLE });

function makeTree(x, z, scale = 1) {
  const trunkHeight = Math.round(3 + scale * 1.5);
  const treeParts = [];          // all meshes that belong to this tree
  let trunkBase = null;
  for (let h = 0; h < trunkHeight; h++) {
    const log = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), _logFaceMats);
    log.position.set(x, 0.5 + h, z);
    log.castShadow = true; log.receiveShadow = true;
    scene.add(log); addArenaMesh(log);
    treeParts.push(log);
    if (h === 0) trunkBase = log;
  }
  const canopyY = trunkHeight - 1;
  for (let dy = 0; dy < 3; dy++) {
    const radius = (dy === 0 || dy === 2) ? 1 : 2;
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        if (dy === 1 && Math.abs(dx) === 2 && Math.abs(dz) === 2 && Math.random() > 0.4) continue;
        if (dx === 0 && dz === 0 && dy < 2) continue;
        const leaf = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), _leafMat);
        leaf.position.set(x + dx, canopyY + dy + 0.5, z + dz);
        leaf.castShadow = true; leaf.receiveShadow = true;
        scene.add(leaf); addArenaMesh(leaf);
        treeParts.push(leaf);
      }
    }
  }
  const box = new THREE.Box3().setFromObject(trunkBase);
  box.max.y += trunkHeight - 1;
  box.expandByScalar(0.05);
  colliders.push({ mesh: trunkBase, box });
  // Mark trunk as destructible — 3 shots to fell the whole tree + leaves
  trunkBase.userData.destructible = {
    hp: 3, connected: treeParts.filter(p => p !== trunkBase), kind: 'tree',
  };
}

// ─── C: themed tree variants ─────────────────────────────────────────────
// Each variant pushes the same kind of destructible record so the rest of
// the game (bullet hits, collapse animation) doesn't need to know about them.
const _cactusBodyMat = new THREE.MeshLambertMaterial({ color: 0x3a7a3a });
const _cactusArmMat  = new THREE.MeshLambertMaterial({ color: 0x2f6a2f });
const _pineLeafMat   = new THREE.MeshLambertMaterial({ color: 0x244d2a });
const _deadLogMats = [
  new THREE.MeshLambertMaterial({ color: 0x2a1612 }),
  new THREE.MeshLambertMaterial({ color: 0x2a1612 }),
  new THREE.MeshLambertMaterial({ color: 0x1a0808 }),
  new THREE.MeshLambertMaterial({ color: 0x1a0808 }),
  new THREE.MeshLambertMaterial({ color: 0x2a1612 }),
  new THREE.MeshLambertMaterial({ color: 0x2a1612 }),
];

function makeCactus(x, z, scale = 1) {
  // Tall slim green column + optional side arms
  const height = Math.max(3, Math.round(3 + scale));
  const parts = [];
  let base = null;
  for (let h = 0; h < height; h++) {
    const seg = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1, 0.9), _cactusBodyMat);
    seg.position.set(x, 0.5 + h, z);
    seg.castShadow = true; seg.receiveShadow = true;
    scene.add(seg); addArenaMesh(seg);
    parts.push(seg);
    if (h === 0) base = seg;
  }
  // Two small arms branching out
  if (height >= 3) {
    const armY = 1.5 + Math.random();
    const offsets = [[1.0, 0], [-1.0, 0]];
    for (const [ox, oz] of offsets) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.6, 0.6), _cactusArmMat);
      arm.position.set(x + ox, armY, z + oz);
      arm.castShadow = true; arm.receiveShadow = true;
      scene.add(arm); addArenaMesh(arm);
      parts.push(arm);
    }
  }
  const box = new THREE.Box3().setFromObject(base);
  box.max.y += height - 1;
  box.expandByScalar(0.05);
  colliders.push({ mesh: base, box });
  base.userData.destructible = {
    hp: 2, connected: parts.filter(p => p !== base), kind: 'cactus',
  };
}

function makePine(x, z, scale = 1) {
  // Taller trunk + cone-shaped dark green canopy (wider at the bottom)
  const trunkHeight = Math.round(4 + scale * 2);
  const parts = [];
  let trunkBase = null;
  for (let h = 0; h < trunkHeight; h++) {
    const log = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), _logFaceMats);
    log.position.set(x, 0.5 + h, z);
    log.castShadow = true; log.receiveShadow = true;
    scene.add(log); addArenaMesh(log);
    parts.push(log);
    if (h === 0) trunkBase = log;
  }
  // Cone canopy: 4 layers, each smaller than the one below it
  const layers = [
    { r: 2, y: trunkHeight - 1 },
    { r: 2, y: trunkHeight },
    { r: 1, y: trunkHeight + 1 },
    { r: 1, y: trunkHeight + 2 },
  ];
  for (const layer of layers) {
    for (let dx = -layer.r; dx <= layer.r; dx++) {
      for (let dz = -layer.r; dz <= layer.r; dz++) {
        if (layer.r === 2 && Math.abs(dx) === 2 && Math.abs(dz) === 2 && Math.random() > 0.4) continue;
        const leaf = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), _pineLeafMat);
        leaf.position.set(x + dx, layer.y + 0.5, z + dz);
        leaf.castShadow = true; leaf.receiveShadow = true;
        // Sprinkle a bit of snow on top — top-only layer of brighter material
        scene.add(leaf); addArenaMesh(leaf);
        parts.push(leaf);
      }
    }
  }
  // White cap on the tip — looks snowy
  const cap = new THREE.Mesh(new THREE.BoxGeometry(1, 0.4, 1), new THREE.MeshLambertMaterial({ color: 0xffffff }));
  cap.position.set(x, trunkHeight + 2.7, z);
  scene.add(cap); addArenaMesh(cap);
  parts.push(cap);
  const box = new THREE.Box3().setFromObject(trunkBase);
  box.max.y += trunkHeight - 1;
  box.expandByScalar(0.05);
  colliders.push({ mesh: trunkBase, box });
  trunkBase.userData.destructible = {
    hp: 3, connected: parts.filter(p => p !== trunkBase), kind: 'pine',
  };
}

function makeDeadTree(x, z, scale = 1) {
  // Charred Nether-style stump — just a leaf-less log column, dark crimson
  const trunkHeight = Math.round(3 + scale * 1.2);
  const parts = [];
  let trunkBase = null;
  for (let h = 0; h < trunkHeight; h++) {
    const log = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), _deadLogMats);
    log.position.set(x, 0.5 + h, z);
    log.castShadow = true; log.receiveShadow = true;
    scene.add(log); addArenaMesh(log);
    parts.push(log);
    if (h === 0) trunkBase = log;
  }
  // A jagged stump-top: tilt the last log
  const top = parts[parts.length - 1];
  top.rotation.z = (Math.random() - 0.5) * 0.4;
  const box = new THREE.Box3().setFromObject(trunkBase);
  box.max.y += trunkHeight - 1;
  box.expandByScalar(0.05);
  colliders.push({ mesh: trunkBase, box });
  trunkBase.userData.destructible = {
    hp: 2, connected: parts.filter(p => p !== trunkBase), kind: 'dead',
  };
}

// Dispatch a "tree" call to the right variant for the active theme.
function makeThemedTree(x, z, scale) {
  switch (getTheme().treeKind) {
    case 'cactus': return makeCactus(x, z, scale);
    case 'pine':   return makePine(x, z, scale);
    case 'dead':   return makeDeadTree(x, z, scale);
    default:       return makeTree(x, z, scale);
  }
}

// ─── Block-style rocks: small clusters of stone cubes ────────────────────
// Lazily-built theme-tinted rock materials, keyed by tint colour. The base
// _stoneBlockMat / _cobbleBlockMat are reused for the default forest tint so
// the GPU still shares them across the common case.
const _themedRockMats = new Map();
function getRockMats(tint) {
  if (tint === 0xffffff) return [_stoneBlockMat, _cobbleBlockMat];
  let pair = _themedRockMats.get(tint);
  if (!pair) {
    pair = [
      new THREE.MeshLambertMaterial({ map: TEX_STONE,  color: tint }),
      new THREE.MeshLambertMaterial({ map: TEX_COBBLE, color: tint }),
    ];
    _themedRockMats.set(tint, pair);
  }
  return pair;
}

function makeRock(x, z, scale = 1) {
  const cubes = Math.max(1, Math.round(1 + scale * 1.5));
  let rep = null;
  const cluster = [];
  const [stoneMat, cobbleMat] = getRockMats(getTheme().rockTint);
  for (let i = 0; i < cubes; i++) {
    const sz = 0.7 + Math.random() * 0.6 + scale * 0.3;
    const ox = (Math.random() - 0.5) * 1.2 * scale;
    const oz = (Math.random() - 0.5) * 1.2 * scale;
    const oy = i === 0 ? sz / 2 : 0.2 + Math.random() * sz * 0.5;
    const useCobble = Math.random() > 0.5;
    const stone = new THREE.Mesh(
      new THREE.BoxGeometry(sz, sz, sz),
      useCobble ? cobbleMat : stoneMat
    );
    stone.position.set(x + ox, oy, z + oz);
    stone.castShadow = true; stone.receiveShadow = true;
    scene.add(stone); addArenaMesh(stone);
    cluster.push(stone);
    if (i === 0) rep = stone;
  }
  if (rep) {
    const box = new THREE.Box3().setFromObject(rep);
    box.expandByScalar(0.4 * scale);
    colliders.push({ mesh: rep, box });
    // 2 shots crumble the whole cluster
    rep.userData.destructible = {
      hp: 2, connected: cluster.filter(s => s !== rep), kind: 'rock',
    };
  }
}

// ─── Block-style crate: simple oak-plank cube ───────────────────────────
const _planksBlockMat = new THREE.MeshLambertMaterial({ map: TEX_PLANKS });
function makeCrate(x, z, size = 1) {
  const crate = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), _planksBlockMat);
  crate.position.set(x, size / 2, z);
  crate.castShadow = true; crate.receiveShadow = true;
  scene.add(crate); addArenaMesh(crate);
  const box = new THREE.Box3().setFromObject(crate);
  colliders.push({ mesh: crate, box });
  // Crates shatter in a single hit
  crate.userData.destructible = { hp: 1, connected: [], kind: 'crate' };
}

// ─── Flowers + tall grass — flat decorations on the ground ──────────────
// Two crossed billboards per flower so they read from any angle, just
// like Minecraft renders its flora. No collider — purely visual.
function makeFlowerTex(seed, baseColor, petalColor, centerColor) {
  return makePixelTexture(pixelCanvas(seed, 16, (x, rng, S) => {
    x.clearRect(0, 0, S, S);
    // Stem
    x.fillStyle = '#3a8b2a';
    for (let py = 8; py < 16; py++) x.fillRect(7, py, 2, 1);
    // Petals — 4 around a center pixel
    const cx = 8, cy = 5;
    x.fillStyle = petalColor;
    x.fillRect(cx - 1, cy - 2, 2, 2);
    x.fillRect(cx + 1, cy - 1, 2, 2);
    x.fillRect(cx - 1, cy + 1, 2, 2);
    x.fillRect(cx - 3, cy - 1, 2, 2);
    // Center
    x.fillStyle = centerColor;
    x.fillRect(cx - 1, cy - 1, 2, 2);
    // A small leaf on the stem
    x.fillStyle = '#256818';
    x.fillRect(5, 11, 2, 1);
  }), 1);
}

const FLOWER_TEXS = [
  makeFlowerTex(701, '', '#e84a4a', '#ffd54a'), // poppy red
  makeFlowerTex(702, '', '#ffd54a', '#a47020'), // dandelion yellow
  makeFlowerTex(703, '', '#a07ad8', '#ffd54a'), // allium purple
  makeFlowerTex(704, '', '#e8e8e8', '#ffd54a'), // oxeye white
];
// Need transparent backgrounds — set alpha test on each material
const FLOWER_MATS = FLOWER_TEXS.map(t => new THREE.MeshBasicMaterial({
  map: t, transparent: true, alphaTest: 0.5, side: THREE.DoubleSide, fog: true,
}));

function makeFlower(x, z) {
  // Two crossed quads → readable from any angle, like Minecraft flora
  const mat = FLOWER_MATS[Math.floor(Math.random() * FLOWER_MATS.length)];
  const flower = new THREE.Group();
  const planeA = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.7), mat);
  const planeB = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.7), mat);
  planeA.position.y = 0.35;
  planeB.position.y = 0.35; planeB.rotation.y = Math.PI / 2;
  flower.add(planeA, planeB);
  flower.position.set(x, 0, z);
  scene.add(flower); addArenaMesh(flower);
}

// ─── Block-style hut: plank walls + stepped pyramid roof ─────────────────
function makeHut(x, z) {
  const roofPalette = [0xc23b3b, 0x4a73c2, 0x3aa18a, 0xc28a3a];
  const roofColor = roofPalette[Math.floor(Math.random() * 4)];
  const roofMat = new THREE.MeshLambertMaterial({ color: roofColor });
  // Walls: 3 wide × 3 deep × 3 tall, hollow inside (placeholder — solid for collision)
  const wallSize = 3;
  const wall = new THREE.Mesh(
    new THREE.BoxGeometry(wallSize, wallSize, wallSize),
    _planksBlockMat
  );
  wall.position.set(x, wallSize / 2, z);
  wall.castShadow = true; wall.receiveShadow = true;
  scene.add(wall); addArenaMesh(wall);
  // Stepped pyramid roof: 3 layers, each smaller than the one below
  const roofLayers = [
    { size: 3.6, h: 0.6, y: wallSize + 0.3 },
    { size: 2.6, h: 0.6, y: wallSize + 0.9 },
    { size: 1.4, h: 0.6, y: wallSize + 1.5 },
  ];
  for (const r of roofLayers) {
    const layer = new THREE.Mesh(new THREE.BoxGeometry(r.size, r.h, r.size), roofMat);
    layer.position.set(x, r.y, z);
    layer.castShadow = true;
    scene.add(layer); addArenaMesh(layer);
  }
  const box = new THREE.Box3().setFromObject(wall);
  colliders.push({ mesh: wall, box });
}

// ─── New scenery: lake, cave, ruin ───────────────────────────────────────
function makeLake(x, z, radius) {
  // Slightly inset water plane — visual only, no collider so the player
  // can wade through it.
  const water = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 32),
    new THREE.MeshStandardMaterial({
      color: 0x2e7fc1, roughness: 0.15, metalness: 0.5,
      transparent: true, opacity: 0.86,
    })
  );
  water.rotation.x = -Math.PI / 2;
  water.position.set(x, 0.04, z);
  water.receiveShadow = true;
  scene.add(water); addArenaMesh(water);
  // A subtle darker rim of "wet earth" around the lake
  const rim = new THREE.Mesh(
    new THREE.RingGeometry(radius, radius + 0.6, 32),
    new THREE.MeshStandardMaterial({ color: 0x3a2a16, roughness: 1 })
  );
  rim.rotation.x = -Math.PI / 2;
  rim.position.set(x, 0.03, z);
  scene.add(rim); addArenaMesh(rim);
}

function makeCave(x, z) {
  // A horseshoe of tall rocks with a gap on the south side — feels like a
  // cave entrance the player can run into.
  const RING = 4;
  for (let i = 0; i < 8; i++) {
    const ang = (i / 8) * Math.PI * 2;
    if (ang > Math.PI * 0.35 && ang < Math.PI * 1.05) continue; // entrance gap
    const rx = Math.cos(ang) * RING;
    const rz = Math.sin(ang) * RING;
    const rock = new THREE.Mesh(
      new THREE.IcosahedronGeometry(2.0 + Math.random() * 0.4, 0),
      new THREE.MeshStandardMaterial({ map: TEX_STONE, roughness: 1, color: 0x8b8b9a })
    );
    rock.position.set(x + rx, 1.6, z + rz);
    rock.scale.set(1 + Math.random() * 0.3, 2.2 + Math.random() * 0.6, 1 + Math.random() * 0.3);
    rock.castShadow = true; rock.receiveShadow = true;
    scene.add(rock); addArenaMesh(rock);
    const box = new THREE.Box3().setFromObject(rock);
    colliders.push({ mesh: rock, box });
  }
  // A flatter ceiling rock spanning the entrance
  const cap = new THREE.Mesh(
    new THREE.BoxGeometry(RING * 2.6, 1.2, 1.4),
    new THREE.MeshStandardMaterial({ map: TEX_STONE, roughness: 1, color: 0x70707a })
  );
  cap.position.set(x, 4.2, z + RING * 0.7);
  cap.rotation.y = Math.PI / 2;
  cap.castShadow = true;
  scene.add(cap); addArenaMesh(cap);
}

function makeRuin(x, z) {
  // Cluster of broken stone walls + a few half-pillars — feels like a
  // collapsed temple. All pieces are colliders so they double as cover.
  const stoneMat = new THREE.MeshStandardMaterial({ map: TEX_STONE, roughness: 1, color: 0xc8c2b0 });
  const pieces = [
    { w: 6.2, h: 3.2, d: 0.7, ax: -2.5, az: -2.5, ry: 0 },
    { w: 4.0, h: 1.8, d: 0.7, ax:  2.4, az: -1.0, ry: Math.PI / 6 },
    { w: 4.6, h: 2.6, d: 0.7, ax:  1.0, az:  3.2, ry: -Math.PI / 8 },
    { w: 2.5, h: 1.2, d: 0.7, ax: -3.0, az:  2.5, ry: Math.PI / 3 },
  ];
  for (const p of pieces) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(p.w, p.h, p.d), stoneMat);
    wall.position.set(x + p.ax, p.h / 2, z + p.az);
    wall.rotation.y = p.ry;
    wall.castShadow = true; wall.receiveShadow = true;
    scene.add(wall); addArenaMesh(wall);
    const box = new THREE.Box3().setFromObject(wall);
    colliders.push({ mesh: wall, box });
  }
  // A short broken pillar in the middle
  const pillar = new THREE.Mesh(
    new THREE.CylinderGeometry(0.45, 0.5, 1.6, 12),
    stoneMat
  );
  pillar.position.set(x, 0.8, z);
  pillar.castShadow = true; pillar.receiveShadow = true;
  scene.add(pillar); addArenaMesh(pillar);
  const pbox = new THREE.Box3().setFromObject(pillar);
  colliders.push({ mesh: pillar, box: pbox });
}

// ─── buildArena(size, themeKey): build a world from scratch. Called at
// startup and again whenever the player switches arena size OR theme. Always
// runs under the seeded RNG so every client lays scenery out identically.
function buildArena(size, themeKey) {
  if (themeKey && MAP_THEMES[themeKey]) currentTheme = themeKey;
  const theme = getTheme();
  // Tint shared ground + wall materials to match the theme. They're shared
  // across all rebuilds so we always write a fresh colour (default forest =
  // pure white, i.e. show the texture untouched).
  groundMat.color.setHex(theme.groundTint);
  wallMat.color.setHex(theme.rockTint);
  ARENA = size;
  // Wipe any prior arena meshes from the scene + colliders + placement grid
  for (const m of arenaMeshes) scene.remove(m);
  arenaMeshes.length = 0;
  colliders.length = 0;
  placed.length = 0;

  // Use a deterministic RNG ONLY for world generation
  const rng = makeSeededRng(20260507 + size); // small map and big map differ
  Math.random = rng;

  // Outer perimeter walls — clone the wall material so each side gets its
  // own texture-repeat tuned to the wall length.
  const longSide  = wallMat.clone(); longSide.map = TEX_WALL.clone();
  longSide.map.wrapS = longSide.map.wrapT = THREE.RepeatWrapping;
  longSide.map.repeat.set(Math.max(8, ARENA * 0.4), 1);
  const shortSide = wallMat.clone(); shortSide.map = TEX_WALL.clone();
  shortSide.map.wrapS = shortSide.map.wrapT = THREE.RepeatWrapping;
  shortSide.map.repeat.set(1, Math.max(8, ARENA * 0.4));
  addBox(ARENA * 2, 4, 1, 0, 2,  ARENA, longSide);
  addBox(ARENA * 2, 4, 1, 0, 2, -ARENA, longSide);
  addBox(1, 4, ARENA * 2,  ARENA, 2, 0, shortSide);
  addBox(1, 4, ARENA * 2, -ARENA, 2, 0, shortSide);

  // Density scales with arena area. Block-style trees are ~30 meshes each
  // (trunk column + leaf cluster) so we keep counts modest. Frustum culling
  // handles the rest at runtime.
  const isBig = size >= 100;
  const counts = isBig
    ? { trees: 80, rocks: 60, crates: 50, huts: 12, lakes: 3, caves: 2, ruins: 3, landmarks: 6, flowers: 60 }
    : { trees: 14, rocks: 12, crates: 12, huts: 4,  lakes: 1, caves: 1, ruins: 1, landmarks: 0, flowers: 14 };

  // Special structures FIRST — they're chunkier and reserve a larger area
  for (let i = 0; i < counts.lakes; i++) {
    let x, z, attempts = 0, r = isBig ? 6 + Math.random() * 6 : 4;
    do {
      x = (Math.random() - 0.5) * (ARENA * 1.4);
      z = (Math.random() - 0.5) * (ARENA * 1.4);
      attempts++;
    } while (!tryPlace(x, z, r + 1.5) && attempts < 15);
    if (attempts >= 15) continue;
    makeLake(x, z, r);
  }
  for (let i = 0; i < counts.caves; i++) {
    let x, z, attempts = 0;
    do {
      x = (Math.random() - 0.5) * (ARENA * 1.6);
      z = (Math.random() - 0.5) * (ARENA * 1.6);
      attempts++;
    } while (!tryPlace(x, z, 5) && attempts < 18);
    if (attempts >= 18) continue;
    makeCave(x, z);
  }
  for (let i = 0; i < counts.ruins; i++) {
    let x, z, attempts = 0;
    do {
      x = (Math.random() - 0.5) * (ARENA * 1.5);
      z = (Math.random() - 0.5) * (ARENA * 1.5);
      attempts++;
    } while (!tryPlace(x, z, 4.5) && attempts < 18);
    if (attempts >= 18) continue;
    makeRuin(x, z);
  }
  // Then the smaller filler scenery
  for (let i = 0; i < counts.trees; i++) {
    let x, z, attempts = 0;
    do {
      x = (Math.random() - 0.5) * (ARENA * 1.8);
      z = (Math.random() - 0.5) * (ARENA * 1.8);
      attempts++;
    } while (!tryPlace(x, z, 1.6) && attempts < 12);
    if (attempts >= 12) continue;
    makeThemedTree(x, z, 0.9 + Math.random() * 0.9);
  }
  for (let i = 0; i < counts.rocks; i++) {
    let x, z, attempts = 0;
    do {
      x = (Math.random() - 0.5) * (ARENA * 1.8);
      z = (Math.random() - 0.5) * (ARENA * 1.8);
      attempts++;
    } while (!tryPlace(x, z, 1.2) && attempts < 12);
    if (attempts >= 12) continue;
    makeRock(x, z, 0.7 + Math.random() * 1.4);
  }
  for (let i = 0; i < counts.crates; i++) {
    let x, z, attempts = 0;
    do {
      x = (Math.random() - 0.5) * (ARENA * 1.8);
      z = (Math.random() - 0.5) * (ARENA * 1.8);
      attempts++;
    } while (!tryPlace(x, z, 1.1) && attempts < 12);
    if (attempts >= 12) continue;
    makeCrate(x, z, 0.9 + Math.random() * 0.6);
  }
  for (let i = 0; i < counts.huts; i++) {
    let x, z, attempts = 0;
    do {
      x = (Math.random() - 0.5) * (ARENA * 1.6);
      z = (Math.random() - 0.5) * (ARENA * 1.6);
      attempts++;
    } while (!tryPlace(x, z, 3.5) && attempts < 18);
    if (attempts >= 18) continue;
    makeHut(x, z);
  }
  // Landmark boulders ringing the far edges (only on the big map)
  for (let i = 0; i < counts.landmarks; i++) {
    const ang = (i / counts.landmarks) * Math.PI * 2 + Math.random() * 0.4;
    const r = ARENA * 0.85;
    const x = Math.cos(ang) * r, z = Math.sin(ang) * r;
    if (!tryPlace(x, z, 4)) continue;
    makeRock(x, z, 3 + Math.random() * 2);
  }
  // Flowers — purely decorative, no collider, scatter across the grass.
  // Desert / snow / nether themes skip flowers (no soft ground cover).
  if (theme.flowers) {
    for (let i = 0; i < counts.flowers; i++) {
      const x = (Math.random() - 0.5) * (ARENA * 1.7);
      const z = (Math.random() - 0.5) * (ARENA * 1.7);
      if (Math.hypot(x, z) < 6) continue;
      if (isInsideObstacle(x, z)) continue;
      makeFlower(x, z);
    }
  }

  // Restore the real Math.random for runtime systems
  Math.random = _origRandom;
}

// Initial build — solo / co-op players get the big arena by default
buildArena(BIG_ARENA);

// ─── Player controls (pointer lock = FPS mouse look) ──────────────────────
const controls = new PointerLockControls(camera, renderer.domElement);
const overlay = document.getElementById('overlay');
const gameOverEl = document.getElementById('gameOver');
const victoryEl  = document.getElementById('victory');
const killCountEl = document.getElementById('killCount');
const killTargetLabelEl = document.getElementById('killTargetLabel');
const diffLabelEl = document.getElementById('diffLabel');
const finalKillsEl = document.getElementById('finalKills');
const finalTargetEl = document.getElementById('finalTarget');
const finalDiffEl  = document.getElementById('finalDiff');
const victoryKillsEl = document.getElementById('victoryKills');
const victoryDiffEl  = document.getElementById('victoryDiff');
const botTargetInput = document.getElementById('botTarget');
const damageFlash  = document.getElementById('damageFlash');
const hpTextEl = document.getElementById('hpText');
const hpFillEl = document.getElementById('hpFill');

// Difficulty presets — concurrent bots, HP, damage, speed, fire rate, sight range, default quota.
// `count` = how many bots are alive at once. `defaultQuota` = total kills to finish the stage.
const DIFFICULTIES = {
  easy:   { label: 'קל',     count: 3, hp: 30, damage: 5,  speed: 2.0, fireInterval: 2.0, sight: 25, defaultQuota: 10 },
  medium: { label: 'בינוני', count: 5, hp: 50, damage: 8,  speed: 2.7, fireInterval: 1.4, sight: 32, defaultQuota: 25 },
  hard:   { label: 'קשה',    count: 8, hp: 70, damage: 12, speed: 3.4, fireInterval: 0.9, sight: 40, defaultQuota: 50 },
};

// BOSS bot — replaces the FINAL kill in bot mode. Tankier, slower, hits hard.
// Scaled relative to the chosen difficulty so it stays threatening but fair.
function bossConfFor(diffKey) {
  const c = DIFFICULTIES[diffKey];
  return {
    label: c.label + ' BOSS',
    count: 1, hp: c.hp * 8, damage: c.damage * 2,
    speed: Math.max(1.4, c.speed * 0.7),
    fireInterval: c.fireInterval * 0.7,
    sight: c.sight + 20,
    defaultQuota: 1,
    isBoss: true,
    archetype: 'tank',
  };
}

// ─── Bot archetypes (special variants beyond the standard grunt) ─────────
// `archetype` on a bot.conf shifts its AI behaviour:
//   tank      — default; chases + shoots
//   sniper    — high HP only fires at long range, slow rate
//   kamikaze  — sprints toward the player; explodes on contact
//   healer    — runs toward injured bots and heals them; no direct damage
function sniperConfFor(diffKey) {
  const c = DIFFICULTIES[diffKey];
  return {
    label: c.label + ' צלף', hp: c.hp * 1.4, damage: c.damage * 2.5,
    speed: c.speed * 0.7, fireInterval: c.fireInterval * 2.0,
    sight: c.sight + 30, isBoss: false, archetype: 'sniper',
  };
}
function kamikazeConfFor(diffKey) {
  const c = DIFFICULTIES[diffKey];
  return {
    label: c.label + ' קמיקזה', hp: c.hp * 0.6, damage: c.damage * 4,
    speed: c.speed * 1.6, fireInterval: 999, sight: c.sight + 5,
    isBoss: false, archetype: 'kamikaze',
    explodeRadius: 4.5,
  };
}
function healerConfFor(diffKey) {
  const c = DIFFICULTIES[diffKey];
  return {
    label: c.label + ' רופא', hp: c.hp * 1.2, damage: 0,
    speed: c.speed * 1.1, fireInterval: 1.0, sight: c.sight,
    isBoss: false, archetype: 'healer',
    healAmount: 12, healRange: 4,
  };
}

const game = {
  difficulty: 'medium',
  mode: 'bots',           // 'bots' (PvE) or 'pvp' (player vs player only)
  kills: 0,
  killTarget: 25,         // total bots to kill to finish the stage (1-200)
  pendingSpawns: 0,       // bots scheduled to respawn (so we don't over-spawn)
  bossSpawned: false,     // true once the BOSS has been pushed into the arena
  playerHP: 100,
  playerHPMax: 100,
  alive: false,           // true once a difficulty has been picked & game started
};

// B4: the peerId of whoever last hit us via pvp-hit. When damagePlayer drops
// us to 0 HP we send a 'pvp-killed' back to this peer so they can call
// Auth.reportPvpKill(myUserId) and pick up the ELO win.
let lastPvpAttackerPeerId = null;

// Wire up difficulty buttons. Each button starts the game at that level.
overlay.querySelectorAll('button[data-diff]').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    startGame(btn.dataset.diff);
  });
});

// When the user clicks a difficulty button without first editing the input,
// fill the input with that difficulty's default quota for next time.
let botTargetUserEdited = false;
botTargetInput.addEventListener('input', () => { botTargetUserEdited = true; });

document.getElementById('restartBtn').addEventListener('click', () => {
  gameOverEl.classList.add('hidden');
  overlay.classList.remove('hidden');
  refreshSessionUser();
});
document.getElementById('victoryRestartBtn').addEventListener('click', () => {
  victoryEl.classList.add('hidden');
  overlay.classList.remove('hidden');
  refreshSessionUser();
});

controls.addEventListener('lock', () => {
  // Only hide the start overlay if we're actually in a live game
  if (game.alive) overlay.classList.add('hidden');
});
controls.addEventListener('unlock', () => {
  // ESC → pause: bring start overlay back unless we're on the death screen
  if (!gameOverEl.classList.contains('hidden')) return;
  overlay.classList.remove('hidden');
});

function startGame(diffKey, overrideKillTarget, overrideMode, overrideTheme) {
  const conf = DIFFICULTIES[diffKey];
  game.difficulty = diffKey;
  // Mode: 'bots' (default, PvE with bots + a BOSS at the end) or 'pvp'
  // (player-vs-player only, no bots, smaller arena).
  game.mode = overrideMode || (net.isHost() ? (currentHostMode || 'bots') : 'bots');
  // Theme: host's pick wins for multiplayer; solo uses the local pick.
  const themeKey = (overrideTheme && MAP_THEMES[overrideTheme])
    ? overrideTheme
    : (selectedMapTheme || DEFAULT_THEME);
  game.kills = 0;
  game.pendingSpawns = 0;
  game.bossSpawned = false;
  game.coinsThisGame = 0;
  // Perks: HP / stamina / grenade caps depend on what the player owns
  game.playerHPMax = playerOwns('hpBoost') ? 125 : 100;
  game.playerHP = game.playerHPMax;
  game.staminaMax = playerOwns('staminaBoost') ? 130 : STAMINA_MAX;
  game.maxGrenades = playerOwns('grenadeMax') ? 7 : MAX_GRENADES;
  game.alive = true;
  updateCoinHUD();
  Auth.bumpChallenge('play_games', 1);

  // Resolve the kill target: explicit override (e.g. from host broadcast) wins,
  // else the input value if user edited it, else the difficulty default.
  let target;
  if (overrideKillTarget != null && Number.isFinite(overrideKillTarget)) {
    target = overrideKillTarget;
  } else {
    target = botTargetUserEdited ? parseInt(botTargetInput.value, 10) : conf.defaultQuota;
    if (!Number.isFinite(target)) target = conf.defaultQuota;
  }
  target = Math.max(1, Math.min(200, target));
  game.killTarget = target;

  // If we're the multiplayer host, tell everyone else to start with the same params
  if (net.isHost() && overrideKillTarget == null) {
    net.broadcast({ type: 'start-game', difficulty: diffKey, killTarget: target, mode: game.mode, theme: themeKey });
  }

  // PvP plays on the original tight arena; bots/co-op uses the big map.
  // Rebuild whenever either the size OR the theme changed.
  const desiredArena = game.mode === 'pvp' ? SMALL_ARENA : BIG_ARENA;
  if (ARENA !== desiredArena || currentTheme !== themeKey) buildArena(desiredArena, themeKey);
  // Reflect resolved value in the input so the user sees what's running
  botTargetInput.value = target;
  botTargetUserEdited = false;

  killCountEl.textContent = '0';
  killTargetLabelEl.textContent = String(target);
  diffLabelEl.textContent = conf.label;
  updateHPUI();
  // Reset stamina + all weapons (refill magazine + reserve, cancel any reloads)
  // (Stamina cap honours the staminaBoost perk if owned.)
  stamina.value = game.staminaMax || STAMINA_MAX;
  stamina.lockedOut = false;
  // Clone each weapon's conf for this round so attachments can mutate freely
  // without leaking into WEAPONS[id] (shared base definition).
  for (const id of Object.keys(weapons)) {
    weapons[id].conf = { ...WEAPONS[id] };
  }
  applyAttachments();
  for (const id of Object.keys(weapons)) {
    weapons[id].ammo = weapons[id].conf.maxAmmo;
    weapons[id].reserve = weapons[id].conf.reserveStart ?? 0;
    weapons[id].reloading = false;
    weapons[id].recoilTimer = 0;
    weapons[id].swingTimer = 0;
    weapons[id].model.position.copy(weapons[id].restPos);
    weapons[id].model.rotation.x = weapons[id].restRotX;
  }
  // Reset grenades (you start with 2; pickups give you more — capped at maxGrenades)
  grenades.count = 2;
  grenades.maxOverride = game.maxGrenades || MAX_GRENADES;
  updateGrenadeHUD();
  // Clear any leftover thrown grenades, explosions, flame particles
  clearActiveProjectiles();
  // Spawn fresh pickups around the map
  spawnAllPickups();
  // Equip the user's favorite weapon (falls back to pistol if invalid/missing)
  setWeapon(getEffectiveFavorite());
  fireCooldown = 0;
  mouseDown = false;
  setZoom(false);

  // Wipe remote-player avatars from any previous round, then re-create only
  // for peers we're still actually connected to. Stops ghost figures from
  // a disconnected friend lingering at their last reported position.
  clearAllRemoteAvatars();
  for (const peerId of net.getPeers()) ensureRemoteAvatar(peerId);

  // Spawn enemies — only in bots mode. PvP players hunt each other instead.
  clearBots();
  if (game.mode === 'bots') {
    if (target === 1) {
      // Single-target round → straight to the BOSS, no warm-up
      game.bossSpawned = true;
      spawnOneBot(bossConfFor(diffKey));
    } else {
      const initialBatch = Math.min(conf.count, target - 1);
      for (let i = 0; i < initialBatch; i++) spawnOneBot(conf);
    }
  }
  // Reset player position
  camera.position.set(0, 1.7, 0);
  velocity.set(0, 0, 0);
  // (Bot spawning happens earlier — clearBots + bots/PvP branch above.)
  // Hide overlay + lock pointer
  overlay.classList.add('hidden');
  controls.lock();
}

function updateHPUI() {
  hpTextEl.textContent = Math.max(0, Math.round(game.playerHP));
  hpFillEl.style.width = Math.max(0, (game.playerHP / game.playerHPMax) * 100) + '%';
}

function damagePlayer(amount) {
  if (!game.alive) return;
  game.playerHP -= amount;
  updateHPUI();
  Sfx.damageHurt();
  damageFlash.classList.add('show');
  setTimeout(() => damageFlash.classList.remove('show'), 180);
  if (game.playerHP <= 0) {
    game.alive = false;
    Auth.bumpStat('deaths', 1);
    Auth.bumpStat('gamesPlayed', 1);
    finalKillsEl.textContent = game.kills;
    finalTargetEl.textContent = game.killTarget;
    finalDiffEl.textContent = DIFFICULTIES[game.difficulty].label;
    // Coins earned this round still belong to the player even on death
    const coinsRow = document.getElementById('finalCoinsRow');
    const coinsValEl = document.getElementById('finalCoins');
    if (coinsRow && coinsValEl) {
      if (game.mode === 'bots' && (game.coinsThisGame || 0) > 0) {
        coinsValEl.textContent = game.coinsThisGame;
        coinsRow.classList.remove('hidden');
      } else {
        coinsRow.classList.add('hidden');
      }
    }
    gameOverEl.classList.remove('hidden');
    controls.unlock();
  }
}

// ─── Movement state ───────────────────────────────────────────────────────
const keys = { w: false, a: false, s: false, d: false, space: false, shift: false };
const velocity = new THREE.Vector3();
const direction = new THREE.Vector3();
let onGround = true;
const PLAYER_SPEED = 30;     // acceleration
const JUMP_VELOCITY = 8;
const GRAVITY = 25;
const PLAYER_RADIUS = 0.4;

// Sprint + stamina
const SPRINT_MULTIPLIER = 1.7;       // speed boost while sprinting
const STAMINA_MAX = 100;
const STAMINA_DRAIN_PER_SEC = 28;    // depletes in ~3.5s of full sprinting
const STAMINA_REGEN_PER_SEC = 18;    // refills in ~5.5s of rest
const STAMINA_REGEN_DELAY = 0.6;     // seconds after sprint ends before regen kicks in
const stamina = { value: STAMINA_MAX, regenCooldown: 0, lockedOut: false };
const staminaTextEl = document.getElementById('staminaText');
const staminaFillEl = document.getElementById('staminaFill');
const staminaWrapEl = document.getElementById('stamina');

document.addEventListener('keydown', (e) => {
  if (e.code === 'KeyW') keys.w = true;
  if (e.code === 'KeyA') keys.a = true;
  if (e.code === 'KeyS') keys.s = true;
  if (e.code === 'KeyD') keys.d = true;
  if (e.code === 'Space') keys.space = true;
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') keys.shift = true;
  if (e.code === 'KeyR') reload();
  // Weapon switching — base weapons always work, shop weapons only if owned
  if (e.code === 'Digit1') setWeapon('pistol');
  if (e.code === 'Digit2') setWeapon('rifle');
  if (e.code === 'Digit3') setWeapon('sniper');
  if (e.code === 'Digit4') setWeapon('shotgun');
  if (e.code === 'Digit5') setWeapon('sword');
  if (e.code === 'Digit6') setWeapon('flamethrower');
  if (e.code === 'Digit7' && playerOwns('rpg'))        setWeapon('rpg');
  if (e.code === 'Digit8' && playerOwns('tommyGun'))   setWeapon('tommyGun');
  if (e.code === 'Digit9' && playerOwns('lightsaber')) setWeapon('lightsaber');
  if (e.code === 'Digit0' && playerOwns('crossbow'))   setWeapon('crossbow');
  if (e.code === 'Minus'  && playerOwns('minigun'))    setWeapon('minigun');
  // Throw grenade
  if (e.code === 'KeyG') tryThrowGrenade();
  // Debug weather toggles (keyboard only) — handy for showing the new
  // visuals on demand instead of waiting for the random roll.
  if (e.code === 'Comma')   setWeather(weather.type === 'rain' ? 'clear' : 'rain');
  if (e.code === 'Period')  setWeather(weather.type === 'snow' ? 'clear' : 'snow');
  if (e.code === 'Slash')   setWeather('clear');
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'KeyW') keys.w = false;
  if (e.code === 'KeyA') keys.a = false;
  if (e.code === 'KeyS') keys.s = false;
  if (e.code === 'KeyD') keys.d = false;
  if (e.code === 'Space') keys.space = false;
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') keys.shift = false;
});

// ─── Weapons: 6 weapons (5 firearms + sword + flamethrower), each with its own model and behavior
// Ammo model:
//   maxAmmo     = magazine capacity (loaded rounds)
//   reserveStart = how many extra rounds you start with off the magazine
//   reserveCap   = upper limit on the reserve (capped when picking up ammo crates)
const WEAPONS = {
  pistol: {
    id: 'pistol', name: 'אקדח',
    fireMode: 'semi', maxAmmo: 12, reserveStart: 36, reserveCap: 60,
    damage: 25, range: 80,
    fireInterval: 0.20, reloadTime: 0.9,
    spread: 0, pellets: 1, headshotMult: 2,
    recoilZ: 0.05, recoilTime: 0.07,
  },
  rifle: {
    id: 'rifle', name: 'רובה סער',
    fireMode: 'auto', maxAmmo: 30, reserveStart: 90, reserveCap: 150,
    damage: 15, range: 100,
    fireInterval: 0.10, reloadTime: 1.5,
    spread: 0.015, pellets: 1, headshotMult: 1.8,
    recoilZ: 0.04, recoilTime: 0.05,
  },
  sniper: {
    id: 'sniper', name: 'רובה צלפים',
    fireMode: 'semi', maxAmmo: 5, reserveStart: 15, reserveCap: 30,
    damage: 80, range: 200,
    fireInterval: 1.2, reloadTime: 2.5,
    spread: 0, pellets: 1, headshotMult: 2.5,
    recoilZ: 0.15, recoilTime: 0.20,
    canZoom: true,
  },
  shotgun: {
    id: 'shotgun', name: 'רובה ציד',
    fireMode: 'semi', maxAmmo: 8, reserveStart: 24, reserveCap: 40,
    damage: 14, range: 25,
    fireInterval: 0.8, reloadTime: 1.8,
    spread: 0.12, pellets: 8, headshotMult: 1.5,
    recoilZ: 0.20, recoilTime: 0.15,
  },
  flamethrower: {
    id: 'flamethrower', name: 'להביור',
    fireMode: 'continuous', maxAmmo: 100, reserveStart: 100, reserveCap: 300,
    damage: 35,        // damage per second
    range: 6.5, coneCos: 0.8, // cos of half-angle (~37° cone)
    fireInterval: 0.05, reloadTime: 1.2,
    fuelPerSecond: 25, // fuel drained per second of continuous fire
    headshotMult: 1,
  },
  sword: {
    id: 'sword', name: 'חרב',
    fireMode: 'melee', maxAmmo: null, damage: 60, range: 3.5,
    fireInterval: 0.5, headshotMult: 1.2,
    swingArc: 1.4, swingTime: 0.25,
  },
  // ─── Shop weapons (locked until purchased) ───────────────────────────
  rpg: {
    id: 'rpg', name: 'RPG', shopOnly: true,
    fireMode: 'projectile', maxAmmo: 1, reserveStart: 4, reserveCap: 12,
    damage: 200, splashRadius: 7,
    range: 200, projectileSpeed: 32,
    fireInterval: 1.4, reloadTime: 2.4,
    spread: 0, pellets: 1, headshotMult: 1,
    recoilZ: 0.30, recoilTime: 0.30,
  },
  tommyGun: {
    id: 'tommyGun', name: 'תת-מקלע מאפיה', shopOnly: true,
    fireMode: 'auto', maxAmmo: 50, reserveStart: 100, reserveCap: 200,
    damage: 12, range: 70,
    fireInterval: 0.07, reloadTime: 1.8,
    spread: 0.025, pellets: 1, headshotMult: 1.6,
    recoilZ: 0.04, recoilTime: 0.05,
  },
  lightsaber: {
    id: 'lightsaber', name: 'חרב לייזר', shopOnly: true,
    fireMode: 'melee', maxAmmo: null, damage: 120, range: 4.5,
    fireInterval: 0.35, headshotMult: 1.4,
    swingArc: 1.7, swingTime: 0.22,
  },
  crossbow: {
    id: 'crossbow', name: 'קשת', shopOnly: true,
    fireMode: 'semi', maxAmmo: 1, reserveStart: 12, reserveCap: 30,
    damage: 100, range: 150,
    fireInterval: 0.9, reloadTime: 1.2,
    spread: 0, pellets: 1, headshotMult: 2.5,
    recoilZ: 0.10, recoilTime: 0.18,
  },
  minigun: {
    id: 'minigun', name: 'מיניגן', shopOnly: true,
    fireMode: 'auto', maxAmmo: 100, reserveStart: 200, reserveCap: 500,
    damage: 9, range: 90,
    fireInterval: 0.05, reloadTime: 3.0,
    spread: 0.045, pellets: 1, headshotMult: 1.5,
    recoilZ: 0.03, recoilTime: 0.04,
  },
};

const muzzleMat = () => new THREE.MeshBasicMaterial({ color: 0xffaa00, transparent: true, opacity: 0 });

// ─── Player hands (FPS arms) ──────────────────────────────────────────────
// Reusable hand factory. Returns a Group whose local origin sits at the
// WRIST. The forearm extends DOWNWARD (negative Y) like a real arm reaching
// up to grip the gun; the glove + curled fingers wrap forward (-Z). This
// way you simply place the wrist AT the visible grip on each weapon and
// the forearm naturally trails outside the gun body so the hand reads as
// a hand, not a hidden blob.
function createPlayerHand(side = 'right', opts = {}) {
  const handG = new THREE.Group();
  const sleeveColor  = opts.sleeveColor  ?? 0x3a78c8;     // jersey blue (bright, contrasts with dark guns)
  const cuffColor    = opts.cuffColor    ?? 0xffd54a;     // gold trim
  const gloveColor   = opts.gloveColor   ?? 0x2a2a2a;     // matte black glove
  const fingerColor  = opts.fingerColor  ?? 0x383838;     // slightly lighter so fingers separate from palm
  const knuckleColor = opts.knuckleColor ?? 0x6a6a6a;     // pale grey accents

  const sleeveMat  = new THREE.MeshStandardMaterial({ color: sleeveColor,  roughness: 0.85 });
  const cuffMat    = new THREE.MeshStandardMaterial({ color: cuffColor,    roughness: 0.5, metalness: 0.3 });
  const gloveMat   = new THREE.MeshStandardMaterial({ color: gloveColor,   roughness: 0.5 });
  const fingerMat  = new THREE.MeshStandardMaterial({ color: fingerColor,  roughness: 0.5 });
  const knuckleMat = new THREE.MeshStandardMaterial({ color: knuckleColor, roughness: 0.4, metalness: 0.3 });

  const sx = side === 'right' ? 1 : -1;

  // Short, fat forearm stub — clearly visible behind the glove without
  // dropping off the bottom edge of the screen at typical FPS distances.
  const forearm = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 0.10, 0.12, 14),
    sleeveMat
  );
  // Tilt it BACK toward the player (positive Z) so it exits behind the
  // gun rather than falling below the FOV.
  forearm.position.set(sx * 0.025, -0.04, 0.06);
  forearm.rotation.x = Math.PI / 2 - 0.55; // mostly horizontal, angled down a hair

  // Gold cuff band where the sleeve meets the glove — high contrast
  const cuff = new THREE.Mesh(
    new THREE.CylinderGeometry(0.105, 0.105, 0.045, 14),
    cuffMat
  );
  cuff.position.set(sx * 0.005, -0.005, 0.0);
  cuff.rotation.x = Math.PI / 2 - 0.55;

  // Glove palm — sits at the wrist, extending forward toward the grip
  const palm = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.12, 0.13), gloveMat);
  palm.position.set(0, 0.005, -0.05);
  palm.rotation.x = 0.15;

  // Four fingers as ONE block, curled forward (wraps the gun grip)
  const fingers = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.10, 0.11), fingerMat);
  fingers.position.set(0, -0.03, -0.16);
  fingers.rotation.x = 0.55; // curl down/around the grip

  // Knuckle plate on top of the palm — adds detail visible from above
  const knuckle = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.02, 0.10), knuckleMat);
  knuckle.position.set(0, 0.07, -0.04);
  knuckle.rotation.x = 0.15;

  // Thumb on the inside of the hand
  const thumb = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.07, 0.10), gloveMat);
  thumb.position.set(-sx * 0.085, 0.03, -0.05);
  thumb.rotation.set(0.1, sx * 0.6, sx * -0.2);

  // Trigger finger — extended forward (only on right hand for guns)
  const trigger = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.035, 0.10), fingerMat);
  trigger.position.set(sx * 0.05, -0.03, -0.18);
  trigger.rotation.x = 0.2;

  handG.add(forearm, cuff, palm, knuckle, fingers, thumb, trigger);
  handG.userData.side = side;
  // No shadow casting from hands — they're glued to the camera anyway, and
  // shadow-mapping a fast-moving mesh next to the camera looks ugly.
  handG.traverse(o => { if (o.isMesh) o.castShadow = false; });
  return handG;
}

function createPistolModel() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.18, 0.5),  new THREE.MeshStandardMaterial({ color: 0x222222 }));
  body.position.set(0, 0, -0.05);
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.35), new THREE.MeshStandardMaterial({ color: 0x444444 }));
  barrel.position.set(0, 0.04, -0.35);
  const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 8), muzzleMat());
  muzzle.position.set(0, 0.04, -0.55);
  // Right hand wraps the back of the pistol — one-handed weapon
  const rightHand = createPlayerHand('right');
  rightHand.position.set(0, -0.03, 0.10);
  g.add(body, barrel, muzzle, rightHand);
  g.position.set(0.28, -0.28, -0.5);
  return { group: g, muzzle };
}

function createRifleModel() {
  const g = new THREE.Group();
  const stockMat  = new THREE.MeshStandardMaterial({ color: 0x4a3525 });
  const bodyMat   = new THREE.MeshStandardMaterial({ color: 0x2a2a2a });
  const barrelMat = new THREE.MeshStandardMaterial({ color: 0x111111 });
  const stock  = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.16, 0.32), stockMat);  stock.position.set(0, 0,  0.18);
  const body   = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.13, 0.55), bodyMat);   body.position.set(0, 0, -0.18);
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.45), barrelMat); barrel.position.set(0, 0.04, -0.55);
  const mag    = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.18, 0.12), bodyMat);   mag.position.set(0, -0.13, -0.10);
  const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 8), muzzleMat());  muzzle.position.set(0, 0.04, -0.78);
  // ─── Attachment: scope (hidden by default; shown when scopeRifle owned) ─
  // Built as a sub-group so applyAttachments can flip its visibility per round.
  const scopeAttach = new THREE.Group();
  scopeAttach.name = 'scopeAttachment';
  const scopeBody = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035, 0.035, 0.22, 12),
    new THREE.MeshStandardMaterial({ color: 0x111111, metalness: 0.6, roughness: 0.4 })
  );
  scopeBody.rotation.x = Math.PI / 2;
  scopeBody.position.set(0, 0.10, -0.20);
  const scopeLens = new THREE.Mesh(
    new THREE.CircleGeometry(0.032, 16),
    new THREE.MeshBasicMaterial({ color: 0x66ccff, transparent: true, opacity: 0.85 })
  );
  scopeLens.position.set(0, 0.10, -0.09);
  scopeLens.rotation.y = Math.PI;
  // Tiny mount posts holding the scope to the rifle body
  const mountFront = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.02), new THREE.MeshStandardMaterial({ color: 0x222222 }));
  mountFront.position.set(0, 0.075, -0.25);
  const mountBack = mountFront.clone();
  mountBack.position.set(0, 0.075, -0.13);
  scopeAttach.add(scopeBody, scopeLens, mountFront, mountBack);
  scopeAttach.visible = false;
  // Two hands: right on the trigger near the stock, left on the foregrip
  const rightHand = createPlayerHand('right');
  rightHand.position.set(0, -0.03, 0.05);
  const leftHand = createPlayerHand('left');
  leftHand.position.set(0, -0.04, -0.40);
  g.add(stock, body, barrel, mag, muzzle, scopeAttach, rightHand, leftHand);
  g.position.set(0.28, -0.28, -0.5);
  return { group: g, muzzle };
}

function createSniperModel() {
  const g = new THREE.Group();
  const stockMat  = new THREE.MeshStandardMaterial({ color: 0x3a2818 });
  const bodyMat   = new THREE.MeshStandardMaterial({ color: 0x2a2a2a });
  const barrelMat = new THREE.MeshStandardMaterial({ color: 0x111111 });
  const lensMat   = new THREE.MeshBasicMaterial({ color: 0x6699ff, transparent: true, opacity: 0.9 });
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.14, 0.35), stockMat);   stock.position.set(0, 0,  0.20);
  const body  = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.13, 0.40), bodyMat);    body.position.set(0, 0, -0.05);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.95, 12), barrelMat);
  barrel.rotation.x = Math.PI / 2; barrel.position.set(0, 0.03, -0.7);
  const scopeMain = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.30, 12), bodyMat);
  scopeMain.rotation.x = Math.PI / 2; scopeMain.position.set(0, 0.13, -0.05);
  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.045, 16), lensMat);
  lens.position.set(0, 0.13, 0.10); lens.rotation.y = Math.PI;
  const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 8), muzzleMat());  muzzle.position.set(0, 0.03, -1.18);
  // Right hand on the trigger near the stock; left hand near the front of the body
  const rightHand = createPlayerHand('right');
  rightHand.position.set(0, -0.04, 0.05);
  const leftHand = createPlayerHand('left');
  leftHand.position.set(0, -0.04, -0.30);
  g.add(stock, body, barrel, scopeMain, lens, muzzle, rightHand, leftHand);
  g.position.set(0.30, -0.30, -0.55);
  return { group: g, muzzle };
}

function createShotgunModel() {
  const g = new THREE.Group();
  const stockMat  = new THREE.MeshStandardMaterial({ color: 0x6b4226 });
  const bodyMat   = new THREE.MeshStandardMaterial({ color: 0x2a2a2a });
  const barrelMat = new THREE.MeshStandardMaterial({ color: 0x111111 });
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.16, 0.28), stockMat);  stock.position.set(0, 0,  0.18);
  const body  = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.16, 0.45), bodyMat);   body.position.set(0, 0, -0.10);
  const pump  = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.18, 8), stockMat);
  pump.rotation.x = Math.PI / 2; pump.position.set(0, -0.06, -0.20);
  const barrelL = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.55, 12), barrelMat);
  barrelL.rotation.x = Math.PI / 2; barrelL.position.set(-0.04, 0.03, -0.50);
  const barrelR = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.55, 12), barrelMat);
  barrelR.rotation.x = Math.PI / 2; barrelR.position.set( 0.04, 0.03, -0.50);
  const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 8), muzzleMat()); muzzle.position.set(0, 0.03, -0.78);
  // Right hand grips the rear, left hand on the pump
  const rightHand = createPlayerHand('right');
  rightHand.position.set(0, -0.03, 0.05);
  const leftHand = createPlayerHand('left');
  leftHand.position.set(0, -0.04, -0.22);
  g.add(stock, body, pump, barrelL, barrelR, muzzle, rightHand, leftHand);
  g.position.set(0.28, -0.28, -0.5);
  return { group: g, muzzle };
}

function createFlamethrowerModel() {
  const g = new THREE.Group();
  const tankMat   = new THREE.MeshStandardMaterial({ color: 0x8a2a2a, metalness: 0.3, roughness: 0.5 });
  const bodyMat   = new THREE.MeshStandardMaterial({ color: 0x2a2a2a });
  const barrelMat = new THREE.MeshStandardMaterial({ color: 0x111111 });
  const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.45, 12), tankMat);
  tank.rotation.x = Math.PI / 2; tank.position.set(0, -0.05, 0.18);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.18, 0.10), bodyMat);
  grip.position.set(0, -0.15, -0.05);
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.13, 0.40), bodyMat);
  body.position.set(0, 0, -0.18);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.55, 12), barrelMat);
  barrel.rotation.x = Math.PI / 2; barrel.position.set(0, 0.02, -0.55);
  // Pilot light at the tip (small orange flicker, kept opacity 0 except while firing)
  const muzzle = new THREE.Mesh(
    new THREE.SphereGeometry(0.14, 10, 10),
    new THREE.MeshBasicMaterial({ color: 0xff8a30, transparent: true, opacity: 0 })
  );
  muzzle.position.set(0, 0.02, -0.85);
  // Right hand on the grip behind the body, left hand bracing the front
  const rightHand = createPlayerHand('right');
  rightHand.position.set(0, -0.10, -0.05);
  const leftHand = createPlayerHand('left');
  leftHand.position.set(0, -0.05, -0.40);
  g.add(tank, grip, body, barrel, muzzle, rightHand, leftHand);
  g.position.set(0.30, -0.30, -0.5);
  return { group: g, muzzle };
}

function createRPGModel() {
  const g = new THREE.Group();
  const tubeMat = new THREE.MeshStandardMaterial({ color: 0x556b2f, roughness: 0.7 });
  const ringMat = new THREE.MeshStandardMaterial({ color: 0x111111 });
  const sightMat = new THREE.MeshStandardMaterial({ color: 0x333333 });
  // Long launcher tube
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.10, 1.0, 18), tubeMat);
  tube.rotation.x = Math.PI / 2; tube.position.set(0, 0.04, -0.35);
  // Cone-shaped warhead sticking out of the front
  const warhead = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.30, 14), new THREE.MeshStandardMaterial({ color: 0xa0392b, roughness: 0.5 }));
  warhead.rotation.x = -Math.PI / 2; warhead.position.set(0, 0.04, -0.95);
  // Reinforcement rings around the tube
  for (let i = -1; i <= 1; i++) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.105, 0.01, 8, 18), ringMat);
    ring.rotation.y = Math.PI / 2; ring.position.set(0, 0.04, -0.10 + i * -0.30);
    g.add(ring);
  }
  // Trigger grip below the tube
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.18, 0.10), tubeMat);
  grip.position.set(0, -0.16, 0.02);
  // Iron sight on top
  const sight = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.08, 0.06), sightMat);
  sight.position.set(0, 0.18, -0.10);
  // Muzzle (back blast point — we still want a flash)
  const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 10), muzzleMat());
  muzzle.position.set(0, 0.04, 0.20);
  // Hands
  const rightHand = createPlayerHand('right'); rightHand.position.set(0, -0.10, -0.05);
  const leftHand  = createPlayerHand('left');  leftHand.position.set(0, -0.04, -0.55);
  g.add(tube, warhead, grip, sight, muzzle, rightHand, leftHand);
  g.position.set(0.30, -0.30, -0.55);
  return { group: g, muzzle };
}

function createTommyGunModel() {
  const g = new THREE.Group();
  const stockMat   = new THREE.MeshStandardMaterial({ color: 0x6b3a1a, roughness: 0.7 });   // walnut wood
  const bodyMat    = new THREE.MeshStandardMaterial({ color: 0x2a2a2a });
  const drumMat    = new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.4, metalness: 0.5 });
  const drumBandMat = new THREE.MeshStandardMaterial({ color: 0x666666, metalness: 0.6 });
  const barrelMat  = new THREE.MeshStandardMaterial({ color: 0x111111 });
  // Wooden stock
  const stock  = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.16, 0.30), stockMat); stock.position.set(0, 0,  0.20);
  // Body
  const body   = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.13, 0.42), bodyMat);  body.position.set(0, 0, -0.10);
  // Round drum magazine
  const drum   = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.06, 24), drumMat);
  drum.position.set(0, -0.16, -0.10);
  const drumBand = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.012, 8, 24), drumBandMat);
  drumBand.rotation.x = Math.PI / 2; drumBand.position.set(0, -0.16, -0.10);
  // Barrel with cooling fins
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.40, 14), barrelMat);
  barrel.rotation.x = Math.PI / 2; barrel.position.set(0, 0.04, -0.50);
  for (let i = 0; i < 5; i++) {
    const fin = new THREE.Mesh(new THREE.TorusGeometry(0.045, 0.008, 6, 14), drumBandMat);
    fin.rotation.y = Math.PI / 2; fin.position.set(0, 0.04, -0.36 - i * 0.05);
    g.add(fin);
  }
  // Wooden foregrip
  const foregrip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.12, 0.10), stockMat);
  foregrip.position.set(0, -0.10, -0.30);
  const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 8), muzzleMat());
  muzzle.position.set(0, 0.04, -0.72);
  // Hands
  const rightHand = createPlayerHand('right'); rightHand.position.set(0, -0.04, 0.05);
  const leftHand  = createPlayerHand('left');  leftHand.position.set(0, -0.06, -0.30);
  g.add(stock, body, drum, drumBand, barrel, foregrip, muzzle, rightHand, leftHand);
  g.position.set(0.28, -0.28, -0.5);
  return { group: g, muzzle };
}

function createLightsaberModel() {
  const g = new THREE.Group();
  // Metal hilt with bands
  const hiltMat  = new THREE.MeshStandardMaterial({ color: 0x9aa1a8, metalness: 0.85, roughness: 0.25 });
  const bandMat  = new THREE.MeshStandardMaterial({ color: 0x222222 });
  const buttonMat = new THREE.MeshStandardMaterial({ color: 0xff3030, emissive: 0xff0000, emissiveIntensity: 0.6 });
  const hilt = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.30, 14), hiltMat);
  hilt.rotation.x = Math.PI / 2; hilt.position.set(0, 0, 0.10);
  // Black grip bands wrapping the hilt
  for (let i = 0; i < 3; i++) {
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.052, 0.008, 8, 14), bandMat);
    band.rotation.y = Math.PI / 2; band.position.set(0, 0, 0.18 - i * 0.07);
    g.add(band);
  }
  // Activation button
  const button = new THREE.Mesh(new THREE.SphereGeometry(0.014, 8, 8), buttonMat);
  button.position.set(0.05, 0.02, 0.22);
  // Glowing blade — emissive + transparent core, with bloom around it
  const bladeColor = 0x4ad8ff;
  const bladeCore = new THREE.Mesh(
    new THREE.CylinderGeometry(0.025, 0.025, 0.95, 12),
    new THREE.MeshBasicMaterial({ color: 0xffffff })
  );
  bladeCore.rotation.x = Math.PI / 2; bladeCore.position.set(0, 0, -0.50);
  const bladeGlow = new THREE.Mesh(
    new THREE.CylinderGeometry(0.06, 0.06, 1.00, 14),
    new THREE.MeshBasicMaterial({ color: bladeColor, transparent: true, opacity: 0.5, depthWrite: false })
  );
  bladeGlow.rotation.x = Math.PI / 2; bladeGlow.position.set(0, 0, -0.50);
  const bladeTip = new THREE.Mesh(
    new THREE.SphereGeometry(0.06, 12, 10),
    new THREE.MeshBasicMaterial({ color: bladeColor, transparent: true, opacity: 0.5, depthWrite: false })
  );
  bladeTip.position.set(0, 0, -1.0);
  // Right hand on the hilt
  const rightHand = createPlayerHand('right'); rightHand.position.set(0, -0.03, 0.20);
  g.add(hilt, button, bladeCore, bladeGlow, bladeTip, rightHand);
  g.position.set(0.35, -0.32, -0.5);
  g.rotation.set(0, -0.2, 0);
  return { group: g, muzzle: null };
}

function createCrossbowModel() {
  const g = new THREE.Group();
  const woodMat  = new THREE.MeshStandardMaterial({ color: 0x6b4226, roughness: 0.85 });
  const metalMat = new THREE.MeshStandardMaterial({ color: 0x444444, metalness: 0.6, roughness: 0.4 });
  const stringMat = new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.7 });
  // Stock + body
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.12, 0.40), woodMat);
  stock.position.set(0, 0, 0.05);
  // Bow arms — two angled blocks
  const arm1 = new THREE.Mesh(new THREE.BoxGeometry(0.50, 0.05, 0.04), woodMat);
  arm1.position.set(0, 0.04, -0.20);
  arm1.rotation.z = 0.0;
  // String (just a thin cylinder across the front)
  const string = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.50, 6), stringMat);
  string.rotation.z = Math.PI / 2; string.position.set(0, 0.04, -0.05);
  // Loaded bolt
  const bolt = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.5, 8), metalMat);
  bolt.rotation.x = Math.PI / 2; bolt.position.set(0, 0.04, -0.30);
  // Bolt fletching
  const fletch = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.005, 0.04), metalMat);
  fletch.position.set(0, 0.045, -0.08);
  // Sight
  const sight = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.06, 0.06), metalMat);
  sight.position.set(0, 0.13, -0.10);
  const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 8), muzzleMat());
  muzzle.position.set(0, 0.04, -0.55);
  // Hands
  const rightHand = createPlayerHand('right'); rightHand.position.set(0, -0.04, 0.10);
  const leftHand  = createPlayerHand('left');  leftHand.position.set(0, -0.05, -0.18);
  g.add(stock, arm1, string, bolt, fletch, sight, muzzle, rightHand, leftHand);
  g.position.set(0.28, -0.28, -0.5);
  return { group: g, muzzle };
}

function createMinigunModel() {
  const g = new THREE.Group();
  const bodyMat   = new THREE.MeshStandardMaterial({ color: 0x2a2a2a });
  const barrelMat = new THREE.MeshStandardMaterial({ color: 0x111111, metalness: 0.5 });
  const accentMat = new THREE.MeshStandardMaterial({ color: 0x666666, metalness: 0.6 });
  // Big chunky body
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.20, 0.50), bodyMat);
  body.position.set(0, 0, -0.10);
  // 6 rotating barrels arranged in a circle
  const barrelGroup = new THREE.Group();
  for (let i = 0; i < 6; i++) {
    const ang = (i / 6) * Math.PI * 2;
    const bx = Math.cos(ang) * 0.06;
    const by = Math.sin(ang) * 0.06;
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.55, 10), barrelMat);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(bx, by, -0.55);
    barrelGroup.add(barrel);
  }
  // Center hub
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.55, 14), accentMat);
  hub.rotation.x = Math.PI / 2; hub.position.set(0, 0, -0.55);
  barrelGroup.add(hub);
  // Front ring
  const frontRing = new THREE.Mesh(new THREE.TorusGeometry(0.10, 0.012, 8, 18), accentMat);
  frontRing.position.set(0, 0, -0.82);
  barrelGroup.add(frontRing);
  g.add(barrelGroup);
  g.userData.barrelGroup = barrelGroup;
  // Ammo belt feeding from the side
  const belt = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.10, 0.25), accentMat);
  belt.position.set(0.13, -0.08, -0.15);
  // Trigger grip
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.18, 0.10), bodyMat);
  grip.position.set(0, -0.18, 0.02);
  const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 10), muzzleMat());
  muzzle.position.set(0, 0, -0.85);
  // Hands
  const rightHand = createPlayerHand('right'); rightHand.position.set(0, -0.12, -0.05);
  const leftHand  = createPlayerHand('left');  leftHand.position.set(-0.10, -0.04, -0.20);
  g.add(body, belt, grip, muzzle, rightHand, leftHand);
  g.position.set(0.32, -0.30, -0.5);
  return { group: g, muzzle };
}

function createSwordModel() {
  const g = new THREE.Group();
  const hilt  = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.22, 12), new THREE.MeshStandardMaterial({ color: 0x6b4226 }));
  hilt.rotation.x = Math.PI / 2; hilt.position.set(0, 0,  0.15);
  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.04, 0.06), new THREE.MeshStandardMaterial({ color: 0xc9a132 }));
  guard.position.set(0, 0,  0.04);
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.025, 0.7),
    new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.9, roughness: 0.2 }));
  blade.position.set(0, 0, -0.32);
  blade.name = 'swordBlade';
  // ─── Attachment: sharpSword glow edge (hidden until owned) ──────────────
  // A thin glowing cyan edge runs along the top of the blade — clear visual
  // cue that the sword has been sharpened/enchanted.
  const edge = new THREE.Mesh(
    new THREE.BoxGeometry(0.084, 0.005, 0.71),
    new THREE.MeshBasicMaterial({ color: 0x66e7ff, transparent: true, opacity: 0.9 })
  );
  edge.position.set(0, 0.018, -0.32);
  edge.name = 'sharpSwordEdge';
  edge.visible = false;
  // Right hand grips the hilt — sword is one-handed
  const rightHand = createPlayerHand('right');
  rightHand.position.set(0, -0.04, 0.18);
  g.add(hilt, guard, blade, edge, rightHand);
  g.position.set(0.35, -0.32, -0.5);
  g.rotation.set(0, -0.2, 0); // hangs to the right at a slight angle
  return { group: g, muzzle: null };
}

const WEAPON_FACTORIES = {
  pistol: createPistolModel,
  rifle: createRifleModel,
  sniper: createSniperModel,
  shotgun: createShotgunModel,
  flamethrower: createFlamethrowerModel,
  sword: createSwordModel,
  rpg: createRPGModel,
  tommyGun: createTommyGunModel,
  lightsaber: createLightsaberModel,
  crossbow: createCrossbowModel,
  minigun: createMinigunModel,
};

const weapons = {};
for (const id of Object.keys(WEAPONS)) {
  const built = WEAPON_FACTORIES[id]();
  built.group.visible = false;
  camera.add(built.group);
  weapons[id] = {
    conf: WEAPONS[id],
    model: built.group,
    muzzle: built.muzzle,
    restPos: built.group.position.clone(),
    restRotX: built.group.rotation.x, // for sword swing (only x is animated)
    ammo: WEAPONS[id].maxAmmo,
    reserve: WEAPONS[id].reserveStart ?? 0,
    reloading: false,
    recoilTimer: 0,
    swingTimer: 0,
  };
}
let currentWeaponId = 'pistol';
weapons.pistol.model.visible = true;
scene.add(camera);

// Sniper zoom state
const NORMAL_FOV = 75;
const ZOOM_FOV = 30;
let isZoomed = false;
const scopeEl = document.getElementById('scope');
function setZoom(on) {
  if (isZoomed === on) return;
  isZoomed = on;
  camera.fov = on ? ZOOM_FOV : NORMAL_FOV;
  camera.updateProjectionMatrix();
  scopeEl.classList.toggle('on', on);
}

const weaponNameEl = document.getElementById('weaponName');
const ammoEl = document.getElementById('ammo');
const ammoMaxEl = document.getElementById('ammoMax');
const ammoReserveEl = document.getElementById('ammoReserve');

function updateWeaponHUD() {
  const w = weapons[currentWeaponId];
  weaponNameEl.textContent = w.conf.name;
  if (w.conf.maxAmmo === null) {
    ammoEl.textContent = '∞';
    ammoMaxEl.textContent = '';
    ammoReserveEl.textContent = '';
    ammoReserveEl.classList.remove('empty');
  } else {
    ammoEl.textContent = w.reloading ? '...' : Math.ceil(w.ammo);
    ammoMaxEl.textContent = w.conf.maxAmmo;
    ammoReserveEl.textContent = '+' + Math.ceil(w.reserve);
    ammoReserveEl.classList.toggle('empty', w.reserve <= 0 && w.ammo <= 0);
  }
  // Highlight active slot + refresh per-slot ammo labels
  for (const id of Object.keys(weapons)) {
    const slot = document.querySelector(`#weaponRow .slot[data-weapon="${id}"]`);
    if (!slot) continue;
    slot.classList.toggle('active', id === currentWeaponId);
    const ammoLabel = slot.querySelector('.ammo-mini');
    if (!ammoLabel) continue;
    const ww = weapons[id];
    if (ww.conf.maxAmmo === null) {
      ammoLabel.textContent = '∞';
    } else {
      const a = ww.reloading ? '...' : Math.ceil(ww.ammo);
      ammoLabel.textContent = `${a}/${ww.conf.maxAmmo} (+${Math.ceil(ww.reserve)})`;
    }
  }
}

// Returns true if the player has unlocked the shop item.
// Base weapons (in WEAPONS, not flagged shopOnly) are always free; everything
// else — shop weapons, perks, attachments — needs to be in user.ownedItems.
function playerOwns(itemId) {
  if (WEAPONS[itemId] && !WEAPONS[itemId].shopOnly) return true; // base weapons free
  return !!(session.user && (session.user.ownedItems || []).includes(itemId));
}

// Apply weapon attachments to this round's cloned confs.
// Must run AFTER weapons[id].conf has been reset to a fresh copy of WEAPONS[id]
// and BEFORE ammo/reserve are filled, so the new caps take effect immediately.
// Also toggles visibility of the matching 3D attachment meshes (scope on rifle,
// glow edge + gold tint on sword) so the player can SEE what they own.
function applyAttachments() {
  // ─── Stat effects ──────────────────────────────────────────────────────
  if (playerOwns('scopeRifle')   && weapons.rifle)    weapons.rifle.conf.canZoom = true;
  if (playerOwns('bigMagRifle')  && weapons.rifle)    weapons.rifle.conf.maxAmmo = 45;
  if (playerOwns('bigMagPistol') && weapons.pistol)   weapons.pistol.conf.maxAmmo = 18;
  if (playerOwns('extraPellets') && weapons.shotgun)  weapons.shotgun.conf.pellets = 11;
  if (playerOwns('sharpSword')   && weapons.sword)    weapons.sword.conf.damage = 90;
  if (playerOwns('fastReload')) {
    for (const id of Object.keys(weapons)) {
      if (weapons[id].conf.reloadTime != null) {
        weapons[id].conf.reloadTime = weapons[id].conf.reloadTime * 0.65;
      }
    }
  }

  // ─── Visual effects ────────────────────────────────────────────────────
  // Rifle scope: show the scope sub-group on top of the rifle if owned.
  if (weapons.rifle) {
    const scope = weapons.rifle.model.getObjectByName('scopeAttachment');
    if (scope) scope.visible = playerOwns('scopeRifle');
  }
  // Sharp sword: show the glow edge + tint the blade golden when owned.
  if (weapons.sword) {
    const edge  = weapons.sword.model.getObjectByName('sharpSwordEdge');
    const blade = weapons.sword.model.getObjectByName('swordBlade');
    const sharp = playerOwns('sharpSword');
    if (edge)  edge.visible = sharp;
    if (blade) blade.material.color.setHex(sharp ? 0xfff3a8 : 0xdddddd);
  }
}

function setWeapon(id) {
  if (!weapons[id]) return;
  if (WEAPONS[id] && WEAPONS[id].shopOnly && !playerOwns(id)) return;
  if (id !== currentWeaponId) {
    weapons[currentWeaponId].model.visible = false;
    // In 3rd person we never show the camera-attached weapon (it'd float
    // behind the avatar). setViewMode handles the visibility otherwise.
    weapons[id].model.visible = (typeof viewMode === 'undefined') ? true : (viewMode === 'fps');
    // cancel reload of the previous weapon
    weapons[currentWeaponId].reloading = false;
  }
  currentWeaponId = id;
  fireCooldown = 0.15; // small switch delay
  setZoom(false);
  updateWeaponHUD();
}

// Make every weapon-row slot tappable. On touch the player has no number
// keys, so this is the only way to switch weapons on a phone. Click also
// works on desktop for users who'd rather mouse than press 1-6.
document.querySelectorAll('#weaponRow .slot[data-weapon]').forEach(slot => {
  const switchTo = (e) => {
    if (e) { e.stopPropagation(); e.preventDefault(); }
    if (!controls.isLocked || !game.alive) return;
    setWeapon(slot.dataset.weapon);
    // On touch, taps to switch weapons also close the drawer
    document.body.classList.remove('weapon-drawer-open');
  };
  slot.addEventListener('click', switchTo);
  slot.addEventListener('touchstart', switchTo, { passive: false });
});

// "Quit to menu" — works on every device. Ends the current round (if any)
// and brings the start overlay back so the player can pick a new game,
// switch loadouts, or leave the room.
const _menuBtnEl = document.getElementById('menuBtn');
function quitToMenu(e) {
  if (e) { e.stopPropagation(); e.preventDefault(); }
  if (game.alive) {
    game.alive = false;
    if (controls.unlock) controls.unlock();
    document.body.classList.remove('weapon-drawer-open');
  }
  // Show the menu the user belongs in (auth if logged out, otherwise main)
  if (session.user || session.guest) overlay.classList.remove('hidden');
  else showAuthScreen();
}
_menuBtnEl.addEventListener('click', quitToMenu);
_menuBtnEl.addEventListener('touchstart', quitToMenu, { passive: false });

// Mobile: tapping the HUD (weapon name + ammo) opens / closes a drawer that
// shows the full weapon row. Default state on touch is "drawer closed" — the
// row stays out of the gameplay area until the player wants to switch.
const _hudEl = document.getElementById('hud');
const toggleWeaponDrawer = (e) => {
  if (e) { e.stopPropagation(); e.preventDefault(); }
  // Drawer only makes sense on touch — desktop already shows the row inline
  if (!document.body.classList.contains('is-touch')) return;
  if (!controls.isLocked || !game.alive) return;
  document.body.classList.toggle('weapon-drawer-open');
};
_hudEl.addEventListener('click', toggleWeaponDrawer);
_hudEl.addEventListener('touchstart', toggleWeaponDrawer, { passive: false });

// Tap anywhere outside the drawer or HUD closes it. We listen at the document
// level on the capture phase so we see the touch before any inner handler.
function maybeCloseDrawer(e) {
  if (!document.body.classList.contains('weapon-drawer-open')) return;
  const t = e.target;
  if (t.closest('#weaponRow') || t.closest('#hud')) return;
  document.body.classList.remove('weapon-drawer-open');
}
document.addEventListener('touchstart', maybeCloseDrawer, { passive: true, capture: true });
document.addEventListener('click',      maybeCloseDrawer, { capture: true });

// When the player switches weapons via number keys (1-6), also close any
// open drawer so it doesn't linger on screen on hybrid touch laptops.
document.addEventListener('keydown', (e) => {
  if (e.code && /^Digit[1-6]$/.test(e.code)) {
    document.body.classList.remove('weapon-drawer-open');
  }
}, true);

let fireCooldown = 0;
let mouseDown = false;
updateWeaponHUD();

// ─── Bots (enemies) ───────────────────────────────────────────────────────
const bots = [];
const losRaycaster = new THREE.Raycaster();
const BOT_DAMAGE_PER_HIT = 25;       // how much damage one player bullet does to a bot
const BOT_ATTACK_RANGE = 18;         // bot starts shooting within this distance
const BOT_KEEP_DISTANCE = 6;         // bot stops getting closer than this

// Steve-style bot palettes (Minecraft mob colours). Body is the shirt,
// accent is the trousers, head is skin tone, eyes are pupils.
const BOT_PALETTES = [
  { body: 0x009faa, accent: 0x3e3eb0, head: 0xf2cbac, eyes: 0x3a2f7a }, // classic Steve cyan
  { body: 0xe04444, accent: 0x2a2a2a, head: 0xf2cbac, eyes: 0x111111 }, // red bandit
  { body: 0x6b3aa6, accent: 0x3e2862, head: 0xa57b54, eyes: 0x111111 }, // dark cloak
  { body: 0xb8c25d, accent: 0x6f4226, head: 0xf2cbac, eyes: 0x111111 }, // farmer
];

// Pixel face for bot heads — drawn on a 32×32 canvas for richer features
// (brows, nose shading, beard, mouth dimple). Still reads as Minecraft.
function makeBotFaceTex(skin, eyes) {
  return makePixelTexture(pixelCanvas(200 + Math.floor(Math.random() * 1000), 32, (x, rng, S) => {
    // Skin base
    x.fillStyle = skin; x.fillRect(0, 0, S, S);
    // Subtle skin tone variation — pixels here and there
    x.fillStyle = 'rgba(0,0,0,0.07)';
    for (let i = 0; i < 60; i++) x.fillRect(Math.floor(rng() * S), Math.floor(rng() * S), 1, 1);
    x.fillStyle = 'rgba(255,255,255,0.06)';
    for (let i = 0; i < 30; i++) x.fillRect(Math.floor(rng() * S), Math.floor(rng() * S), 1, 1);
    // Eyebrows — dark slash above each eye
    x.fillStyle = '#3a2818';
    x.fillRect(7, 11, 6, 1);
    x.fillRect(19, 11, 6, 1);
    // Eye whites — 4×3 boxes
    x.fillStyle = '#ffffff';
    x.fillRect(7, 13, 6, 4);
    x.fillRect(19, 13, 6, 4);
    // Pupils — 2×3 each, on the inner side of each eye for a "looking forward" feel
    x.fillStyle = eyes;
    x.fillRect(9, 14, 2, 3);
    x.fillRect(21, 14, 2, 3);
    // Nose — lighter shading vertical strip
    x.fillStyle = 'rgba(0,0,0,0.10)';
    x.fillRect(15, 17, 2, 4);
    // Nostrils
    x.fillStyle = 'rgba(0,0,0,0.30)';
    x.fillRect(14, 21, 1, 1);
    x.fillRect(17, 21, 1, 1);
    // Mouth — flat closed line with raised corners
    x.fillStyle = '#3a2818';
    x.fillRect(11, 24, 10, 1);
    x.fillRect(10, 23, 1, 1);
    x.fillRect(21, 23, 1, 1);
    // Tiny stubble / beard hint (random per face)
    if (rng() > 0.5) {
      x.fillStyle = 'rgba(60,40,20,0.45)';
      for (let i = 0; i < 18; i++) {
        x.fillRect(8 + Math.floor(rng() * 16), 25 + Math.floor(rng() * 4), 1, 1);
      }
    }
  }), 1);
}

// A vivid red palette reserved for BOSS bots so they're instantly recognisable
const BOSS_PALETTE = { body: 0x8b0000, accent: 0xff2010, head: 0xfff0d8, eyes: 0xffe000 };

function createBot(spawnX, spawnZ, conf) {
  const group = new THREE.Group();
  const isBoss = !!conf.isBoss;
  const palette = isBoss
    ? BOSS_PALETTE
    : BOT_PALETTES[Math.floor(Math.random() * BOT_PALETTES.length)];
  // Steve uses flat (Lambert) shading + emissive accent on the boss
  const bodyMat   = new THREE.MeshLambertMaterial({ color: palette.body,
    emissive: isBoss ? 0x440000 : 0x000000, emissiveIntensity: isBoss ? 0.5 : 0 });
  const accentMat = new THREE.MeshLambertMaterial({ color: palette.accent });
  // Head face is a pixel texture — eyes + mouth drawn directly on the skin
  const faceTex   = makeBotFaceTex(`#${palette.head.toString(16).padStart(6, '0')}`,
                                   `#${palette.eyes.toString(16).padStart(6, '0')}`);
  const headSkinMat = new THREE.MeshLambertMaterial({ color: palette.head });
  const headFaceMat = new THREE.MeshLambertMaterial({ map: faceTex });
  // Steve face is on the front (-Z): order is +X, -X, +Y, -Y, +Z, -Z
  const headMats = [headSkinMat, headSkinMat, headSkinMat, headSkinMat, headSkinMat, headFaceMat];

  // Steve canonical proportions, scaled to a ~1.85m tall mob:
  //   torso: 0.5 × 0.75 × 0.25,  arms / legs: 0.25 × 0.75 × 0.25,  head: 0.5 cube
  // We multiply each by ~1.6 so collisions feel fair against the human player.
  const S = 1.6;
  const TORSO_W = 0.50 * S, TORSO_H = 0.75 * S, TORSO_D = 0.25 * S;
  const LIMB    = 0.25 * S, LIMB_H  = 0.75 * S;
  const HEAD    = 0.50 * S;
  // Vertical layout (feet on y=0):
  const LEG_Y    = LIMB_H / 2;                       // legs centred at half-height
  const TORSO_Y  = LIMB_H + TORSO_H / 2;             // sits on top of legs
  const HEAD_Y   = LIMB_H + TORSO_H + HEAD / 2;      // sits on top of torso
  const ARM_Y    = LIMB_H + TORSO_H - LIMB_H / 2;    // shoulders at top of torso

  // Torso
  const body = new THREE.Mesh(new THREE.BoxGeometry(TORSO_W, TORSO_H, TORSO_D), bodyMat);
  body.position.y = TORSO_Y;
  body.castShadow = true;

  // Legs — pivot at the hip
  const legPivotL = new THREE.Group(); legPivotL.position.set(-LIMB / 2,  LIMB_H,       0); group.add(legPivotL);
  const legPivotR = new THREE.Group(); legPivotR.position.set( LIMB / 2,  LIMB_H,       0); group.add(legPivotR);
  const legGeo = new THREE.BoxGeometry(LIMB, LIMB_H, LIMB);
  const legL = new THREE.Mesh(legGeo, accentMat); legL.position.y = -LIMB_H / 2; legL.castShadow = true; legPivotL.add(legL);
  const legR = new THREE.Mesh(legGeo, accentMat); legR.position.y = -LIMB_H / 2; legR.castShadow = true; legPivotR.add(legR);

  // Arms — pivot at the shoulder, hang straight down by default
  const armPivotL = new THREE.Group(); armPivotL.position.set(-(TORSO_W / 2 + LIMB / 2), ARM_Y + LIMB_H / 2, 0); group.add(armPivotL);
  const armPivotR = new THREE.Group(); armPivotR.position.set( (TORSO_W / 2 + LIMB / 2), ARM_Y + LIMB_H / 2, 0); group.add(armPivotR);
  const armGeo = new THREE.BoxGeometry(LIMB, LIMB_H, LIMB);
  const armL = new THREE.Mesh(armGeo, bodyMat); armL.position.y = -LIMB_H / 2; armL.castShadow = true; armPivotL.add(armL);
  const armR = new THREE.Mesh(armGeo, bodyMat); armR.position.y = -LIMB_H / 2; armR.castShadow = true; armPivotR.add(armR);

  // Head — canonical Steve cube with the pixel face on the front
  const head = new THREE.Mesh(new THREE.BoxGeometry(HEAD, HEAD, HEAD), headMats);
  head.position.y = HEAD_Y;
  head.castShadow = true;

  // Hat layer — a slightly larger overlay (Minecraft mobs all have one)
  const hatColor = isBoss ? 0xff2010 : (palette.body);
  const hat = new THREE.Mesh(
    new THREE.BoxGeometry(HEAD + 0.06, HEAD + 0.06, HEAD + 0.06),
    new THREE.MeshLambertMaterial({ color: hatColor, transparent: true, opacity: 0.35 })
  );
  hat.position.y = HEAD_Y;
  group.add(hat);

  // Body parts list used by the existing aim / shoot pipeline. Eyes are
  // drawn into the face texture so we no longer add separate eye meshes.
  const eyeL = head, eyeR = head; // alias — kept for return shape compatibility

  // BOSS gets a noticeably larger silhouette + a glowing aura
  if (isBoss) {
    group.scale.setScalar(1.7);
    const aura = new THREE.Mesh(
      new THREE.SphereGeometry(1.4, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xff4020, transparent: true, opacity: 0.18, depthWrite: false, fog: false })
    );
    aura.position.y = 1.4;
    group.add(aura);
  }
  // Archetype-specific visuals — only added for non-boss special bots
  const arch = conf.archetype || 'tank';
  if (!isBoss && arch === 'sniper') {
    // A long "scope tube" sticking out of the head — silhouette of a rifle
    const scope = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.05, 1.2, 10),
      new THREE.MeshLambertMaterial({ color: 0x303030 })
    );
    scope.rotation.x = Math.PI / 2;
    scope.position.set(0, HEAD_Y - 0.05, -0.7);
    group.add(scope);
  } else if (!isBoss && arch === 'kamikaze') {
    // Strapped explosives — red blocks around the torso + pulsing red aura
    const tntMat = new THREE.MeshLambertMaterial({ color: 0xd22020, emissive: 0x661010, emissiveIntensity: 0.4 });
    for (let i = 0; i < 4; i++) {
      const stick = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.36, 0.08), tntMat);
      const ang = (i / 4) * Math.PI * 2;
      stick.position.set(Math.cos(ang) * 0.32, TORSO_Y, Math.sin(ang) * 0.18);
      group.add(stick);
    }
    const aura = new THREE.Mesh(
      new THREE.SphereGeometry(1.1, 14, 10),
      new THREE.MeshBasicMaterial({ color: 0xff5030, transparent: true, opacity: 0.22, depthWrite: false, fog: false })
    );
    aura.position.y = TORSO_Y;
    aura.userData.pulse = true;
    group.add(aura);
  } else if (!isBoss && arch === 'healer') {
    // White cross on the chest + soft green halo
    const crossMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const crossH = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.1, 0.04), crossMat);
    const crossV = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.45, 0.04), crossMat);
    crossH.position.set(0, TORSO_Y, -TORSO_D / 2 - 0.02);
    crossV.position.set(0, TORSO_Y, -TORSO_D / 2 - 0.02);
    group.add(crossH, crossV);
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(1.0, 14, 10),
      new THREE.MeshBasicMaterial({ color: 0x55ff7a, transparent: true, opacity: 0.18, depthWrite: false, fog: false })
    );
    halo.position.y = TORSO_Y;
    group.add(halo);
  }

  // HP bar floating above the bot's head — billboarded each frame to face the camera
  const hpBar = new THREE.Group();
  const hpBarBg = new THREE.Mesh(
    new THREE.PlaneGeometry(0.9, 0.1),
    new THREE.MeshBasicMaterial({ color: 0x000000, depthTest: false, transparent: true, opacity: 0.6, side: THREE.DoubleSide })
  );
  const hpBarFill = new THREE.Mesh(
    new THREE.PlaneGeometry(0.86, 0.06),
    new THREE.MeshBasicMaterial({ color: 0x4caf50, depthTest: false, side: THREE.DoubleSide })
  );
  // Anchor fill on the LEFT edge so scale.x shrinks toward the left
  hpBarFill.geometry.translate(0.43, 0, 0);
  hpBarFill.position.x = -0.43;
  hpBarFill.position.z = 0.002;
  hpBarBg.renderOrder = 999;
  hpBarFill.renderOrder = 1000;
  hpBar.add(hpBarBg, hpBarFill);
  // Steve mob is taller than the old cartoon bot — float the HP bar above
  // the head + the hat overlay.
  hpBar.position.y = 3.45;

  group.add(body, head, hpBar);
  group.position.set(spawnX, 0, spawnZ);
  scene.add(group);

  return {
    group, conf,
    parts: [body, head], // parts that count as hittable
    legPivotL, legPivotR, armPivotL, armPivotR, head,
    headRestY: HEAD_Y,
    walkPhase: Math.random() * Math.PI * 2,
    isMoving: false,
    archetype: arch,
    deathTimer: 0,    // when > 0, bot is in falling-corpse animation
    hpBar,
    hpBarFill,
    hp: conf.hp,
    maxHp: conf.hp,
    speed: conf.speed,
    damage: conf.damage,
    fireInterval: conf.fireInterval,
    sightRange: conf.sight,
    fireCooldown: 0.5 + Math.random() * conf.fireInterval, // staggered first shot
    wanderTarget: new THREE.Vector3(
      spawnX + (Math.random() - 0.5) * 12, 0,
      spawnZ + (Math.random() - 0.5) * 12,
    ),
    wanderTimer: 1 + Math.random() * 2,
    alive: true,
    isBoss,
  };
}

function spawnOneBot(conf) {
  // Spawn in a ring 22-90m around the player so they can actually be found
  // on the bigger map. Clamp to inside the arena, dodge obstacles.
  let x, z, attempts = 0;
  do {
    const angle = Math.random() * Math.PI * 2;
    const dist = 22 + Math.random() * 68;
    x = camera.position.x + Math.cos(angle) * dist;
    z = camera.position.z + Math.sin(angle) * dist;
    x = Math.max(-ARENA + 4, Math.min(ARENA - 4, x));
    z = Math.max(-ARENA + 4, Math.min(ARENA - 4, z));
    attempts++;
  } while (attempts < 25 && isInsideObstacle(x, z));
  bots.push(createBot(x, z, conf));
}

function isInsideObstacle(x, z) {
  for (const c of colliders) {
    if (x >= c.box.min.x - 0.5 && x <= c.box.max.x + 0.5 &&
        z >= c.box.min.z - 0.5 && z <= c.box.max.z + 0.5) return true;
  }
  return false;
}

function clearBots() {
  for (const b of bots) scene.remove(b.group);
  bots.length = 0;
}

// Decide whether to schedule a replacement bot after one dies.
// Cap concurrent bots at the difficulty's `count`, and never overshoot the kill quota.
// When the player is one kill away from victory, the next spawn is the BOSS
// (instead of a regular bot) — only happens in bots/co-op mode, not PvP.
function scheduleRespawn() {
  if (!game.alive || game.mode === 'pvp') return;
  const conf = DIFFICULTIES[game.difficulty];
  const aliveCount = bots.filter(b => b.alive).length;
  const inFlight = aliveCount + game.pendingSpawns;

  // Final kill is the BOSS — spawn exactly once, after all regulars are dead
  if (game.kills >= game.killTarget - 1) {
    if (game.bossSpawned || aliveCount > 0) return; // wait until arena is clear
    game.bossSpawned = true;
    game.pendingSpawns++;
    setTimeout(() => {
      game.pendingSpawns--;
      if (!game.alive) return;
      spawnOneBot(bossConfFor(game.difficulty));
    }, 2200);
    return;
  }

  if (inFlight >= conf.count) return;
  if (game.kills + inFlight >= game.killTarget - 1) return; // leave room for the BOSS
  game.pendingSpawns++;
  setTimeout(() => {
    game.pendingSpawns--;
    if (!game.alive) return;
    if (game.kills + bots.filter(b => b.alive).length >= game.killTarget - 1) return;
    // 30% chance to spawn a special archetype — sniper / kamikaze / healer.
    // The remaining 70% are standard "tank" grunts.
    const r = Math.random();
    let pickConf;
    if      (r < 0.10) pickConf = sniperConfFor(game.difficulty);
    else if (r < 0.20) pickConf = kamikazeConfFor(game.difficulty);
    else if (r < 0.30) pickConf = healerConfFor(game.difficulty);
    else               pickConf = DIFFICULTIES[game.difficulty];
    spawnOneBot(pickConf);
  }, 1500);
}

function winGame() {
  game.alive = false;
  Auth.bumpStat('victories', 1);
  Auth.bumpStat('gamesPlayed', 1);
  Auth.bumpChallenge('win_games', 1);
  victoryKillsEl.textContent = game.kills;
  victoryDiffEl.textContent = DIFFICULTIES[game.difficulty].label;
  // Show coin earnings (only meaningful in bots mode)
  const coinsRow = document.getElementById('victoryCoinsRow');
  const coinsValEl = document.getElementById('victoryCoins');
  if (coinsRow && coinsValEl) {
    if (game.mode === 'bots' && (game.coinsThisGame || 0) > 0) {
      coinsValEl.textContent = game.coinsThisGame;
      coinsRow.classList.remove('hidden');
    } else {
      coinsRow.classList.add('hidden');
    }
  }
  victoryEl.classList.remove('hidden');
  controls.unlock();
}

// True if no obstacle (collider) blocks the line from `from` to `to`.
const _losDir = new THREE.Vector3();
function hasLineOfSight(from, to) {
  _losDir.subVectors(to, from);
  const dist = _losDir.length();
  _losDir.normalize();
  losRaycaster.set(from, _losDir);
  losRaycaster.far = dist;
  const hits = losRaycaster.intersectObjects(colliders.map(c => c.mesh), false);
  return hits.length === 0;
}

const _toPlayer = new THREE.Vector3();
const _from = new THREE.Vector3();
// Healer behaviour — runs to the most injured bot in range and heals.
// Falls back to lazy wander if no allies need help.
const _healTo = new THREE.Vector3();
function tickHealerAI(bot, dt) {
  // Find the most injured ally (excluding self + boss + other healers)
  let target = null, lowestHp = Infinity;
  for (const ally of bots) {
    if (!ally.alive || ally === bot) continue;
    if (ally.hp >= ally.maxHp) continue;
    if (ally.archetype === 'healer') continue;
    if (ally.hp < lowestHp) { lowestHp = ally.hp; target = ally; }
  }

  if (target) {
    _healTo.subVectors(target.group.position, bot.group.position);
    _healTo.y = 0;
    const d = _healTo.length();
    bot.group.lookAt(target.group.position.x, bot.group.position.y, target.group.position.z);
    if (d > (bot.conf.healRange || 4)) {
      const step = bot.speed * dt;
      bot.group.position.x += (_healTo.x / d) * step;
      bot.group.position.z += (_healTo.z / d) * step;
      bot.isMoving = true;
    } else {
      // Heal: refill ally HP at healAmount per second
      bot.isMoving = false;
      target.hp = Math.min(target.maxHp, target.hp + (bot.conf.healAmount || 10) * dt);
      const pct = target.hp / target.maxHp;
      target.hpBarFill.scale.x = pct;
      target.hpBarFill.material.color.setHex(pct > 0.6 ? 0x4caf50 : pct > 0.3 ? 0xffc107 : 0xf44336);
    }
  } else {
    // No one to heal — wander
    bot.wanderTimer -= dt;
    if (bot.wanderTimer <= 0) {
      bot.wanderTarget.set(
        THREE.MathUtils.clamp(bot.group.position.x + (Math.random() - 0.5) * 18, -ARENA + 2, ARENA - 2),
        0,
        THREE.MathUtils.clamp(bot.group.position.z + (Math.random() - 0.5) * 18, -ARENA + 2, ARENA - 2),
      );
      bot.wanderTimer = 2 + Math.random() * 3;
    }
    const wx = bot.wanderTarget.x - bot.group.position.x;
    const wz = bot.wanderTarget.z - bot.group.position.z;
    const wd = Math.hypot(wx, wz);
    if (wd > 0.5) {
      const step = bot.speed * 0.4 * dt;
      bot.group.position.x += (wx / wd) * step;
      bot.group.position.z += (wz / wd) * step;
      bot.group.lookAt(bot.wanderTarget.x, bot.group.position.y, bot.wanderTarget.z);
      bot.isMoving = true;
    } else {
      bot.isMoving = false;
    }
  }

  // Walk animation + HP bar billboard (shared with the main loop)
  if (bot.isMoving) {
    bot.walkPhase += dt * 7;
    const swing = Math.sin(bot.walkPhase) * 0.5;
    bot.legPivotL.rotation.x =  swing;
    bot.legPivotR.rotation.x = -swing;
    bot.armPivotL.rotation.x = -swing * 0.7;
    bot.armPivotR.rotation.x =  swing * 0.7;
  } else {
    bot.legPivotL.rotation.x *= 0.85;
    bot.legPivotR.rotation.x *= 0.85;
    bot.armPivotL.rotation.x *= 0.85;
    bot.armPivotR.rotation.x *= 0.85;
  }
  const worldPos = bot.hpBar.getWorldPosition(new THREE.Vector3());
  bot.hpBar.lookAt(camera.position.x, worldPos.y, camera.position.z);
  bot.hpBar.rotation.y -= bot.group.rotation.y;
}

function updateBots(dt) {
  for (const bot of bots) {
    if (!bot.alive) continue;

    // ─── Healer archetype: ignore the player, run to wounded allies ────
    if (bot.archetype === 'healer') {
      tickHealerAI(bot, dt);
      continue;
    }

    _toPlayer.set(
      camera.position.x - bot.group.position.x,
      0,
      camera.position.z - bot.group.position.z,
    );
    const dist = _toPlayer.length();

    // Line of sight from bot's head to player's eye (head sits at ~2.8m
    // on the Steve-proportioned bot)
    _from.set(bot.group.position.x, 2.8, bot.group.position.z);
    const sees = game.alive && dist < bot.sightRange && hasLineOfSight(_from, camera.position);

    if (sees) {
      // Face player
      bot.group.lookAt(camera.position.x, bot.group.position.y, camera.position.z);

      // Kamikaze: charge until point-blank, then explode
      if (bot.archetype === 'kamikaze') {
        const step = bot.speed * dt;
        if (dist > 1.6) {
          bot.group.position.x += (_toPlayer.x / dist) * step;
          bot.group.position.z += (_toPlayer.z / dist) * step;
          bot.isMoving = true;
        } else {
          bot.isMoving = false;
          // Boom — explode AT the player using the standard AOE pipeline,
          // then mark the bot itself as dead (counts as a kill + coin).
          explodeAt(bot.group.position.clone(), bot.damage, bot.conf.explodeRadius || 4);
          damageBot(bot, 9999);
          continue;
        }
      } else {
        // Sniper: keep a long distance; only fire from afar
        const sniperPrefDist = bot.archetype === 'sniper' ? Math.max(28, bot.sightRange * 0.7) : BOT_KEEP_DISTANCE;
        if (dist > sniperPrefDist + 4) {
          const step = bot.speed * dt;
          bot.group.position.x += (_toPlayer.x / dist) * step;
          bot.group.position.z += (_toPlayer.z / dist) * step;
          bot.isMoving = true;
        } else if (bot.archetype === 'sniper' && dist < sniperPrefDist - 4) {
          // Back off — kite the player
          const step = bot.speed * 0.6 * dt;
          bot.group.position.x -= (_toPlayer.x / dist) * step;
          bot.group.position.z -= (_toPlayer.z / dist) * step;
          bot.isMoving = true;
        } else {
          bot.isMoving = false;
        }

        // Shoot when in attack range. Snipers fire from much further.
        const fireMaxDist = bot.archetype === 'sniper' ? bot.sightRange : BOT_ATTACK_RANGE;
        const fireMinDist = bot.archetype === 'sniper' ? 18 : 0;
        bot.fireCooldown -= dt;
        if (dist < fireMaxDist && dist >= fireMinDist && bot.fireCooldown <= 0 && bot.damage > 0) {
          bot.fireCooldown = bot.fireInterval;
          // Snipers are crack shots
          const hitChance = bot.archetype === 'sniper'
            ? 0.95
            : bot.damage <= 5 ? 0.55 : bot.damage <= 8 ? 0.75 : 0.9;
          if (Math.random() < hitChance) damagePlayer(bot.damage);
        }
      }
    } else {
      // Wander
      bot.wanderTimer -= dt;
      if (bot.wanderTimer <= 0) {
        bot.wanderTarget.set(
          THREE.MathUtils.clamp(bot.group.position.x + (Math.random() - 0.5) * 18, -ARENA + 2, ARENA - 2),
          0,
          THREE.MathUtils.clamp(bot.group.position.z + (Math.random() - 0.5) * 18, -ARENA + 2, ARENA - 2),
        );
        bot.wanderTimer = 2 + Math.random() * 3;
      }
      const wx = bot.wanderTarget.x - bot.group.position.x;
      const wz = bot.wanderTarget.z - bot.group.position.z;
      const wd = Math.hypot(wx, wz);
      if (wd > 0.5) {
        const step = bot.speed * 0.4 * dt;
        bot.group.position.x += (wx / wd) * step;
        bot.group.position.z += (wz / wd) * step;
        bot.group.lookAt(bot.wanderTarget.x, bot.group.position.y, bot.wanderTarget.z);
        bot.isMoving = true;
      } else {
        bot.isMoving = false;
      }
    }

    // Walk animation — swing legs + arms based on walkPhase, head bobs slightly
    if (bot.isMoving) {
      const swingSpeed = sees ? 9 : 5;
      bot.walkPhase += dt * swingSpeed;
      const swing = Math.sin(bot.walkPhase) * 0.6;
      bot.legPivotL.rotation.x =  swing;
      bot.legPivotR.rotation.x = -swing;
      bot.armPivotL.rotation.x = -swing * 0.8;
      bot.armPivotR.rotation.x =  swing * 0.8;
      bot.head.position.y = bot.headRestY + Math.abs(Math.sin(bot.walkPhase * 2)) * 0.04;
    } else {
      // Smoothly settle limbs to rest
      bot.legPivotL.rotation.x *= 0.85;
      bot.legPivotR.rotation.x *= 0.85;
      bot.armPivotL.rotation.x *= 0.85;
      bot.armPivotR.rotation.x *= 0.85;
      bot.head.position.y = bot.headRestY;
    }

    // Billboard the HP bar so it always faces the camera (in world space)
    const worldPos = bot.hpBar.getWorldPosition(new THREE.Vector3());
    bot.hpBar.lookAt(camera.position.x, worldPos.y, camera.position.z);
    // Cancel out the parent's rotation so we look directly at the camera
    bot.hpBar.rotation.y -= bot.group.rotation.y;
  }
}

function damageBot(bot, amount) {
  bot.hp -= amount;
  // Update floating HP bar (scaleX from 1 → 0)
  const pct = Math.max(0, bot.hp / bot.maxHp);
  bot.hpBarFill.scale.x = pct;
  // Bar turns yellow / red as HP drops
  bot.hpBarFill.material.color.setHex(pct > 0.6 ? 0x4caf50 : pct > 0.3 ? 0xffc107 : 0xf44336);
  if (bot.hp <= 0) {
    bot.alive = false;
    bot.deathTimer = 0;       // start the fall-and-fade animation in tickDyingBots
    bot.hpBar.visible = false;
    Sfx.botDeath();
    game.kills += 1;
    killCountEl.textContent = game.kills;
    Auth.bumpStat('kills', 1);

    // B2: daily-challenge progress for kills.
    Auth.bumpChallenge('kill_bots', 1);
    if (bot.isBoss) Auth.bumpChallenge('kill_boss', 1);
    if (bot.archetype === 'sniper')   Auth.bumpChallenge('kill_sniper', 1);
    if (bot.archetype === 'kamikaze') Auth.bumpChallenge('kill_kamikaze', 1);
    if (bot.archetype === 'healer')   Auth.bumpChallenge('kill_healer', 1);
    if (currentWeaponId === 'sword') Auth.bumpChallenge('kill_with_sword', 1);
    if (currentWeaponId === 'rpg')   Auth.bumpChallenge('kill_with_rpg', 1);

    // Coins are only awarded in the PvE (bots + BOSS) mode — PvP doesn't
    // pay out so no incentive to farm friends.
    if (game.mode === 'bots') {
      const reward = bot.isBoss ? 5 : 1;
      game.coinsThisGame = (game.coinsThisGame || 0) + reward;
      Auth.bumpStat('coins', reward);
      Auth.bumpChallenge('earn_coins', reward);
      // Pop a tiny "+N 💰" indicator near the kill counter
      flashCoinReward(reward);
      updateCoinHUD();
    }

    if (game.kills >= game.killTarget) {
      winGame();
    } else {
      scheduleRespawn();
    }
  } else {
    Sfx.hitConfirm();
  }
}

const DEATH_DURATION = 0.85;
function tickDyingBots(dt) {
  for (const bot of bots) {
    if (bot.alive) continue;
    if (bot.deathTimer == null || bot.deathTimer < 0) continue; // not dying or already cleaned up
    bot.deathTimer += dt;
    const t = Math.min(1, bot.deathTimer / DEATH_DURATION);
    bot.group.rotation.x = -Math.PI / 2 * t;
    bot.group.position.y = -0.5 * t;
    // Lazily collect all materials and switch to transparent on first frame
    if (!bot.fadeMaterials) {
      bot.fadeMaterials = [];
      bot.group.traverse(o => { if (o.material && o.material.opacity != null) bot.fadeMaterials.push(o.material); });
      for (const m of bot.fadeMaterials) m.transparent = true;
    }
    for (const m of bot.fadeMaterials) m.opacity = 1 - t;
    if (t >= 1) {
      scene.remove(bot.group);
      bot.deathTimer = -1;
    }
  }
}

// ─── Shooting ─────────────────────────────────────────────────────────────
const raycaster = new THREE.Raycaster();
const bulletHoles = [];
const holeGeom = new THREE.CircleGeometry(0.08, 12);
const holeMat = new THREE.MeshBasicMaterial({ color: 0x111111, side: THREE.DoubleSide });

function addBulletHole(hit) {
  const hole = new THREE.Mesh(holeGeom, holeMat);
  hole.position.copy(hit.point).add(hit.face.normal.clone().multiplyScalar(0.01));
  hole.lookAt(hit.point.clone().add(hit.face.normal));
  scene.add(hole);
  bulletHoles.push(hole);
  if (bulletHoles.length > 60) scene.remove(bulletHoles.shift());
  spawnHitSparks(hit.point, hit.face.normal);
}

const SHOT_SOUND = {
  pistol: Sfx.shotPistol,
  rifle: Sfx.shotRifle,
  sniper: Sfx.shotSniper,
  shotgun: Sfx.shotShotgun,
};

function tryFire() {
  if (!controls.isLocked || !game.alive) return;
  if (fireCooldown > 0) return;
  const w = weapons[currentWeaponId];
  if (w.reloading) return;
  if (w.conf.fireMode === 'continuous') return;
  if (w.conf.maxAmmo !== null && w.ammo <= 0) {
    if (w.reserve > 0) reload();
    else Sfx.emptyClick();
    return;
  }
  if (w.conf.fireMode === 'melee') { swingMelee(w); Sfx.swordSwing(); }
  else if (w.conf.fireMode === 'projectile') { fireProjectile(w); Sfx.shotSniper(); }
  else { fireRanged(w); const s = SHOT_SOUND[w.conf.id]; if (s) s(); }
  fireCooldown = w.conf.fireInterval;
}

function fireRanged(w) {
  if (w.conf.maxAmmo !== null) {
    w.ammo -= 1;
    updateWeaponHUD();
  }
  // Build hittable target list once for all pellets
  const wallMeshes = colliders.map(c => c.mesh);
  const botParts = [];
  const partToBot = new Map();
  for (const b of bots) {
    if (!b.alive) continue;
    for (const p of b.parts) { botParts.push(p); partToBot.set(p, b); }
  }
  // In PvP mode, remote players' bodies/heads are also valid hit targets
  const playerParts = [];
  if (game.mode === 'pvp') {
    for (const av of remotePlayers.values()) {
      if (av.body) playerParts.push(av.body);
      if (av.head) playerParts.push(av.head);
    }
  }
  const targets = [...wallMeshes, ...botParts, ...playerParts];

  const pellets = w.conf.pellets ?? 1;
  const spread = w.conf.spread ?? 0;
  for (let i = 0; i < pellets; i++) {
    const ndcX = (Math.random() - 0.5) * spread;
    const ndcY = (Math.random() - 0.5) * spread;
    raycaster.setFromCamera({ x: ndcX, y: ndcY }, camera);
    raycaster.far = w.conf.range;
    const hits = raycaster.intersectObjects(targets, false);
    if (hits.length === 0) continue;
    const hit = hits[0];
    const bot = partToBot.get(hit.object);
    if (bot) {
      const isHead = hit.object === bot.parts[1];
      damageBot(bot, w.conf.damage * (isHead ? w.conf.headshotMult : 1));
    } else if (hit.object.userData && hit.object.userData.peerId) {
      // We hit another player — tell them (and host relay the hit). The
      // target's client applies the damage on its own HP.
      const targetId = hit.object.userData.peerId;
      const isHead = !!hit.object.userData.isHead;
      const dmg = w.conf.damage * (isHead ? (w.conf.headshotMult ?? 1) : 1);
      const msg = { type: 'pvp-hit', targetId, amount: dmg };
      if (net.isHost()) net.sendTo(targetId, msg);
      else net.sendToHost(msg);
      spawnHitSparks(hit.point, hit.face.normal);
    } else if (hit.object.userData && hit.object.userData.destructible) {
      // Hit a destructible scenery block — chip its HP, break it on zero
      damageDestructible(hit.object, hit.point, hit.face.normal);
    } else {
      addBulletHole(hit);
    }
  }

  // Muzzle flash on the current weapon's barrel tip + recoil
  if (w.muzzle) {
    w.muzzle.material.opacity = 1;
    setTimeout(() => { w.muzzle.material.opacity = 0; }, 60);
  }
  w.recoilTimer = w.conf.recoilTime;
}

// Continuous fire (flamethrower): drains fuel by dt, damages bots in cone, spawns particles.
let _flameSoundCooldown = 0;
function tickContinuousFire(w, dt) {
  // Need fuel — pull from magazine first, fall through to reserve
  const need = w.conf.fuelPerSecond * dt;
  let drawn = 0;
  if (w.ammo > 0) {
    const take = Math.min(w.ammo, need);
    w.ammo -= take; drawn += take;
  }
  if (drawn < need && w.reserve > 0) {
    const take = Math.min(w.reserve, need - drawn);
    w.reserve -= take; drawn += take;
  }
  if (drawn <= 0) return; // truly out of fuel — silent click
  const dmg = w.conf.damage * (drawn / w.conf.fuelPerSecond);
  damageBotsInCone(w.conf.range, w.conf.coneCos, dmg);
  spawnFlameParticle();
  if (w.muzzle) w.muzzle.material.opacity = 1;
  // Throttle the flame sfx so it doesn't stack into white noise
  _flameSoundCooldown -= dt;
  if (_flameSoundCooldown <= 0) {
    Sfx.flameTick();
    _flameSoundCooldown = 0.08;
  }
  updateWeaponHUD();
}

const _coneFwd = new THREE.Vector3();
const _toCone  = new THREE.Vector3();
function damageBotsInCone(range, coneCos, dmg) {
  camera.getWorldDirection(_coneFwd);
  for (const bot of bots) {
    if (!bot.alive) continue;
    _toCone.subVectors(bot.group.position, camera.position);
    const dist = _toCone.length();
    if (dist > range || dist < 0.001) continue;
    _toCone.normalize();
    if (_toCone.dot(_coneFwd) < coneCos) continue;
    damageBot(bot, dmg);
  }
}

// Flame particles — small bright spheres that fly forward and fade out
const flameParticles = [];
const flameGeo = new THREE.SphereGeometry(0.12, 6, 6);
function spawnFlameParticle() {
  const flameW = weapons.flamethrower;
  if (!flameW || !flameW.muzzle) return;
  const mat = new THREE.MeshBasicMaterial({
    color: Math.random() < 0.45 ? 0xff7820 : 0xffd255,
    transparent: true, opacity: 0.9, depthWrite: false, fog: false,
  });
  const p = new THREE.Mesh(flameGeo, mat);
  flameW.muzzle.getWorldPosition(p.position);
  const fwd = new THREE.Vector3();
  camera.getWorldDirection(fwd);
  const v = fwd.clone().multiplyScalar(11 + Math.random() * 5);
  v.x += (Math.random() - 0.5) * 2.5;
  v.y += (Math.random() - 0.5) * 1.6 + 0.6;
  v.z += (Math.random() - 0.5) * 2.5;
  scene.add(p);
  flameParticles.push({ mesh: p, mat, v, age: 0, life: 0.45 + Math.random() * 0.2 });
}

function tickFlameParticles(dt) {
  for (let i = flameParticles.length - 1; i >= 0; i--) {
    const fp = flameParticles[i];
    fp.age += dt;
    if (fp.age >= fp.life) {
      scene.remove(fp.mesh);
      fp.mat.dispose();
      flameParticles.splice(i, 1);
      continue;
    }
    fp.mesh.position.x += fp.v.x * dt;
    fp.mesh.position.y += fp.v.y * dt;
    fp.mesh.position.z += fp.v.z * dt;
    fp.v.y -= 1.2 * dt; // mild gravity
    const k = fp.age / fp.life;
    fp.mesh.scale.setScalar(0.5 + k * 1.8);
    fp.mat.opacity = (1 - k) * 0.9;
  }
}

// ─── Pickups: med kit, ammo, grenade pack, flamethrower fuel ──────────────
const PICKUP_TYPES = {
  medkit: {
    name: 'ערכת עזרה', glowColor: 0x88e88a,
    radius: 1.6, respawnTime: 30,
    canPickup: () => game.alive && game.playerHP < (game.playerHPMax || 100),
    apply: () => {
      game.playerHP = Math.min(game.playerHPMax || 100, game.playerHP + 50);
      updateHPUI();
    },
    build: buildMedkitMesh,
  },
  ammo: {
    name: 'תיבת תחמושת', glowColor: 0xfff0a0,
    radius: 1.6, respawnTime: 25,
    canPickup: () => Object.values(weapons).some(w => w.conf.maxAmmo !== null && w.reserve < w.conf.reserveCap),
    apply: () => {
      // Add ~40% of each weapon's reserve cap (ammo crates refill all firearms)
      for (const id of Object.keys(weapons)) {
        const w = weapons[id];
        if (w.conf.maxAmmo === null) continue;
        const refill = Math.ceil(w.conf.reserveCap * 0.4);
        w.reserve = Math.min(w.conf.reserveCap, w.reserve + refill);
      }
      updateWeaponHUD();
    },
    build: buildAmmoCrateMesh,
  },
  grenade: {
    name: 'חבילת רימונים', glowColor: 0xff8888,
    radius: 1.6, respawnTime: 30,
    canPickup: () => grenades.count < (grenades.maxOverride || MAX_GRENADES),
    apply: () => {
      const cap = grenades.maxOverride || MAX_GRENADES;
      grenades.count = Math.min(cap, grenades.count + 3);
      updateGrenadeHUD();
    },
    build: buildGrenadePackMesh,
  },
  flame: {
    name: 'דלק להביור', glowColor: 0xffaa55,
    radius: 1.6, respawnTime: 35,
    canPickup: () => weapons.flamethrower && weapons.flamethrower.reserve < weapons.flamethrower.conf.reserveCap,
    apply: () => {
      const w = weapons.flamethrower;
      w.reserve = Math.min(w.conf.reserveCap, w.reserve + 100);
      updateWeaponHUD();
    },
    build: buildFlameCanisterMesh,
  },
};

function buildMedkitMesh() {
  const g = new THREE.Group();
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.5, 0.6), new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.6 }));
  const trim = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.16, 0.62), new THREE.MeshStandardMaterial({ color: 0x4caf50, roughness: 0.55 }));
  trim.position.y = 0.18;
  const crossH = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.08, 0.12), new THREE.MeshStandardMaterial({ color: 0xff5555 }));
  crossH.position.y = 0.27;
  const crossV = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, 0.4), new THREE.MeshStandardMaterial({ color: 0xff5555 }));
  crossV.position.y = 0.27;
  g.add(box, trim, crossH, crossV);
  return g;
}

function buildAmmoCrateMesh() {
  const g = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: 0xb6864e, roughness: 0.85 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x6e4a26 });
  const main = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.55, 0.7), wood);
  const stripeT = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.04, 0.72), dark); stripeT.position.y = 0.2;
  const stripeB = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.04, 0.72), dark); stripeB.position.y = -0.2;
  const bullet = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.18, 12), new THREE.MeshStandardMaterial({ color: 0xffd54a, metalness: 0.5 }));
  bullet.rotation.z = Math.PI / 2;
  bullet.position.y = 0.32;
  g.add(main, stripeT, stripeB, bullet);
  return g;
}

function buildGrenadePackMesh() {
  const g = new THREE.Group();
  const sash = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.16, 0.5), new THREE.MeshStandardMaterial({ color: 0x3a3a3a }));
  g.add(sash);
  const grenadeMat = new THREE.MeshStandardMaterial({ color: 0x556b2f, roughness: 0.5 });
  const stripeMat = new THREE.MeshStandardMaterial({ color: 0xc23b3b });
  const pinMat = new THREE.MeshStandardMaterial({ color: 0xc0c0c0, metalness: 0.7 });
  for (let i = -1; i <= 1; i++) {
    const grenade = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 10), grenadeMat);
    grenade.position.set(i * 0.22, 0.14, 0);
    g.add(grenade);
    const stripe = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.015, 8, 18), stripeMat);
    stripe.position.copy(grenade.position);
    stripe.rotation.x = Math.PI / 2;
    g.add(stripe);
    const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.08), pinMat);
    pin.position.set(i * 0.22, 0.26, 0);
    g.add(pin);
  }
  return g;
}

function buildFlameCanisterMesh() {
  const g = new THREE.Group();
  const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.6, 18), new THREE.MeshStandardMaterial({ color: 0xc23b3b, metalness: 0.5, roughness: 0.4 }));
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.1, 12), new THREE.MeshStandardMaterial({ color: 0x222222 }));
  cap.position.y = 0.35;
  const flame = new THREE.Mesh(new THREE.IcosahedronGeometry(0.1, 0), new THREE.MeshStandardMaterial({ color: 0xff8a30, emissive: 0xff5500, emissiveIntensity: 0.5 }));
  flame.position.set(0, 0.05, 0.23);
  g.add(tank, cap, flame);
  return g;
}

const pickups = []; // { typeKey, type, model, item, glow, basePos, respawnTimer, available }

function spawnPickupAt(typeKey, x, z) {
  const type = PICKUP_TYPES[typeKey];
  const pivot = new THREE.Group();
  const item = type.build();
  pivot.add(item);
  const glow = new THREE.Mesh(
    new THREE.SphereGeometry(0.85, 12, 10),
    new THREE.MeshBasicMaterial({ color: type.glowColor, transparent: true, opacity: 0.18, depthWrite: false, fog: false })
  );
  glow.position.y = 0.3;
  pivot.add(glow);
  pivot.position.set(x, 0.7, z);
  scene.add(pivot);
  pickups.push({
    typeKey, type, model: pivot, item, glow,
    basePos: new THREE.Vector3(x, 0.7, z),
    respawnTimer: 0, available: true,
  });
}

function spawnAllPickups() {
  for (const p of pickups) scene.remove(p.model);
  pickups.length = 0;

  const placedLocal = [];
  function placeOne() {
    for (let attempt = 0; attempt < 40; attempt++) {
      // Pickups spread across ~80% of the arena, never too close to spawn
      const x = (Math.random() - 0.5) * (ARENA * 1.6);
      const z = (Math.random() - 0.5) * (ARENA * 1.6);
      if (Math.hypot(x, z) < 8) continue;
      if (isInsideObstacle(x, z)) continue;
      let ok = true;
      for (const p of placedLocal) if (Math.hypot(p.x - x, p.z - z) < 14) { ok = false; break; }
      if (!ok) continue;
      placedLocal.push({ x, z });
      return { x, z };
    }
    return null;
  }
  // Roomier map → more pickups so the player isn't running 200m to find HP.
  const PLAN = [
    'medkit', 'medkit', 'medkit', 'medkit',
    'ammo', 'ammo', 'ammo', 'ammo', 'ammo',
    'grenade', 'grenade',
    'flame', 'flame',
  ];
  for (const k of PLAN) {
    const loc = placeOne();
    if (!loc) continue;
    spawnPickupAt(k, loc.x, loc.z);
  }
}

const _pickupTo = new THREE.Vector3();
function tickPickups(dt, time) {
  for (const p of pickups) {
    if (p.available) {
      p.model.rotation.y += dt * 1.6;
      p.model.position.y = p.basePos.y + Math.sin(time * 2 + p.basePos.x) * 0.15;
      p.glow.material.opacity = 0.15 + Math.sin(time * 3.5 + p.basePos.x) * 0.06;

      if (!game.alive) continue;
      _pickupTo.subVectors(camera.position, p.model.position);
      _pickupTo.y = 0;
      if (_pickupTo.length() < p.type.radius && p.type.canPickup()) {
        p.type.apply();
        Sfx.pickupItem();
        p.available = false;
        p.model.visible = false;
        p.respawnTimer = p.type.respawnTime;
      }
    } else {
      p.respawnTimer -= dt;
      if (p.respawnTimer <= 0) {
        p.available = true;
        p.model.visible = true;
      }
    }
  }
}

// ─── Grenades (key G to throw) + explosions ──────────────────────────────
const MAX_GRENADES = 5;
const grenades = { count: 0, thrown: [], lastThrow: -999 };
const GRENADE_THROW_COOLDOWN = 0.6;
const GRENADE_FUSE = 1.6;
const GRENADE_THROW_SPEED = 18;
const GRENADE_GRAVITY = 18;
const GRENADE_DAMAGE = 90;
const GRENADE_RADIUS = 6;

const grenadeCountEl = document.getElementById('grenadeCount');
function updateGrenadeHUD() { grenadeCountEl.textContent = grenades.count; }

function tryThrowGrenade() {
  if (!controls.isLocked || !game.alive) return;
  if (grenades.count <= 0) return;
  const t = performance.now() / 1000;
  if (t - grenades.lastThrow < GRENADE_THROW_COOLDOWN) return;
  grenades.lastThrow = t;
  grenades.count -= 1;
  updateGrenadeHUD();
  spawnThrownGrenade();
}

function spawnThrownGrenade() {
  const mesh = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.SphereGeometry(0.15, 14, 12),
    new THREE.MeshStandardMaterial({ color: 0x556b2f, roughness: 0.5 })
  );
  const stripe = new THREE.Mesh(
    new THREE.TorusGeometry(0.15, 0.02, 8, 18),
    new THREE.MeshStandardMaterial({ color: 0xc23b3b })
  );
  stripe.rotation.x = Math.PI / 2;
  mesh.add(body, stripe);

  const fwd = new THREE.Vector3();
  camera.getWorldDirection(fwd);
  const spawnPos = camera.position.clone().add(fwd.clone().multiplyScalar(0.6));
  spawnPos.y -= 0.2;
  mesh.position.copy(spawnPos);

  const v = fwd.clone().multiplyScalar(GRENADE_THROW_SPEED);
  v.y += 4;
  scene.add(mesh);
  grenades.thrown.push({ mesh, v, age: 0, fuse: GRENADE_FUSE });
}

function tickGrenades(dt) {
  for (let i = grenades.thrown.length - 1; i >= 0; i--) {
    const g = grenades.thrown[i];
    g.age += dt;
    g.v.y -= GRENADE_GRAVITY * dt;
    g.mesh.position.x += g.v.x * dt;
    g.mesh.position.y += g.v.y * dt;
    g.mesh.position.z += g.v.z * dt;
    if (g.mesh.position.y < 0.15) {
      g.mesh.position.y = 0.15;
      g.v.y = Math.abs(g.v.y) * 0.4;
      g.v.x *= 0.6; g.v.z *= 0.6;
    }
    g.mesh.rotation.x += dt * 8;
    g.mesh.rotation.z += dt * 6;
    if (g.age >= g.fuse) {
      explodeAt(g.mesh.position.clone(), GRENADE_DAMAGE, GRENADE_RADIUS);
      scene.remove(g.mesh);
      grenades.thrown.splice(i, 1);
    }
  }
}

const _grTo = new THREE.Vector3();
function explodeAt(pos, baseDamage, radius) {
  for (const bot of bots) {
    if (!bot.alive) continue;
    _grTo.subVectors(bot.group.position, pos);
    const dist = _grTo.length();
    if (dist > radius) continue;
    const falloff = 1 - (dist / radius);
    damageBot(bot, baseDamage * falloff);
  }
  // Self-damage if within blast radius (simple linear falloff)
  const playerDist = camera.position.distanceTo(pos);
  if (playerDist < radius && game.alive) {
    damagePlayer(40 * (1 - playerDist / radius));
  }
  spawnExplosionVFX(pos);
}

const explosions = [];
function spawnExplosionVFX(pos) {
  Sfx.explosion();
  const fireMat = new THREE.MeshBasicMaterial({ color: 0xffaa30, transparent: true, opacity: 0.95, depthWrite: false, fog: false });
  const fire = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), fireMat);
  fire.position.copy(pos);
  scene.add(fire);
  explosions.push({ mesh: fire, mat: fireMat, age: 0, life: 0.55, scaleEnd: 6 });
  const smokeMat = new THREE.MeshBasicMaterial({ color: 0x444444, transparent: true, opacity: 0.65, depthWrite: false, fog: false });
  const smoke = new THREE.Mesh(new THREE.SphereGeometry(1.6, 14, 10), smokeMat);
  smoke.position.copy(pos);
  scene.add(smoke);
  explosions.push({ mesh: smoke, mat: smokeMat, age: 0, life: 0.85, scaleEnd: 5 });
}

function tickExplosions(dt) {
  for (let i = explosions.length - 1; i >= 0; i--) {
    const e = explosions[i];
    e.age += dt;
    if (e.age >= e.life) {
      scene.remove(e.mesh);
      e.mat.dispose();
      explosions.splice(i, 1);
      continue;
    }
    const k = e.age / e.life;
    e.mesh.scale.setScalar(1 + k * e.scaleEnd);
    e.mat.opacity = (1 - k) * 0.95;
  }
}

function clearActiveProjectiles() {
  for (const g of grenades.thrown) scene.remove(g.mesh);
  grenades.thrown.length = 0;
  for (const e of explosions) scene.remove(e.mesh);
  explosions.length = 0;
  for (const fp of flameParticles) scene.remove(fp.mesh);
  flameParticles.length = 0;
  for (const p of projectiles) scene.remove(p.mesh);
  projectiles.length = 0;
}

const _camFwd = new THREE.Vector3();
const _toBot = new THREE.Vector3();
function swingMelee(w) {
  // Damage every alive bot in a forward cone (~60°) within sword range
  camera.getWorldDirection(_camFwd);
  _camFwd.y = 0; _camFwd.normalize();
  for (const bot of bots) {
    if (!bot.alive) continue;
    _toBot.subVectors(bot.group.position, camera.position);
    _toBot.y = 0;
    const dist = _toBot.length();
    if (dist > w.conf.range) continue;
    _toBot.normalize();
    if (_toBot.dot(_camFwd) < 0.5) continue;
    damageBot(bot, w.conf.damage);
  }
  w.swingTimer = w.conf.swingTime;
}

function reload() {
  const w = weapons[currentWeaponId];
  if (w.conf.maxAmmo === null) return;     // sword can't reload
  if (w.reloading) return;
  if (w.ammo >= w.conf.maxAmmo) return;
  if (w.reserve <= 0) return;              // no ammo in reserve to reload from
  w.reloading = true;
  Sfx.reloadClick();
  updateWeaponHUD();
  setTimeout(() => {
    if (!w.reloading) return; // canceled (e.g. weapon switched)
    const need = w.conf.maxAmmo - w.ammo;
    const take = Math.min(need, w.reserve);
    w.ammo += take;
    w.reserve -= take;
    w.reloading = false;
    updateWeaponHUD();
  }, w.conf.reloadTime * 1000);
}

document.addEventListener('mousedown', (e) => {
  if (!controls.isLocked) return;
  if (e.button === 0) {
    mouseDown = true;
    tryFire(); // immediate first shot for both semi and auto
  } else if (e.button === 2) {
    if (weapons[currentWeaponId].conf.canZoom) setZoom(true);
  }
});
document.addEventListener('mouseup', (e) => {
  if (e.button === 0) mouseDown = false;
  else if (e.button === 2) setZoom(false);
});
// Block the right-click context menu so right-click is free for zoom
document.addEventListener('contextmenu', (e) => e.preventDefault());

// Player walk state — used for weapon bob + footsteps
const playerWalk = { phase: 0, prevPhase: 0 };

function tickWeapons(dt) {
  if (fireCooldown > 0) fireCooldown = Math.max(0, fireCooldown - dt);
  const w = weapons[currentWeaponId];

  if (mouseDown && controls.isLocked && game.alive) {
    if (w.conf.fireMode === 'auto') tryFire();
    else if (w.conf.fireMode === 'continuous') tickContinuousFire(w, dt);
  }
  if (w.conf.fireMode === 'continuous' && (!mouseDown || !controls.isLocked || !game.alive) && w.muzzle) {
    w.muzzle.material.opacity = Math.max(0, (w.muzzle.material.opacity ?? 0) - dt * 6);
  }

  // Walk-bob: weapon sways while the player is on the ground and moving
  const isPlayerMoving = controls.isLocked && (keys.w || keys.a || keys.s || keys.d) && onGround && game.alive;
  const isPlayerSprinting = isPlayerMoving && keys.shift && stamina.value > 0 && !stamina.lockedOut;
  let bobX = 0, bobY = 0;
  if (isPlayerMoving) {
    playerWalk.prevPhase = playerWalk.phase;
    playerWalk.phase += dt * (isPlayerSprinting ? 14 : 9);
    const amp = isPlayerSprinting ? 0.04 : 0.025;
    bobX = Math.cos(playerWalk.phase * 0.5) * amp;
    bobY = Math.abs(Math.sin(playerWalk.phase)) * amp;
    // Trigger a footstep sound on each peak of the bob (every π of phase)
    if (Math.floor(playerWalk.phase / Math.PI) !== Math.floor(playerWalk.prevPhase / Math.PI)) {
      Sfx.footstep();
    }
  }

  // Recoil: subtract from cooldown timer + add Z kick on the model
  let recoilZ = 0;
  if (w.recoilTimer > 0) {
    w.recoilTimer = Math.max(0, w.recoilTimer - dt);
    recoilZ = (w.recoilTimer / w.conf.recoilTime) * w.conf.recoilZ;
  }
  w.model.position.set(
    w.restPos.x + bobX,
    w.restPos.y - bobY,
    w.restPos.z + recoilZ,
  );

  if (w.conf.fireMode === 'melee') {
    if (w.swingTimer > 0) {
      w.swingTimer = Math.max(0, w.swingTimer - dt);
      const t = 1 - (w.swingTimer / w.conf.swingTime);
      w.model.rotation.x = w.restRotX + Math.sin(t * Math.PI) * -w.conf.swingArc;
    } else {
      w.model.rotation.x = w.restRotX;
    }
  }
}

// ─── Projectile weapons (RPG) ────────────────────────────────────────────
const projectiles = []; // { mesh, vel, conf, age }

function fireProjectile(w) {
  if (w.conf.maxAmmo !== null) {
    w.ammo -= 1;
    updateWeaponHUD();
  }
  // Build the rocket mesh — small body + cone warhead + smoke trail spawn point
  const rocket = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x556b2f, roughness: 0.5 });
  const tipMat  = new THREE.MeshStandardMaterial({ color: 0xa0392b, roughness: 0.4, emissive: 0x441111, emissiveIntensity: 0.6 });
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.30, 12), bodyMat);
  tube.rotation.x = Math.PI / 2;
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.14, 12), tipMat);
  tip.rotation.x = -Math.PI / 2; tip.position.z = -0.20;
  // Tail flame
  const flame = new THREE.Mesh(
    new THREE.ConeGeometry(0.05, 0.12, 10),
    new THREE.MeshBasicMaterial({ color: 0xffaa30, transparent: true, opacity: 0.9 })
  );
  flame.rotation.x = Math.PI / 2; flame.position.z = 0.20;
  rocket.add(tube, tip, flame);
  // Spawn position: from the camera muzzle, in look direction
  const fwd = new THREE.Vector3();
  camera.getWorldDirection(fwd);
  rocket.position.copy(camera.position).add(fwd.clone().multiplyScalar(0.6));
  rocket.position.y -= 0.15;
  // Orient the rocket to point forward
  rocket.lookAt(rocket.position.clone().add(fwd));
  scene.add(rocket);
  projectiles.push({
    mesh: rocket,
    vel: fwd.clone().multiplyScalar(w.conf.projectileSpeed || 30),
    conf: w.conf,
    age: 0,
  });
  // Recoil + muzzle flash
  if (w.muzzle) {
    w.muzzle.material.opacity = 1;
    setTimeout(() => { w.muzzle.material.opacity = 0; }, 80);
  }
  w.recoilTimer = w.conf.recoilTime;
}

const _projTo = new THREE.Vector3();
const _projRay = new THREE.Raycaster();
function tickProjectiles(dt) {
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];
    p.age += dt;
    // Move forward
    const step = p.vel.clone().multiplyScalar(dt);
    const prev = p.mesh.position.clone();
    p.mesh.position.add(step);
    // Detect collision: raycast from prev to new along path
    _projRay.set(prev, step.clone().normalize());
    _projRay.far = step.length() + 0.1;
    const wallMeshes = colliders.map(c => c.mesh);
    const botParts = [];
    for (const b of bots) if (b.alive) for (const part of b.parts) botParts.push(part);
    const hits = _projRay.intersectObjects([...wallMeshes, ...botParts], false);
    let exploded = false;
    if (hits.length > 0) {
      _projTo.copy(hits[0].point);
      explodeAt(_projTo, p.conf.damage, p.conf.splashRadius);
      exploded = true;
    } else if (p.age > 6) {
      // Fuse — explode in air after 6 seconds so we don't leak meshes
      explodeAt(p.mesh.position.clone(), p.conf.damage, p.conf.splashRadius);
      exploded = true;
    } else if (p.mesh.position.y < 0.1) {
      explodeAt(p.mesh.position.clone(), p.conf.damage, p.conf.splashRadius);
      exploded = true;
    }
    if (exploded) {
      scene.remove(p.mesh);
      projectiles.splice(i, 1);
    }
  }
}

// ─── Destructible scenery ────────────────────────────────────────────────
// Trees, rocks and crates carry a `userData.destructible = { hp, connected }`
// payload. Each bullet impact subtracts 1 HP; on zero the mesh + every
// connected piece (leaves, sibling rocks) vanishes with a spark burst.
function damageDestructible(mesh, point, normal) {
  const d = mesh.userData.destructible;
  if (!d) return;
  d.hp -= 1;
  // Loud spark on every hit so the player can tell the block is taking damage
  spawnHitSparks(point, normal);
  if (d.hp > 0) return;
  // Final blow — remove the mesh + all connected meshes + collider
  scene.remove(mesh);
  for (const m of d.connected || []) scene.remove(m);
  // Drop from the collider list (linear scan, OK at a few hundred entries)
  for (let i = colliders.length - 1; i >= 0; i--) {
    if (colliders[i].mesh === mesh) { colliders.splice(i, 1); break; }
  }
  // Confetti burst — a few extra sparks pointing every which way
  const burstPoint = mesh.position.clone();
  for (let i = 0; i < 8; i++) {
    spawnHitSparks(burstPoint, new THREE.Vector3(
      (Math.random() - 0.5) * 2,
      0.6 + Math.random() * 0.6,
      (Math.random() - 0.5) * 2,
    ).normalize());
  }
}

// Hit sparks — small bright particles when bullets impact a wall/object
const sparks = [];
const sparkGeo = new THREE.SphereGeometry(0.04, 4, 3);
function spawnHitSparks(point, normal) {
  const count = 4 + Math.floor(Math.random() * 3);
  for (let i = 0; i < count; i++) {
    const mat = new THREE.MeshBasicMaterial({ color: 0xffe060, transparent: true, opacity: 1, depthWrite: false, fog: false });
    const m = new THREE.Mesh(sparkGeo, mat);
    m.position.copy(point);
    const v = normal.clone().multiplyScalar(1.5 + Math.random() * 2.5);
    v.x += (Math.random() - 0.5) * 4;
    v.y += (Math.random() - 0.5) * 3 + 1;
    v.z += (Math.random() - 0.5) * 4;
    scene.add(m);
    sparks.push({ mesh: m, mat, v, age: 0, life: 0.3 + Math.random() * 0.2 });
  }
}

function tickSparks(dt) {
  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i];
    s.age += dt;
    if (s.age >= s.life) { scene.remove(s.mesh); s.mat.dispose(); sparks.splice(i, 1); continue; }
    s.mesh.position.x += s.v.x * dt;
    s.mesh.position.y += s.v.y * dt;
    s.mesh.position.z += s.v.z * dt;
    s.v.y -= 8 * dt;
    s.mat.opacity = 1 - s.age / s.life;
  }
}

// ─── Player collision against the box list ────────────────────────────────
const playerBox = new THREE.Box3();
function resolveCollisions(prevPos) {
  // Build a small box around the player for AABB tests
  playerBox.setFromCenterAndSize(
    new THREE.Vector3(camera.position.x, camera.position.y - 0.85, camera.position.z),
    new THREE.Vector3(PLAYER_RADIUS * 2, 1.7, PLAYER_RADIUS * 2)
  );
  for (const c of colliders) {
    if (playerBox.intersectsBox(c.box)) {
      // simplest resolution: revert to previous position on the X/Z plane
      camera.position.x = prevPos.x;
      camera.position.z = prevPos.z;
      return;
    }
  }
}

// ─── View mode: FPS (default) ↔ third-person ─────────────────────────────
// FPS keeps the camera at eye level and renders the weapon. Third-person
// pulls the camera back along the player's view direction and shows a
// Steve-style avatar (reusing the remote-player figure) so you can see
// your own character. Toggled with V or the on-screen 👁️ button.
//
// Implementation: game logic (movement, collisions, raycasting, networking)
// always operates on the camera's "head" position. In each frame, JUST
// before composer.render(), we save the head position, move the camera
// back+up, render, and restore. Nothing else needs to know.
let viewMode = 'fps';
let localAvatar = null;
const THIRD_PERSON_BACK = 4.5;   // metres pulled back along view forward
const THIRD_PERSON_UP   = 1.2;   // metres pulled up above eye line
const TP_WALL_MARGIN    = 0.3;   // keep camera this far in front of any wall
const EYE_HEIGHT        = 1.7;   // matches camera.position.y at rest
const _tpSavedCamPos = new THREE.Vector3();
const _tpForward     = new THREE.Vector3();
const _tpToCam       = new THREE.Vector3();
const _tpCollisionRay = new THREE.Raycaster();

// ─── Held-weapon prop (third-person only) ───────────────────────────────
// A tiny box stuck to the local avatar's right hand. Color + size hint at
// which weapon you're holding without rebuilding the full FPS weapon model
// (those models include their own hands and are tuned for camera-local
// space, so reparenting them would look wrong).
const TP_WEAPON_PROPS = {
  pistol:       { w: 0.20, h: 0.14, d: 0.32, color: 0x2a2a2a },
  rifle:        { w: 0.14, h: 0.18, d: 0.85, color: 0x222222 },
  sniper:       { w: 0.14, h: 0.18, d: 1.10, color: 0x1c1c1c },
  shotgun:      { w: 0.18, h: 0.20, d: 0.70, color: 0x3a2a18 },
  flamethrower: { w: 0.20, h: 0.24, d: 0.55, color: 0x8a2a2a },
  sword:        { w: 0.08, h: 0.04, d: 0.85, color: 0xdddddd },
  rpg:          { w: 0.22, h: 0.22, d: 1.00, color: 0x3a4a2a },
  tommyGun:     { w: 0.16, h: 0.18, d: 0.70, color: 0x4a3525 },
  lightsaber:   { w: 0.08, h: 0.08, d: 1.10, color: 0x66e7ff },
  crossbow:     { w: 0.30, h: 0.16, d: 0.55, color: 0x6b4226 },
  minigun:      { w: 0.30, h: 0.30, d: 0.80, color: 0x222222 },
};

function ensureLocalAvatar() {
  if (localAvatar) return localAvatar;
  const profile = {
    name:  getMyDisplayName(),
    color: (net.profile && net.profile.color) || '#ffd54a',
    skin:  (session.user && session.user.loadout && session.user.loadout.skin) || 'classic',
  };
  // Use a sentinel peerId so this never collides with a real connection
  localAvatar = createRemoteAvatar(profile, '__local__');
  // Hide the floating name label — the player knows who they are
  if (localAvatar.label) localAvatar.label.visible = false;
  // Weapon-prop slot, placed at the local position of the right hand.
  // The right arm anchor is at (0.6, 1.0, 0) with height 0.85, so the hand
  // is at roughly (0.6, 0.58, 0). We park the slot slightly in front so
  // the weapon sticks out forward like the avatar is aiming.
  const weaponSlot = new THREE.Group();
  weaponSlot.position.set(0.6, 0.65, -0.2);
  localAvatar.group.add(weaponSlot);
  localAvatar.weaponSlot = weaponSlot;
  localAvatar.heldWeaponId = null;
  scene.add(localAvatar.group);
  updateLocalAvatarWeapon();
  return localAvatar;
}

// Tear down + recreate the local avatar — used when the skin changes so the
// new colors / cap take effect immediately. Re-attaches the weapon slot and
// resets heldWeaponId so the next updateLocalAvatarWeapon() rebuilds the prop.
function rebuildLocalAvatar() {
  if (localAvatar) {
    scene.remove(localAvatar.group);
    localAvatar = null;
  }
  // Only build it back if we're currently in 3rd person — otherwise lazy-
  // build on the next setViewMode('third-person').
  if (viewMode === 'third-person') ensureLocalAvatar();
}

// Build (or rebuild) the small proxy mesh in the local avatar's hand to
// reflect whatever the player has equipped right now. Cheap: O(1) mesh.
function updateLocalAvatarWeapon() {
  if (!localAvatar || !localAvatar.weaponSlot) return;
  const id = currentWeaponId;
  if (localAvatar.heldWeaponId === id) return;
  // Clear previous prop
  while (localAvatar.weaponSlot.children.length) {
    const child = localAvatar.weaponSlot.children[0];
    localAvatar.weaponSlot.remove(child);
    if (child.geometry) child.geometry.dispose();
    if (child.material) child.material.dispose();
  }
  const spec = TP_WEAPON_PROPS[id];
  if (spec) {
    const mat = new THREE.MeshLambertMaterial({ color: spec.color });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(spec.w, spec.h, spec.d), mat);
    // Box centered on its origin → shift forward so it sticks OUT of the hand
    mesh.position.set(0, 0, -spec.d / 2);
    mesh.castShadow = true;
    localAvatar.weaponSlot.add(mesh);
  }
  localAvatar.heldWeaponId = id;
}

function setViewMode(mode) {
  if (mode !== 'fps' && mode !== 'third-person') mode = 'fps';
  viewMode = mode;
  // The weapon is attached to the camera; in 3rd person it'd float behind
  // the player's avatar. Hide it for now (a future pass can put it in the
  // avatar's hand).
  if (weapons[currentWeaponId]) {
    weapons[currentWeaponId].model.visible = (mode === 'fps');
  }
  if (mode === 'third-person') {
    ensureLocalAvatar();
    localAvatar.group.visible = true;
  } else if (localAvatar) {
    localAvatar.group.visible = false;
  }
  // Reflect on the toggle button
  const btn = document.getElementById('viewBtn');
  if (btn) {
    btn.textContent = (mode === 'third-person') ? '🎥' : '👁️';
    btn.classList.toggle('tp', mode === 'third-person');
    btn.title = (mode === 'third-person') ? 'מבט גוף שלישי (V)' : 'מבט גוף ראשון (V)';
  }
  try { localStorage.setItem('fps_view_mode', mode); } catch {}
}

function toggleViewMode() {
  setViewMode(viewMode === 'fps' ? 'third-person' : 'fps');
}

// Restore preference on boot — but only AFTER weapons + setWeapon ran above
try {
  const saved = localStorage.getItem('fps_view_mode');
  if (saved === 'third-person') setViewMode('third-person');
} catch {}

// V key toggles. Don't fire on key-repeat — one tap per toggle.
document.addEventListener('keydown', (e) => {
  if (e.code === 'KeyV' && !e.repeat) toggleViewMode();
});

// On-screen button (touch + click)
{
  const btn = document.getElementById('viewBtn');
  if (btn) {
    const handler = (e) => { e.stopPropagation(); e.preventDefault(); toggleViewMode(); };
    btn.addEventListener('click', handler);
    btn.addEventListener('touchstart', handler, { passive: false });
  }
}

// ─── Main loop ────────────────────────────────────────────────────────────
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1); // cap dt to avoid huge jumps

  if (controls.isLocked) {
    // Direction relative to look
    direction.z = Number(keys.w) - Number(keys.s);
    direction.x = Number(keys.d) - Number(keys.a);
    direction.normalize();

    const isMoving = keys.w || keys.a || keys.s || keys.d;
    // Sprint only while actually moving and we have stamina (and haven't fully drained)
    const isSprinting = keys.shift && isMoving && stamina.value > 0 && !stamina.lockedOut;
    const speedMult = isSprinting ? SPRINT_MULTIPLIER : 1;

    // Stamina drain / regen — cap honours the staminaBoost perk
    const staminaCap = game.staminaMax || STAMINA_MAX;
    if (isSprinting) {
      stamina.value = Math.max(0, stamina.value - STAMINA_DRAIN_PER_SEC * dt);
      stamina.regenCooldown = STAMINA_REGEN_DELAY;
      if (stamina.value === 0) stamina.lockedOut = true;
    } else {
      if (stamina.regenCooldown > 0) {
        stamina.regenCooldown = Math.max(0, stamina.regenCooldown - dt);
      } else {
        stamina.value = Math.min(staminaCap, stamina.value + STAMINA_REGEN_PER_SEC * dt);
      }
      if (stamina.lockedOut && stamina.value > 25) stamina.lockedOut = false;
    }

    // Update stamina UI (color shifts when low / empty)
    const staminaPct = (stamina.value / staminaCap) * 100;
    staminaFillEl.style.width = staminaPct + '%';
    staminaTextEl.textContent = Math.round(stamina.value);
    staminaWrapEl.classList.toggle('low', stamina.value < (staminaCap * 0.35) && stamina.value > 0);
    staminaWrapEl.classList.toggle('empty', stamina.value === 0 || stamina.lockedOut);

    // Damping (friction) on horizontal velocity
    velocity.x -= velocity.x * 8.0 * dt;
    velocity.z -= velocity.z * 8.0 * dt;

    if (keys.w || keys.s) velocity.z -= direction.z * PLAYER_SPEED * speedMult * dt;
    if (keys.a || keys.d) velocity.x -= direction.x * PLAYER_SPEED * speedMult * dt;

    // Gravity
    velocity.y -= GRAVITY * dt;

    // Jump
    if (keys.space && onGround) {
      velocity.y = JUMP_VELOCITY;
      onGround = false;
    }

    const prev = camera.position.clone();

    controls.moveRight(-velocity.x * dt);
    controls.moveForward(-velocity.z * dt);
    camera.position.y += velocity.y * dt;

    // Floor
    if (camera.position.y < 1.7) {
      camera.position.y = 1.7;
      velocity.y = 0;
      onGround = true;
    }

    resolveCollisions(prev);
  }

  if (game.alive) updateBots(dt);
  tickDyingBots(dt);

  tickTouchInput();
  tickWeapons(dt);
  tickFlameParticles(dt);
  tickGrenades(dt);
  tickProjectiles(dt);
  tickExplosions(dt);
  tickSparks(dt);
  tickPickups(dt, clock.elapsedTime);
  tickNetSync(dt);
  tickDayCycle(dt);
  tickWeather(dt);

  // Spin the minigun barrels while the player is firing it
  const wep = weapons[currentWeaponId];
  if (wep && wep.conf.id === 'minigun' && wep.model.userData.barrelGroup) {
    const isShooting = mouseDown && controls.isLocked && game.alive && wep.ammo > 0;
    wep.model.userData.barrelGroup.rotation.z += (isShooting ? 18 : 0) * dt;
  }

  // Shadow camera target follows the player so the small shadow frustum
  // stays centred. The sun's actual XY position is set by tickDayCycle so
  // shadows arrive from wherever the sun is in the sky.
  sun.target.position.set(camera.position.x, 0, camera.position.z);
  sun.target.updateMatrixWorld();

  // Toggle the `in-game` body class so CSS can hide the gameplay HUD whenever
  // any menu overlay is open. classList.toggle with an explicit boolean is
  // idempotent — cheap to call every frame.
  const isMenuOpen = (el) => el && !el.classList.contains('hidden');
  const menuOpen =
    isMenuOpen(_menuEls.start)    ||
    isMenuOpen(_menuEls.auth)     ||
    isMenuOpen(_menuEls.gameOver) ||
    isMenuOpen(_menuEls.victory)  ||
    isMenuOpen(_menuEls.admin);
  document.body.classList.toggle('in-game', !menuOpen);

  // ─── 3rd-person render trick ───────────────────────────────────────────
  // Game logic above used `camera.position` as the player's HEAD. We now
  // (optionally) move the camera back+up just for this render so the
  // player sees their own avatar. After render we restore so next frame's
  // logic keeps operating on the head position.
  let _tpActive = false;
  if (viewMode === 'third-person' && localAvatar && controls.isLocked && game.alive) {
    localAvatar.group.visible = true;
    // Place avatar at the player's feet, facing the same way as the camera.
    // EYE_HEIGHT subtracts so feet land on the ground when standing.
    localAvatar.group.position.set(
      camera.position.x,
      camera.position.y - EYE_HEIGHT,
      camera.position.z
    );
    // ─── Where do we WANT the camera to be? ───────────────────────────
    camera.getWorldDirection(_tpForward);  // unit vector in world space
    // Yaw the avatar to match the camera's horizontal facing. We compute
    // yaw from the world-space forward vector (ignoring its y component)
    // because camera.rotation.y is NOT a clean yaw when pitch is non-zero
    // — Three.js applies rotations in XYZ order by default, so the Y
    // rotation is taken IN the pitched frame and the avatar would lean
    // when the player looked up or down.
    localAvatar.group.rotation.y = Math.atan2(-_tpForward.x, -_tpForward.z);
    // Make sure the held weapon prop matches the equipped weapon
    updateLocalAvatarWeapon();
    _tpSavedCamPos.copy(camera.position);
    const wantX = camera.position.x - _tpForward.x * THIRD_PERSON_BACK;
    const wantY = camera.position.y - _tpForward.y * THIRD_PERSON_BACK + THIRD_PERSON_UP;
    const wantZ = camera.position.z - _tpForward.z * THIRD_PERSON_BACK;
    // ─── Camera wall collision ────────────────────────────────────────
    // Raycast from head to wanted position. If a wall is in the way,
    // pull the camera up SHORT of it so we don't clip through scenery.
    _tpToCam.set(wantX - camera.position.x, wantY - camera.position.y, wantZ - camera.position.z);
    const wantedDist = _tpToCam.length();
    _tpToCam.normalize();
    _tpCollisionRay.set(camera.position, _tpToCam);
    _tpCollisionRay.far = wantedDist + TP_WALL_MARGIN;
    const wallMeshes = colliders.map(c => c.mesh);
    const hits = _tpCollisionRay.intersectObjects(wallMeshes, false);
    let finalDist = wantedDist;
    if (hits.length > 0) {
      // Stop short of the wall by TP_WALL_MARGIN. Min distance prevents
      // the camera from sitting INSIDE the avatar if a wall is hugging us.
      finalDist = Math.max(0.4, hits[0].distance - TP_WALL_MARGIN);
    }
    camera.position.x += _tpToCam.x * finalDist;
    camera.position.y += _tpToCam.y * finalDist;
    camera.position.z += _tpToCam.z * finalDist;
    _tpActive = true;
  } else if (localAvatar) {
    // Hide the avatar in FPS mode (or while paused / dead)
    localAvatar.group.visible = (viewMode === 'third-person');
  }

  composer.render();

  if (_tpActive) camera.position.copy(_tpSavedCamPos);
}

animate();

// ─── User accounts (login / register / guest, stats, loadout) ─────────────
let session = {
  user: Auth.getCurrentUser(),  // synchronous: returns the cached user (or null)
  guest: false,
  guestFavorite: 'pistol',
};

// On boot, ask the server "is my saved token still valid?" — if yes, refresh
// our cached user (stats may have updated remotely); if no, drop the cache.
Auth.tryRestoreSession().then(user => {
  session.user = user;
  if (user) {
    showMainOverlay();
    updateOverlayUserUI();
  }
}).catch(() => {});

const authOverlayEl = document.getElementById('authOverlay');
const userBarEl = document.getElementById('userName');
const userStatsEl = document.getElementById('userStats');
const statsKillsEl = document.getElementById('statsKills');
const statsVictoriesEl = document.getElementById('statsVictories');
const statsDeathsEl = document.getElementById('statsDeaths');
const authErrorEl = document.getElementById('authError');
const authUsernameEl = document.getElementById('authUsername');
const authPasswordEl = document.getElementById('authPassword');

function getEffectiveFavorite() {
  if (session.user) {
    const fav = session.user.loadout.favoriteWeapon;
    return weapons[fav] ? fav : 'pistol';
  }
  return weapons[session.guestFavorite] ? session.guestFavorite : 'pistol';
}

function refreshSessionUser() {
  // Re-read from storage so stats panel reflects the latest persisted values
  if (!session.guest) session.user = Auth.getCurrentUser();
  updateOverlayUserUI();
}

function updateOverlayUserUI() {
  const adminBadge = document.getElementById('adminBadge');
  const adminBtn = document.getElementById('adminBtn');
  const shopBtn = document.getElementById('shopBtn');
  const challengesBtn = document.getElementById('challengesBtn');
  const achievementsBtn = document.getElementById('achievementsBtn');
  const userCoinsEl = document.getElementById('userCoins');
  if (session.user) {
    userBarEl.textContent = session.user.name;
    statsKillsEl.textContent = session.user.stats.kills;
    statsVictoriesEl.textContent = session.user.stats.victories;
    statsDeathsEl.textContent = session.user.stats.deaths;
    userStatsEl.style.display = '';
    adminBadge.classList.toggle('hidden', !session.user.isAdmin);
    adminBtn.classList.toggle('hidden', !session.user.isAdmin);
    // Coin pill + shop / challenges / achievements buttons are logged-in only
    userCoinsEl.textContent = '💰 ' + (session.user.stats.coins || 0);
    userCoinsEl.classList.remove('hidden');
    shopBtn.classList.remove('hidden');
    if (challengesBtn)   challengesBtn.classList.remove('hidden');
    if (achievementsBtn) achievementsBtn.classList.remove('hidden');
  } else {
    userBarEl.textContent = 'אורח';
    userStatsEl.style.display = 'none';
    adminBadge.classList.add('hidden');
    adminBtn.classList.add('hidden');
    userCoinsEl.classList.add('hidden');
    shopBtn.classList.add('hidden');
    if (challengesBtn)   challengesBtn.classList.add('hidden');
    if (achievementsBtn) achievementsBtn.classList.add('hidden');
  }
  // Show / hide shop-weapon loadout buttons based on ownership
  document.querySelectorAll('#overlay .loadout-picks button[data-shop]').forEach(b => {
    b.classList.toggle('hidden', !playerOwns(b.dataset.shop));
  });
  // Show / hide shop-weapon row slots based on ownership (in-game HUD)
  document.querySelectorAll('#weaponRow .slot[data-shop]').forEach(slot => {
    slot.classList.toggle('hidden', !playerOwns(slot.dataset.shop));
  });
  // Highlight the favorite weapon button
  const fav = getEffectiveFavorite();
  document.querySelectorAll('#overlay .loadout-picks button[data-fav]').forEach(b => {
    b.classList.toggle('fav', b.dataset.fav === fav);
  });
  // Skin picker: show only owned skins, highlight active
  const activeSkin =
    (session.user && session.user.loadout && session.user.loadout.skin) ||
    (session.guestSkin || 'classic');
  document.querySelectorAll('#overlay #skinPicks button[data-skin]').forEach(b => {
    const id = b.dataset.skin;
    if (b.classList.contains('skin-locked')) {
      b.classList.toggle('hidden', !playerOwns(id));
    }
    b.classList.toggle('active', id === activeSkin);
  });
}

// In-game coin counter
const coinHudEl    = document.getElementById('coinHud');
const coinTotalEl  = document.getElementById('coinTotal');
const coinFlashEl  = document.getElementById('coinFlash');
let _coinFlashTimer = 0;

// ─── Shop UI ─────────────────────────────────────────────────────────────
const shopPanelEl = document.getElementById('shopPanel');
const shopGridEl  = document.getElementById('shopGrid');
const shopBalanceEl = document.getElementById('shopBalance');
const shopErrorEl   = document.getElementById('shopError');

document.getElementById('shopBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  if (!session.user) return;
  openShop();
});
document.getElementById('shopCloseBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  shopPanelEl.classList.add('hidden');
});

function openShop() {
  shopPanelEl.classList.remove('hidden');
  shopErrorEl.innerHTML = '&nbsp;';
  renderShop();
}

function renderShop() {
  if (!session.user) return;
  const coins = session.user.stats.coins || 0;
  shopBalanceEl.textContent = coins;
  shopGridEl.innerHTML = '';
  for (const id of SHOP_ORDER) {
    const item = SHOP_ITEMS[id];
    if (!item) continue;
    const owned = isOwned(session.user, id);
    const tooPoor = !owned && coins < item.cost;
    const card = document.createElement('div');
    card.className = 'shop-card' + (owned ? ' owned' : '') + (tooPoor ? ' too-poor' : '');
    card.innerHTML = `
      <div class="kind kind-${item.kind}">${item.kind === 'weapon' ? '🗡️ נשק חדש' : item.kind === 'attach' ? '🔧 אביזר לנשק קיים' : '✨ שדרוג'}</div>
      <div class="icon">${item.icon}</div>
      <div class="name">${item.name}</div>
      <div class="desc">${item.description}</div>
      <div class="cost">💰 ${item.cost}</div>
    `;
    const btn = document.createElement('button');
    btn.textContent = owned ? '✓ ברשותך' : (tooPoor ? '🔒 חסרים מטבעות' : 'קנה');
    if (!owned && !tooPoor) {
      btn.onclick = async () => {
        shopErrorEl.innerHTML = '&nbsp;';
        btn.disabled = true; btn.textContent = 'קונה...';
        try {
          session.user = await Auth.buyItem(id);
          renderShop();
          updateOverlayUserUI();
          updateCoinHUD();
        } catch (err) {
          shopErrorEl.textContent = err.message || 'הקנייה נכשלה';
          btn.disabled = false; btn.textContent = 'קנה';
        }
      };
    }
    card.appendChild(btn);
    shopGridEl.appendChild(card);
  }
}

function updateCoinHUD() {
  if (!coinTotalEl) return;
  const coins = session.user ? (session.user.stats.coins || 0) : 0;
  coinTotalEl.textContent = coins;
}

function flashCoinReward(amount) {
  if (!coinFlashEl || !coinHudEl) return;
  coinFlashEl.textContent = '+' + amount;
  coinHudEl.classList.add('flashing');
  clearTimeout(_coinFlashTimer);
  _coinFlashTimer = setTimeout(() => coinHudEl.classList.remove('flashing'), 600);
}

function showAuthScreen() {
  authOverlayEl.classList.remove('hidden');
  overlay.classList.add('hidden');
  gameOverEl.classList.add('hidden');
  victoryEl.classList.add('hidden');
}
function showMainOverlay() {
  authOverlayEl.classList.add('hidden');
  overlay.classList.remove('hidden');
}

function clearAuthError() { authErrorEl.innerHTML = '&nbsp;'; }
function setAuthError(msg) { authErrorEl.textContent = msg; }

document.getElementById('loginBtn').addEventListener('click', async () => {
  clearAuthError();
  try {
    session.user = await Auth.login(authUsernameEl.value, authPasswordEl.value);
    session.guest = false;
    authPasswordEl.value = '';
    showMainOverlay();
    updateOverlayUserUI();
  } catch (e) { setAuthError(e.message); }
});

document.getElementById('registerBtn').addEventListener('click', async () => {
  clearAuthError();
  try {
    session.user = await Auth.register(authUsernameEl.value, authPasswordEl.value);
    session.guest = false;
    authPasswordEl.value = '';
    showMainOverlay();
    updateOverlayUserUI();
  } catch (e) { setAuthError(e.message); }
});

document.getElementById('guestBtn').addEventListener('click', () => {
  clearAuthError();
  session.user = null;
  session.guest = true;
  authPasswordEl.value = '';
  showMainOverlay();
  updateOverlayUserUI();
});

// Submit form on Enter — defaults to login (or register if username unknown)
[authUsernameEl, authPasswordEl].forEach(el => {
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    document.getElementById('loginBtn').click();
  });
});

document.getElementById('logoutBtn').addEventListener('click', () => {
  if (session.user) Auth.logout();
  session.user = null;
  session.guest = false;
  showAuthScreen();
});

// ─── B1: Global leaderboard ──────────────────────────────────────────────
const leaderboardPanelEl = document.getElementById('leaderboardPanel');
const leaderboardListEl  = document.getElementById('leaderboardList');
let _lbCurrentSort = 'kills';

document.getElementById('leaderboardBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  openLeaderboard();
});
document.getElementById('leaderboardCloseBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  leaderboardPanelEl.classList.add('hidden');
});
document.querySelectorAll('#leaderboardPanel .lb-tab').forEach(tab => {
  tab.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('#leaderboardPanel .lb-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    _lbCurrentSort = tab.dataset.sort;
    renderLeaderboard();
  });
});

async function openLeaderboard() {
  leaderboardPanelEl.classList.remove('hidden');
  leaderboardListEl.innerHTML = '<div style="text-align:center;opacity:0.6">טוען...</div>';
  await renderLeaderboard();
}

async function renderLeaderboard() {
  try {
    const players = await Auth.fetchLeaderboard(_lbCurrentSort);
    leaderboardListEl.innerHTML = '';
    const myName = session.user ? session.user.name : null;
    const valueField = {
      kills: 'kills', victories: 'victories', coins: 'coins', pvp_elo: 'pvpElo',
    }[_lbCurrentSort];
    players.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'lb-row' + (p.name === myName ? ' me' : '');
      const rankClass = i === 0 ? 'rank gold' : i === 1 ? 'rank silver' : i === 2 ? 'rank bronze' : 'rank';
      row.innerHTML = `
        <span class="${rankClass}">#${i + 1}</span>
        <span class="name">${escapeHtml(p.name)}${p.isAdmin ? ' ⭐' : ''}</span>
        <span class="value">${p[valueField] ?? 0}</span>
      `;
      leaderboardListEl.appendChild(row);
    });
    if (players.length === 0) {
      leaderboardListEl.innerHTML = '<div style="text-align:center;opacity:0.6">אין שחקנים</div>';
    }
  } catch (err) {
    leaderboardListEl.innerHTML = `<div style="color:#ff7b6b;text-align:center">שגיאה: ${err.message || err}</div>`;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// ─── B2: Daily challenges ────────────────────────────────────────────────
const challengesPanelEl = document.getElementById('challengesPanel');
const challengesListEl  = document.getElementById('challengesList');
const challengesErrorEl = document.getElementById('challengesError');

document.getElementById('challengesBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  if (!session.user) return;
  openChallenges();
});
document.getElementById('challengesCloseBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  challengesPanelEl.classList.add('hidden');
});

async function openChallenges() {
  challengesPanelEl.classList.remove('hidden');
  challengesErrorEl.innerHTML = '&nbsp;';
  challengesListEl.innerHTML = '<div style="text-align:center;opacity:0.6">טוען...</div>';
  try {
    const challenges = await Auth.fetchDailyChallenges();
    renderChallenges(challenges);
  } catch (err) {
    challengesErrorEl.textContent = err.message || 'שגיאה';
    challengesListEl.innerHTML = '';
  }
}

function renderChallenges(challenges) {
  challengesListEl.innerHTML = '';
  for (const c of challenges.list) {
    const done = c.progress >= c.target;
    const card = document.createElement('div');
    card.className = 'ch-card' + (done ? ' done' : '') + (c.claimed ? ' claimed' : '');
    const pct = Math.min(100, (c.progress / c.target) * 100);
    card.innerHTML = `
      <div class="row">
        <span class="label">${escapeHtml(c.label)}</span>
        <span class="reward">💰 ${c.reward}</span>
      </div>
      <div class="bar"><div class="fill" style="width:${pct}%"></div></div>
      <div class="row">
        <span class="progress">${c.progress} / ${c.target}</span>
      </div>
    `;
    const btn = document.createElement('button');
    if (c.claimed) {
      btn.textContent = '✓ נדרשה'; btn.disabled = true;
    } else if (done) {
      btn.textContent = '🎁 קח פרס';
      btn.onclick = async () => {
        challengesErrorEl.innerHTML = '&nbsp;';
        btn.disabled = true; btn.textContent = 'מקבל...';
        try {
          const result = await Auth.claimChallenge(c.id);
          renderChallenges(result.challenges);
          updateOverlayUserUI();
          updateCoinHUD();
        } catch (err) {
          challengesErrorEl.textContent = err.message || 'הקבלה נכשלה';
          btn.disabled = false; btn.textContent = '🎁 קח פרס';
        }
      };
    } else {
      btn.textContent = '🔒 לא הושלם'; btn.disabled = true;
    }
    card.appendChild(btn);
    challengesListEl.appendChild(card);
  }
}

// ─── B3: Achievements ────────────────────────────────────────────────────
const achievementsPanelEl   = document.getElementById('achievementsPanel');
const achievementsGridEl    = document.getElementById('achievementsGrid');
const achievementsSummaryEl = document.getElementById('achievementsSummary');

document.getElementById('achievementsBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  if (!session.user) return;
  openAchievements();
});
document.getElementById('achievementsCloseBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  achievementsPanelEl.classList.add('hidden');
});

const ACHIEVEMENT_ICONS = {
  first_blood: '🩸', killer_25: '🎯', killer_100: '💀', killer_500: '☠️', killer_1000: '👹',
  first_win: '🏁', winner_10: '🏆', winner_50: '👑',
  coin_hoarder: '💰', rich: '💎',
  veteran: '🎖️',
  pvp_starter: '⚔️', pvp_master: '🗡️',
};

async function openAchievements() {
  achievementsPanelEl.classList.remove('hidden');
  achievementsGridEl.innerHTML = '<div style="text-align:center;opacity:0.6">טוען...</div>';
  achievementsSummaryEl.textContent = '';
  try {
    const data = await Auth.fetchAchievements();
    achievementsSummaryEl.textContent = `פתחת ${data.unlockedCount} מתוך ${data.total}`;
    achievementsGridEl.innerHTML = '';
    for (const a of data.achievements) {
      const card = document.createElement('div');
      card.className = 'ach-card' + (a.unlocked ? ' unlocked' : '');
      card.innerHTML = `
        <div class="icon">${ACHIEVEMENT_ICONS[a.id] || (a.unlocked ? '🏆' : '🔒')}</div>
        <div class="name">${escapeHtml(a.name)}</div>
        <div class="desc">${escapeHtml(a.description)}</div>
      `;
      achievementsGridEl.appendChild(card);
    }
  } catch (err) {
    achievementsGridEl.innerHTML = `<div style="color:#ff7b6b;text-align:center">שגיאה: ${err.message || err}</div>`;
  }
}

// ─── Admin panel ──────────────────────────────────────────────────────────
const adminPanelEl = document.getElementById('adminPanel');
const adminUsersGridEl = document.getElementById('adminUsersGrid');
const adminSummaryEl = document.getElementById('adminSummary');
const adminErrorEl = document.getElementById('adminError');

document.getElementById('adminBtn').addEventListener('click', async (e) => {
  e.stopPropagation();
  if (!session.user || !session.user.isAdmin) return;
  await openAdminPanel();
});
document.getElementById('adminCloseBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  adminPanelEl.classList.add('hidden');
});

async function openAdminPanel() {
  adminPanelEl.classList.remove('hidden');
  adminErrorEl.innerHTML = '&nbsp;';
  adminUsersGridEl.innerHTML = '';
  adminSummaryEl.textContent = 'טוען רשימת משתמשים...';
  try {
    const users = await Auth.listAllUsers();
    renderAdminUsers(users);
  } catch (err) {
    adminErrorEl.textContent = err.message || 'שגיאה בטעינה';
    adminSummaryEl.textContent = '';
  }
}

function renderAdminUsers(users) {
  adminSummaryEl.textContent =
    `סה"כ ${users.length} משתמשים · ` +
    `${users.filter(u => u.isAdmin).length} מנהלים · ` +
    `${users.filter(u => u.isDisabled).length} מושבתים`;
  adminUsersGridEl.innerHTML = '';
  for (const u of users) {
    const isMe = session.user && u.id === session.user.id;
    const card = document.createElement('div');
    card.className = 'user-card' + (u.isDisabled ? ' disabled' : '') + (u.isAdmin ? ' admin' : '');
    const lastLogin = u.lastLogin ? new Date(u.lastLogin).toLocaleString('he-IL') : '—';
    const created = u.createdAt ? new Date(u.createdAt).toLocaleDateString('he-IL') : '—';
    card.innerHTML = `
      <div class="row">
        <span class="name" title="${u.name}">${u.name}${isMe ? ' (אני)' : ''}</span>
        <span class="meta">${u.isAdmin ? '⭐ Admin' : ''} ${u.isDisabled ? '🚫 מושבת' : ''}</span>
      </div>
      <div class="meta">נרשם: ${created} · התחבר לאחרונה: ${lastLogin}</div>
      <div class="stats">
        <span>🎯 ${u.stats.kills}</span>
        <span>🏆 ${u.stats.victories}</span>
        <span>💀 ${u.stats.deaths}</span>
        <span>🎮 ${u.stats.gamesPlayed}</span>
        <span>💰 ${u.stats.coins ?? 0}</span>
      </div>
      <div class="actions"></div>
    `;
    const actionsEl = card.querySelector('.actions');
    // 💰 Grant coins — allowed on YOURSELF too (admins often want to top up
    // their own account for testing). The server clamps at 0 so subtracting
    // too much can't go negative.
    const grantCoins = document.createElement('button');
    grantCoins.className = 'coins';
    grantCoins.textContent = '💰 הוסף כסף';
    grantCoins.onclick = async () => {
      const raw = prompt(`כמה מטבעות להוסיף ל-${u.name}?\n(מספר חיובי = להוסיף, שלילי = להוריד)`, '100');
      if (raw == null) return;
      const amount = parseInt(raw, 10);
      if (!Number.isFinite(amount) || amount === 0) {
        adminErrorEl.textContent = 'יש להזין מספר שלם שונה מאפס';
        return;
      }
      await adminAction(() => Auth.adminGrantCoins(u.id, amount));
    };
    actionsEl.appendChild(grantCoins);

    if (!isMe) {
      const toggleDisable = document.createElement('button');
      toggleDisable.textContent = u.isDisabled ? 'הפעל' : 'השבת';
      toggleDisable.onclick = () => adminAction(u.isDisabled ? Auth.enableUser : Auth.disableUser, u.id);
      actionsEl.appendChild(toggleDisable);

      const togglePromote = document.createElement('button');
      togglePromote.className = 'promote';
      togglePromote.textContent = u.isAdmin ? 'הורד מ-Admin' : 'הפוך ל-Admin';
      togglePromote.onclick = () => adminAction(u.isAdmin ? Auth.demoteUser : Auth.promoteUser, u.id);
      actionsEl.appendChild(togglePromote);

      const del = document.createElement('button');
      del.className = 'danger';
      del.textContent = '🗑️ מחק';
      del.onclick = async () => {
        if (!confirm(`למחוק את ${u.name} לצמיתות?`)) return;
        await adminAction(Auth.deleteUser, u.id);
      };
      actionsEl.appendChild(del);
    } else {
      const note = document.createElement('span');
      note.className = 'meta';
      note.textContent = '(שאר הפעולות לא ניתנות על עצמך)';
      actionsEl.appendChild(note);
    }
    adminUsersGridEl.appendChild(card);
  }
}

async function adminAction(fn, userId) {
  adminErrorEl.innerHTML = '&nbsp;';
  try {
    await fn(userId);
    const users = await Auth.listAllUsers();
    renderAdminUsers(users);
    // If the action might've touched our own row (e.g. self-grant coins),
    // refresh session.user so the HUD coin pill updates immediately.
    await Auth.tryRestoreSession();
    updateOverlayUserUI();
  } catch (err) {
    adminErrorEl.textContent = err.message || 'הפעולה נכשלה';
  }
}

// Favorite weapon picker
document.querySelectorAll('#overlay .loadout-picks button[data-fav]').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const id = btn.dataset.fav;
    if (!weapons[id]) return;
    if (session.user) {
      Auth.setFavoriteWeapon(id);
      session.user.loadout.favoriteWeapon = id;
    } else {
      session.guestFavorite = id;
    }
    updateOverlayUserUI();
  });
});

// Skin picker — same flow as favorite weapon, plus rebuild the local avatar
// so the 3rd-person view updates instantly, and re-sync the net profile so
// peers see the new look.
document.querySelectorAll('#overlay #skinPicks button[data-skin]').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const id = btn.dataset.skin;
    if (!SKINS[id]) return;
    // Block locked skins (the button is also hidden, but defensive)
    if (id !== 'classic' && !playerOwns(id)) return;
    if (session.user) {
      session.user.loadout = session.user.loadout || {};
      session.user.loadout.skin = id;
      Auth.setActiveSkin(id);
    } else {
      // Guests can pick classic only (other buttons stay hidden for them).
      session.guestSkin = id;
    }
    updateOverlayUserUI();
    rebuildLocalAvatar();
    // Re-sync to peers so the new look propagates if we're in a room
    if (net.isConnected()) {
      syncProfileToNet();
      net.broadcast({ type: 'profile-update', profile: net.profile });
    }
  });
});

// Initial screen: if logged in already → straight to main overlay; else auth
if (session.user) {
  showMainOverlay();
  updateOverlayUserUI();
} else {
  showAuthScreen();
}

console.log('FPS Stage 4 ready — login or play as guest.');

// ─── Multiplayer (PeerJS) ────────────────────────────────────────────────
const PLAYER_COLORS = ['#ff6b35', '#4ac1ff', '#b46cff', '#52d97e'];
// Tracks the host's currently selected room mode (read by startGame). Solo
// players use the default 'bots'.
let currentHostMode = 'bots';
// C: which map theme the player picked in the overlay. The host's pick is
// broadcast to clients as part of `start-game`.
let selectedMapTheme = DEFAULT_THEME;
// `remotePlayers` map (peerId → avatar) was forward-declared above so the
// animation loop could safely reference it before this block initialises.

const hostBtn = document.getElementById('hostBtn');
const hostStartRow = document.getElementById('hostStartRow');
const hostRoomRow = document.getElementById('hostRoomRow');
const hostCodeEl = document.getElementById('hostCode');
const hostLeaveBtn = document.getElementById('hostLeaveBtn');
const hostPlayerList = document.getElementById('hostPlayerList');
const hostStatusEl = document.getElementById('hostStatus');

const joinCodeInput = document.getElementById('joinCode');
const joinBtn = document.getElementById('joinBtn');
const joinFormRow = document.getElementById('joinFormRow');
const joinedRow = document.getElementById('joinedRow');
const joinedCodeEl = document.getElementById('joinedCode');
const clientLeaveBtn = document.getElementById('clientLeaveBtn');
const clientPlayerList = document.getElementById('clientPlayerList');
const joinStatusEl = document.getElementById('joinStatus');

const waitingForHostEl = document.getElementById('waitingForHost');

function getMyDisplayName() {
  if (session.user) return session.user.name;
  if (session.guest) return 'אורח';
  return 'שחקן';
}

function pickPlayerColor() {
  // Pick first color not used by an already-connected peer
  const used = new Set();
  for (const peerId of net.getPeers()) {
    const p = net.getPeerProfile(peerId);
    if (p && p.color) used.add(p.color);
  }
  for (const c of PLAYER_COLORS) if (!used.has(c)) return c;
  return PLAYER_COLORS[0];
}

function syncProfileToNet() {
  net.setProfile({
    name: getMyDisplayName(),
    color: pickPlayerColor(),
    fav: getEffectiveFavorite(),
    // B4: PvP-ELO needs the server-side user id so the shooter can call
    // /api/me/pvp-kill with the right target. Guests have no id → null.
    userId: session.user ? session.user.id : null,
    // Cosmetic skin — other players will see this on our avatar.
    skin: (session.user && session.user.loadout && session.user.loadout.skin) || 'classic',
  });
}

// Tab switching
overlay.querySelectorAll('.mp-tab').forEach(tab => {
  tab.addEventListener('click', e => {
    e.stopPropagation();
    overlay.querySelectorAll('.mp-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    overlay.querySelectorAll('.mp-panel').forEach(p => p.classList.toggle('hidden', p.dataset.panel !== tab.dataset.mp));
  });
});

// Host mode radio buttons
document.querySelectorAll('input[name="hostMode"]').forEach(input => {
  input.addEventListener('change', () => {
    if (input.checked) currentHostMode = input.value;
  });
});

// C: map picker — clicking a tile sets the active theme. Only the host's
// pick matters in multiplayer; client picks are overridden by the start-game
// broadcast.
document.querySelectorAll('#mapPicks button[data-map]').forEach(btn => {
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const key = btn.dataset.map;
    if (!MAP_THEMES[key]) return;
    selectedMapTheme = key;
    document.querySelectorAll('#mapPicks button[data-map]').forEach(b => {
      b.classList.toggle('active', b === btn);
    });
  });
});

hostBtn.addEventListener('click', async (e) => {
  e.stopPropagation();
  hostStatusEl.textContent = 'יוצר חדר...';
  hostStatusEl.className = 'status';
  try {
    syncProfileToNet();
    const code = await net.host();
    hostCodeEl.textContent = code;
    hostStartRow.classList.add('hidden');
    hostRoomRow.classList.remove('hidden');
    hostStatusEl.textContent = '✓ חדר פתוח. שתף את הקוד.';
    hostStatusEl.className = 'status ok';
    refreshPlayerLists();
    refreshDifficultyButtonsState();
  } catch (err) {
    hostStatusEl.textContent = err.message || 'שגיאה ביצירת החדר';
    hostStatusEl.className = 'status error';
  }
});

hostLeaveBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  net.leave();
  hostStartRow.classList.remove('hidden');
  hostRoomRow.classList.add('hidden');
  hostStatusEl.textContent = '';
  clearAllRemoteAvatars();
  refreshPlayerLists();
  refreshDifficultyButtonsState();
});

joinBtn.addEventListener('click', async (e) => {
  e.stopPropagation();
  const code = (joinCodeInput.value || '').trim().toUpperCase();
  if (code.length !== 5) {
    joinStatusEl.textContent = 'הקוד צריך להיות 5 תווים';
    joinStatusEl.className = 'status error';
    return;
  }
  joinStatusEl.textContent = 'מתחבר...';
  joinStatusEl.className = 'status';
  try {
    syncProfileToNet();
    await net.join(code);
    joinedCodeEl.textContent = code;
    joinFormRow.classList.add('hidden');
    joinedRow.classList.remove('hidden');
    joinStatusEl.textContent = '✓ מחובר לחדר';
    joinStatusEl.className = 'status ok';
    refreshPlayerLists();
    refreshDifficultyButtonsState();
  } catch (err) {
    joinStatusEl.textContent = err.message || 'שגיאת חיבור';
    joinStatusEl.className = 'status error';
  }
});

clientLeaveBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  net.leave();
  joinFormRow.classList.remove('hidden');
  joinedRow.classList.add('hidden');
  joinStatusEl.textContent = '';
  clearAllRemoteAvatars();
  refreshPlayerLists();
  refreshDifficultyButtonsState();
});

joinCodeInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); joinBtn.click(); }
});

function refreshDifficultyButtonsState() {
  const isClient = net.isClient();
  overlay.querySelectorAll('button[data-diff]').forEach(b => {
    b.disabled = isClient;
    b.style.opacity = isClient ? 0.4 : 1;
    b.style.cursor = isClient ? 'not-allowed' : 'pointer';
    b.title = isClient ? 'רק המארח יכול להתחיל את המשחק' : '';
  });
}

function refreshPlayerLists() {
  const myColor = net.profile.color || '#ffd54a';
  const myName = getMyDisplayName();
  const buildList = (containerEl) => {
    if (!containerEl) return;
    containerEl.innerHTML = '';
    if (!net.isConnected()) return;
    const meDiv = document.createElement('div');
    meDiv.className = 'player';
    meDiv.innerHTML = `<span class="swatch" style="background:${myColor}"></span><strong>${myName} (אני)</strong>`;
    containerEl.appendChild(meDiv);
    for (const peerId of net.getPeers()) {
      const profile = net.getPeerProfile(peerId) || {};
      const div = document.createElement('div');
      div.className = 'player';
      div.innerHTML = `<span class="swatch" style="background:${profile.color || '#888'}"></span>${profile.name || 'שחקן'}`;
      containerEl.appendChild(div);
    }
  };
  buildList(hostPlayerList);
  buildList(clientPlayerList);
}

// ─── Remote player avatars ───────────────────────────────────────────────
function createNameLabel(name, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  const r = 12;
  ctx.beginPath();
  ctx.moveTo(r, 0); ctx.lineTo(canvas.width - r, 0);
  ctx.arcTo(canvas.width, 0, canvas.width, r, r);
  ctx.lineTo(canvas.width, canvas.height - r);
  ctx.arcTo(canvas.width, canvas.height, canvas.width - r, canvas.height, r);
  ctx.lineTo(r, canvas.height);
  ctx.arcTo(0, canvas.height, 0, canvas.height - r, r);
  ctx.lineTo(0, r);
  ctx.arcTo(0, 0, r, 0, r);
  ctx.closePath(); ctx.fill();
  ctx.font = 'bold 28px Arial, sans-serif';
  ctx.fillStyle = color;
  ctx.strokeStyle = 'black'; ctx.lineWidth = 4;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const text = name || 'שחקן';
  ctx.strokeText(text, canvas.width / 2, canvas.height / 2);
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(2.4, 0.6, 1);
  sprite.renderOrder = 1000;
  return sprite;
}

// ─── Skins ──────────────────────────────────────────────────────────────
// Cosmetic look-and-feel overrides for the player avatar. Server-side
// validation lives in server.js; this is just rendering data.
//   body/accent/head/eye: hex colors (null means "use player color")
//   eyeGlow: render eyes with a basic material (no shading) so they pop
//   cap: which head-piece to build (see buildCap below)
//   capColor: optional override for cap (defaults to body color)
const SKINS = {
  classic: {
    id: 'classic', name: 'קלאסי',
    body: null, accent: null, head: 0xfff0d8, eye: 0x111111, eyeGlow: false,
    cap: 'baseball', capColor: null,
  },
  skinNinja: {
    id: 'skinNinja', name: 'נינג\'ה',
    body: 0x161616, accent: 0x0a0a0a, head: 0x1a1a1a, eye: 0xff4040, eyeGlow: true,
    cap: 'headband', capColor: 0xb22222,
  },
  skinRobot: {
    id: 'skinRobot', name: 'רובוט',
    body: 0x8d96a0, accent: 0x586068, head: 0xb0b8c0, eye: 0x44ddff, eyeGlow: true,
    cap: 'antenna', capColor: 0x445058,
  },
  skinAstronaut: {
    id: 'skinAstronaut', name: 'אסטרונאוט',
    body: 0xf0f0f0, accent: 0xe07a30, head: 0x88c8e8, eye: 0x111111, eyeGlow: false,
    cap: 'helmet', capColor: 0xeaeaea,
  },
  skinWizard: {
    id: 'skinWizard', name: 'קוסם',
    body: 0x6a3a9a, accent: 0x4a2070, head: 0xf2c89a, eye: 0x111111, eyeGlow: false,
    cap: 'wizardHat', capColor: 0x3a1860,
  },
};

function getSkin(id) { return SKINS[id] || SKINS.classic; }

// Build the head-piece for a given cap kind. Returns a Group (so several
// pieces can come back together for fancier hats). All meshes cast shadows
// and are positioned in the avatar's local space where head sits at y=2.0.
function buildCap(kind, color) {
  const g = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ color });
  if (kind === 'baseball') {
    const flat = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.18, 0.95), mat);
    flat.position.y = 2.5; flat.castShadow = true; g.add(flat);
    const brim = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.06, 0.35),
      new THREE.MeshLambertMaterial({ color: new THREE.Color(color).multiplyScalar(0.7) }));
    brim.position.set(0, 2.43, -0.55); brim.castShadow = true; g.add(brim);
  } else if (kind === 'headband') {
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.14, 0.95), mat);
    band.position.y = 2.32; band.castShadow = true; g.add(band);
    // Two trailing strips so it reads as a ninja headband
    const tail1 = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.12, 0.05), mat);
    tail1.position.set( 0.42, 2.20, 0.40); tail1.rotation.y = 0.4; g.add(tail1);
    const tail2 = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.12, 0.05), mat);
    tail2.position.set( 0.50, 2.05, 0.50); tail2.rotation.y = 0.4; g.add(tail2);
  } else if (kind === 'antenna') {
    const dome = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.40, 0.18, 12), mat);
    dome.position.y = 2.50; dome.castShadow = true; g.add(dome);
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.45, 8),
      new THREE.MeshLambertMaterial({ color: 0x222222 }));
    rod.position.y = 2.82; g.add(rod);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.10, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0x44ddff }));
    bulb.position.y = 3.10; g.add(bulb);
  } else if (kind === 'helmet') {
    // Translucent dome over the head so the face still shows through
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.55, 16, 12),
      new THREE.MeshStandardMaterial({
        color: color, roughness: 0.05, metalness: 0.4,
        transparent: true, opacity: 0.32,
      }));
    dome.position.y = 2.20; dome.castShadow = false; g.add(dome);
    // A small antenna on top to read as space gear
    const tip = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.20, 0.10),
      new THREE.MeshLambertMaterial({ color: 0xe07a30 }));
    tip.position.y = 2.80; g.add(tip);
  } else if (kind === 'wizardHat') {
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.65, 0.65, 0.06, 16), mat);
    brim.position.y = 2.45; brim.castShadow = true; g.add(brim);
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.45, 1.0, 16), mat);
    cone.position.y = 2.98; cone.castShadow = true; g.add(cone);
    // Three little gold stars on the cone
    const starMat = new THREE.MeshBasicMaterial({ color: 0xffd54a });
    for (let i = 0; i < 3; i++) {
      const star = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.04), starMat);
      const ang = (i / 3) * Math.PI * 2;
      star.position.set(Math.sin(ang) * 0.28, 2.85 + i * 0.20, -Math.cos(ang) * 0.28);
      g.add(star);
    }
  }
  return g;
}

function createRemoteAvatar(profile, peerId) {
  const group = new THREE.Group();
  const skin = getSkin(profile.skin || 'classic');
  // For classic skin, body/accent come from the player's slot color so each
  // teammate is visually distinct. Custom skins override with their own colors.
  const playerColor = new THREE.Color(profile.color || '#ffd54a');
  const baseColor   = skin.body   != null ? new THREE.Color(skin.body)   : playerColor;
  const accentColor = skin.accent != null ? new THREE.Color(skin.accent) : playerColor.clone().multiplyScalar(0.6);
  const headColor   = skin.head;
  const bodyMat = new THREE.MeshStandardMaterial({ color: baseColor, roughness: 0.55 });
  const accentMat = new THREE.MeshStandardMaterial({ color: accentColor, roughness: 0.6 });
  const headMat = new THREE.MeshStandardMaterial({ color: headColor, roughness: 0.6 });

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.1, 0.6), bodyMat);
  body.position.y = 1.0; body.castShadow = true;
  body.userData.peerId = peerId; body.userData.isHead = false;
  const belt = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.18, 0.7), accentMat);
  belt.position.y = 0.5;
  const legL = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.55, 0.34), accentMat); legL.position.set(-0.22, 0.27, 0); legL.castShadow = true;
  const legR = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.55, 0.34), accentMat); legR.position.set( 0.22, 0.27, 0); legR.castShadow = true;
  const armL = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.85, 0.32), bodyMat); armL.position.set(-0.6, 1.0, 0); armL.castShadow = true;
  const armR = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.85, 0.32), bodyMat); armR.position.set( 0.6, 1.0, 0); armR.castShadow = true;
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.8, 0.85), headMat);
  head.position.y = 2.0; head.castShadow = true;
  head.userData.peerId = peerId; head.userData.isHead = true;
  // Glowy eyes (basic material → ignores lighting) for robot/ninja skins
  const eyeMat = skin.eyeGlow
    ? new THREE.MeshBasicMaterial({ color: skin.eye })
    : new THREE.MeshBasicMaterial({ color: skin.eye });
  const eyeL = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.14, 0.04), eyeMat); eyeL.position.set(-0.18, 2.07, -0.43);
  const eyeR = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.14, 0.04), eyeMat); eyeR.position.set( 0.18, 2.07, -0.43);
  const cap = buildCap(skin.cap, skin.capColor != null ? skin.capColor : baseColor.getHex());
  group.add(body, belt, legL, legR, armL, armR, head, eyeL, eyeR, cap);

  const label = createNameLabel(profile.name || 'שחקן', profile.color || '#ffd54a');
  label.position.y = 3.1;
  group.add(label);

  return {
    group, label, body, head,
    targetPos: new THREE.Vector3(0, 0, 0),
    targetRotY: 0,
    profile, peerId,
  };
}

function ensureRemoteAvatar(peerId) {
  if (remotePlayers.has(peerId)) return remotePlayers.get(peerId);
  const profile = net.getPeerProfile(peerId) || { name: 'שחקן', color: '#ffd54a' };
  const av = createRemoteAvatar(profile, peerId);
  scene.add(av.group);
  remotePlayers.set(peerId, av);
  return av;
}

function removeRemoteAvatar(peerId) {
  const av = remotePlayers.get(peerId);
  if (!av) return;
  scene.remove(av.group);
  remotePlayers.delete(peerId);
}

function clearAllRemoteAvatars() {
  for (const peerId of [...remotePlayers.keys()]) removeRemoteAvatar(peerId);
}

// ─── Net event handlers ──────────────────────────────────────────────────
net.addEventListener('peer-join', () => refreshPlayerLists());
net.addEventListener('peer-leave', e => {
  removeRemoteAvatar(e.detail.peerId);
  refreshPlayerLists();
  // If we're a client and the host went away, reset our lobby UI so the
  // user knows they're no longer in a room. (In star topology, clients
  // only ever connect to the host, so a peer-leave === host left.)
  if (net.isClient() && net.peerCount() === 0) {
    net.leave(); // tear down our peer object too
    joinFormRow.classList.remove('hidden');
    joinedRow.classList.add('hidden');
    joinStatusEl.textContent = '⚠️ אבד החיבור למארח';
    joinStatusEl.className = 'status error';
    refreshDifficultyButtonsState();
    // If a game was running, drop the player out of it back to the menu
    if (game.alive) {
      game.alive = false;
      controls.unlock();
      overlay.classList.remove('hidden');
    }
  }
});
net.addEventListener('peer-profile', e => {
  refreshPlayerLists();
  // If host, propagate the new peer's profile to other clients,
  // and tell the new peer about already-connected peers.
  if (net.isHost()) {
    const newPeerId = e.detail.peerId;
    const newProfile = e.detail.profile;
    for (const peerId of net.getPeers()) {
      if (peerId === newPeerId) continue;
      const profile = net.getPeerProfile(peerId);
      if (profile) net.sendTo(newPeerId, { type: 'profile-relay', peerId, profile });
    }
    for (const peerId of net.getPeers()) {
      if (peerId === newPeerId) continue;
      net.sendTo(peerId, { type: 'profile-relay', peerId: newPeerId, profile: newProfile });
    }
  }
});

net.addEventListener('message', e => {
  const { from, data } = e.detail;
  if (!data || !data.type) return;
  switch (data.type) {
    case 'pos': {
      const av = ensureRemoteAvatar(from);
      // Camera is at eye-height (1.7) so subtract that to anchor avatar feet on ground
      av.targetPos.set(data.pos[0], data.pos[1] - 1.7, data.pos[2]);
      av.targetRotY = data.rotY;
      // If host, relay to all other clients
      if (net.isHost()) {
        for (const peerId of net.getPeers()) {
          if (peerId === from) continue;
          net.sendTo(peerId, { type: 'pos-relay', from, pos: data.pos, rotY: data.rotY });
        }
      }
      break;
    }
    case 'pos-relay': {
      const av = ensureRemoteAvatar(data.from);
      av.targetPos.set(data.pos[0], data.pos[1] - 1.7, data.pos[2]);
      av.targetRotY = data.rotY;
      break;
    }
    case 'profile-relay': {
      net.peerProfiles.set(data.peerId, data.profile);
      // (Re)create avatar so the label/color is up-to-date
      removeRemoteAvatar(data.peerId);
      ensureRemoteAvatar(data.peerId);
      refreshPlayerLists();
      break;
    }
    case 'profile-update': {
      // A peer changed something on their profile mid-session (e.g. skin).
      // Update our cached profile + rebuild their avatar so the new look
      // shows. Host also relays to every other client.
      net.peerProfiles.set(from, data.profile);
      removeRemoteAvatar(from);
      ensureRemoteAvatar(from);
      refreshPlayerLists();
      if (net.isHost()) {
        for (const peerId of net.getPeers()) {
          if (peerId === from) continue;
          net.sendTo(peerId, { type: 'profile-relay', peerId: from, profile: data.profile });
        }
      }
      break;
    }
    case 'start-game': {
      if (net.isClient()) {
        waitingForHostEl.classList.add('hidden');
        startGame(data.difficulty, data.killTarget, data.mode, data.theme);
      }
      break;
    }
    case 'pvp-hit': {
      // Another player reported hitting us. Apply the damage locally. We
      // trust the sender for v1 — no anti-cheat (this is a friend-game).
      // If the hit kills us, the damagePlayer path will tell the shooter
      // so they can credit themselves with the PvP-ELO win.
      const wasAlive = game.alive;
      lastPvpAttackerPeerId = from;
      damagePlayer(Math.max(1, Math.min(50, data.amount || 0)));
      // If this packet was the killing blow, send a `pvp-killed` back to
      // the shooter so they can call Auth.reportPvpKill(myUserId).
      if (wasAlive && !game.alive && session.user) {
        const killedMsg = { type: 'pvp-killed', shooterId: from, victimUserId: session.user.id };
        if (net.isHost()) net.sendTo(from, killedMsg);
        else net.sendToHost(killedMsg);
      }
      // Host relays so the rest of the room can also count the hit later
      if (net.isHost() && data.targetId && data.targetId !== net.myId) {
        net.sendTo(data.targetId, { type: 'pvp-hit', from, amount: data.amount });
      }
      break;
    }
    case 'pvp-killed': {
      // We were told we landed a kill. If the message is for us, credit
      // the ELO update on the server (server treats `this user` as winner).
      if (data.shooterId === net.myId && data.victimUserId) {
        Auth.reportPvpKill(data.victimUserId).catch(() => {});
        updateOverlayUserUI();
      } else if (net.isHost() && data.shooterId) {
        // We're the host and the victim was a client → relay to shooter.
        net.sendTo(data.shooterId, { type: 'pvp-killed', shooterId: data.shooterId, victimUserId: data.victimUserId });
      }
      break;
    }
  }
});

// Show / hide the "waiting for host" notice when client unlocks/locks
controls.addEventListener('lock', () => waitingForHostEl.classList.add('hidden'));
controls.addEventListener('unlock', () => {
  if (net.isClient() && !game.alive && !gameOverEl.classList.contains('hidden')) return;
  if (net.isClient() && !game.alive) {
    // Show waiting screen ONLY if we've never been into a game yet
    // For simplicity: don't auto-show; the start overlay is enough
  }
});

// ─── Position sync loop ──────────────────────────────────────────────────
const SYNC_HZ = 20;
const SYNC_INTERVAL = 1 / SYNC_HZ;
function tickNetSync(dt) {
  // Smooth-interpolate remote avatar positions every frame regardless of sync rate
  for (const av of remotePlayers.values()) {
    av.group.position.lerp(av.targetPos, 0.25);
    av.group.rotation.y += (av.targetRotY - av.group.rotation.y) * 0.25;
  }

  if (!net.isConnected()) return;
  syncAccumulator += dt;
  if (syncAccumulator < SYNC_INTERVAL) return;
  syncAccumulator = 0;
  // Derive yaw from the world-space forward direction. camera.rotation.y is
  // NOT a clean yaw with default XYZ Euler order — when the player tilts up
  // or down their reported yaw drifts, so peers would see their avatar
  // twist sideways. atan2 of horizontal components is always clean.
  camera.getWorldDirection(_tpForward);
  const cleanYaw = Math.atan2(-_tpForward.x, -_tpForward.z);
  const msg = {
    type: 'pos',
    pos: [camera.position.x, camera.position.y, camera.position.z],
    rotY: cleanYaw,
    weapon: currentWeaponId,
  };
  if (net.isHost()) net.broadcast(msg);
  else if (net.isClient()) net.sendToHost(msg);
}

console.log('FPS Stage 5 ready — multiplayer enabled.');

// ─── Touch / mobile controls ─────────────────────────────────────────────
// On phones and tablets the desktop pointer-lock + WASD scheme is unusable.
// We expose an on-screen joystick for movement, a drag-to-look area, and
// fire / jump / reload / grenade buttons. The existing keyboard/mouse state
// objects (`keys`, `mouseDown`, camera rotation) are driven by this input —
// the rest of the game doesn't need to know we're on mobile.
setupTouchControls({
  onJump:    () => { if (controls.isLocked && onGround) keys.space = true; setTimeout(() => keys.space = false, 100); },
  onReload:  () => { if (controls.isLocked) reload(); },
  onGrenade: () => { if (controls.isLocked) tryThrowGrenade(); },
});

// Helper used everywhere we'd normally call controls.lock() / unlock().
// On mobile pointer-lock isn't available, so we just flip the `isLocked`
// flag manually — the rest of the game already gates on it.
function setLockState(locked) {
  if (isTouch) {
    controls.isLocked = locked;
    if (locked) overlay.classList.add('hidden');
  } else {
    if (locked) controls.lock();
    else controls.unlock();
  }
}

// Patch over the original startGame's call to controls.lock() so it works
// on mobile too. We do this by overriding lock/unlock on the controls object
// when running on a touch device.
if (isTouch) {
  controls.lock   = function () { setLockState(true); };
  controls.unlock = function () {
    controls.isLocked = false;
    overlay.classList.remove('hidden');
  };
}

// Per-frame input bridge: feed touch state into the existing keys / mouseDown
// vars + rotate camera manually (PointerLockControls is a no-op on touch).
// `var` here so the variable is hoisted — `tickTouchInput` is invoked from
// the animate loop which starts before this block runs.
var _prevTouchFiring = false;

function tickTouchInput() {
  // Driven by the `is-touch` body class — set by setupTouchControls() on real
  // touch devices, but can also be toggled manually (e.g. by power-users
  // testing on a hybrid laptop).
  if (!document.body.classList.contains('is-touch')) return;
  if (!controls.isLocked || !game.alive) {
    keys.w = keys.a = keys.s = keys.d = keys.shift = false;
    mouseDown = false;
    _prevTouchFiring = false;
    return;
  }

  // Joystick → WASD. Y is screen-down, so up on the stick (negative Y) means forward.
  const fwd = -touchState.moveY;
  const right = touchState.moveX;
  keys.w = fwd >  0.2;
  keys.s = fwd < -0.2;
  keys.a = right < -0.2;
  keys.d = right >  0.2;
  // Sprint is intentional only — held via the ⚡ button. Auto-engaging on a
  // joystick push past 0.85 felt like the stick was always sprinting.
  keys.shift = touchState.sprinting;

  // Look — manually rotate the camera. YXZ Euler keeps pitch/yaw decoupled.
  if (touchState.lookDX !== 0 || touchState.lookDY !== 0) {
    const euler = new THREE.Euler(0, 0, 0, 'YXZ');
    euler.setFromQuaternion(camera.quaternion);
    euler.y -= touchState.lookDX * 0.005;
    euler.x -= touchState.lookDY * 0.005;
    euler.x = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, euler.x));
    camera.quaternion.setFromEuler(euler);
    touchState.lookDX = 0;
    touchState.lookDY = 0;
  }

  // Rising edge of the fire button shoots immediately (covers semi + melee).
  // Auto weapons keep firing from tickWeapons while mouseDown is true.
  if (touchState.firing && !_prevTouchFiring) tryFire();
  mouseDown = touchState.firing;
  _prevTouchFiring = touchState.firing;
}

if (isTouch) console.log('Touch device detected — on-screen controls enabled.');

// ─── Fullscreen / "open like an app" on mobile ───────────────────────────
// Two paths:
//   • Android Chrome / Firefox: a real Fullscreen API call hides the URL
//     bar + nav buttons. Must be triggered from a user gesture so we wait
//     for the first tap on any button and request it then.
//   • iOS Safari: blocks programmatic fullscreen for browser pages. The
//     only way to get a chrome-less experience is "Add to Home Screen" —
//     once the user does that, our `apple-mobile-web-app-capable` meta tag
//     makes it open in standalone mode. We show a one-time hint pointing
//     them at the share menu.
const isiOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
const isStandaloneApp =
  (window.navigator.standalone === true) ||
  window.matchMedia('(display-mode: standalone)').matches ||
  window.matchMedia('(display-mode: fullscreen)').matches;

let _fullscreenRequested = false;
function requestFullscreenIfMobile() {
  if (_fullscreenRequested) return;
  if (!isTouch) return;
  if (isStandaloneApp) return; // already chrome-less, nothing to do
  if (isiOS) return;           // Safari refuses; the hint covers this
  _fullscreenRequested = true;
  const el = document.documentElement;
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!req) return;
  try {
    const r = req.call(el);
    if (r && r.catch) r.catch(() => {}); // user might cancel — silent
  } catch {}
}

// Any tap on the auth buttons / overlay buttons / mp tabs counts as a user
// gesture. Capture-phase so we run before the button's own handler fires.
document.addEventListener('click', requestFullscreenIfMobile, { capture: true });
document.addEventListener('touchend', requestFullscreenIfMobile, { capture: true, passive: true });

// One-time iOS hint — only if we're in Safari and not yet a home-screen app
if (isiOS && isTouch && !isStandaloneApp && !sessionStorage.getItem('fps_ios_hint_seen')) {
  sessionStorage.setItem('fps_ios_hint_seen', '1');
  setTimeout(() => {
    const hint = document.createElement('div');
    hint.id = 'iosHint';
    hint.innerHTML =
      '📱 לחווית מסך מלא ב-iPhone' +
      '<div class="small">לחץ על <strong>שתף</strong> בתחתית הדפדפן ←<br><strong>הוסף למסך הבית</strong></div>' +
      '<div class="close">(לחץ כאן לסגירה)</div>';
    hint.addEventListener('click', () => hint.remove());
    document.body.appendChild(hint);
    setTimeout(() => { if (hint.isConnected) hint.remove(); }, 12000);
  }, 1200);
}

// Dev hook — open DevTools and play with `__fps` (e.g. `__fps.bots[0].hp = 1`)
window.__fps = {
  THREE, scene, camera, bots, game, stamina, controls,
  weapons, WEAPONS, setWeapon,
  get currentWeaponId() { return currentWeaponId; },
  get fireCooldown() { return fireCooldown; },
  set fireCooldown(v) { fireCooldown = v; },
  tryFire, fireRanged, swingMelee, reload, setZoom,
  get isZoomed() { return isZoomed; },
  damageBot, damagePlayer, scheduleRespawn, spawnOneBot, winGame, startGame,
  DIFFICULTIES,
  auth: Auth, get session() { return session; },
  pickups, PICKUP_TYPES, spawnAllPickups, tickPickups,
  grenades, tryThrowGrenade, explodeAt, tickGrenades, tickExplosions,
  flameParticles, explosions, tickFlameParticles,
  tickContinuousFire, damageBotsInCone,
  net, remotePlayers, ensureRemoteAvatar, removeRemoteAvatar,
  keys, isTouch, touchState, tickTouchInput,
  dayCycle, tickDayCycle, sunVisual, moonVisual, starsMesh,
  weather, setWeather, tickWeather,
};
