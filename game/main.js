// Remote wrecking-ball crane: first-person cab + Rapier physics
import * as THREE from 'three';
import RAPIER from 'rapier';

await RAPIER.init();

// ====================== Constants ======================
const DT = 1 / 60;
const CLEAR_RATIO = 0.6;         // a building counts as "down" once 65% of its pieces have moved
const SAMPLE_MS = 50;            // 20 Hz telemetry
const UPLOAD_MS = 1000;
const DEG = 180 / Math.PI;
const G = 9.81;

// Crane joints. swing/boom in radians (boom = elevation above horizontal), hoist = cable length in metres.
const JOINTS = {
  swing: { min: -Infinity, max: Infinity, speed: 0.3, accel: 0.35, dir: +1 },
  boom:  { min: 0.42, max: 1.36, speed: 0.16, accel: 0.3, dir: -1 },   // command + = boom down
  hoist: { min: 3, max: 34, speed: 6.0, accel: 10.0, dir: +1 },         // command + = pay out (lower the ball)
};
const JOINT_NAMES = Object.keys(JOINTS);
const START_POSE = { swing: 0, boom: 1.2, hoist: 7 };
const BOOM_L = 34;
const BALL_R = 0.75, BALL_DENSITY = 7800;   // ~13.8 t
const DRAG_ACC = 6.0;                       // drag-line pull (m/s²)
const STEADY = 1.6;                         // anti-sway damping rate (1/s)
const BREAK_SPEED = 1.5;                    // ball speed (m/s) needed to punch pieces out of a wall
const BREAK_RADIUS = 2.6;                   // pieces within this distance of the ball surface take the hit

// Building kit: storey = wall height + slab
const FH = 2.8, ST = 0.3, WT = 0.3, STORY = FH + ST;
const TEMPLATES = [
  { name: 'Slab block', style: 'punch', palette: [0xd8cfc0, 0xcfc5b4, 0xe0d8ca], vols: [{ w: 14, d: 7, floors: 7 }] },
  { name: 'Point tower', style: 'ribbon', palette: [0xe8e8e4, 0xdcdcd6, 0xd2d4d0], vols: [{ w: 7.5, d: 7.5, floors: 10 }] },
  { name: 'Wedding-cake tower', style: 'punch', palette: [0xd9b98c, 0xceac7d, 0xe2c497],
    vols: [{ w: 12, d: 12, floors: 3 }, { w: 9, d: 9, from: 3, floors: 3 }, { w: 6, d: 6, from: 6, floors: 3 }] },
  { name: 'Podium tower', style: 'ribbon', palette: [0xbfc6cc, 0xb3bac1, 0xc8ced3],
    vols: [{ w: 15, d: 11, floors: 2, style: 'curtain' }, { w: 7, d: 7, from: 2, floors: 7 }] },
  { name: 'Glass office', style: 'curtain', palette: [0x7fa6c8, 0x7099bd, 0x88afd0], vols: [{ w: 11, d: 9, floors: 8 }] },
  { name: 'Twin towers', style: 'ribbon', palette: [0xc9c2b8, 0xbdb6ab, 0xd3cdc4],
    vols: [{ ox: -4, w: 6, d: 6, floors: 9 }, { ox: 4, w: 6, d: 6, floors: 9 }] },
  { name: 'Brick tenement', style: 'brick', panel: 1.7, palette: [0xa4553e, 0xb5654a, 0x9a4d38], vols: [{ w: 10, d: 8, floors: 6 }] },
  { name: 'Parking garage', frame: true, palette: [0x9d9d98, 0xa8a8a2], vols: [{ w: 14, d: 10, floors: 5 }] },
  { name: 'L-shaped apartments', style: 'punch', palette: [0xe6d3b0, 0xdcc8a2, 0xefdcbb],
    vols: [{ ox: -3, oz: -3, w: 12, d: 6, floors: 7 }, { ox: 3, oz: 3.55, w: 6, d: 7, floors: 7 }] },
];
const HERITAGE = { name: 'Heritage house', style: 'punch', palette: [0x8fb0d0, 0x9dbcd9, 0x84a4c4], vols: [{ w: 8, d: 6, floors: 2 }] };

// ====================== DOM ======================
const $ = id => document.getElementById(id);
const ui = {
  startOverlay: $('startOverlay'), resultOverlay: $('resultOverlay'),
  startBtn: $('startBtn'), againBtn: $('againBtn'), playerName: $('playerName'),
  latency: $('latency'), latencyVal: $('latencyVal'),
  hud: ['hudTL', 'hudTR', 'hudB', 'help'].map($),
  hTime: $('hTime'), hDemo: $('hDemo'), demoBar: $('demoBar').firstElementChild, hLot: $('hLot'),
  hCleared: $('hCleared'), hCollateral: $('hCollateral'), hStrikes: $('hStrikes'), hLatency: $('hLatency'),
  hSamples: $('hSamples'), hView: $('hView'), hRec: $('hRec'), hPad: $('hPad'),
  gSwing: $('gSwing'), gBoom: $('gBoom'), gHoist: $('gHoist'), gBall: $('gBall'),
  loadBar: $('loadBar').firstElementChild, toast: $('toast'), finishHint: $('finishHint'),
  rTitle: $('rTitle'), rStars: $('rStars'), rTable: $('rTable'), rRank: $('rRank'),
  pairQr: $('pairQr'), pairUrl: $('pairUrl'), pairRoom: $('pairRoom'), pairStatus: $('pairStatus'),
  lotPreview: $('lotPreview'),
};
const store = {
  get(k, d) { try { const v = localStorage.getItem('exc.' + k); return v == null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('exc.' + k, v); } catch { /* private mode */ } },
};
ui.playerName.value = store.get('name', '');
ui.latency.value = store.get('latency', '0');
ui.latencyVal.textContent = ui.latency.value + ' ms';
ui.latency.addEventListener('input', () => { ui.latencyVal.textContent = ui.latency.value + ' ms'; });

// ====================== Three.js scene ======================
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xa9c7e4);
scene.fog = new THREE.Fog(0xa9c7e4, 110, 330);

scene.add(new THREE.HemisphereLight(0xe3edff, 0x5a4a35, 1.0));
const sun = new THREE.DirectionalLight(0xfff3dd, 2.4);
sun.position.set(45, 80, -5);
sun.target.position.set(0, 0, 22);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, near: 1, far: 220 });
sun.shadow.bias = -0.0006;
scene.add(sun, sun.target);

const fpCam = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.05, 600);
const tpCam = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 600);
let thirdPerson = false;
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  for (const c of [fpCam, tpCam]) { c.aspect = innerWidth / innerHeight; c.updateProjectionMatrix(); }
});

function mat(color, opts = {}) { return new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0.1, ...opts }); }
function box(w, h, d, material, x = 0, y = 0, z = 0, parent) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
  if (parent) parent.add(m);
  return m;
}
function canvasTex(size, draw, repeat) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat, repeat); }
  return t;
}

// Ground: procedural dirt
const ground = new THREE.Mesh(new THREE.PlaneGeometry(700, 700), new THREE.MeshStandardMaterial({
  roughness: 1,
  map: canvasTex(512, (g) => {
    g.fillStyle = '#8a7558'; g.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 9000; i++) {
      const v = 100 + Math.random() * 60;
      g.fillStyle = `rgba(${v + 20},${v},${v - 30},${Math.random() * 0.35})`;
      g.fillRect(Math.random() * 512, Math.random() * 512, 2 + Math.random() * 4, 2 + Math.random() * 4);
    }
    g.strokeStyle = 'rgba(60,45,30,.25)'; g.lineWidth = 2;
    for (let i = 0; i <= 512; i += 64) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 512); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(512, i); g.stroke(); }
  }, 70),
}));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

// Background: distant skyline and the site hoarding (decoration only)
{
  const cityMat = [mat(0x9aa3ad), mat(0xb3aa9c), mat(0x8c97a3), mat(0xc2bdb4)];
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2 + Math.random() * 0.04;
    const r = 130 + Math.random() * 60;
    const h = 15 + Math.random() * 70;
    const b = box(10 + Math.random() * 14, h, 10 + Math.random() * 14, cityMat[i % 4], Math.cos(a) * r, h / 2, Math.sin(a) * r + 20);
    b.castShadow = false;
    scene.add(b);
  }
  const fence = [];
  const X0 = -64, X1 = 64, Z0 = -26, Z1 = 74, P = 4;
  for (let x = X0; x < X1; x += P) fence.push([x + P / 2, Z0, 0], [x + P / 2, Z1, 0]);
  for (let z = Z0; z < Z1; z += P) fence.push([X0, z + P / 2, Math.PI / 2], [X1, z + P / 2, Math.PI / 2]);
  const fm = new THREE.InstancedMesh(new THREE.BoxGeometry(P, 2.2, 0.1), mat(0xffffff), fence.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), c = new THREE.Color();
  fence.forEach(([x, z, ry], i) => {
    fm.setMatrixAt(i, m4.compose(new THREE.Vector3(x, 1.1, z), q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), ry), new THREE.Vector3(1, 1, 1)));
    fm.setColorAt(i, c.setHex(i % 4 < 2 ? 0xf5b800 : 0x1d1f22));
  });
  fm.receiveShadow = true; scene.add(fm);
}

