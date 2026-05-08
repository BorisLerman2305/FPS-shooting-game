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

// ─── Scene, camera, renderer ──────────────────────────────────────────────
const scene = new THREE.Scene();
const SKY_TOP = new THREE.Color(0x6cb9ff);    // deep blue overhead
const SKY_HORIZON = new THREE.Color(0xffd6a0); // peach near horizon (Fortnite-ish)
scene.background = SKY_HORIZON.clone();
scene.fog = new THREE.Fog(0xffe6c7, 60, 180);  // warm tinted fog

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 600);
camera.position.set(0, 1.7, 0); // eye height ~1.7m

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
document.getElementById('app').appendChild(renderer.domElement);

// Stylized sky dome with vertical gradient (no shaders — vertex colors are simpler)
function buildSkyDome() {
  const geo = new THREE.SphereGeometry(400, 32, 16);
  const positions = geo.attributes.position;
  const colors = new Float32Array(positions.count * 3);
  const top = SKY_TOP, mid = new THREE.Color(0xc8e9ff), low = SKY_HORIZON;
  for (let i = 0; i < positions.count; i++) {
    const y = positions.getY(i);
    const t = THREE.MathUtils.clamp((y + 80) / 320, 0, 1); // 0 at horizon, 1 at top
    let c;
    if (t > 0.5) c = mid.clone().lerp(top, (t - 0.5) * 2);
    else         c = low.clone().lerp(mid, t * 2);
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false });
  const sky = new THREE.Mesh(geo, mat);
  scene.add(sky);
  // Visible sun (just a glowy disc, not the actual light source)
  const sunSphere = new THREE.Mesh(
    new THREE.SphereGeometry(12, 24, 24),
    new THREE.MeshBasicMaterial({ color: 0xfff4c4, fog: false, depthWrite: false })
  );
  sunSphere.position.set(120, 180, -180);
  scene.add(sunSphere);
}
buildSkyDome();

// Postprocessing: bloom for glowing sun, muzzle flashes, fire, explosions
const composer = new EffectComposer(renderer);
const renderPass = new RenderPass(scene, camera);
composer.addPass(renderPass);
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.55,  // strength
  0.45,  // radius
  0.82,  // threshold (only the brightest bits bloom)
);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

function handleResize() {
  const w = window.innerWidth || document.documentElement.clientWidth;
  const h = window.innerHeight || document.documentElement.clientHeight;
  if (w === 0 || h === 0) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
  bloomPass.setSize(w, h);
}
window.addEventListener('resize', handleResize);
new ResizeObserver(handleResize).observe(document.documentElement);
handleResize();

// Activate WebAudio on the first user gesture (browsers require this)
Sfx.unlockOnUserGesture();

// ─── Forward declarations for state read by the animate loop ─────────────
// (declared up-front so tickNetSync — invoked from animate() — doesn't hit
// the temporal dead zone before the multiplayer block at the bottom runs)
const remotePlayers = new Map();
let syncAccumulator = 0;

// ─── Procedural textures ──────────────────────────────────────────────────
// Generated in canvas — no external assets needed.
function makeTextureFromCanvas(canvas, repeat = 1) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function makeGrassTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const x = c.getContext('2d');
  // Base
  x.fillStyle = '#4f7a35'; x.fillRect(0, 0, 256, 256);
  // Mottled darker patches
  for (let i = 0; i < 80; i++) {
    x.fillStyle = `rgba(40,80,30,${0.15 + Math.random() * 0.35})`;
    x.beginPath();
    x.arc(Math.random() * 256, Math.random() * 256, 8 + Math.random() * 18, 0, Math.PI * 2);
    x.fill();
  }
  // Tufts of brighter grass
  for (let i = 0; i < 1500; i++) {
    const px = Math.random() * 256, py = Math.random() * 256;
    const tone = Math.random();
    x.fillStyle = tone > 0.6
      ? `rgba(150, 200, 110, ${0.4 + Math.random() * 0.4})`
      : tone > 0.3
        ? `rgba(95, 145, 60, ${0.5 + Math.random() * 0.4})`
        : `rgba(60, 95, 35, ${0.5 + Math.random() * 0.4})`;
    x.fillRect(px, py, 1, 1 + Math.random() * 2);
  }
  // Subtle yellow specks (dry grass)
  for (let i = 0; i < 80; i++) {
    x.fillStyle = `rgba(200, 175, 90, ${0.5})`;
    x.fillRect(Math.random() * 256, Math.random() * 256, 1, 2);
  }
  return c;
}

function makeWoodTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const x = c.getContext('2d');
  x.fillStyle = '#6b4226'; x.fillRect(0, 0, 256, 256);
  // Grain stripes
  for (let i = 0; i < 256; i += 1) {
    const dark = 30 + Math.random() * 30;
    x.fillStyle = `rgba(0,0,0,${(Math.sin(i * 0.18) * 0.5 + 0.5) * 0.25 + Math.random() * 0.05})`;
    x.fillRect(0, i, 256, 1);
  }
  // Plank gaps every ~50px
  x.fillStyle = '#2c1a0e';
  for (let py = 0; py < 256; py += 50 + Math.floor(Math.random() * 14)) x.fillRect(0, py, 256, 2);
  // Knots
  for (let i = 0; i < 5; i++) {
    const px = Math.random() * 256, py = Math.random() * 256;
    const grad = x.createRadialGradient(px, py, 1, px, py, 10);
    grad.addColorStop(0, 'rgba(20,10,5,0.9)');
    grad.addColorStop(1, 'rgba(20,10,5,0)');
    x.fillStyle = grad;
    x.beginPath(); x.arc(px, py, 10, 0, Math.PI * 2); x.fill();
  }
  return c;
}

function makeStoneTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const x = c.getContext('2d');
  x.fillStyle = '#7a8090'; x.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 600; i++) {
    const r = 50 + Math.random() * 80;
    x.fillStyle = `rgba(${r},${r + 5},${r + 10},${0.4 + Math.random() * 0.5})`;
    x.fillRect(Math.random() * 256, Math.random() * 256, 1 + Math.random() * 3, 1 + Math.random() * 3);
  }
  // Cracks
  x.strokeStyle = 'rgba(20,20,30,0.4)'; x.lineWidth = 1;
  for (let i = 0; i < 8; i++) {
    x.beginPath();
    let cx = Math.random() * 256, cy = Math.random() * 256;
    x.moveTo(cx, cy);
    for (let s = 0; s < 6; s++) {
      cx += (Math.random() - 0.5) * 40;
      cy += (Math.random() - 0.5) * 40;
      x.lineTo(cx, cy);
    }
    x.stroke();
  }
  return c;
}

function makeWallTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const x = c.getContext('2d');
  x.fillStyle = '#5a3d22'; x.fillRect(0, 0, 256, 256);
  // Vertical plank lines
  x.fillStyle = '#2c1a0e';
  for (let px = 0; px < 256; px += 32) x.fillRect(px, 0, 2, 256);
  // Wood grain noise per plank
  for (let i = 0; i < 4000; i++) {
    const tone = 30 + Math.random() * 30;
    x.fillStyle = `rgba(0,0,0,${Math.random() * 0.18})`;
    x.fillRect(Math.random() * 256, Math.random() * 256, 1, 2);
  }
  // Highlight strokes
  for (let i = 0; i < 200; i++) {
    x.fillStyle = `rgba(180,140,90,${0.15 + Math.random() * 0.2})`;
    x.fillRect(Math.random() * 256, Math.random() * 256, 1, 3 + Math.random() * 8);
  }
  return c;
}

const TEX_GRASS = makeTextureFromCanvas(makeGrassTexture(), 25);
const TEX_WOOD  = makeTextureFromCanvas(makeWoodTexture(),  1);
const TEX_STONE = makeTextureFromCanvas(makeStoneTexture(), 1);
const TEX_WALL  = makeTextureFromCanvas(makeWallTexture(),  4);

// ─── Lights (cartoon-bright: hemisphere ambient + warm sun) ──────────────
const hemi = new THREE.HemisphereLight(0xb8e0ff, 0x6f8a4a, 0.85);
hemi.position.set(0, 50, 0);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xfff2cc, 1.4);
sun.position.set(40, 70, 30);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -60; sun.shadow.camera.right = 60;
sun.shadow.camera.top = 60;   sun.shadow.camera.bottom = -60;
sun.shadow.camera.near = 1;   sun.shadow.camera.far = 200;
sun.shadow.bias = -0.0008;
scene.add(sun);