// Facade textures: tinted per piece by the instance colour
const FACADE = {
  punch: canvasTex(128, (g, s) => {
    g.fillStyle = '#f4f2ee'; g.fillRect(0, 0, s, s);
    g.fillStyle = '#d9d6cf'; g.fillRect(0, s * 0.94, s, s * 0.06);
    const grd = g.createLinearGradient(0, s * 0.22, s, s * 0.72);
    grd.addColorStop(0, '#5a6b7e'); grd.addColorStop(1, '#232c37');
    g.fillStyle = grd; g.fillRect(s * 0.2, s * 0.22, s * 0.6, s * 0.48);
    g.fillStyle = '#e8e5df'; g.fillRect(s * 0.18, s * 0.7, s * 0.64, s * 0.05);
    g.fillRect(s * 0.49, s * 0.22, s * 0.02, s * 0.48);
  }),
  ribbon: canvasTex(128, (g, s) => {
    g.fillStyle = '#f4f2ee'; g.fillRect(0, 0, s, s);
    const grd = g.createLinearGradient(0, s * 0.3, 0, s * 0.72);
    grd.addColorStop(0, '#6d8296'); grd.addColorStop(1, '#2a3440');
    g.fillStyle = grd; g.fillRect(0, s * 0.3, s, s * 0.42);
    g.fillStyle = '#cfd3d6'; for (const x of [0, 0.33, 0.66]) g.fillRect(s * x, s * 0.3, s * 0.025, s * 0.42);
  }),
  curtain: canvasTex(128, (g, s) => {
    const grd = g.createLinearGradient(0, 0, s, s);
    grd.addColorStop(0, '#e8f0f8'); grd.addColorStop(1, '#9fb2c4');
    g.fillStyle = grd; g.fillRect(0, 0, s, s);
    g.fillStyle = '#4b5562'; g.fillRect(0, s * 0.82, s, s * 0.18);
    for (const x of [0, 0.5]) g.fillRect(s * x, 0, s * 0.03, s);
    g.fillRect(0, s * 0.4, s, s * 0.02);
  }),
  brick: canvasTex(128, (g, s) => {
    g.fillStyle = '#f0ece6'; g.fillRect(0, 0, s, s);
    g.fillStyle = '#c9c3ba';
    for (let r = 0; r < 16; r++) { g.fillRect(0, r * 8, s, 1.5); for (let k = 0; k < 6; k++) g.fillRect(((k * 24) + (r % 2) * 12) % s, r * 8, 1.5, 8); }
    g.fillStyle = '#26303b'; g.fillRect(s * 0.28, s * 0.25, s * 0.44, s * 0.45);
    g.fillStyle = '#e9e4dc'; g.fillRect(s * 0.25, s * 0.7, s * 0.5, s * 0.05);
  }),
};
const facadeMat = {
  punch: mat(0xffffff, { map: FACADE.punch, roughness: 0.85 }),
  ribbon: mat(0xffffff, { map: FACADE.ribbon, roughness: 0.75 }),
  curtain: mat(0xffffff, { map: FACADE.curtain, roughness: 0.25, metalness: 0.35 }),
  brick: mat(0xffffff, { map: FACADE.brick, roughness: 0.95 }),
};
const structMat = mat(0xffffff, { roughness: 0.92 });

// ====================== Rapier physics world ======================
let world, eventQueue;
const colliderTag = new Map(); // collider handle -> 'machine' | 'boom' | 'ball' | 'target' | 'neighbor' | 'ground'
function initWorld() {
  world = new RAPIER.World({ x: 0, y: -G, z: 0 });
  world.timestep = DT;
  world.integrationParameters.numSolverIterations = 8;
  eventQueue = new RAPIER.EventQueue(true);
  colliderTag.clear(); pieceByCollider.clear();
  const g = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const c = world.createCollider(RAPIER.ColliderDesc.cuboid(350, 0.5, 350).setTranslation(0, -0.5, 0).setFriction(1.0), g);
  colliderTag.set(c.handle, 'ground');
}

// ====================== Crawler crane (kinematic bodies driven by joint values) ======================
const red = mat(0xc8302a, { roughness: 0.5, metalness: 0.25 });
const yellow = mat(0xf2b416, { roughness: 0.55, metalness: 0.2 });
const darkSteel = mat(0x2b2e33, { roughness: 0.7, metalness: 0.4 });
const blackRubber = mat(0x151617, { roughness: 0.95 });
const steel = mat(0x6c7178, { roughness: 0.5, metalness: 0.6 });
const cabMat = mat(0x24272c, { roughness: 0.6, metalness: 0.3 });
const glass = new THREE.MeshStandardMaterial({ color: 0x9fc3d8, transparent: true, opacity: 0.1, roughness: 0.05, metalness: 0.2, depthWrite: false, side: THREE.DoubleSide });

const rig = {};
rig.chassis = new THREE.Group(); scene.add(rig.chassis);
box(1.2, 1.2, 8.0, blackRubber, 2.4, 0.6, 0, rig.chassis);
box(1.2, 1.2, 8.0, blackRubber, -2.4, 0.6, 0, rig.chassis);
box(3.6, 0.6, 4.5, darkSteel, 0, 0.9, 0, rig.chassis);
for (const x of [2.4, -2.4]) for (let z = -3.5; z <= 3.5; z += 0.5) box(1.25, 0.08, 0.18, darkSteel, x, 1.22, z, rig.chassis);

rig.house = new THREE.Group(); rig.house.position.set(0, 1.4, 0); rig.chassis.add(rig.house);
box(4.0, 2.0, 6.4, red, 0, 1.0, -0.6, rig.house);
box(4.2, 1.6, 1.6, darkSteel, 0, 1.1, -4.4, rig.house);         // counterweight
box(4.2, 0.12, 0.3, yellow, 0, 1.95, -5.2, rig.house);           // counterweight stripe
// Gantry (A-frame) that carries the boom pendants
for (const x of [1.2, -1.2]) {
  const p = box(0.22, 6.2, 0.22, steel, x, 4.6, -2.6, rig.house); p.rotation.x = -0.18;
}
box(2.7, 0.3, 0.3, steel, 0, 7.6, -2.05, rig.house);
rig.gantryTop = new THREE.Object3D(); rig.gantryTop.position.set(0, 7.7, -2.05); rig.house.add(rig.gantryTop);
rig.fairlead = new THREE.Object3D(); rig.fairlead.position.set(0, 1.4, 2.8); rig.house.add(rig.fairlead);
box(0.8, 0.5, 0.4, darkSteel, 0, 1.4, 2.65, rig.house);          // drag-line fairlead
// Operator cab on the left front (local +x)
{
  const H = rig.house;
  box(1.2, 0.2, 2.2, cabMat, 2.65, 0.9, 1.3, H);                  // floor
  for (const [x, z] of [[2.07, 2.4], [3.23, 2.4], [2.07, 0.2], [3.23, 0.2]]) box(0.07, 2.1, 0.07, cabMat, x, 2.05, z, H);
  box(1.25, 0.08, 2.3, red, 2.65, 3.12, 1.3, H);                  // roof
  box(1.2, 0.3, 0.07, cabMat, 2.65, 1.15, 2.4, H);               // dash
  box(0.6, 0.12, 0.35, darkSteel, 2.65, 1.32, 2.15, H);
  box(1.2, 0.95, 0.07, cabMat, 2.65, 1.45, 0.2, H);              // rear wall
  const gl = (w, h, x, y, z, ry = 0, rx = 0) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), glass); m.position.set(x, y, z); m.rotation.set(rx, ry, 0, 'YXZ'); H.add(m); };
  gl(1.12, 1.8, 2.65, 2.15, 2.4); gl(2.2, 1.9, 2.07, 2.05, 1.3, Math.PI / 2); gl(2.2, 1.9, 3.23, 2.05, 1.3, Math.PI / 2);
  gl(1.1, 1.6, 2.65, 3.08, 1.6, 0, -Math.PI / 2);                 // roof window: look up at the boom
  for (const x of [2.35, 2.95]) { box(0.04, 0.3, 0.04, cabMat, x, 1.3, 1.65, H); box(0.08, 0.1, 0.08, mat(0x111111), x, 1.47, 1.65, H); }
}
rig.camMount = new THREE.Group(); rig.camMount.position.set(2.65, 2.15, 1.35); rig.camMount.rotation.y = Math.PI;
rig.house.add(rig.camMount);
fpCam.rotation.order = 'YXZ';
rig.camMount.add(fpCam);

// Lattice boom: four chords + instanced lacing
rig.boomPivot = new THREE.Group(); rig.boomPivot.position.set(0, 2.2, 2.0); rig.house.add(rig.boomPivot);
{
  const B = rig.boomPivot, hw = 0.6;
  for (const [x, y] of [[hw, hw], [-hw, hw], [hw, -hw], [-hw, -hw]]) box(0.14, 0.14, BOOM_L, red, x, y, BOOM_L / 2, B);
  box(1.6, 1.0, 1.2, red, 0, 0, 0.3, B);                                   // foot
  box(1.4, 1.4, 1.0, red, 0, 0, BOOM_L - 0.3, B);                           // head
  const sheave = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.3, 16), darkSteel);
  sheave.rotation.z = Math.PI / 2; sheave.position.set(0, -0.2, BOOM_L + 0.2); B.add(sheave);
  const SEG = 1.7, n = Math.floor((BOOM_L - 1.6) / SEG), mats = [];
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), pos = new THREE.Vector3(), sc = new THREE.Vector3();
  const diagLen = Math.hypot(2 * hw, SEG);
  for (let i = 0; i < n; i++) {
    const z = 1.0 + SEG * (i + 0.5), flip = i % 2 ? 1 : -1;
    const tilt = Math.atan2(2 * hw, SEG) * flip;
    for (const y of [hw, -hw]) { e.set(0, tilt, 0); mats.push(m4.compose(pos.set(0, y, z), q.setFromEuler(e), sc.set(0.07, 0.07, diagLen)).clone()); }
    for (const x of [hw, -hw]) { e.set(tilt, 0, 0); mats.push(m4.compose(pos.set(x, 0, z), q.setFromEuler(e), sc.set(0.07, 0.07, diagLen)).clone()); }
  }
  const lacing = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), steel, mats.length);
  mats.forEach((m, i) => lacing.setMatrixAt(i, m));
  lacing.castShadow = true; B.add(lacing);
}
rig.tip = new THREE.Object3D(); rig.tip.position.set(0, -0.6, BOOM_L + 0.2); rig.boomPivot.add(rig.tip);
rig.pendant = new THREE.Object3D(); rig.pendant.position.set(0, 0.7, BOOM_L - 0.4); rig.boomPivot.add(rig.pendant);

// Ropes are cylinders re-stretched every frame between two world points
const ropeMat = mat(0x1c1d1f, { metalness: 0.6, roughness: 0.45 });
function rope(r) { const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 1, 6, 1), ropeMat); m.castShadow = true; m.frustumCulled = false; scene.add(m); return m; }
const ropes = { hoist: rope(0.045), drag: rope(0.04), pendL: rope(0.05), pendR: rope(0.05) };
const _up = new THREE.Vector3(0, 1, 0), _rd = new THREE.Vector3();
function stretchRope(m, a, b) {
  _rd.subVectors(b, a); const len = _rd.length();
  m.position.addVectors(a, b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(_up, _rd.divideScalar(len || 1));
  m.scale.set(1, Math.max(len, 0.01), 1);
}

// Wrecking ball visual
const ballMesh = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 28, 20), mat(0x2a2c30, { metalness: 0.75, roughness: 0.38 }));
ballMesh.castShadow = true; scene.add(ballMesh);
const shackle = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.06, 8, 16), steel);
shackle.castShadow = true; scene.add(shackle);

const machine = { parts: [] }; // { obj, body }
const ball = { body: null, mass: 0 };
function createMachineBodies() {
  machine.parts = [];
  const mk = (obj, shapes, tag, physical = true) => {
    obj.updateWorldMatrix(true, false);
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    obj.matrixWorld.decompose(p, q, s);
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(p.x, p.y, p.z).setRotation(q));
    for (const [hx, hy, hz, x, y, z] of shapes) {
      if (!physical) continue;
      const c = world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z).setFriction(0.9)
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(2000), body);
      colliderTag.set(c.handle, tag);
    }
    machine.parts.push({ obj, body, tag, shapes: shapes.map(([hx, hy, hz, x, y, z]) => ({ shape: new RAPIER.Cuboid(hx, hy, hz), off: new THREE.Vector3(x, y, z) })) });
  };
  mk(rig.chassis, [[3.0, 0.6, 4.0, 0, 0.6, 0]], 'machine');
  mk(rig.house, [[2.1, 1.0, 3.4, 0, 1.0, -0.8], [0.6, 1.1, 1.1, 2.65, 2.0, 1.3]], 'machine');
  // The boom never pushes buildings: it is only used for overlap checks that stop the crane (see rigBlocked)
  mk(rig.boomPivot, [[0.7, 0.7, BOOM_L / 2 - 2, 0, 0, BOOM_L / 2 + 1.5]], 'boom', false);
  // The ball: a heavy dynamic sphere hanging on a one-sided cable constraint (see physicsStep)
  rig.tip.getWorldPosition(_v);
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(_v.x, _v.y - game.joints.hoist, _v.z)
    .setCcdEnabled(true).setCanSleep(false).setLinearDamping(0.02).setAngularDamping(1.5));
  const c = world.createCollider(RAPIER.ColliderDesc.ball(BALL_R).setDensity(BALL_DENSITY).setFriction(0.6).setRestitution(0.1)
    .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(20000), body);
  colliderTag.set(c.handle, 'ball');
  ball.body = body; ball.mass = body.mass();
  game.prevTip.copy(_v);
}

// ====================== Buildings (stacked wall panels + floor slabs) ======================
const unitBox = new THREE.BoxGeometry(1, 1, 1);
const level = { houses: [], extraMeshes: [] };
const pieceByCollider = new Map();

function footprintRadius(t) {
  let r = 0;
  for (const v of t.vols) for (const sx of [-1, 1]) for (const sz of [-1, 1]) r = Math.max(r, Math.hypot((v.ox || 0) + sx * v.w / 2, (v.oz || 0) + sz * v.d / 2));
  return r;
}
function buildBuilding(tpl, cx, cz, yaw, kind) {
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  const rot = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
  const pieces = [];
  const pick = () => tpl.palette[(Math.random() * tpl.palette.length) | 0];
  const add = (group, lx, y, lz, w, h, d, color, density) => {
    const x = cx + lx * cos + lz * sin, z = cz - lx * sin + lz * cos;
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z).setRotation(rot).setSleeping(true)
      .setLinearDamping(0.05).setAngularDamping(0.15));
    const c = world.createCollider(RAPIER.ColliderDesc.cuboid(w / 2, h / 2, d / 2).setDensity(density).setFriction(0.6).setRestitution(0.02), body);
    colliderTag.set(c.handle, kind);
    const piece = { group, body, collider: c, size: [w, h, d], origin: new THREE.Vector3(x, y, z), color, moved: false, broken: false, idx: 0 };
    pieceByCollider.set(c.handle, piece);
    pieces.push(piece);
  };
  const slabs = (v, base) => {
    const y = base + FH + ST / 2, ox = v.ox || 0, oz = v.oz || 0, sc = 0x9c9a94;
    if (v.w >= 8) for (const s of [-1, 1]) add('struct', ox + s * v.w / 4, y, oz, v.w / 2 - 0.02, ST - 0.004, v.d, sc, 1100);
    else add('struct', ox, y, oz, v.w, ST - 0.004, v.d, sc, 1100);
  };
  for (const v of tpl.vols) {
    const ox = v.ox || 0, oz = v.oz || 0, from = v.from || 0, P = tpl.panel || 2.6;
    const style = v.style || tpl.style;
    for (let f = 0; f < v.floors; f++) {
      const base = (from + f) * STORY, y = base + FH / 2;
      if (tpl.frame) {
        const nx = Math.max(2, Math.round(v.w / 4.5) + 1), nz = Math.max(2, Math.round(v.d / 4.5) + 1);
        for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) {
          add('struct', ox - v.w / 2 + 0.4 + (v.w - 0.8) * i / (nx - 1), y, oz - v.d / 2 + 0.4 + (v.d - 0.8) * k / (nz - 1), 0.6, FH - 0.004, 0.6, pick(), 2400);
        }
        // Low parapets so it still reads as a car park
        slabs(v, base);
        continue;
      }
      const even = (from + f) % 2 === 0;
      const longLen = even ? v.w : v.w - 2 * WT, shortLen = even ? v.d - 2 * WT : v.d;
      const nl = Math.max(1, Math.round(longLen / P)), ns = Math.max(1, Math.round(shortLen / P));
      for (const zs of [-1, 1]) for (let i = 0; i < nl; i++) {
        const bl = longLen / nl;
        add(style, ox - longLen / 2 + bl * (i + 0.5), y, oz + zs * (v.d / 2 - WT / 2), bl - 0.01, FH - 0.004, WT, pick(), 1200);
      }
      for (const xs of [-1, 1]) for (let i = 0; i < ns; i++) {
        const bl = shortLen / ns;
        add(style, ox + xs * (v.w / 2 - WT / 2), y, oz - shortLen / 2 + bl * (i + 0.5), WT, FH - 0.004, bl - 0.01, pick(), 1200);
      }
      slabs(v, base);
    }
  }
  // One InstancedMesh per material group
  const meshes = {};
  const groups = [...new Set(pieces.map(p => p.group))];
  const col = new THREE.Color();
  for (const gname of groups) {
    const list = pieces.filter(p => p.group === gname);
    const mesh = new THREE.InstancedMesh(unitBox, gname === 'struct' ? structMat : facadeMat[gname], list.length);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    list.forEach((p, i) => { p.idx = i; p.mesh = mesh; mesh.setColorAt(i, col.setHex(p.color)); });
    scene.add(mesh); meshes[gname] = mesh;
  }
  // Ground marker: yellow for targets, blue for the protected building
  const r = footprintRadius(tpl) + 1.2;
  const ring = new THREE.Mesh(new THREE.RingGeometry(r, r + 0.35, 64), new THREE.MeshBasicMaterial({ color: kind === 'target' ? 0xf5b800 : 0x4da3ff, transparent: true, opacity: 0.7 }));
  ring.rotation.x = -Math.PI / 2; ring.position.set(cx, 0.03, cz); scene.add(ring); level.extraMeshes.push(ring);
  const house = { kind, name: tpl.name, pieces, meshes, ratio: 0, cleared: false, center: new THREE.Vector3(cx, 0, cz), r: footprintRadius(tpl) };
  level.houses.push(house);
  return house;
}