// ─── World: textured ground + walls + varied scenery ─────────────────────
const groundGeo = new THREE.PlaneGeometry(220, 220, 32, 32);
const groundMat = new THREE.MeshStandardMaterial({ map: TEX_GRASS, roughness: 0.96, metalness: 0 });
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const colliders = []; // boxes the player & bullets must check against

function addBox(w, h, d, x, y, z, mat) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = true; m.receiveShadow = true;
  scene.add(m);
  const box = new THREE.Box3().setFromObject(m);
  colliders.push({ mesh: m, box });
  return m;
}

// Outer perimeter walls — textured wood planks (50×50 arena)
const ARENA = 50;
const wallMatLong = new THREE.MeshStandardMaterial({ map: TEX_WALL.clone(), roughness: 0.85 });
wallMatLong.map.repeat.set(20, 1);
const wallMatLong2 = new THREE.MeshStandardMaterial({ map: TEX_WALL.clone(), roughness: 0.85 });
wallMatLong2.map.repeat.set(1, 20);
addBox(ARENA * 2, 4, 1, 0, 2,  ARENA, wallMatLong);
addBox(ARENA * 2, 4, 1, 0, 2, -ARENA, wallMatLong);
addBox(1, 4, ARENA * 2,  ARENA, 2, 0, wallMatLong2);
addBox(1, 4, ARENA * 2, -ARENA, 2, 0, wallMatLong2);

// Helper: track placed objects so we don't stack scenery
const placed = []; // { x, z, r }
function tryPlace(x, z, r) {
  for (const p of placed) {
    if (Math.hypot(p.x - x, p.z - z) < p.r + r) return false;
  }
  if (Math.hypot(x, z) < 6) return false; // keep player spawn clear
  if (Math.abs(x) > ARENA - 2 || Math.abs(z) > ARENA - 2) return false;
  placed.push({ x, z, r });
  return true;
}

// Trees — cone canopy + cylinder trunk (groups added as a single collider on the trunk)
function makeTree(x, z, scale = 1) {
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.25 * scale, 0.32 * scale, 1.4 * scale, 8),
    new THREE.MeshStandardMaterial({ color: 0x6b4226, roughness: 0.9 })
  );
  trunk.position.set(x, 0.7 * scale, z);
  trunk.castShadow = true; trunk.receiveShadow = true;
  scene.add(trunk);

  const canopyColor = [0x4caf50, 0x66bb6a, 0x2e8b57, 0x388e3c][Math.floor(Math.random() * 4)];
  // 2-stage canopy for a stylized look
  const canopyLow = new THREE.Mesh(
    new THREE.ConeGeometry(1.2 * scale, 1.6 * scale, 8),
    new THREE.MeshStandardMaterial({ color: canopyColor, roughness: 0.85 })
  );
  canopyLow.position.set(x, 1.6 * scale, z);
  canopyLow.castShadow = true;
  const canopyTop = new THREE.Mesh(
    new THREE.ConeGeometry(0.85 * scale, 1.3 * scale, 8),
    new THREE.MeshStandardMaterial({ color: canopyColor, roughness: 0.85 })
  );
  canopyTop.position.set(x, 2.5 * scale, z);
  canopyTop.castShadow = true;
  scene.add(canopyLow, canopyTop);

  // Use the trunk's bounding box (slightly wider) as the collider
  const box = new THREE.Box3().setFromObject(trunk);
  box.expandByScalar(0.15);
  colliders.push({ mesh: trunk, box });
}

// Rocks — low-poly icosahedrons with stone texture
function makeRock(x, z, scale = 1) {
  const geo = new THREE.IcosahedronGeometry(0.9 * scale, 0);
  const mat = new THREE.MeshStandardMaterial({ map: TEX_STONE, roughness: 1, metalness: 0 });
  const rock = new THREE.Mesh(geo, mat);
  rock.position.set(x, 0.55 * scale, z);
  rock.rotation.set(Math.random(), Math.random(), Math.random());
  rock.castShadow = true; rock.receiveShadow = true;
  scene.add(rock);
  const box = new THREE.Box3().setFromObject(rock);
  colliders.push({ mesh: rock, box });
}