function signPost(text, x, z, faceYaw, color) {
  const tex = canvasTex(256, (g, s) => {
    g.fillStyle = color; g.fillRect(0, 0, s, s);
    g.fillStyle = '#fff'; g.font = 'bold 44px system-ui,sans-serif'; g.textAlign = 'center';
    text.split('\n').forEach((l, i) => g.fillText(l, s / 2, 100 + i * 56));
  });
  const grp = new THREE.Group();
  const board = new THREE.Mesh(new THREE.PlaneGeometry(3, 3), new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
  board.position.y = 3.6; grp.add(board);
  box(0.12, 2.2, 0.12, steel, 0, 1.1, 0, grp);
  grp.position.set(x, 0, z); grp.rotation.y = faceYaw;
  scene.add(grp); level.extraMeshes.push(grp);
}

// Pick 1–3 random templates and place them in a fan in front of the crane, plus one protected house
function generateLot() {
  // ?lot=0,4 forces specific templates (handy for demos and recordings)
  const forced = (new URLSearchParams(location.search).get('lot') || '').split(',').map(Number).filter(i => TEMPLATES[i]).slice(0, 3);
  const n = 1 + ((Math.random() * 3) | 0);
  const pool = forced.length ? forced.map(i => TEMPLATES[i]) : [...TEMPLATES].sort(() => Math.random() - 0.5).slice(0, n);
  const placed = [];
  const tryPlace = (tpl, rMin, rMax) => {
    const br = footprintRadius(tpl);
    for (let k = 0; k < 400; k++) {
      const grow = Math.floor(k / 80) * 5;
      const a = (Math.random() * 2 - 1) * 1.35, r = rMin + br + grow + Math.random() * (rMax - rMin);
      const x = Math.sin(a) * r, z = Math.cos(a) * r;
      if (placed.every(p => Math.hypot(p.x - x, p.z - z) > p.br + br + 4)) {
        const yaw = Math.atan2(x, z) + (Math.random() < 0.5 ? 0 : Math.PI / 2);
        const item = { tpl, x, z, br, yaw };
        placed.push(item);
        return item;
      }
    }
    return null;
  };
  const targets = pool.map(t => tryPlace(t, 16, 9)).filter(Boolean);
  const keep = tryPlace(HERITAGE, 14, 16);
  for (const p of targets) buildBuilding(p.tpl, p.x, p.z, p.yaw, 'target');
  if (keep) {
    buildBuilding(HERITAGE, keep.x, keep.z, keep.yaw, 'neighbor');
    const toCrane = Math.atan2(-keep.x, -keep.z);
    signPost('HERITAGE\nDO NOT\nDEMOLISH', keep.x - Math.sin(Math.atan2(keep.x, keep.z)) * (keep.br + 3), keep.z - Math.cos(Math.atan2(keep.x, keep.z)) * (keep.br + 3), toCrane, '#1f6fd1');
  }
}

// ====================== Particles (dust) ======================
const DUST_N = 700;
const dust = { pos: new Float32Array(DUST_N * 3), vel: new Float32Array(DUST_N * 3), life: new Float32Array(DUST_N), i: 0 };
const dustGeo = new THREE.BufferGeometry();
dustGeo.setAttribute('position', new THREE.BufferAttribute(dust.pos, 3));
const dustPts = new THREE.Points(dustGeo, new THREE.PointsMaterial({ color: 0xcdbb9c, size: 0.6, transparent: true, opacity: 0.55, depthWrite: false }));
dustPts.frustumCulled = false; scene.add(dustPts);
for (let i = 0; i < DUST_N; i++) dust.pos[i * 3 + 1] = -100;
function emitDust(p, n, spread = 1) {
  for (let k = 0; k < n; k++) {
    const i = dust.i = (dust.i + 1) % DUST_N;
    dust.pos.set([p.x + (Math.random() - .5) * spread, p.y + Math.random() * .5, p.z + (Math.random() - .5) * spread], i * 3);
    dust.vel.set([(Math.random() - .5) * 3, 0.4 + Math.random() * 2, (Math.random() - .5) * 3], i * 3);
    dust.life[i] = 1.5 + Math.random() * 1.5;
  }
}
function updateDust(dt) {
  for (let i = 0; i < DUST_N; i++) {
    if (dust.life[i] <= 0) continue;
    dust.life[i] -= dt;
    for (let a = 0; a < 3; a++) dust.pos[i * 3 + a] += dust.vel[i * 3 + a] * dt;
    dust.vel[i * 3 + 1] -= 0.5 * dt;
    if (dust.life[i] <= 0) dust.pos[i * 3 + 1] = -100;
  }
  dustGeo.attributes.position.needsUpdate = true;
}

// ====================== Audio (synthesised live with WebAudio) ======================
const audio = { ctx: null };
function initAudio() {
  if (audio.ctx) return;
  try {
    const ctx = new AudioContext();
    const master = ctx.createGain(); master.gain.value = 0.5; master.connect(ctx.destination);
    const eng = ctx.createOscillator(); eng.type = 'sawtooth'; eng.frequency.value = 42;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 320;
    const eg = ctx.createGain(); eg.gain.value = 0.09;
    eng.connect(lp).connect(eg).connect(master); eng.start();
    const hyd = ctx.createOscillator(); hyd.type = 'triangle'; hyd.frequency.value = 220;
    const hg = ctx.createGain(); hg.gain.value = 0;
    hyd.connect(hg).connect(master); hyd.start();
    const noise = ctx.createBuffer(1, ctx.sampleRate * 0.9, ctx.sampleRate);
    const ch = noise.getChannelData(0); for (let i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / ch.length, 2);
    Object.assign(audio, { ctx, master, eng, lp, eg, hyd, hg, noise, lastHit: 0 });
  } catch { /* still playable without sound */ }
}
function audioUpdate(activity, load) {
  if (!audio.ctx) return;
  const t = audio.ctx.currentTime;
  audio.eng.frequency.setTargetAtTime(40 + activity * 16 + load * 20, t, 0.2);
  audio.lp.frequency.setTargetAtTime(300 + activity * 240 + load * 400, t, 0.2);
  audio.hyd.frequency.setTargetAtTime(180 + activity * 160, t, 0.1);
  audio.hg.gain.setTargetAtTime(0.014 * activity, t, 0.08);
}
function audioHit(strength, freq = 500) {
  if (!audio.ctx || strength < 0.04) return;
  const now = performance.now(); if (now - audio.lastHit < 80) return; audio.lastHit = now;
  const src = audio.ctx.createBufferSource(); src.buffer = audio.noise;
  const f = audio.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = freq;
  const g = audio.ctx.createGain(); g.gain.value = Math.min(1, strength);
  src.connect(f).connect(g).connect(audio.master); src.start();
}

// ====================== Input: keyboard / gamepad / phone ======================
const AXES = ['swing', 'hoist', 'boom', 'drag', 'drive', 'turn'];
const keys = new Set();
addEventListener('keydown', e => {
  if (document.activeElement && document.activeElement.tagName === 'INPUT') {
    if (e.key === 'Enter' && game.phase === 'menu') startGame();
    return;
  }
  keys.add(e.code);
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  if (e.repeat) return;
  if (e.code === 'KeyV') toggleView();
  if (e.code === 'KeyH') { const h = ui.hud[3]; h.style.display = h.style.display === 'none' ? '' : 'none'; }
  if (e.code === 'BracketLeft') setLatency(game.latency - 50);
  if (e.code === 'BracketRight') setLatency(game.latency + 50);
  if (e.code === 'Enter') {
    if (game.phase === 'menu') startGame();
    else if (game.phase === 'play') tryFinish();
    else if (game.phase === 'result') resetLevel();
  }
});
addEventListener('keyup', e => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
const kAxis = (pos, neg) => (keys.has(pos) ? 1 : 0) - (keys.has(neg) ? 1 : 0);
function keyboardInput() {
  return {
    swing: kAxis('KeyA', 'KeyD'), hoist: kAxis('KeyW', 'KeyS'), boom: kAxis('KeyI', 'KeyK'),
    drag: kAxis('KeyJ', 'KeyL'), drive: kAxis('ArrowUp', 'ArrowDown'), turn: kAxis('ArrowLeft', 'ArrowRight'),
  };
}
const dz = v => Math.abs(v) < 0.12 ? 0 : (v - Math.sign(v) * 0.12) / 0.88;
// Raw stick values (right/down positive) → crane commands
function sticksToAxes(lx, ly, rx, ry) {
  return { swing: -dz(lx), hoist: -dz(ly), boom: -dz(ry), drag: -dz(rx) };
}
let gpPrevA = false, gpPrevY = false;
function gamepadInput() {
  const gps = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const gp of gps) {
    if (!gp || gp.axes.length < 4) continue;
    const a = sticksToAxes(gp.axes[0], gp.axes[1], gp.axes[2], gp.axes[3]);
    const b = i => (gp.buttons[i] && gp.buttons[i].pressed ? 1 : 0);
    a.drive = b(12) - b(13); a.turn = b(14) - b(15);
    const A = !!b(0), Y = !!b(3);
    if (A && !gpPrevA) { if (game.phase === 'menu') startGame(); else if (game.phase === 'play') tryFinish(); else resetLevel(); }
    if (Y && !gpPrevY) toggleView();
    gpPrevA = A; gpPrevY = Y;
    game.gamepad = gp;
    return a;
  }
  game.gamepad = null;
  return null;
}
// Phone controller
let lanOrigin = null;
const infoReady = fetch('/api/info').then(r => r.json()).then(j => { lanOrigin = j.lanUrl; }).catch(() => {});
const pad = { ws: null, room: null, pads: 0, input: null, lastAt: 0, retry: 0 };
function connectPadRelay() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let ws;
  try { ws = new WebSocket(`${proto}://${location.host}/ws?role=game`); } catch { return; }
  pad.ws = ws;
  ws.onopen = () => { pad.retry = 0; };
  ws.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.t === 'room') {
      pad.room = m.room;
      const local = /^(localhost|127\.|\[::1\])/.test(location.hostname);
      const url = `${(local && lanOrigin) || location.origin}/pad/?room=${m.room}`;
      ui.pairRoom.textContent = m.room;
      ui.pairUrl.textContent = url;
      ui.pairQr.src = '/api/qr?text=' + encodeURIComponent(url);
    } else if (m.t === 'padJoined' || m.t === 'padLeft') {
      pad.pads = m.pads;
      ui.pairStatus.textContent = m.pads ? `${m.pads} phone${m.pads > 1 ? 's' : ''} connected` : 'Waiting for phone…';
      ui.pairStatus.classList.toggle('on', m.pads > 0);
      toast(m.t === 'padJoined' ? '📱 Phone controller connected' : '📱 Phone controller disconnected');
      if (game.phase === 'play') logEvent(m.t === 'padJoined' ? 'pad_joined' : 'pad_left', { pads: m.pads });
      padSend({ t: 'state', phase: game.phase });
    } else if (m.t === 'in') {
      pad.input = sticksToAxes(+m.lx || 0, +m.ly || 0, +m.rx || 0, +m.ry || 0);
      pad.input.drive = clamp(+m.drive || 0, -1, 1); pad.input.turn = clamp(+m.turn || 0, -1, 1);
      pad.lastAt = performance.now();
    } else if (m.t === 'btn') {
      if (m.b === 'start' && game.phase === 'menu') startGame();
      else if (m.b === 'finish' && game.phase === 'play') tryFinish();
      else if (m.b === 'again' && game.phase === 'result') resetLevel();
      else if (m.b === 'view') toggleView();
      else if (m.b === 'latency') setLatency(+m.v || 0);
    }
  };
  ws.onclose = () => {
    pad.ws = null; pad.room = null; pad.pads = 0;
    ui.pairStatus.textContent = 'Reconnecting…'; ui.pairStatus.classList.remove('on');
    setTimeout(connectPadRelay, Math.min(8000, 1000 * 2 ** pad.retry++));
  };
}
function padSend(obj) { if (pad.ws && pad.ws.readyState === 1) pad.ws.send(JSON.stringify(obj)); }
function phoneInput() {
  // Dead-man switch: no phone signal for 400 ms means the sticks are released
  if (!pad.input || performance.now() - pad.lastAt > 400) return null;
  return pad.input;
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function readInputs() {
  const srcs = [], out = Object.fromEntries(AXES.map(a => [a, 0]));
  const k = keyboardInput(), g = gamepadInput(), p = phoneInput();
  const any = o => o && AXES.some(a => o[a] !== 0);
  for (const [name, o] of [['kbd', k], ['gamepad', g], ['phone', p]]) {
    if (!o) continue;
    if (any(o)) srcs.push(name);
    for (const a of AXES) out[a] += o[a] || 0;
  }
  for (const a of AXES) out[a] = clamp(out[a], -1, 1);
  out.src = srcs.join('+') || '-';
  return out;
}

// ====================== Game state ======================
const game = {
  phase: 'menu', latency: 0, t: 0, timeLimit: 300, joints: { ...START_POSE }, vel: { swing: 0, boom: 0, hoist: 0 },
  ideal: { ...START_POSE }, base: { x: 0, z: 0, heading: 0 }, load: 0, tension: 0, frameForce: 0, sampleForce: 0,
  inputHist: [], raw: null, delayed: null, sessionId: null, samples: [], events: [], sampleCount: 0,
  lastSampleAt: 0, lastUploadAt: 0, demo: 0, cleared: 0, targets: 0, collateral: 0, strikes: 0, lastStrikeAt: 0,
  reversals: 0, lastCmdSign: {}, bigHits: 0, shake: 0, headYaw: 0, headPitch: 0, finishedOnce: false,
  online: true, gamepad: null, lastSrc: '-', prevTip: new THREE.Vector3(), hitAt: new THREE.Vector3(),
};

function setLatency(v) {
  game.latency = clamp(Math.round(v / 50) * 50, 0, 500);
  ui.latency.value = game.latency; ui.latencyVal.textContent = game.latency + ' ms';
  ui.hLatency.textContent = game.latency + ' ms';
  store.set('latency', game.latency);
  if (game.phase === 'play') { logEvent('latency_change', { value: game.latency }); toast(`Latency ${game.latency} ms`); }
}
function toggleView() {
  thirdPerson = !thirdPerson;
  ui.hView.textContent = thirdPerson ? 'Third person (debug)' : 'Cab';
}
let toastTimer;
function toast(msg, ms = 1800) {
  ui.toast.textContent = msg; ui.toast.style.opacity = 1;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { ui.toast.style.opacity = 0; }, ms);
}
function haptic(strength, ms) {
  const gp = game.gamepad;
  try { gp && gp.vibrationActuator && gp.vibrationActuator.playEffect('dual-rumble', { duration: ms, strongMagnitude: Math.min(1, strength), weakMagnitude: Math.min(1, strength * 0.6) }); } catch { /* unsupported */ }
  if (pad.pads) padSend({ t: 'haptic', ms: Math.round(ms), s: Math.min(1, strength) });
}