// Wooden crates — textured wood with darker plank wrap
function makeCrate(x, z, size = 1) {
  const wood = new THREE.MeshStandardMaterial({ map: TEX_WOOD, roughness: 0.85 });
  const crate = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), wood);
  crate.position.set(x, size / 2, z);
  crate.castShadow = true; crate.receiveShadow = true;
  scene.add(crate);
  // Darker stripes on top to suggest planks (purely visual)
  const plankMat = new THREE.MeshStandardMaterial({ color: 0x6e4a26 });
  const stripeY = size + 0.001;
  for (let s = -1; s <= 1; s++) {
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(size + 0.02, 0.02, 0.1), plankMat);
    stripe.position.set(x, stripeY, z + s * (size / 3));
    scene.add(stripe);
  }
  const box = new THREE.Box3().setFromObject(crate);
  colliders.push({ mesh: crate, box });
}

// Tiny hut — cube body + colored roof (red/blue/teal)
function makeHut(x, z) {
  const roofColor = [0xc23b3b, 0x4a73c2, 0x3aa18a, 0xc28a3a][Math.floor(Math.random() * 4)];
  const w = 3.5, d = 3.2, h = 2.5;
  const wall = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({ color: 0xe5d3b0, roughness: 0.9 })
  );
  wall.position.set(x, h / 2, z);
  wall.castShadow = true; wall.receiveShadow = true;
  scene.add(wall);
  // Pyramid-ish roof: cone with 4 segments (looks like a pyramid)
  const roof = new THREE.Mesh(
    new THREE.ConeGeometry(Math.max(w, d) * 0.78, 1.4, 4),
    new THREE.MeshStandardMaterial({ color: roofColor, roughness: 0.7 })
  );
  roof.rotation.y = Math.PI / 4;
  roof.position.set(x, h + 0.7, z);
  roof.castShadow = true;
  scene.add(roof);
  const box = new THREE.Box3().setFromObject(wall);
  colliders.push({ mesh: wall, box });
}

// Scatter scenery across the arena
for (let i = 0; i < 22; i++) {
  let x, z, attempts = 0;
  do {
    x = (Math.random() - 0.5) * (ARENA * 1.7);
    z = (Math.random() - 0.5) * (ARENA * 1.7);
    attempts++;
  } while (!tryPlace(x, z, 1.6) && attempts < 12);
  if (attempts >= 12) continue;
  makeTree(x, z, 0.9 + Math.random() * 0.7);
}
for (let i = 0; i < 14; i++) {
  let x, z, attempts = 0;
  do {
    x = (Math.random() - 0.5) * (ARENA * 1.7);
    z = (Math.random() - 0.5) * (ARENA * 1.7);
    attempts++;
  } while (!tryPlace(x, z, 1.2) && attempts < 12);
  if (attempts >= 12) continue;
  makeRock(x, z, 0.7 + Math.random() * 0.8);
}
for (let i = 0; i < 10; i++) {
  let x, z, attempts = 0;
  do {
    x = (Math.random() - 0.5) * (ARENA * 1.7);
    z = (Math.random() - 0.5) * (ARENA * 1.7);
    attempts++;
  } while (!tryPlace(x, z, 1.1) && attempts < 12);
  if (attempts >= 12) continue;
  makeCrate(x, z, 0.9 + Math.random() * 0.5);
}
for (let i = 0; i < 4; i++) {
  let x, z, attempts = 0;
  do {
    x = (Math.random() - 0.5) * (ARENA * 1.5);
    z = (Math.random() - 0.5) * (ARENA * 1.5);
    attempts++;
  } while (!tryPlace(x, z, 3.5) && attempts < 18);
  if (attempts >= 18) continue;
  makeHut(x, z);
}

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

const game = {
  difficulty: 'medium',
  kills: 0,
  killTarget: 25,         // total bots to kill to finish the stage (1-200)
  pendingSpawns: 0,       // bots scheduled to respawn (so we don't over-spawn)
  playerHP: 100,
  playerHPMax: 100,
  alive: false,           // true once a difficulty has been picked & game started
};

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