// ====================== Level setup / reset ======================
function resetLevel() {
  for (const h of level.houses) for (const m of Object.values(h.meshes)) { scene.remove(m); m.dispose(); }
  for (const m of level.extraMeshes) scene.remove(m);
  level.houses = []; level.extraMeshes = [];
  if (world) world.free();
  initWorld();
  Object.assign(game, {
    joints: { ...START_POSE }, vel: { swing: 0, boom: 0, hoist: 0 }, ideal: { ...START_POSE },
    base: { x: 0, z: 0, heading: 0 }, load: 0, tension: 0, t: 0, inputHist: [], samples: [], events: [], sampleCount: 0,
    demo: 0, cleared: 0, collateral: 0, strikes: 0, reversals: 0, lastCmdSign: {}, bigHits: 0, shake: 0,
    finishedOnce: false, sessionId: null,
  });
  generateLot();
  const targets = level.houses.filter(h => h.kind === 'target');
  // Start facing the first target
  if (targets.length) game.joints.swing = game.ideal.swing = Math.atan2(targets[0].center.x, targets[0].center.z);
  applyRig();
  createMachineBodies();
  game.targets = targets.length;
  game.timeLimit = 120 + 100 * targets.length;
  ui.lotPreview.textContent = `Today's lot: ${targets.map(h => h.name).join(' · ')} (${fmtTime(game.timeLimit)})`;
  ui.hLot.textContent = targets.map(h => h.name).join(' · ');
  syncDynamicMeshes(true);
  ui.resultOverlay.style.display = 'none';
  ui.finishHint.style.display = 'none';
  if (game.phase === 'result') { game.phase = 'menu'; startGame(); }
}