function startGame(diffKey, overrideKillTarget) {
  const conf = DIFFICULTIES[diffKey];
  game.difficulty = diffKey;
  game.kills = 0;
  game.pendingSpawns = 0;
  game.playerHP = game.playerHPMax;
  game.alive = true;

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
    net.broadcast({ type: 'start-game', difficulty: diffKey, killTarget: target });
  }
  // Reflect resolved value in the input so the user sees what's running
  botTargetInput.value = target;
  botTargetUserEdited = false;

  killCountEl.textContent = '0';
  killTargetLabelEl.textContent = String(target);
  diffLabelEl.textContent = conf.label;
  updateHPUI();
  // Reset stamina + all weapons (refill magazine + reserve, cancel any reloads)
  stamina.value = STAMINA_MAX;
  stamina.lockedOut = false;
  for (const id of Object.keys(weapons)) {
    weapons[id].ammo = WEAPONS[id].maxAmmo;
    weapons[id].reserve = WEAPONS[id].reserveStart ?? 0;
    weapons[id].reloading = false;
    weapons[id].recoilTimer = 0;
    weapons[id].swingTimer = 0;
    weapons[id].model.position.copy(weapons[id].restPos);
    weapons[id].model.rotation.x = weapons[id].restRotX;
  }
  // Reset grenades (you start with 2; pickups give you more)
  grenades.count = 2;
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
  // Reset player position
  camera.position.set(0, 1.7, 0);
  velocity.set(0, 0, 0);
  // Clear any existing bots and spawn fresh ones (capped by remaining quota)
  clearBots();
  const initialBatch = Math.min(conf.count, target);
  for (let i = 0; i < initialBatch; i++) spawnOneBot(conf);
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
  // Weapon switching
  if (e.code === 'Digit1') setWeapon('pistol');
  if (e.code === 'Digit2') setWeapon('rifle');
  if (e.code === 'Digit3') setWeapon('sniper');
  if (e.code === 'Digit4') setWeapon('shotgun');
  if (e.code === 'Digit5') setWeapon('sword');
  if (e.code === 'Digit6') setWeapon('flamethrower');
  // Throw grenade
  if (e.code === 'KeyG') tryThrowGrenade();
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
};

const muzzleMat = () => new THREE.MeshBasicMaterial({ color: 0xffaa00, transparent: true, opacity: 0 });

function createPistolModel() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.18, 0.5),  new THREE.MeshStandardMaterial({ color: 0x222222 }));
  body.position.set(0, 0, -0.05);
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.35), new THREE.MeshStandardMaterial({ color: 0x444444 }));
  barrel.position.set(0, 0.04, -0.35);
  const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 8), muzzleMat());
  muzzle.position.set(0, 0.04, -0.55);
  g.add(body, barrel, muzzle);
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
  g.add(stock, body, barrel, mag, muzzle);
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
  g.add(stock, body, barrel, scopeMain, lens, muzzle);
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
  g.add(stock, body, pump, barrelL, barrelR, muzzle);
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
  g.add(tank, grip, body, barrel, muzzle);
  g.position.set(0.30, -0.30, -0.5);
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
  g.add(hilt, guard, blade);
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

function setWeapon(id) {
  if (!weapons[id]) return;
  if (id !== currentWeaponId) {
    weapons[currentWeaponId].model.visible = false;
    weapons[id].model.visible = true;
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
  };
  slot.addEventListener('click', switchTo);
  // Listen to touchstart explicitly so the look-area (which captures any
  // free touch on the right half of the screen) doesn't swallow taps.
  slot.addEventListener('touchstart', switchTo, { passive: false });
});

let fireCooldown = 0;
let mouseDown = false;
updateWeaponHUD();

// ─── Bots (enemies) ───────────────────────────────────────────────────────
const bots = [];
const losRaycaster = new THREE.Raycaster();
const BOT_DAMAGE_PER_HIT = 25;       // how much damage one player bullet does to a bot
const BOT_ATTACK_RANGE = 18;         // bot starts shooting within this distance
const BOT_KEEP_DISTANCE = 6;         // bot stops getting closer than this

// Cartoon-style bot: chunkier proportions, saturated palette, oversized head, simple feet.
const BOT_PALETTES = [
  { body: 0xff6b35, accent: 0xc94a1a, head: 0xfff0d8, eyes: 0x111111 }, // orange
  { body: 0x4ac1ff, accent: 0x1c7eb8, head: 0xfff0d8, eyes: 0x111111 }, // blue
  { body: 0xb46cff, accent: 0x7a3fc6, head: 0xfff0d8, eyes: 0x111111 }, // purple
  { body: 0x52d97e, accent: 0x2c9c52, head: 0xfff0d8, eyes: 0x111111 }, // green
];