function applyRig() {
  const { joints: j, base } = game;
  rig.chassis.position.set(base.x, 0, base.z);
  rig.chassis.rotation.y = base.heading;
  rig.house.rotation.y = j.swing;
  rig.boomPivot.rotation.x = -j.boom;
  rig.chassis.updateMatrixWorld(true);
}
const _v = new THREE.Vector3(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
const _tip = new THREE.Vector3(), _tipVel = new THREE.Vector3(), _f = new THREE.Vector3(), _b = new THREE.Vector3(), _bv = new THREE.Vector3(), _n = new THREE.Vector3();

// ====================== One physics step ======================
function physicsStep() {
  const playing = game.phase === 'play';
  const cmd = playing && game.delayed ? game.delayed : null;

  const prev = { swing: game.joints.swing, boom: game.joints.boom, base: { ...game.base } };
  for (const name of JOINT_NAMES) {
    const J = JOINTS[name];
    const c = cmd ? cmd[name] : 0;
    const scale = name === 'hoist' ? 1 - 0.5 * game.load : 1;
    const target = c * J.speed * J.dir * scale;
    game.vel[name] += clamp(target - game.vel[name], -J.accel * DT, J.accel * DT);
    let a = game.joints[name] + game.vel[name] * DT;
    if (a < J.min || a > J.max) { a = clamp(a, J.min, J.max); game.vel[name] = 0; }
    game.joints[name] = a;
    // Ideal path: where the joint would be with no latency and no drive lag (for the dashboard)
    const rc = playing && game.raw ? game.raw[name] : 0;
    let ia = game.ideal[name] + rc * J.speed * J.dir * DT;
    ia += (game.joints[name] - ia) * 0.5 * DT;
    game.ideal[name] = clamp(ia, J.min, J.max);
    // Direction reversals (smoothness)
    const s = Math.abs(c) > 0.3 ? Math.sign(c) : 0;
    if (s && game.lastCmdSign[name] && s !== game.lastCmdSign[name]) game.reversals++;
    if (s) game.lastCmdSign[name] = s;
  }
  // Crawler tracks
  const drive = cmd ? cmd.drive : 0, turn = cmd ? cmd.turn : 0;
  game.base.heading += turn * 0.3 * DT * (drive < 0 ? -1 : 1);
  game.base.x += Math.sin(game.base.heading) * drive * 1.2 * DT;
  game.base.z += Math.cos(game.base.heading) * drive * 1.2 * DT;
  game.base.x = clamp(game.base.x, -58, 58); game.base.z = clamp(game.base.z, -20, 68);

  applyRig();
  // Anti-collision: the boom (or the crawler driving into an intact wall) stops instead of bulldozing the building
  const hitPart = rigBlocked();
  if (hitPart) {
    const next = { swing: game.joints.swing, boom: game.joints.boom, base: { ...game.base } };
    game.joints.swing = prev.swing; game.joints.boom = prev.boom; game.base = prev.base;
    applyRig();
    if (rigBlocked()) { game.joints.swing = next.swing; game.joints.boom = next.boom; game.base = next.base; applyRig(); } // already touching: let the operator back out
    else {
      game.vel.swing = 0; game.vel.boom = 0;
      if (playing && performance.now() - game.lastStrikeAt > 2000) {
        game.lastStrikeAt = performance.now(); game.strikes++;
        logEvent('boom_strike', { part: hitPart });
        toast(hitPart === 'boom' ? '⚠️ Boom contact! Motion stopped' : '⚠️ Crawler blocked by the building'); haptic(1, 400);
      }
    }
  }
  for (const { obj, body } of machine.parts) {
    obj.matrixWorld.decompose(_p, _q, _s);
    body.setNextKinematicTranslation(_p);
    body.setNextKinematicRotation(_q);
  }

  // Cable: one-sided distance constraint between boom tip and ball, solved at velocity level
  rig.tip.getWorldPosition(_tip);
  _tipVel.subVectors(_tip, game.prevTip).divideScalar(DT);
  game.prevTip.copy(_tip);
  const bb = ball.body, bt = bb.translation(), lv = bb.linvel();
  _b.set(bt.x, bt.y, bt.z); _bv.set(lv.x, lv.y, lv.z);
  const drag = cmd ? cmd.drag : 0;
  if (drag > 0.02) {
    // Drag line pulls the ball back toward the cab; let go and it swings out at the building
    rig.fairlead.getWorldPosition(_f);
    _n.subVectors(_f, _b); _n.y = 0;
    if (_n.lengthSq() > 1) _bv.addScaledVector(_n.normalize(), DRAG_ACC * drag * DT);
  } else if (drag < -0.02) {
    // Steady: damp the sway relative to the boom tip
    const k = Math.min(1, STEADY * -drag * DT);
    _bv.x -= (_bv.x - _tipVel.x) * k; _bv.z -= (_bv.z - _tipVel.z) * k;
  }
  const L = game.joints.hoist;
  _n.subVectors(_b, _tip); const dist = _n.length(); _n.divideScalar(dist || 1);
  let tension = 0;
  if (dist > L - 0.002) {
    const rel = _bv.dot(_n) - _tipVel.dot(_n);
    const bias = Math.min(6, Math.max(0, dist - L) * 0.35 / DT);
    const dvn = rel + bias;
    if (dvn > 0) { _bv.addScaledVector(_n, -dvn); tension = ball.mass * dvn / DT; }
  }
  bb.setLinvel(_bv, true);
  const impactSpeed = _bv.length();
  _vPre.copy(_bv);

  world.step(eventQueue);

  let hitF = 0;
  eventQueue.drainContactForceEvents(ev => {
    const a = colliderTag.get(ev.collider1()), b = colliderTag.get(ev.collider2());
    if (a !== 'ball' && b !== 'ball') return;
    const other = a === 'ball' ? b : a;
    if (other === 'target' || other === 'neighbor') hitF = Math.max(hitF, ev.totalForceMagnitude());
  });
  eventQueue.drainCollisionEvents(() => {});
  if (hitF > 3e5 && impactSpeed > BREAK_SPEED) breakAround(impactSpeed);
  game.frameForce = Math.max(game.frameForce, hitF);
  game.sampleForce = Math.max(game.sampleForce, hitF);
  game.tension += (tension - game.tension) * 0.2;
  game.load = clamp(game.tension / (ball.mass * G) / 4, 0, 1);
}

// Structural damage: rigid panels don't shatter, so a hard hit punches the nearest pieces out along the ball's path.
// Whatever they were holding up then falls under real physics.
const _vPre = new THREE.Vector3(), _dir = new THREE.Vector3(), _pp = new THREE.Vector3();
let breakShape = null, lastBreakT = -1;
function breakAround(speed) {
  if (game.t - lastBreakT < 0.15) return;
  lastBreakT = game.t;
  breakShape ||= new RAPIER.Ball(BALL_R + BREAK_RADIUS);
  const bt = ball.body.translation();
  _dir.copy(_vPre).normalize();
  const hits = [];
  world.intersectionsWithShape(bt, { x: 0, y: 0, z: 0, w: 1 }, breakShape, c => {
    const piece = pieceByCollider.get(c.handle);
    if (piece) hits.push(piece);
    return hits.length < 16;
  });
  const power = Math.min(9, 1.5 + speed * 1.3);
  for (const piece of hits) {
    const t = piece.body.translation();
    _pp.set(t.x - bt.x, t.y - bt.y, t.z - bt.z);
    const falloff = 1 - Math.min(1, Math.max(0, _pp.length() - BALL_R) / (BREAK_RADIUS + 1));
    _pp.normalize().multiplyScalar(0.4).add(_dir).normalize();
    const m = piece.body.mass();
    if (!piece.broken && falloff > 0.15) crack(piece);
    piece.body.wakeUp();
    piece.body.applyImpulse({ x: _pp.x * m * power * falloff, y: _pp.y * m * power * falloff * 0.5, z: _pp.z * m * power * falloff }, true);
    piece.body.applyTorqueImpulse({ x: (Math.random() - 0.5) * m * 2, y: (Math.random() - 0.5) * m * 2, z: (Math.random() - 0.5) * m * 2 }, true);
  }
  if (hits.length) emitDust(_v.set(bt.x, bt.y, bt.z), 10 + hits.length * 4, 3);
}

// A cracked piece shrinks a little and loses its grip, so it no longer carries the floors above it
function crack(piece) {
  piece.broken = true;
  piece.size = piece.size.map(v => v * 0.82);
  piece.collider.setHalfExtents({ x: piece.size[0] / 2, y: piece.size[1] / 2, z: piece.size[2] / 2 });
  piece.collider.setFriction(0.25);
  piece.mesh.setColorAt(piece.idx, _crackCol.setHex(piece.color).multiplyScalar(0.7));
  piece.mesh.instanceColor.needsUpdate = true;
}
const _crackCol = new THREE.Color();

const _qp = new THREE.Vector3(), _qq = new THREE.Quaternion();
function rigBlocked() {
  for (const part of machine.parts) {
    part.obj.matrixWorld.decompose(_p, _qq, _s);
    for (const { shape, off } of part.shapes) {
      _qp.copy(off).applyQuaternion(_qq).add(_p);
      let found = false;
      world.intersectionsWithShape(_qp, _qq, shape, c => {
        const piece = pieceByCollider.get(c.handle);
        if (!piece) return true;
        if (part.tag === 'machine' && piece.moved) return true;  // the crawler may shove loose rubble
        found = true; return false;
      });
      if (found) return part.tag;
    }
  }
  return null;
}

const _m4 = new THREE.Matrix4(), _sc = new THREE.Vector3();
function syncDynamicMeshes(force = false) {
  for (const h of level.houses) {
    const dirty = new Set();
    for (const p of h.pieces) {
      if (!force && p.body.isSleeping()) continue;
      const t = p.body.translation(), r = p.body.rotation();
      _p.set(t.x, t.y, t.z); _q.set(r.x, r.y, r.z, r.w); _sc.set(...p.size);
      p.mesh.setMatrixAt(p.idx, _m4.compose(_p, _q, _sc));
      dirty.add(p.mesh);
    }
    for (const m of dirty) m.instanceMatrix.needsUpdate = true;
  }
  const t = ball.body.translation(), r = ball.body.rotation();
  ballMesh.position.set(t.x, t.y, t.z); ballMesh.quaternion.set(r.x, r.y, r.z, r.w);
}
function updateRopes() {
  rig.tip.getWorldPosition(_tip);
  _n.subVectors(_tip, ballMesh.position).normalize();
  _v.copy(ballMesh.position).addScaledVector(_n, BALL_R + 0.12);
  shackle.position.copy(_v); shackle.quaternion.setFromUnitVectors(_up, _n);
  stretchRope(ropes.hoist, _tip, _v);
  const dragging = game.phase === 'play' && game.delayed && game.delayed.drag > 0.02;
  ropes.drag.visible = dragging;
  if (dragging) { rig.fairlead.getWorldPosition(_f); stretchRope(ropes.drag, _f, ballMesh.position); }
  rig.gantryTop.getWorldPosition(_f);
  for (const [m, x] of [[ropes.pendL, 0.5], [ropes.pendR, -0.5]]) {
    rig.pendant.position.x = x; rig.pendant.getWorldPosition(_v);
    stretchRope(m, _f, _v);
  }
}

// ====================== Mission scoring ======================
let lastJudge = 0;
function judge(now) {
  if (now - lastJudge < 200) return; lastJudge = now;
  let sum = 0, cleared = 0, puffs = 0;
  for (const h of level.houses) {
    let n = 0;
    for (const p of h.pieces) {
      if (!p.moved && !p.body.isSleeping()) {
        const t = p.body.translation();
        _v.set(t.x, t.y, t.z);
        if (_v.distanceTo(p.origin) > (h.kind === 'target' ? 1.0 : 0.4)) {
          p.moved = true;
          if (puffs < 12 && Math.random() < 0.5) { emitDust(_v, 3, 2); puffs++; }
        }
      }
      if (p.moved) n++;
    }
    h.ratio = n / h.pieces.length;
    if (h.kind === 'target') {
      sum += h.ratio;
      if (!h.cleared && h.ratio >= CLEAR_RATIO) {
        h.cleared = true;
        if (game.phase === 'play') { logEvent('building_cleared', { name: h.name, t: r3(game.t) }); toast(`🏚️ ${h.name} is down!`, 2400); haptic(0.8, 300); }
      }
      if (h.cleared) cleared++;
    } else if (n > game.collateral) {
      if (game.phase === 'play') {
        logEvent('collateral', { count: n });
        toast('⚠️ You hit the heritage house!'); haptic(1, 300);
      }
      game.collateral = n;
    }
  }
  const prevPct = Math.floor(game.demo * 10);
  game.demo = game.targets ? sum / game.targets : 0;
  game.cleared = cleared;
  if (game.phase === 'play' && Math.floor(game.demo * 10) > prevPct) logEvent('demolition', { ratio: +game.demo.toFixed(3) });
  if (game.phase === 'play') {
    const done = cleared >= game.targets;
    ui.finishHint.style.display = done ? 'block' : 'none';
    if (done && !game.finishedOnce) { game.finishedOnce = true; toast('All targets down! You can finish the job', 2400); logEvent('target_reached', {}); }
  }
}

// ====================== Telemetry ======================
const r3 = v => Math.round(v * 1000) / 1000;
function logEvent(type, data) {
  const e = { t: r3(game.t), type, ...data };
  game.events.push(e);
}
function takeSample() {
  const j = game.joints, id = game.ideal, raw = game.raw, d = game.delayed;
  rig.tip.getWorldPosition(_v);
  const bt = ball.body.translation(), bv = ball.body.linvel();
  game.samples.push({
    t: r3(game.t), src: raw.src,
    inSwing: r3(raw.swing), inBoom: r3(raw.boom), inHoist: r3(raw.hoist), inDrag: r3(raw.drag),
    inTrackL: r3(clamp(raw.drive - raw.turn, -1, 1)), inTrackR: r3(clamp(raw.drive + raw.turn, -1, 1)),
    dSwing: r3(d.swing), dBoom: r3(d.boom), dHoist: r3(d.hoist), dDrag: r3(d.drag),
    swing: r3(j.swing * DEG), boom: r3(j.boom * DEG), hoist: r3(j.hoist),
    tgtSwing: r3(id.swing * DEG), tgtBoom: r3(id.boom * DEG), tgtHoist: r3(id.hoist),
    tipX: r3(_v.x), tipY: r3(_v.y), tipZ: r3(_v.z),
    ballX: r3(bt.x), ballY: r3(bt.y), ballZ: r3(bt.z), ballVX: r3(bv.x), ballVY: r3(bv.y), ballVZ: r3(bv.z),
    baseX: r3(game.base.x), baseZ: r3(game.base.z), heading: r3(game.base.heading * DEG),
    tensionKN: r3(game.tension / 1000), load: r3(game.load), impulse: r3(game.sampleForce / 1000), latencyMs: game.latency,
  });
  game.sampleForce = 0;
  game.sampleCount++;
}
async function api(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(res.status);
  return res.json();
}
let uploading = false;
async function upload(force = false) {
  if (!game.sessionId || uploading) return;
  if (!force && !game.samples.length && !game.events.length) return;
  const samples = game.samples.splice(0), events = game.events.splice(0);
  uploading = true;
  try {
    await api('/api/telemetry', { sessionId: game.sessionId, latencyMs: game.latency, samples, events });
    setOnline(true);
  } catch {
    game.samples.unshift(...samples.slice(-4000)); game.events.unshift(...events);
    setOnline(false);
  } finally { uploading = false; }
}
function setOnline(on) {
  game.online = on;
  ui.hRec.textContent = on ? 'REC Telemetry recording' : 'REC Offline, buffering';
}

// ====================== Flow ======================
async function startGame() {
  if (game.phase !== 'menu') return;
  initAudio();
  if (audio.ctx && audio.ctx.state === 'suspended') audio.ctx.resume();
  const player = ui.playerName.value.trim() || 'Anonymous';
  store.set('name', player);
  setLatency(+ui.latency.value || 0);
  ui.startOverlay.style.display = 'none';
  ui.hud.forEach(h => { h.style.display = ''; });
  game.phase = 'play'; game.t = 0;
  padSend({ t: 'state', phase: 'play' });
  const names = level.houses.filter(h => h.kind === 'target').map(h => h.name);
  toast(`Demolish: ${names.join(' + ')}`, 3000);
  logEvent('start', { player, latencyMs: game.latency, machine: 'wrecking-ball crane', buildings: names,
    lot: level.houses.map(h => ({ name: h.name, kind: h.kind, x: r3(h.center.x), z: r3(h.center.z), r: r3(h.r), pieces: h.pieces.length })) });
  try {
    const { id } = await api('/api/session/start', { player, latencyMs: game.latency });
    game.sessionId = id; setOnline(true);
  } catch { setOnline(false); }
}
function tryFinish() {
  if (game.phase !== 'play') return;
  if (game.cleared < game.targets) { toast(`Bring down every building first (${game.cleared}/${game.targets})`); return; }
  endGame(true, 'finished');
}
async function endGame(completed, reason) {
  if (game.phase !== 'play') return;
  game.phase = 'result';
  ui.finishHint.style.display = 'none';
  const minutes = Math.max(game.t / 60, 0.25);
  const smooth = Math.round(clamp(100 - (game.reversals / minutes) * 2.5, 0, 100));
  const stars = completed ? 1 + (game.collateral === 0 && game.strikes === 0 ? 1 : 0) + (smooth >= 60 ? 1 : 0) : 0;
  const timeBonus = completed ? Math.round(Math.max(0, game.timeLimit - game.t) * 3) : 0;
  const score = Math.max(0, Math.round(game.demo * 1000) + game.cleared * 400 + timeBonus - game.collateral * 40 - game.strikes * 150 + smooth * 2);
  const result = { completed, score, stars, time: r3(game.t), demolished: r3(game.demo), collateral: game.collateral,
    treasures: game.cleared, buildings: game.targets, boomStrikes: game.strikes, smoothness: smooth, reason };
  logEvent('finish', result);
  padSend({ t: 'state', phase: 'result', score, stars });
  ui.rTitle.textContent = completed ? 'Job done!' : (reason === 'timeout' ? 'Time\'s up: project overdue' : 'Job aborted');
  ui.rStars.innerHTML = [0, 1, 2].map(i => `<span class="${i < stars ? '' : 'off'}">★</span>`).join('');
  const row = (k, v) => `<tr><td>${k}</td><td>${v}</td></tr>`;
  ui.rTable.innerHTML = row('Buildings down', `${game.cleared} / ${game.targets}`) + row('Demolished', Math.round(game.demo * 100) + '%')
    + row('Time', fmtTime(game.t)) + row('Collateral damage', game.collateral + ' pieces') + row('Boom strikes', game.strikes)
    + row('Smoothness', smooth + ' / 100') + row('Network latency', game.latency + ' ms')
    + row('Telemetry samples', game.sampleCount.toLocaleString()) + row('<b>Score</b>', `<b>${score.toLocaleString()}</b>`);
  ui.rRank.textContent = 'Uploading score…';
  ui.resultOverlay.style.display = 'flex';
  await upload(true);
  try {
    if (!game.sessionId) throw new Error('offline');
    const r = await api('/api/session/end', { sessionId: game.sessionId, result });
    ui.rRank.textContent = completed && r.rank ? `Leaderboard rank #${r.rank}. ${game.sampleCount.toLocaleString()} telemetry samples from this run were added to the training dataset.` : 'Telemetry from this run was added to the training dataset.';
  } catch { ui.rRank.textContent = 'Could not reach the server; this run was not saved to the leaderboard.'; }
}
ui.startBtn.addEventListener('click', startGame);
ui.againBtn.addEventListener('click', resetLevel);
const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// Look around: hold right mouse button and drag
let looking = false;
renderer.domElement.addEventListener('contextmenu', e => e.preventDefault());
renderer.domElement.addEventListener('mousedown', e => { if (e.button === 2) looking = true; });
addEventListener('mouseup', e => { if (e.button === 2) looking = false; });
addEventListener('mousemove', e => {
  if (!looking) return;
  game.headYaw = clamp(game.headYaw - e.movementX * 0.004, -1.7, 1.7);
  game.headPitch = clamp(game.headPitch - e.movementY * 0.004, -0.6, 0.9);
});

// ====================== Main loop ======================
let acc = 0, last = performance.now(), hudAt = 0, padStateAt = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000); last = now;

  // Input → latency queue
  const raw = readInputs();
  game.raw = raw;
  game.inputHist.push({ at: now, v: raw });
  const cut = now - game.latency;
  let delayed = game.inputHist[0].v;
  for (let i = 0; i < game.inputHist.length; i++) { if (game.inputHist[i].at <= cut) delayed = game.inputHist[i].v; else break; }
  while (game.inputHist.length > 2 && game.inputHist[1].at <= cut - 50) game.inputHist.shift();
  game.delayed = game.latency ? delayed : raw;
  if (raw.src !== '-') game.lastSrc = raw.src;

  acc += dt;
  let steps = 0;
  game.frameForce = 0;
  while (acc >= DT && steps < 4) { physicsStep(); acc -= DT; steps++; if (game.phase === 'play') game.t += DT; }
  if (steps === 4) acc = 0;
  syncDynamicMeshes();
  updateRopes();
  judge(now);

  // Impact feel: camera shake, dust, sound, rumble
  const hit = clamp((game.frameForce - 5e5) / 2e6, 0, 1);
  if (hit > 0.03) {
    game.shake = Math.max(game.shake, hit * 0.1);
    emitDust(ballMesh.position, Math.ceil(hit * 30), 2.5);
    audioHit(0.3 + hit * 0.7, 250 + hit * 700);
    if (hit > 0.2) haptic(hit, 120);
    if (hit > 0.4 && game.phase === 'play') { game.bigHits++; logEvent('impact', { kN: r3(game.frameForce / 1000) }); }
  }
  game.shake *= Math.pow(0.02, dt);
  updateDust(dt);
  const activity = Math.min(1, JOINT_NAMES.reduce((s, n) => s + Math.abs(game.vel[n]) / JOINTS[n].speed, 0) / 1.5);
  audioUpdate(activity, game.load);

  // Cameras
  fpCam.rotation.set(0.22 + game.headPitch, game.headYaw, 0);
  fpCam.position.set((Math.random() - .5) * game.shake, (Math.random() - .5) * game.shake, 0);
  if (thirdPerson) {
    rig.house.updateWorldMatrix(true, false);
    tpCam.position.copy(_v.set(14, 18, -22).applyMatrix4(rig.house.matrixWorld));
    tpCam.lookAt(_v.set(0, 10, 22).applyMatrix4(rig.house.matrixWorld));
  }

  // Telemetry
  if (game.phase === 'play') {
    if (now - game.lastSampleAt >= SAMPLE_MS) { game.lastSampleAt = now; takeSample(); }
    if (now - game.lastUploadAt >= UPLOAD_MS) { game.lastUploadAt = now; upload(); }
    if (game.t >= game.timeLimit) endGame(game.cleared >= game.targets, 'timeout');
  }
  if (now - padStateAt > 500 && pad.pads) {
    padStateAt = now;
    padSend({ t: 'state', phase: game.phase, demo: Math.round(game.demo * 100), time: Math.round(game.t), load: r3(game.load), latency: game.latency });
  }
  if (now - hudAt > 100) { hudAt = now; updateHud(); }

  renderer.render(scene, thirdPerson ? tpCam : fpCam);
}
function updateHud() {
  if (game.phase === 'menu') return;
  const remain = Math.max(0, game.timeLimit - game.t);
  ui.hTime.textContent = fmtTime(remain);
  ui.hTime.style.color = remain < 30 ? 'var(--red)' : '';
  ui.hDemo.textContent = Math.round(game.demo * 100) + '%';
  ui.demoBar.style.width = Math.min(100, game.demo / CLEAR_RATIO * 100) + '%';
  ui.hCleared.textContent = `${game.cleared} / ${game.targets}`;
  ui.hCollateral.textContent = game.collateral;
  ui.hCollateral.style.color = game.collateral ? 'var(--red)' : '';
  ui.hStrikes.textContent = game.strikes;
  ui.hStrikes.style.color = game.strikes ? 'var(--red)' : '';
  ui.hSamples.textContent = game.sampleCount.toLocaleString();
  const srcName = { kbd: 'Keyboard', gamepad: 'Gamepad', phone: '📱 Phone' };
  ui.hPad.textContent = pad.pads ? '📱 Phone connected' : (game.gamepad ? 'Gamepad' : 'Keyboard');
  if (game.lastSrc !== '-' && !pad.pads) ui.hPad.textContent = game.lastSrc.split('+').map(s => srcName[s] || s).join(' + ');
  const j = game.joints, bv = ball.body.linvel();
  ui.gSwing.textContent = Math.round(((j.swing * DEG) % 360 + 540) % 360 - 180) + '°';
  ui.gBoom.textContent = Math.round(j.boom * DEG) + '°';
  ui.gHoist.textContent = j.hoist.toFixed(1) + ' m';
  ui.gBall.textContent = Math.hypot(bv.x, bv.y, bv.z).toFixed(1) + ' m/s';
  ui.loadBar.style.width = Math.round(game.load * 100) + '%';
}

// ====================== Boot ======================
resetLevel();
setLatency(+ui.latency.value || 0);
infoReady.finally(connectPadRelay);
requestAnimationFrame(frame);
window.__game = { game, level, rig, pad, keys, ball, startGame, endGame, resetLevel, setLatency, TEMPLATES, physicsStep, judge, syncDynamicMeshes };