function createBot(spawnX, spawnZ, conf) {
  const group = new THREE.Group();
  const palette = BOT_PALETTES[Math.floor(Math.random() * BOT_PALETTES.length)];
  const bodyMat   = new THREE.MeshStandardMaterial({ color: palette.body, roughness: 0.6 });
  const accentMat = new THREE.MeshStandardMaterial({ color: palette.accent, roughness: 0.6 });
  const headMat   = new THREE.MeshStandardMaterial({ color: palette.head, roughness: 0.65 });

  // Torso — chunky rounded box
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.95, 1.1, 0.65), bodyMat);
  body.position.y = 1.0;
  body.castShadow = true;

  // Belt accent on torso (decorative)
  const belt = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.18, 0.7), accentMat);
  belt.position.y = 0.5;
  group.add(belt);

  // Legs — pivot at the hip so we can swing them while walking
  const legPivotL = new THREE.Group(); legPivotL.position.set(-0.22, 0.55, 0); group.add(legPivotL);
  const legPivotR = new THREE.Group(); legPivotR.position.set( 0.22, 0.55, 0); group.add(legPivotR);
  const legGeo = new THREE.BoxGeometry(0.32, 0.55, 0.34);
  const legL = new THREE.Mesh(legGeo, accentMat); legL.position.y = -0.28; legL.castShadow = true; legPivotL.add(legL);
  const legR = new THREE.Mesh(legGeo, accentMat); legR.position.y = -0.28; legR.castShadow = true; legPivotR.add(legR);

  // Arms — also pivoted at the shoulder for animation
  const armPivotL = new THREE.Group(); armPivotL.position.set(-0.62, 1.42, 0); group.add(armPivotL);
  const armPivotR = new THREE.Group(); armPivotR.position.set( 0.62, 1.42, 0); group.add(armPivotR);
  const armGeo = new THREE.BoxGeometry(0.3, 0.85, 0.32);
  const armL = new THREE.Mesh(armGeo, bodyMat); armL.position.y = -0.42; armL.castShadow = true; armPivotL.add(armL);
  const armR = new THREE.Mesh(armGeo, bodyMat); armR.position.y = -0.42; armR.castShadow = true; armPivotR.add(armR);

  // OVERSIZED head — Fortnite-ish cartoon proportion
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.8, 0.85), headMat);
  head.position.y = 2.0;
  head.castShadow = true;

  // Eyes — flat black squares
  const eyeMat = new THREE.MeshBasicMaterial({ color: palette.eyes });
  const eyeL = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.14, 0.04), eyeMat);
  const eyeR = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.14, 0.04), eyeMat);
  eyeL.position.set(-0.18, 2.07, -0.43);
  eyeR.position.set( 0.18, 2.07, -0.43);

  // Cap on top of the head (in body color)
  const cap = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.18, 0.95), bodyMat);
  cap.position.y = 2.5;
  cap.castShadow = true;
  group.add(cap);

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
  hpBar.position.y = 2.95;

  group.add(body, head, eyeL, eyeR, hpBar);
  group.position.set(spawnX, 0, spawnZ);
  scene.add(group);

  return {
    group,
    parts: [body, head], // parts that count as hittable
    legPivotL, legPivotR, armPivotL, armPivotR, head,
    walkPhase: Math.random() * Math.PI * 2,
    isMoving: false,
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
  };
}

function spawnOneBot(conf) {
  // Pick a spawn far from the player and not inside an obstacle.
  let x, z, attempts = 0;
  do {
    x = (Math.random() - 0.5) * (ARENA * 1.7);
    z = (Math.random() - 0.5) * (ARENA * 1.7);
    attempts++;
  } while (
    attempts < 30 &&
    (Math.hypot(x - camera.position.x, z - camera.position.z) < 18 || isInsideObstacle(x, z))
  );
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
function scheduleRespawn() {
  if (!game.alive) return;
  const conf = DIFFICULTIES[game.difficulty];
  const aliveCount = bots.filter(b => b.alive).length;
  const inFlight = aliveCount + game.pendingSpawns;
  if (inFlight >= conf.count) return;
  if (game.kills + inFlight >= game.killTarget) return;
  game.pendingSpawns++;
  setTimeout(() => {
    game.pendingSpawns--;
    if (!game.alive) return;
    if (game.kills + bots.filter(b => b.alive).length >= game.killTarget) return;
    spawnOneBot(DIFFICULTIES[game.difficulty]);
  }, 1500);
}

function winGame() {
  game.alive = false;
  Auth.bumpStat('victories', 1);
  Auth.bumpStat('gamesPlayed', 1);
  victoryKillsEl.textContent = game.kills;
  victoryDiffEl.textContent = DIFFICULTIES[game.difficulty].label;
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
function updateBots(dt) {
  for (const bot of bots) {
    if (!bot.alive) continue;

    _toPlayer.set(
      camera.position.x - bot.group.position.x,
      0,
      camera.position.z - bot.group.position.z,
    );
    const dist = _toPlayer.length();

    // Line of sight from bot's head to player's eye
    _from.set(bot.group.position.x, 2.0, bot.group.position.z);
    const sees = game.alive && dist < bot.sightRange && hasLineOfSight(_from, camera.position);

    if (sees) {
      // Face player
      bot.group.lookAt(camera.position.x, bot.group.position.y, camera.position.z);

      // Move toward player but keep some distance
      if (dist > BOT_KEEP_DISTANCE) {
        const step = bot.speed * dt;
        bot.group.position.x += (_toPlayer.x / dist) * step;
        bot.group.position.z += (_toPlayer.z / dist) * step;
        bot.isMoving = true;
      } else {
        bot.isMoving = false;
      }

      // Shoot when in attack range
      bot.fireCooldown -= dt;
      if (dist < BOT_ATTACK_RANGE && bot.fireCooldown <= 0) {
        bot.fireCooldown = bot.fireInterval;
        // Easy bots miss sometimes; harder bots hit more reliably
        const hitChance = bot.damage <= 5 ? 0.55 : bot.damage <= 8 ? 0.75 : 0.9;
        if (Math.random() < hitChance) damagePlayer(bot.damage);
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
      bot.head.position.y = 2.0 + Math.abs(Math.sin(bot.walkPhase * 2)) * 0.04;
    } else {
      // Smoothly settle limbs to rest
      bot.legPivotL.rotation.x *= 0.85;
      bot.legPivotR.rotation.x *= 0.85;
      bot.armPivotL.rotation.x *= 0.85;
      bot.armPivotR.rotation.x *= 0.85;
      bot.head.position.y = 2.0;
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
  const targets = [...wallMeshes, ...botParts];

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
    canPickup: () => game.alive && game.playerHP < game.playerHPMax,
    apply: () => {
      game.playerHP = Math.min(game.playerHPMax, game.playerHP + 50);
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
    canPickup: () => grenades.count < MAX_GRENADES,
    apply: () => {
      grenades.count = Math.min(MAX_GRENADES, grenades.count + 3);
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
    for (let attempt = 0; attempt < 30; attempt++) {
      const x = (Math.random() - 0.5) * (ARENA * 1.6);
      const z = (Math.random() - 0.5) * (ARENA * 1.6);
      if (Math.hypot(x, z) < 8) continue;
      if (isInsideObstacle(x, z)) continue;
      let ok = true;
      for (const p of placedLocal) if (Math.hypot(p.x - x, p.z - z) < 6) { ok = false; break; }
      if (!ok) continue;
      placedLocal.push({ x, z });
      return { x, z };
    }
    return null;
  }
  // Distribution: more medkits + ammo crates than special items
  const PLAN = ['medkit', 'medkit', 'ammo', 'ammo', 'ammo', 'grenade', 'flame'];
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

    // Stamina drain / regen
    if (isSprinting) {
      stamina.value = Math.max(0, stamina.value - STAMINA_DRAIN_PER_SEC * dt);
      stamina.regenCooldown = STAMINA_REGEN_DELAY;
      // If we hit zero, lock out sprint until it recovers a bit (avoids 1-frame spam)
      if (stamina.value === 0) stamina.lockedOut = true;
    } else {
      if (stamina.regenCooldown > 0) {
        stamina.regenCooldown = Math.max(0, stamina.regenCooldown - dt);
      } else {
        stamina.value = Math.min(STAMINA_MAX, stamina.value + STAMINA_REGEN_PER_SEC * dt);
      }
      // Re-enable sprint once we've recovered a meaningful amount
      if (stamina.lockedOut && stamina.value > 25) stamina.lockedOut = false;
    }

    // Update stamina UI (color shifts when low / empty)
    const staminaPct = (stamina.value / STAMINA_MAX) * 100;
    staminaFillEl.style.width = staminaPct + '%';
    staminaTextEl.textContent = Math.round(stamina.value);
    staminaWrapEl.classList.toggle('low', stamina.value < 35 && stamina.value > 0);
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
  tickExplosions(dt);
  tickSparks(dt);
  tickPickups(dt, clock.elapsedTime);
  tickNetSync(dt);

  composer.render();
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
  if (session.user) {
    userBarEl.textContent = session.user.name;
    statsKillsEl.textContent = session.user.stats.kills;
    statsVictoriesEl.textContent = session.user.stats.victories;
    statsDeathsEl.textContent = session.user.stats.deaths;
    userStatsEl.style.display = '';
    adminBadge.classList.toggle('hidden', !session.user.isAdmin);
    adminBtn.classList.toggle('hidden', !session.user.isAdmin);
  } else {
    userBarEl.textContent = 'אורח';
    userStatsEl.style.display = 'none';
    adminBadge.classList.add('hidden');
    adminBtn.classList.add('hidden');
  }
  // Highlight the favorite weapon button
  const fav = getEffectiveFavorite();
  document.querySelectorAll('#overlay .loadout-picks button[data-fav]').forEach(b => {
    b.classList.toggle('fav', b.dataset.fav === fav);
  });
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
      </div>
      <div class="actions"></div>
    `;
    const actionsEl = card.querySelector('.actions');
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
      note.textContent = '(לא ניתן לבצע פעולות על עצמך)';
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

function createRemoteAvatar(profile) {
  const group = new THREE.Group();
  const baseColor = new THREE.Color(profile.color || '#ffd54a');
  const accentColor = baseColor.clone().multiplyScalar(0.6);
  const bodyMat = new THREE.MeshStandardMaterial({ color: baseColor, roughness: 0.55 });
  const accentMat = new THREE.MeshStandardMaterial({ color: accentColor, roughness: 0.6 });
  const headMat = new THREE.MeshStandardMaterial({ color: 0xfff0d8, roughness: 0.6 });

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.1, 0.6), bodyMat);
  body.position.y = 1.0; body.castShadow = true;
  const belt = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.18, 0.7), accentMat);
  belt.position.y = 0.5;
  const legL = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.55, 0.34), accentMat); legL.position.set(-0.22, 0.27, 0); legL.castShadow = true;
  const legR = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.55, 0.34), accentMat); legR.position.set( 0.22, 0.27, 0); legR.castShadow = true;
  const armL = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.85, 0.32), bodyMat); armL.position.set(-0.6, 1.0, 0); armL.castShadow = true;
  const armR = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.85, 0.32), bodyMat); armR.position.set( 0.6, 1.0, 0); armR.castShadow = true;
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.8, 0.85), headMat);
  head.position.y = 2.0; head.castShadow = true;
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0x111111 });
  const eyeL = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.14, 0.04), eyeMat); eyeL.position.set(-0.18, 2.07, -0.43);
  const eyeR = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.14, 0.04), eyeMat); eyeR.position.set( 0.18, 2.07, -0.43);
  const cap = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.18, 0.95), bodyMat);
  cap.position.y = 2.5; cap.castShadow = true;
  group.add(body, belt, legL, legR, armL, armR, head, eyeL, eyeR, cap);

  const label = createNameLabel(profile.name || 'שחקן', profile.color || '#ffd54a');
  label.position.y = 3.1;
  group.add(label);

  return {
    group, label,
    targetPos: new THREE.Vector3(0, 0, 0),
    targetRotY: 0,
    profile,
  };
}

function ensureRemoteAvatar(peerId) {
  if (remotePlayers.has(peerId)) return remotePlayers.get(peerId);
  const profile = net.getPeerProfile(peerId) || { name: 'שחקן', color: '#ffd54a' };
  const av = createRemoteAvatar(profile);
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
    case 'start-game': {
      if (net.isClient()) {
        waitingForHostEl.classList.add('hidden');
        startGame(data.difficulty, data.killTarget);
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
  const msg = {
    type: 'pos',
    pos: [camera.position.x, camera.position.y, camera.position.z],
    rotY: camera.rotation.y,
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
  const stickMag = Math.hypot(touchState.moveX, touchState.moveY);
  keys.shift = touchState.sprinting || stickMag > 0.85;

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
};
