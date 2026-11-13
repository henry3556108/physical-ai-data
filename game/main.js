// Remote heavy-machine operator: pick a machine, take on a mission. First-person cab + Rapier physics.
import * as THREE from 'three';
import RAPIER from 'rapier';

await RAPIER.init();

// ====================== Constants ======================
const DT = 1 / 60;
const CLEAR_RATIO = 0.6;         // a building counts as "down" once 60% of its pieces have moved
const SAMPLE_MS = 50;            // 20 Hz telemetry
const UPLOAD_MS = 1000;
const DEG = 180 / Math.PI;
const G = 9.81;

// Wrecking ball
const CRANE_BOOM_L = 34;
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
const tplFloors = t => Math.max(...t.vols.map(v => (v.from || 0) + v.floors));

// ====================== DOM ======================
const $ = id => document.getElementById(id);
const ui = {
  startOverlay: $('startOverlay'), resultOverlay: $('resultOverlay'),
  startBtn: $('startBtn'), againBtn: $('againBtn'), menuBtn: $('menuBtn'), playerName: $('playerName'),
  latency: $('latency'), latencyVal: $('latencyVal'),
  hud: ['hudTL', 'hudTR', 'hudB', 'help'].map($),
  hTime: $('hTime'), hProgLabel: $('hProgLabel'), hDemo: $('hDemo'), demoBar: $('demoBar').firstElementChild, hLot: $('hLot'),
  hRows: $('hRows'), hLatency: $('hLatency'),
  hSamples: $('hSamples'), hView: $('hView'), hRec: $('hRec'), hPad: $('hPad'), hMachine: $('hMachine'),
  hudB: $('hudB'), toast: $('toast'), finishHint: $('finishHint'),
  rTitle: $('rTitle'), rStars: $('rStars'), rTable: $('rTable'), rRank: $('rRank'),
  pairQr: $('pairQr'), pairUrl: $('pairUrl'), pairRoom: $('pairRoom'), pairStatus: $('pairStatus'),
  lotPreview: $('lotPreview'), machinePick: $('machinePick'), controls: $('controls'), title: $('title'), sub: $('sub'),
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
fpCam.rotation.order = 'YXZ';
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
// collider handle -> 'machine' | 'boom' | 'tool' | 'target' | 'neighbor' | 'ground' | 'soil' | 'truck' | 'utility'
const colliderTag = new Map();
const pieceByCollider = new Map();
const blockers = new Map();   // fixed things the machine must not pass through: collider handle -> label
function initWorld() {
  world = new RAPIER.World({ x: 0, y: -G, z: 0 });
  world.timestep = DT;
  world.integrationParameters.numSolverIterations = 8;
  eventQueue = new RAPIER.EventQueue(true);
  colliderTag.clear(); pieceByCollider.clear(); blockers.clear();
  const g = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const c = world.createCollider(RAPIER.ColliderDesc.cuboid(350, 0.5, 350).setTranslation(0, -0.5, 0).setFriction(1.0), g);
  colliderTag.set(c.handle, 'ground');
}

// ====================== Shared machine parts ======================
const red = mat(0xc8302a, { roughness: 0.5, metalness: 0.25 });
const yellow = mat(0xf2b416, { roughness: 0.55, metalness: 0.2 });
const orange = mat(0xe8761c, { roughness: 0.55, metalness: 0.2 });
const darkSteel = mat(0x2b2e33, { roughness: 0.7, metalness: 0.4 });
const blackRubber = mat(0x151617, { roughness: 0.95 });
const steel = mat(0x6c7178, { roughness: 0.5, metalness: 0.6 });
const cabMat = mat(0x24272c, { roughness: 0.6, metalness: 0.3 });
const glass = new THREE.MeshStandardMaterial({ color: 0x9fc3d8, transparent: true, opacity: 0.1, roughness: 0.05, metalness: 0.2, depthWrite: false, side: THREE.DoubleSide });

// Glass cab: floor, four posts, roof, dash with two joystick towers. (x, z) = centre, w × d footprint, y0 = floor height
function buildCab(H, { x, z, w, d, y0, h, roofMat, roofWindow }) {
  box(w, 0.2, d, cabMat, x, y0, z, H);
  for (const [px, pz] of [[x - w / 2 + 0.03, z + d / 2], [x + w / 2 - 0.03, z + d / 2], [x - w / 2 + 0.03, z - d / 2], [x + w / 2 - 0.03, z - d / 2]]) box(0.07, h, 0.07, cabMat, px, y0 + h / 2 + 0.1, pz, H);
  box(w + 0.05, 0.08, d + 0.1, roofMat, x, y0 + h + 0.15, z, H);
  box(w, 0.3, 0.07, cabMat, x, y0 + 0.25, z + d / 2, H);
  box(w * 0.5, 0.12, 0.35, darkSteel, x, y0 + 0.42, z + d / 2 - 0.25, H);
  box(w, 0.95, 0.07, cabMat, x, y0 + 0.55, z - d / 2, H);
  const gl = (gw, gh, gx, gy, gz, ry = 0, rx = 0) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(gw, gh), glass); m.position.set(gx, gy, gz); m.rotation.set(rx, ry, 0, 'YXZ'); H.add(m); };
  gl(w - 0.08, h - 0.3, x, y0 + h / 2 + 0.1, z + d / 2);
  gl(d, h - 0.2, x - w / 2 + 0.03, y0 + h / 2 + 0.1, z, Math.PI / 2); gl(d, h - 0.2, x + w / 2 - 0.03, y0 + h / 2 + 0.1, z, Math.PI / 2);
  if (roofWindow) gl(w - 0.1, d * 0.7, x, y0 + h + 0.1, z + d * 0.15, 0, -Math.PI / 2);
  for (const dx of [-w * 0.25, w * 0.25]) { box(0.04, 0.3, 0.04, cabMat, x + dx, y0 + 0.4, z + d * 0.15, H); box(0.08, 0.1, 0.08, mat(0x111111), x + dx, y0 + 0.57, z + d * 0.15, H); }
  const cam = new THREE.Group(); cam.position.set(x, y0 + 1.25, z + 0.05); cam.rotation.y = Math.PI; H.add(cam);
  return cam;
}
function buildCrawler(R, gauge, len, trackW, trackH) {
  R.chassis = new THREE.Group(); scene.add(R.chassis);
  for (const s of [1, -1]) {
    box(trackW, trackH, len, blackRubber, s * gauge / 2, trackH / 2, 0, R.chassis);
    for (let z = -len / 2 + 0.4; z <= len / 2 - 0.4; z += 0.45) box(trackW + 0.04, 0.07, 0.16, darkSteel, s * gauge / 2, trackH + 0.02, z, R.chassis);
  }
  box(gauge - trackW, trackH * 0.5, len * 0.55, darkSteel, 0, trackH * 0.75, 0, R.chassis);
}

// ---------- Crawler crane with wrecking ball ----------
function buildCraneRig() {
  const R = { name: 'crane', meshes: [] };
  buildCrawler(R, 4.8, 8.0, 1.2, 1.2);
  R.house = new THREE.Group(); R.house.position.set(0, 1.4, 0); R.chassis.add(R.house);
  box(4.0, 2.0, 6.4, red, 0, 1.0, -0.6, R.house);
  box(4.2, 1.6, 1.6, darkSteel, 0, 1.1, -4.4, R.house);         // counterweight
  box(4.2, 0.12, 0.3, yellow, 0, 1.95, -5.2, R.house);           // counterweight stripe
  for (const x of [1.2, -1.2]) { const p = box(0.22, 6.2, 0.22, steel, x, 4.6, -2.6, R.house); p.rotation.x = -0.18; }
  box(2.7, 0.3, 0.3, steel, 0, 7.6, -2.05, R.house);
  R.gantryTop = new THREE.Object3D(); R.gantryTop.position.set(0, 7.7, -2.05); R.house.add(R.gantryTop);
  R.fairlead = new THREE.Object3D(); R.fairlead.position.set(0, 1.4, 2.8); R.house.add(R.fairlead);
  box(0.8, 0.5, 0.4, darkSteel, 0, 1.4, 2.65, R.house);          // drag-line fairlead
  R.camMount = buildCab(R.house, { x: 2.65, z: 1.3, w: 1.2, d: 2.2, y0: 0.9, h: 2.1, roofMat: red, roofWindow: true });
  // Lattice boom: four chords + instanced lacing
  R.boomPivot = new THREE.Group(); R.boomPivot.position.set(0, 2.2, 2.0); R.house.add(R.boomPivot);
  {
    const B = R.boomPivot, hw = 0.6, L = CRANE_BOOM_L;
    for (const [x, y] of [[hw, hw], [-hw, hw], [hw, -hw], [-hw, -hw]]) box(0.14, 0.14, L, red, x, y, L / 2, B);
    box(1.6, 1.0, 1.2, red, 0, 0, 0.3, B);
    box(1.4, 1.4, 1.0, red, 0, 0, L - 0.3, B);
    const sheave = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.3, 16), darkSteel);
    sheave.rotation.z = Math.PI / 2; sheave.position.set(0, -0.2, L + 0.2); B.add(sheave);
    const SEG = 1.7, n = Math.floor((L - 1.6) / SEG), mats = [];
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
  R.tip = new THREE.Object3D(); R.tip.position.set(0, -0.6, CRANE_BOOM_L + 0.2); R.boomPivot.add(R.tip);
  R.pendant = new THREE.Object3D(); R.pendant.position.set(0, 0.7, CRANE_BOOM_L - 0.4); R.boomPivot.add(R.pendant);
  return R;
}

// ---------- Hydraulic excavator (normal and high-reach demolition) ----------
// Bucket: opens toward local -Y. Each part: half extents + centre in the tool pivot frame.
const BUCKET_PARTS = [
  [0.62, 0.05, 0.72, 0, 0.05, 0.72],      // back plate
  [0.05, 0.38, 0.64, 0.62, -0.33, 0.74],  // side plates
  [0.05, 0.38, 0.64, -0.62, -0.33, 0.74],
  [0.62, 0.36, 0.05, 0, -0.33, 0.05],     // heel plate
  [0.62, 0.12, 0.05, 0, -0.08, 1.42],     // cutting edge
];
// Demolition crusher: a heavy jaw body with two fixed jaws
const CRUSHER_PARTS = [
  [0.45, 0.45, 0.55, 0, 0, 0.55],
  [0.14, 0.42, 0.85, 0.32, -0.1, 1.75],
  [0.14, 0.42, 0.85, -0.32, -0.1, 1.75],
  [0.46, 0.14, 0.3, 0, -0.4, 1.0],
];
function buildExcavatorRig(o) {
  const R = { name: o.name, meshes: [], boomL: o.boomL, armL: o.armL, tool: o.tool };
  const s = o.scale;
  buildCrawler(R, 2.5 * s, 4.6 * s, 0.75 * s, 0.9 * s);
  R.house = new THREE.Group(); R.house.position.set(0, 1.0 * s, 0); R.chassis.add(R.house);
  box(2.9 * s, 1.0 * s, 3.2 * s, o.paint, 0, 0.5 * s, -0.3 * s, R.house);
  box(2.9 * s, 0.9 * s, 0.9 * s, darkSteel, 0, 0.55 * s, -2.2 * s, R.house);    // counterweight
  box(2.9 * s, 0.1, 0.2, yellow, 0, 1.0 * s, -2.66 * s, R.house);
  R.camMount = buildCab(R.house, { x: 0.9 * s, z: 0.4 * s, w: 0.98, d: 1.3, y0: 1.0 * s, h: 1.9, roofMat: o.paint, roofWindow: o.roofWindow });
  // Boom
  R.boomPivot = new THREE.Group(); R.boomPivot.position.set(-0.3 * s, 0.95 * s, 1.1 * s); R.house.add(R.boomPivot);
  const bw = o.beam;
  box(bw[0], bw[1], o.boomL, o.paint, 0, 0, o.boomL / 2, R.boomPivot);
  box(0.16 * s, 0.16 * s, o.boomL * 0.7, steel, 0, -bw[1] * 0.7, o.boomL * 0.4, R.boomPivot);  // cylinder
  R.armPivot = new THREE.Group(); R.armPivot.position.set(0, 0, o.boomL); R.boomPivot.add(R.armPivot);
  box(bw[0] * 0.85, bw[1] * 0.75, o.armL, o.paint, 0, 0, o.armL / 2, R.armPivot);
  box(0.12 * s, 0.12 * s, o.armL * 0.8, steel, 0, bw[1] * 0.55, o.armL * 0.45, R.armPivot);
  R.toolPivot = new THREE.Group(); R.toolPivot.position.set(0, 0, o.armL); R.armPivot.add(R.toolPivot);
  const parts = o.tool === 'bucket' ? BUCKET_PARTS : CRUSHER_PARTS;
  for (const [hx, hy, hz, x, y, z] of parts) box(hx * 2, hy * 2, hz * 2, o.tool === 'bucket' ? darkSteel : steel, x, y, z, R.toolPivot);
  const pt = (x, y, z) => { const p = new THREE.Object3D(); p.position.set(x, y, z); R.toolPivot.add(p); return p; };
  if (o.tool === 'bucket') {
    for (let i = -2; i <= 2; i++) box(0.1, 0.08, 0.22, steel, i * 0.28, -0.12, 1.55, R.toolPivot);
    R.tip = pt(0, -0.05, 1.5);
    R.cavity = pt(0, -0.35, 0.75);
    R.toolPts = [R.tip, pt(0, -0.7, 0.05), pt(0, 0.1, 0.72), pt(0, -0.7, 1.4)];
  } else {
    for (const x of [0.32, -0.32]) for (let k = 0; k < 4; k++) box(0.3, 0.12, 0.12, darkSteel, x, -0.52, 1.2 + k * 0.32, R.toolPivot);
    R.tip = pt(0, -0.1, 2.6);
    R.cavity = pt(0, -0.1, 1.7);
    R.toolPts = [R.tip, pt(0, -0.6, 1.8), pt(0, 0.45, 0.6), pt(0, -0.6, 0.6)];
  }
  return R;
}

// Ropes are cylinders re-stretched every frame between two world points
const ropeMat = mat(0x1c1d1f, { metalness: 0.6, roughness: 0.45 });
function rope(r) { const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 1, 6, 1), ropeMat); m.castShadow = true; m.frustumCulled = false; scene.add(m); return m; }
const ropes = { hoist: rope(0.045), drag: rope(0.035), pendL: rope(0.05), pendR: rope(0.05) };
ropes.drag.material = mat(0xf5b800, { roughness: 0.6 });
const _up = new THREE.Vector3(0, 1, 0), _rd = new THREE.Vector3();
function stretchRope(m, a, b) {
  _rd.subVectors(b, a); const len = _rd.length();
  m.position.addVectors(a, b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(_up, _rd.divideScalar(len || 1));
  m.scale.set(1, Math.max(len, 0.01), 1);
}
const ballMesh = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 28, 20), mat(0x2a2c30, { metalness: 0.75, roughness: 0.38 }));
ballMesh.castShadow = true; scene.add(ballMesh);
const shackle = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.06, 8, 16), steel);
shackle.castShadow = true; scene.add(shackle);
const craneOnly = [ballMesh, shackle, ...Object.values(ropes)];

const RIGS = {
  crane: buildCraneRig(),
  highreach: buildExcavatorRig({ name: 'highreach', scale: 1.35, boomL: 13, armL: 10, beam: [0.6, 0.8], tool: 'crusher', paint: orange, roofWindow: true }),
  excavator: buildExcavatorRig({ name: 'excavator', scale: 1, boomL: 5.6, armL: 2.9, beam: [0.5, 0.65], tool: 'bucket', paint: yellow, roofWindow: false }),
};

// ====================== Machine catalogue ======================
// Every machine maps the same two sticks (lx, ly, rx, ry; right/down positive) onto its own joints,
// so keyboard, gamepad and phone work for all of them.
const dz = v => Math.abs(v) < 0.12 ? 0 : (v - Math.sign(v) * 0.12) / 0.88;
const machine = { parts: [] };     // kinematic bodies of the current machine: { obj, body, tag, shapes }
const ball = { body: null, mass: 0, tipBody: null, joint: null, jointL: -1 };

const MACHINES = {
  crane: {
    id: 'crane', icon: '🏗️', name: 'Wrecking-ball crane', mission: 'demolition',
    blurb: '14 t ball on a 34 m boom. Time the pendulum, wind up with the drag line, steady the sway.',
    joints: {
      swing: { label: 'Swing', unit: 'deg', min: -Infinity, max: Infinity, speed: 0.3, accel: 0.35, dir: +1 },
      boom:  { label: 'Boom', unit: 'deg', min: 0.42, max: 1.36, speed: 0.16, accel: 0.3, dir: -1 },     // command + = boom down
      hoist: { label: 'Cable', unit: 'm', min: 3, max: 34, speed: 6.0, accel: 10.0, dir: +1, loadSlow: 0.5, noRevert: true },
    },
    pose: { swing: 0, boom: 1.2, hoist: 7 },
    lot: { target: [16, 9], keep: [14, 16], maxFloors: 99, time: [120, 100] },
    drive: { speed: 1.2, turn: 0.3 },
    camPitch: 0.22, tp: [[14, 18, -22], [0, 10, 22]],
    loadLabel: 'Cable tension', hitForce: [5e5, 2e6],
    labels: { L: ['Lower', 'Hoist', 'Swing L', 'Swing R'], R: ['Boom down', 'Boom up', 'Drag in', 'Steady'] },
    help: ['<kbd>A</kbd><kbd>D</kbd> swing left / right<br><kbd>W</kbd><kbd>S</kbd> lower / hoist the ball',
      '<kbd>I</kbd><kbd>K</kbd> boom down / up<br><kbd>J</kbd> drag line in (release to throw) · <kbd>L</kbd> steady the sway'],
    map(s) {
      // Drag line / steady only when the right stick is pushed clearly sideways, so boom moves don't leak into it
      const dragOn = Math.abs(s.rx) > 0.35 && Math.abs(s.rx) > Math.abs(s.ry) * 1.2;
      return { swing: -dz(s.lx), hoist: -dz(s.ly), boom: -dz(s.ry), drag: dragOn ? -Math.sign(s.rx) * (Math.abs(s.rx) - 0.35) / 0.65 : 0 };
    },
    apply(R, j) { R.boomPivot.rotation.x = -j.boom; },
    bodies(R, mk) {
      mk(R.chassis, [[3.0, 0.6, 4.0, 0, 0.6, 0]], 'machine');
      mk(R.house, [[2.1, 1.0, 3.4, 0, 1.0, -0.8], [0.6, 1.1, 1.1, 2.65, 2.0, 1.3]], 'machine');
      // The boom never pushes buildings: it is only used for overlap checks that stop the crane (see rigBlocked)
      mk(R.boomPivot, [[0.7, 0.7, CRANE_BOOM_L / 2 - 2, 0, 0, CRANE_BOOM_L / 2 + 1.5]], 'boom', false);
      R.tip.getWorldPosition(_v);
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(_v.x, _v.y - game.joints.hoist, _v.z)
        .setCcdEnabled(true).setCanSleep(false).setLinearDamping(0.04).setAngularDamping(1.5));
      const c = world.createCollider(RAPIER.ColliderDesc.ball(BALL_R).setDensity(BALL_DENSITY).setFriction(0.6).setRestitution(0.1)
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(20000), body);
      colliderTag.set(c.handle, 'tool');
      ball.body = body; ball.mass = body.mass();
      ball.tipBody = machine.parts.find(p => p.obj === R.boomPivot).body;
      ball.joint = null; ball.jointL = -1;
      ensureRope(game.joints.hoist);
      ballMesh.position.copy(_v).y -= game.joints.hoist;
    },
    preStep: cranePreStep, postStep: cranePostStep,
    workPoint: out => out.copy(ballMesh.position),
    gauges: [['Swing', () => angDeg(game.joints.swing)], ['Boom', () => Math.round(game.joints.boom * DEG) + '°'],
      ['Cable', () => game.joints.hoist.toFixed(1) + ' m'], ['Ball', () => { const v = ball.body.linvel(); return Math.hypot(v.x, v.y, v.z).toFixed(1) + ' m/s'; }]],
    sample(o) {
      const bt = ball.body.translation(), bv = ball.body.linvel();
      Object.assign(o, { toolX: r3(bt.x), toolY: r3(bt.y), toolZ: r3(bt.z), ballX: r3(bt.x), ballY: r3(bt.y), ballZ: r3(bt.z),
        ballVX: r3(bv.x), ballVY: r3(bv.y), ballVZ: r3(bv.z), tensionKN: r3(game.tension / 1000), inDrag: r3(game.raw.drag), dDrag: r3(game.delayed.drag) });
    },
  },
  highreach: {
    id: 'highreach', icon: '🦾', name: 'High-reach demolition excavator', mission: 'demolition',
    blurb: '23 m front with a concrete crusher. Bite the walls floor by floor; the crusher cracks whatever it pushes into.',
    joints: {
      swing: { label: 'Swing', unit: 'deg', min: -Infinity, max: Infinity, speed: 0.35, accel: 1.0, dir: +1 },
      boom:  { label: 'Boom', unit: 'deg', min: -1.3, max: 0.25, speed: 0.2, accel: 0.8, dir: +1 },       // command + = boom down
      arm:   { label: 'Arm', unit: 'deg', min: 0.05, max: 2.5, speed: 0.28, accel: 0.9, dir: -1 },        // command + = arm out
      tool:  { label: 'Crusher', unit: 'deg', min: -0.9, max: 1.9, speed: 0.7, accel: 2.5, dir: +1 },
    },
    pose: { swing: 0, boom: -1.0, arm: 1.3, tool: 0.5 },
    lot: { target: [9, 6], keep: [10, 9], maxFloors: 8, time: [150, 140] },
    drive: { speed: 1.4, turn: 0.4 },
    camPitch: 0.3, tp: [[13, 15, -20], [0, 9, 14]],
    loadLabel: 'Hydraulic load', hitForce: [2e5, 1.5e6],
    labels: { L: ['Arm out', 'Arm in', 'Swing L', 'Swing R'], R: ['Boom down', 'Boom up', 'Crusher curl', 'Crusher out'] },
    help: ['<kbd>A</kbd><kbd>D</kbd> swing left / right<br><kbd>W</kbd><kbd>S</kbd> arm out / in',
      '<kbd>I</kbd><kbd>K</kbd> boom down / up<br><kbd>J</kbd><kbd>L</kbd> crusher curl / out'],
    map: s => ({ swing: -dz(s.lx), arm: -dz(s.ly), boom: -dz(s.ry), tool: -dz(s.rx) }),
    apply: excavatorApply, bodies: excavatorBodies, guard: toolGroundGuard,
    preStep: excavatorPreStep, postStep: excavatorPostStep,
    workPoint: out => rig.tip.getWorldPosition(out),
    gauges: [['Swing', () => angDeg(game.joints.swing)], ['Boom', () => Math.round(-game.joints.boom * DEG) + '°'],
      ['Arm', () => Math.round(game.joints.arm * DEG) + '°'], ['Tool height', () => rig.tip.getWorldPosition(_v).y.toFixed(1) + ' m']],
    sample: excavatorSample,
  },
  excavator: {
    id: 'excavator', icon: '🚜', name: '20 t hydraulic excavator', mission: 'excavation',
    blurb: 'Dig the spoil heap and load the dump trucks. Stay clear of the marked gas line.',
    joints: {
      swing:  { label: 'Swing', unit: 'deg', min: -Infinity, max: Infinity, speed: 0.7, accel: 3.2, dir: +1 },
      boom:   { label: 'Boom', unit: 'deg', min: -1.05, max: 0.45, speed: 0.55, accel: 3.2, dir: +1 },
      arm:    { label: 'Arm', unit: 'deg', min: 0.35, max: 2.7, speed: 0.75, accel: 3.2, dir: -1 },
      bucket: { label: 'Bucket', unit: 'deg', min: -0.7, max: 2.4, speed: 1.6, accel: 4.5, dir: +1 },
    },
    pose: { swing: 0, boom: -0.85, arm: 1.6, bucket: 1.2 },
    drive: { speed: 1.6, turn: 0.5 },
    camPitch: -0.12, tp: [[6, 6.5, -9], [0, 1.5, 8]],
    loadLabel: 'Hydraulic load', hitForce: [6e4, 4e5],
    labels: { L: ['Arm out', 'Arm in', 'Swing L', 'Swing R'], R: ['Boom down', 'Boom up', 'Curl', 'Dump'] },
    help: ['<kbd>A</kbd><kbd>D</kbd> swing left / right<br><kbd>W</kbd><kbd>S</kbd> arm out / in',
      '<kbd>I</kbd><kbd>K</kbd> boom down / up<br><kbd>J</kbd><kbd>L</kbd> bucket curl / dump'],
    map: s => ({ swing: -dz(s.lx), arm: -dz(s.ly), boom: -dz(s.ry), bucket: -dz(s.rx) }),
    apply: excavatorApply, bodies: excavatorBodies, guard: toolGroundGuard,
    preStep: excavatorPreStep, postStep: excavatorPostStep,
    workPoint: out => rig.tip.getWorldPosition(out),
    gauges: [['Swing', () => angDeg(game.joints.swing)], ['Boom', () => Math.round(-game.joints.boom * DEG) + '°'],
      ['Arm', () => Math.round(game.joints.arm * DEG) + '°'], ['Payload', () => (game.payload / 1000).toFixed(1) + ' t']],
    sample: excavatorSample,
  },
};
const MACHINE_IDS = Object.keys(MACHINES);
const toolJoint = M => M.joints.tool ? 'tool' : 'bucket';
const angDeg = a => Math.round(((a * DEG) % 360 + 540) % 360 - 180) + '°';

let M = MACHINES[new URLSearchParams(location.search).get('machine')] || MACHINES[store.get('machine', 'crane')] || MACHINES.crane;
let rig = RIGS[M.id];

function excavatorApply(R, j) {
  R.boomPivot.rotation.x = j.boom;
  R.armPivot.rotation.x = j.arm;
  R.toolPivot.rotation.x = j[toolJoint(M)];
}
function excavatorBodies(R, mk) {
  const s = R.name === 'highreach' ? 1.35 : 1;
  mk(R.chassis, [[1.65 * s, 0.48 * s, 2.3 * s, 0, 0.48 * s, 0]], 'machine');
  mk(R.house, [[1.45 * s, 0.5 * s, 1.6 * s, 0, 0.5 * s, -0.3 * s], [0.5, 0.95, 0.62, 0.9 * s, 1.0 * s + 0.95, 0.4 * s]], 'machine');
  // Boom and arm only check for overlaps (the machine stops instead of slicing through a building or truck)
  mk(R.boomPivot, [[0.3 * s, 0.4 * s, R.boomL / 2 - 0.4, 0, 0, R.boomL / 2 + 0.2]], 'boom', false);
  mk(R.armPivot, [[0.25 * s, 0.3 * s, R.armL / 2 - 0.3, 0, 0, R.armL / 2 - 0.1]], 'boom', false);
  // The tool is a real kinematic body: it scoops soil and shoves, cracks and crushes wall panels
  mk(R.toolPivot, R.tool === 'bucket' ? BUCKET_PARTS : CRUSHER_PARTS, 'tool');
  R.tip.getWorldPosition(game.prevTip);
}
// The tool may not dig into the ground: pushing it further down just stops
function toolMinY() {
  let m = Infinity;
  for (const o of rig.toolPts) m = Math.min(m, o.getWorldPosition(_v).y);
  return m;
}
const GUARD_SETS = [[0], [1], [2], [0, 1], [0, 2], [1, 2], [0, 1, 2]];
function toolGroundGuard(prev, prevMin) {
  game.groundPress = false;
  const floor = Math.min(0.02, prevMin - 1e-5);
  if (toolMinY() >= floor) return;
  // Hold back as few joints as possible, so the bucket can still slide along the ground while it scoops
  const names = ['boom', 'arm', toolJoint(M)], next = names.map(n => game.joints[n]);
  for (const set of GUARD_SETS) {
    names.forEach((n, i) => { game.joints[n] = set.includes(i) ? prev[n] : next[i]; });
    applyRig();
    if (toolMinY() >= floor || set.length === 3) {
      for (const i of set) game.vel[names[i]] = 0;
      break;
    }
  }
  game.groundPress = true;
}
function excavatorSample(o) {
  rig.tip.getWorldPosition(_v);
  Object.assign(o, { toolX: r3(_v.x), toolY: r3(_v.y), toolZ: r3(_v.z), payloadKg: Math.round(game.payload), toolSpeed: r3(game.toolSpeed) });
}

function ensureRope(L) {
  if (ball.joint && Math.abs(L - ball.jointL) < 0.005) return;
  if (ball.joint) world.removeImpulseJoint(ball.joint, true);
  const a = rig.tip.position;
  ball.joint = world.createImpulseJoint(RAPIER.JointData.rope(L, { x: a.x, y: a.y, z: a.z }, { x: 0, y: 0, z: 0 }), ball.tipBody, ball.body, true);
  ball.jointL = L;
}
function createMachineBodies() {
  machine.parts = [];
  const mk = (obj, shapes, tag, physical = true) => {
    obj.updateWorldMatrix(true, false);
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    obj.matrixWorld.decompose(p, q, s);
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(p.x, p.y, p.z).setRotation(q));
    if (physical) for (const [hx, hy, hz, x, y, z] of shapes) {
      const c = world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z).setFriction(0.9)
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(2000), body);
      if (tag === 'tool' && rig.tool === 'crusher') c.setCollisionGroups(CRUSHER_GROUPS);
      colliderTag.set(c.handle, tag);
    }
    machine.parts.push({ obj, body, tag, shapes: shapes.map(([hx, hy, hz, x, y, z]) => ({ shape: new RAPIER.Cuboid(hx, hy, hz), off: new THREE.Vector3(x, y, z) })) });
  };
  M.bodies(rig, mk);
  rig.tip.getWorldPosition(game.prevTip);
}
function selectMachine(id) {
  if (!MACHINES[id] || game.phase === 'play') return;
  M = MACHINES[id]; store.set('machine', id);
  resetLevel();
}

// ====================== Buildings (stacked wall panels + floor slabs) ======================
const unitBox = new THREE.BoxGeometry(1, 1, 1);
const level = { houses: [], extraMeshes: [], clods: [], clodMesh: null, trucks: [], heap: null, layout: [], debris: [], debrisMesh: null };

function footprintRadius(t) {
  let r = 0;
  for (const v of t.vols) for (const sx of [-1, 1]) for (const sz of [-1, 1]) r = Math.max(r, Math.hypot((v.ox || 0) + sx * v.w / 2, (v.oz || 0) + sz * v.d / 2));
  return r;
}
function groundRing(x, z, r, color) {
  const ring = new THREE.Mesh(new THREE.RingGeometry(r, r + 0.35, 64), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7 }));
  ring.rotation.x = -Math.PI / 2; ring.position.set(x, 0.03, z); scene.add(ring); level.extraMeshes.push(ring);
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
    const piece = { group, body, collider: c, size: [w, h, d], origin: new THREE.Vector3(x, y, z), color, moved: false, broken: false, idx: 0, hitAt: -1, kind, gen: 0, density, pv: null };
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
  groundRing(cx, cz, footprintRadius(tpl) + 1.2, kind === 'target' ? 0xf5b800 : 0x4da3ff);
  const house = { kind, name: tpl.name, pieces, meshes, ratio: 0, cleared: false, center: new THREE.Vector3(cx, 0, cz), r: footprintRadius(tpl) };
  level.houses.push(house);
  level.layout.push({ name: tpl.name, kind, x: r3(cx), z: r3(cz), r: r3(house.r), pieces: pieces.length });
  return house;
}

function signPost(text, x, z, faceYaw, color, h = 3.6) {
  const tex = canvasTex(256, (g, s) => {
    g.fillStyle = color; g.fillRect(0, 0, s, s);
    g.fillStyle = '#fff'; g.font = 'bold 44px system-ui,sans-serif'; g.textAlign = 'center';
    text.split('\n').forEach((l, i) => g.fillText(l, s / 2, 100 + i * 56));
  });
  const grp = new THREE.Group();
  const board = new THREE.Mesh(new THREE.PlaneGeometry(3, 3), new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
  board.position.y = h; grp.add(board);
  box(0.12, h - 1.4, 0.12, steel, 0, (h - 1.4) / 2, 0, grp);
  grp.position.set(x, 0, z); grp.rotation.y = faceYaw;
  scene.add(grp); level.extraMeshes.push(grp);
  return grp;
}

// Random, non-overlapping spots in a fan in front of the machine
function placer() {
  const placed = [];
  return (br, rMin, rMax, fan = 1.35) => {
    for (let k = 0; k < 400; k++) {
      const grow = Math.floor(k / 80) * 4;
      const a = (Math.random() * 2 - 1) * fan, r = rMin + br + grow + Math.random() * rMax;
      const x = Math.sin(a) * r, z = Math.cos(a) * r;
      if (placed.every(p => Math.hypot(p.x - x, p.z - z) > p.br + br + 3)) {
        const item = { x, z, br, a };
        placed.push(item);
        return item;
      }
    }
    return null;
  };
}

// ====================== Missions ======================
let lastLot = [];
const MISSIONS = {
  // ---------- Demolition: 1–3 random high-rises plus a protected heritage house ----------
  demolition: {
    name: 'Demolition', progressLabel: 'Demolition',
    rows: [['Buildings down', () => `${game.cleared} / ${game.targets}`], ['Collateral damage', () => game.collateral, () => game.collateral > 0],
      ['Boom strikes', () => game.strikes, () => game.strikes > 0]],
    goalText: 'Bring every yellow-ringed building down, then press <kbd>Enter</kbd><br>Don\'t hit the blue heritage house, and keep the boom off the buildings',
    finishText: 'All buildings down! Press <b>Enter</b> to finish the job',
    build() {
      // ?lot=0,4 forces specific templates (handy for demos and recordings)
      const allowed = TEMPLATES.filter(t => tplFloors(t) <= M.lot.maxFloors);
      const forced = (new URLSearchParams(location.search).get('lot') || '').split(',').filter(v => /^\d+$/.test(v.trim())).map(Number).filter(i => TEMPLATES[i]).slice(0, 3);
      const n = 1 + ((Math.random() * 3) | 0);
      // Random draw; prefer templates that were not in the previous lot so every round looks different
      const shuffled = [...allowed].sort(() => Math.random() - 0.5);
      const fresh = shuffled.filter(t => !lastLot.includes(t.name)), seen = shuffled.filter(t => lastLot.includes(t.name));
      const pool = forced.length ? forced.map(i => TEMPLATES[i]) : [...fresh, ...seen].slice(0, n);
      lastLot = pool.map(t => t.name);
      const place = placer();
      const targets = pool.map(tpl => ({ tpl, at: place(footprintRadius(tpl), ...M.lot.target) })).filter(t => t.at);
      const keep = place(footprintRadius(HERITAGE), ...M.lot.keep);
      const yawOf = p => Math.atan2(p.x, p.z) + (Math.random() < 0.5 ? 0 : Math.PI / 2);
      for (const { tpl, at } of targets) buildBuilding(tpl, at.x, at.z, yawOf(at), 'target');
      if (keep) {
        buildBuilding(HERITAGE, keep.x, keep.z, yawOf(keep), 'neighbor');
        const out = Math.atan2(keep.x, keep.z);
        signPost('HERITAGE\nDO NOT\nDEMOLISH', keep.x - Math.sin(out) * (keep.br + 3), keep.z - Math.cos(out) * (keep.br + 3), Math.atan2(-keep.x, -keep.z), '#1f6fd1');
      }
      const t = level.houses.filter(h => h.kind === 'target');
      game.targets = t.length;
      game.timeLimit = M.lot.time[0] + M.lot.time[1] * t.length;
      return { names: t.map(h => h.name), face: t.length ? t[0].center : null };
    },
    judge: judgeDemolition,
    score(minutes, smooth, completed) {
      const timeBonus = completed ? Math.round(Math.max(0, game.timeLimit - game.t) * 3) : 0;
      return Math.round(game.demo * 1000) + game.cleared * 400 + timeBonus - game.collateral * 40 - game.strikes * 150 + smooth * 2;
    },
    clean: () => game.collateral === 0 && game.strikes === 0,
    resultRows: () => [['Buildings down', `${game.cleared} / ${game.targets}`], ['Demolished', Math.round(game.demo * 100) + '%'],
      ['Collateral damage', game.collateral + ' pieces'], ['Boom strikes', game.strikes]],
  },
  // ---------- Excavation: dig a spoil heap and load 1–2 dump trucks, without touching the gas line ----------
  excavation: {
    name: 'Excavation', progressLabel: 'Loaded',
    rows: [['Trucks loaded', () => `${game.cleared} / ${game.targets}`], ['Spilled clods', () => game.collateral, () => game.collateral > 20],
      ['Strikes', () => game.strikes, () => game.strikes > 0]],
    goalText: 'Dig the spoil heap and fill every dump truck to the line, then press <kbd>Enter</kbd><br>Keep spillage low and never touch the orange gas line',
    finishText: 'All trucks loaded! Press <b>Enter</b> to finish the job',
    build: buildExcavation,
    judge: judgeExcavation,
    score(minutes, smooth, completed) {
      const timeBonus = completed ? Math.round(Math.max(0, game.timeLimit - game.t) * 3) : 0;
      return Math.round(game.demo * 1000) + game.cleared * 400 + timeBonus - game.collateral * 4 - game.strikes * 150 + smooth * 2;
    },
    clean: () => game.strikes === 0 && game.collateral <= 15,
    resultRows: () => [['Trucks loaded', `${game.cleared} / ${game.targets}`], ['Loaded', `${Math.round(game.loaded * 0.1 * 10) / 10} t of ${Math.round(game.goal * 0.1)} t`],
      ['Spilled clods', game.collateral], ['Strikes (truck, gas line)', game.strikes]],
  },
};
const mission = () => MISSIONS[M.mission];

// ---------- Excavation site ----------
const CLOD_KG = 70;
const clodGeo = new THREE.DodecahedronGeometry(1, 0);
const clodMat = mat(0xffffff, { roughness: 1 });
const TRUCK = { w: 2.8, d: 5.0, floorY: 1.35, wallH: 1.15 };
function buildTruck(x, z, yaw) {
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, 0, z).setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }));
  const grp = new THREE.Group(); grp.position.set(x, 0, z); grp.rotation.y = yaw; scene.add(grp); level.extraMeshes.push(grp);
  const { w, d, floorY, wallH } = TRUCK;
  const parts = [
    [w / 2, 0.2, d / 2, 0, floorY - 0.2, 0, 0x3a3f46],                         // bed floor
    [0.06, wallH / 2, d / 2, -w / 2, floorY + wallH / 2, 0, 0xd8a21c],          // side boards
    [0.06, wallH / 2, d / 2, w / 2, floorY + wallH / 2, 0, 0xd8a21c],
    [w / 2, wallH / 2, 0.06, 0, floorY + wallH / 2, -d / 2, 0xd8a21c],
    [w / 2, (wallH + 0.4) / 2, 0.06, 0, floorY + (wallH + 0.4) / 2, d / 2, 0xd8a21c], // headboard
    [w / 2, 1.2, 0.95, 0, 1.25, d / 2 + 1.1, 0x2f6fb5],                       // cab
    [w / 2 - 0.1, 0.35, d / 2 + 1.0, 0, 0.75, 0.5, 0x22252a],                  // chassis
  ];
  for (const [hx, hy, hz, px, py, pz, color] of parts) {
    const c = world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(px, py, pz).setFriction(0.9), body);
    colliderTag.set(c.handle, 'truck'); blockers.set(c.handle, 'truck');
    box(hx * 2, hy * 2, hz * 2, mat(color, { metalness: 0.3, roughness: 0.6 }), px, py, pz, grp);
  }
  for (const [px, pz] of [[-1.2, -1.6], [1.2, -1.6], [-1.2, 0.4], [1.2, 0.4], [-1.2, 3.4], [1.2, 3.4]]) {
    const wh = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.4, 18), blackRubber);
    wh.rotation.z = Math.PI / 2; wh.position.set(px, 0.55, pz); wh.castShadow = true; grp.add(wh);
  }
  // Fill line on the side boards + status lamp
  for (const sx of [-1, 1]) {
    const line = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.08, d - 0.1), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    line.position.set(sx * (w / 2 + 0.07), floorY + wallH - 0.1, 0); grp.add(line);
  }
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 8), new THREE.MeshBasicMaterial({ color: 0xff4d4d }));
  lamp.position.set(0, 2.65, d / 2 + 1.1); grp.add(lamp);
  const t = { x, z, yaw, cos: Math.cos(yaw), sin: Math.sin(yaw), count: 0, full: false, lamp, grp };
  level.trucks.push(t);
  return t;
}
function truckIndexAt(p) {
  for (let i = 0; i < level.trucks.length; i++) {
    const t = level.trucks[i], dx = p.x - t.x, dz2 = p.z - t.z;
    const lx = dx * t.cos - dz2 * t.sin, lz = dx * t.sin + dz2 * t.cos;
    if (Math.abs(lx) < TRUCK.w / 2 && Math.abs(lz) < TRUCK.d / 2 && p.y > TRUCK.floorY - 0.1 && p.y < TRUCK.floorY + TRUCK.wallH + 1.5) return i;
  }
  return -1;
}
function buildExcavation() {
  world.integrationParameters.numSolverIterations = 4;   // loose soil needs fewer iterations than stacked high-rises
  // Spoil heap: a cone of soil clods (rounded boxes stack and slump like real dirt)
  const place = placer();
  const R = 2.6 + Math.random() * 0.7, H = 1.6 + Math.random() * 0.45;
  const heap = place(R, 3.9, 1.0, 0.6);
  const nTrucks = 1 + (Math.random() < 0.55 ? 1 : 0);
  level.heap = { x: heap.x, z: heap.z, r: R };
  const col = new THREE.Color(), pal = [0x7a5a3a, 0x6b4e32, 0x86643f, 0x5e4630];
  // Layers touch each other so the heap is one contact island: digging under it wakes the clods above
  const list = [], S = 0.38, HY = 0.18;
  for (let k = 0, y = HY; y < H; k++, y += 2 * HY) {
    const rr = R * (1 - y / H) + 0.2, o = (k % 2) * S / 2;
    for (let x = -rr + o; x <= rr; x += S) for (let z = -rr + o; z <= rr; z += S) {
      if (Math.hypot(x, z) > rr) continue;
      list.push([heap.x + x, y + 0.001 + k * 0.001, heap.z + z]);
    }
  }
  const mesh = new THREE.InstancedMesh(clodGeo, clodMat, list.length);
  mesh.castShadow = mesh.receiveShadow = true; mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  list.forEach(([x, y, z], i) => {
    const h = [0.155 + Math.random() * 0.025, HY, 0.155 + Math.random() * 0.025];
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z).setSleeping(true).setLinearDamping(0.2).setAngularDamping(0.8));
    const c = world.createCollider(RAPIER.ColliderDesc.roundCuboid(h[0] - 0.04, h[1] - 0.04, h[2] - 0.04, 0.04).setMass(CLOD_KG).setFriction(0.95).setRestitution(0), body);
    colliderTag.set(c.handle, 'soil');
    mesh.setColorAt(i, col.setHex(pal[(Math.random() * pal.length) | 0]));
    level.clods.push({ body, origin: new THREE.Vector3(x, y, z), size: h.map(v => v * 1.18), idx: i, moved: false, carried: false, spilled: false, truck: -1, grip: null, col: c });
  });
  scene.add(mesh); level.clodMesh = mesh;
  groundRing(heap.x, heap.z, R + 0.6, 0xf5b800);
  level.layout.push({ name: 'Spoil heap', kind: 'heap', x: r3(heap.x), z: r3(heap.z), r: r3(R), pieces: list.length });

  // Dump trucks to the side, broadside-ish to the excavator so the bed is in reach
  const side = Math.random() < 0.5 ? 1 : -1;
  for (let i = 0; i < nTrucks; i++) {
    const s = i === 0 ? side : -side;
    let a = heap.a + s * (1.35 + Math.random() * 0.45);
    const r = 6.6 + Math.random() * 0.6;
    const x = Math.sin(a) * r, z = Math.cos(a) * r;
    const yaw = a + Math.PI / 2 * (Math.random() < 0.5 ? 1 : -1);
    buildTruck(x, z, yaw);
    level.layout.push({ name: `Truck ${i + 1}`, kind: 'truck', x: r3(x), z: r3(z), r: 3.2 });
  }
  // Capacity: what fits up to the fill line
  game.truckCap = 35;
  game.goal = game.truckCap * nTrucks;
  game.targets = nTrucks;

  // Live gas line: runs past the far side of the heap, marked with posts
  const far = Math.atan2(heap.x, heap.z), off = R + 1.3 + Math.random() * 0.8;
  const px = heap.x + Math.sin(far) * off, pz = heap.z + Math.cos(far) * off, len = 16;
  const pipeYaw = far;   // local +x of the pipe runs tangentially, across the line of sight
  const pb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(px, 0.22, pz).setRotation({ x: 0, y: Math.sin(pipeYaw / 2), z: 0, w: Math.cos(pipeYaw / 2) }));
  const pc = world.createCollider(RAPIER.ColliderDesc.cuboid(len / 2, 0.22, 0.22), pb);
  colliderTag.set(pc.handle, 'utility'); blockers.set(pc.handle, 'gas line');
  const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, len, 14), mat(0xff7a1a, { roughness: 0.5 }));
  pipe.rotation.set(0, pipeYaw, Math.PI / 2, 'YXZ'); pipe.position.set(px, 0.22, pz); pipe.castShadow = true;
  scene.add(pipe); level.extraMeshes.push(pipe);
  const tape = new THREE.Mesh(new THREE.PlaneGeometry(len, 2.2), new THREE.MeshBasicMaterial({ color: 0xff7a1a, transparent: true, opacity: 0.18, depthWrite: false }));
  tape.rotation.set(-Math.PI / 2, 0, pipeYaw, 'YXZ'); tape.position.set(px, 0.025, pz); scene.add(tape); level.extraMeshes.push(tape);
  for (const k of [-0.4, 0.4]) signPost('GAS LINE\nDO NOT\nDIG', px + Math.cos(pipeYaw) * len * k + Math.sin(far) * 1.2, pz - Math.sin(pipeYaw) * len * k + Math.cos(far) * 1.2, far + Math.PI, '#e8761c', 2.6);
  level.layout.push({ name: 'Gas line', kind: 'utility', x: r3(px), z: r3(pz), r: 0.3, len, yaw: r3(pipeYaw) });

  game.timeLimit = 180 + 170 * nTrucks;
  return { names: [`Spoil heap → ${nTrucks} dump truck${nTrucks > 1 ? 's' : ''}`], face: new THREE.Vector3(heap.x, 0, heap.z) };
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
// Every source produces the same raw sticks; the current machine maps them to joint commands.
const STICKS = ['lx', 'ly', 'rx', 'ry', 'drive', 'turn'];
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
  if (game.phase === 'menu' && /^Digit[1-9]$/.test(e.code)) selectMachine(MACHINE_IDS[+e.code.slice(5) - 1]);
  if (e.code === 'Enter') {
    if (game.phase === 'menu') startGame();
    else if (game.phase === 'play') tryFinish();
    else if (game.phase === 'result') resetLevel(true);
  }
});
addEventListener('keyup', e => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
const kAxis = (pos, neg) => (keys.has(pos) ? 1 : 0) - (keys.has(neg) ? 1 : 0);
function keyboardInput() {
  return { lx: kAxis('KeyD', 'KeyA'), ly: kAxis('KeyS', 'KeyW'), rx: kAxis('KeyL', 'KeyJ'), ry: kAxis('KeyK', 'KeyI'),
    drive: kAxis('ArrowUp', 'ArrowDown'), turn: kAxis('ArrowLeft', 'ArrowRight') };
}
let gpPrevA = false, gpPrevY = false;
function gamepadInput() {
  const gps = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const gp of gps) {
    if (!gp || gp.axes.length < 4) continue;
    const b = i => (gp.buttons[i] && gp.buttons[i].pressed ? 1 : 0);
    const a = { lx: gp.axes[0], ly: gp.axes[1], rx: gp.axes[2], ry: gp.axes[3], drive: b(12) - b(13), turn: b(14) - b(15) };
    const A = !!b(0), Y = !!b(3);
    if (A && !gpPrevA) { if (game.phase === 'menu') startGame(); else if (game.phase === 'play') tryFinish(); else resetLevel(true); }
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
      sendPadState(true);
    } else if (m.t === 'in') {
      pad.input = { lx: clamp(+m.lx || 0, -1, 1), ly: clamp(+m.ly || 0, -1, 1), rx: clamp(+m.rx || 0, -1, 1), ry: clamp(+m.ry || 0, -1, 1),
        drive: clamp(+m.drive || 0, -1, 1), turn: clamp(+m.turn || 0, -1, 1) };
      pad.lastAt = performance.now();
    } else if (m.t === 'btn') {
      if (m.b === 'start' && game.phase === 'menu') startGame();
      else if (m.b === 'finish' && game.phase === 'play') tryFinish();
      else if (m.b === 'again' && game.phase === 'result') resetLevel(true);
      else if (m.b === 'menu' && game.phase === 'result') resetLevel(false);
      else if (m.b === 'machine' && game.phase === 'menu') selectMachine(MACHINE_IDS[(MACHINE_IDS.indexOf(M.id) + 1) % MACHINE_IDS.length]);
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
function sendPadState(full, extra = {}) {
  const o = { t: 'state', phase: game.phase, ...extra };
  if (full) Object.assign(o, { machine: M.id, machineName: `${M.icon} ${M.name}`, mission: mission().name, labels: M.labels });
  padSend(o);
}
function phoneInput() {
  // Dead-man switch: no phone signal for 400 ms means the sticks are released
  if (!pad.input || performance.now() - pad.lastAt > 400) return null;
  return pad.input;
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function readInputs() {
  const srcs = [], st = Object.fromEntries(STICKS.map(a => [a, 0]));
  const k = keyboardInput(), g = gamepadInput(), p = phoneInput();
  for (const [name, o] of [['kbd', k], ['gamepad', g], ['phone', p]]) {
    if (!o) continue;
    if (STICKS.some(a => Math.abs(o[a] || 0) > 0.12)) srcs.push(name);
    for (const a of STICKS) st[a] += o[a] || 0;
  }
  for (const a of STICKS) st[a] = clamp(st[a], -1, 1);
  const out = M.map(st);
  out.drive = st.drive; out.turn = st.turn; out.sticks = st;
  out.src = srcs.join('+') || '-';
  return out;
}

// ====================== Game state ======================
const game = {
  phase: 'menu', latency: 0, t: 0, timeLimit: 300, joints: {}, vel: {}, ideal: {},
  base: { x: 0, z: 0, heading: 0 }, load: 0, tension: 0, payload: 0, toolSpeed: 0, frameForce: 0, sampleForce: 0,
  inputHist: [], raw: null, delayed: null, sessionId: null, samples: [], events: [], sampleCount: 0,
  lastSampleAt: 0, lastUploadAt: 0, demo: 0, cleared: 0, targets: 0, collateral: 0, strikes: 0, lastStrikeAt: 0,
  loaded: 0, goal: 0, truckCap: 0, groundPress: false,
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

// ====================== Menu / HUD for the selected machine ======================
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function renderMachineUi() {
  ui.machinePick.innerHTML = MACHINE_IDS.map((id, i) => {
    const m = MACHINES[id];
    return `<button class="mcard${id === M.id ? ' on' : ''}" data-m="${id}"><span class="mi">${m.icon}</span><b>${esc(m.name)}</b>`
      + `<span class="mtag ${m.mission}">${esc(MISSIONS[m.mission].name)}</span><span class="mb">${esc(m.blurb)}</span><kbd>${i + 1}</kbd></button>`;
  }).join('');
  ui.machinePick.querySelectorAll('.mcard').forEach(b => b.addEventListener('click', () => selectMachine(b.dataset.m)));
  ui.controls.innerHTML = `<div><b>Left stick</b><br>${M.help[0]}</div><div><b>Right stick</b><br>${M.help[1]}</div>`
    + '<div><b>Tracks</b><br><kbd>↑</kbd><kbd>↓</kbd> forward / reverse · <kbd>←</kbd><kbd>→</kbd> turn in place</div>'
    + `<div><b>Mission: ${esc(mission().name)}</b><br>${mission().goalText}</div>`;
  ui.startBtn.textContent = `Start ${M.name.toLowerCase()}`;
  ui.hMachine.textContent = M.name;
  ui.hProgLabel.textContent = mission().progressLabel;
  ui.hRows.innerHTML = mission().rows.map((_, i) => `<div class="row"><span>${esc(mission().rows[i][0])}</span><span id="hRow${i}">0</span></div>`).join('');
  ui.hudB.innerHTML = M.gauges.map(([label], i) => `<div class="gauge">${esc(label)}<b id="g${i}">–</b></div>`).join('')
    + (M.id === 'crane' ? '<div class="gauge" id="dragTag" style="display:none;color:var(--yellow)">Drag line<b style="color:var(--yellow)">PULLING</b></div>' : '')
    + `<div style="width:150px;font-size:12px;color:var(--muted)">${esc(M.loadLabel)}<div class="bar" id="loadBar"><i></i></div></div>`;
  ui.loadBar = $('loadBar').firstElementChild; ui.dragTag = $('dragTag');
  ui.finishHint.innerHTML = mission().finishText;
  sendPadState(true);
}

// ====================== Level setup / reset ======================
function resetLevel(autoStart = false) {
  for (const h of level.houses) for (const m of Object.values(h.meshes)) { scene.remove(m); m.dispose(); }
  for (const m of level.extraMeshes) scene.remove(m);
  if (level.clodMesh) { scene.remove(level.clodMesh); level.clodMesh.dispose(); }
  if (level.debrisMesh) { scene.remove(level.debrisMesh); level.debrisMesh.dispose(); }
  Object.assign(level, { houses: [], extraMeshes: [], clods: [], clodMesh: null, trucks: [], heap: null, layout: [], debris: [], debrisMesh: null });
  game.shatterQ = []; game.lastShatterSound = 0;
  if (world) world.free();
  initWorld();
  rig = RIGS[M.id];
  for (const R of Object.values(RIGS)) R.chassis.visible = R === rig;
  for (const o of craneOnly) o.visible = M.id === 'crane';
  rig.camMount.add(fpCam);
  game.headYaw = game.headPitch = 0;
  const pose = { ...M.pose };
  Object.assign(game, {
    joints: { ...pose }, vel: Object.fromEntries(Object.keys(M.joints).map(n => [n, 0])), ideal: { ...pose },
    base: { x: 0, z: 0, heading: 0 }, load: 0, tension: 0, payload: 0, toolSpeed: 0, t: 0, inputHist: [], samples: [], events: [], sampleCount: 0,
    demo: 0, cleared: 0, collateral: 0, strikes: 0, loaded: 0, goal: 0, reversals: 0, lastCmdSign: {}, bigHits: 0, shake: 0,
    finishedOnce: false, sessionId: null, groundPress: false,
  });
  const info = mission().build();
  // Start facing the first target
  if (info.face) game.joints.swing = game.ideal.swing = Math.atan2(info.face.x, info.face.z);
  applyRig();
  createMachineBodies();
  ui.lotPreview.textContent = `Today's job: ${info.names.join(' · ')} (${fmtTime(game.timeLimit)})`;
  ui.hLot.textContent = info.names.join(' · ');
  game.jobNames = info.names;
  renderMachineUi();
  syncDynamicMeshes(true);
  ui.resultOverlay.style.display = 'none';
  ui.finishHint.style.display = 'none';
  if (game.phase === 'result') {
    game.phase = 'menu';
    if (autoStart) startGame();
    else { ui.startOverlay.style.display = 'flex'; ui.hud.forEach(h => { h.style.display = 'none'; }); sendPadState(true); }
  }
}

function applyRig() {
  const { joints: j, base } = game;
  rig.chassis.position.set(base.x, 0, base.z);
  rig.chassis.rotation.y = base.heading;
  rig.house.rotation.y = j.swing;
  M.apply(rig, j);
  rig.chassis.updateMatrixWorld(true);
}
const _v = new THREE.Vector3(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
const _tip = new THREE.Vector3(), _tipVel = new THREE.Vector3(), _f = new THREE.Vector3(), _b = new THREE.Vector3(), _bv = new THREE.Vector3(), _n = new THREE.Vector3();

// ====================== One physics step ======================
function physicsStep() {
  const playing = game.phase === 'play';
  const cmd = playing && game.delayed ? game.delayed : null;

  const prev = { joints: { ...game.joints }, base: { ...game.base } };
  const prevMin = M.guard ? toolMinY() : 0;
  for (const name in M.joints) {
    const J = M.joints[name];
    const c = cmd ? cmd[name] || 0 : 0;
    const scale = J.loadSlow ? 1 - J.loadSlow * game.load : (name === 'swing' ? 1 : 1 - 0.5 * game.load);
    const target = c * J.speed * J.dir * scale;
    game.vel[name] += clamp(target - game.vel[name], -J.accel * DT, J.accel * DT);
    let a = game.joints[name] + game.vel[name] * DT;
    if (a < J.min || a > J.max) { a = clamp(a, J.min, J.max); game.vel[name] = 0; }
    game.joints[name] = a;
    // Ideal path: where the joint would be with no latency and no drive lag (for the dashboard)
    const rc = playing && game.raw ? game.raw[name] || 0 : 0;
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
  game.base.heading += turn * M.drive.turn * DT * (drive < 0 ? -1 : 1);
  game.base.x += Math.sin(game.base.heading) * drive * M.drive.speed * DT;
  game.base.z += Math.cos(game.base.heading) * drive * M.drive.speed * DT;
  game.base.x = clamp(game.base.x, -58, 58); game.base.z = clamp(game.base.z, -20, 68);

  applyRig();
  if (M.guard) M.guard(prev.joints, prevMin);
  // Anti-collision: boom, arm or crawler stop instead of bulldozing a building, a truck or the gas line
  const hit = rigBlocked();
  if (hit) {
    const next = { joints: { ...game.joints }, base: { ...game.base } };
    for (const n in M.joints) if (!M.joints[n].noRevert) game.joints[n] = prev.joints[n];
    game.base = prev.base;
    applyRig();
    if (rigBlocked()) { game.joints = next.joints; game.base = next.base; applyRig(); } // already touching: let the operator back out
    else {
      for (const n in M.joints) if (!M.joints[n].noRevert) game.vel[n] = 0;
      if (playing && performance.now() - game.lastStrikeAt > 2000) {
        game.lastStrikeAt = performance.now(); game.strikes++;
        if (hit.what === 'gas line') { logEvent('utility_strike', { part: hit.part }); toast('🔥 Gas line contact! Motion stopped'); }
        else { logEvent('boom_strike', { part: hit.part, what: hit.what }); toast(STRIKE_MSG[hit.part]?.(hit.what) || '⚠️ Contact! Motion stopped'); }
        haptic(1, 400);
      }
    }
  }
  for (const { obj, body } of machine.parts) {
    obj.matrixWorld.decompose(_p, _q, _s);
    body.setNextKinematicTranslation(_p);
    body.setNextKinematicRotation(_q);
  }
  rig.tip.getWorldPosition(_tip);
  _tipVel.subVectors(_tip, game.prevTip).divideScalar(DT);
  game.prevTip.copy(_tip);

  M.preStep(cmd);
  world.step(eventQueue);

  const contacts = [];
  eventQueue.drainContactForceEvents(ev => {
    const h1 = ev.collider1(), h2 = ev.collider2();
    const a = colliderTag.get(h1), b = colliderTag.get(h2);
    if (a === 'tool') contacts.push({ other: b, handle: h2, f: ev.totalForceMagnitude() });
    else if (b === 'tool') contacts.push({ other: a, handle: h1, f: ev.totalForceMagnitude() });
  });
  eventQueue.drainCollisionEvents(() => {});
  M.postStep(contacts);
  if (M.mission === 'demolition') debrisPostStep();
}
const STRIKE_MSG = {
  boom: w => w === 'truck' ? '⚠️ Arm hit the truck! Motion stopped' : '⚠️ Boom contact! Motion stopped',
  machine: w => w === 'truck' ? '⚠️ Crawler blocked by the truck' : '⚠️ Crawler blocked by the building',
  tool: w => w === 'truck' ? '⚠️ Bucket hit the truck! Motion stopped' : '⚠️ Tool contact! Motion stopped',
};

// ---------- Crane: drag line, steady, rope joint, tension, ball impacts ----------
const _vPre = new THREE.Vector3();
function cranePreStep(cmd) {
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
  // The cable itself is a Rapier rope joint (max distance = cable length), solved together with the contacts
  ensureRope(game.joints.hoist);
  bb.setLinvel(_bv, true);
  _vPre.copy(_bv);
}
function cranePostStep(contacts) {
  const bb = ball.body;
  // Cable tension estimate from the pendulum state (0 when the cable is slack)
  let tension = 0;
  {
    const q = bb.translation(), w = bb.linvel();
    _n.set(q.x - _tip.x, q.y - _tip.y, q.z - _tip.z); const dist = _n.length(); _n.divideScalar(dist || 1);
    if (dist > game.joints.hoist - 0.03) {
      _v.set(w.x - _tipVel.x, w.y - _tipVel.y, w.z - _tipVel.z);
      const vr = _v.dot(_n), vt2 = Math.max(0, _v.lengthSq() - vr * vr);
      tension = Math.max(0, ball.mass * (vt2 / Math.max(dist, 1) + G * -_n.y));
    }
  }
  let hitF = 0;
  for (const c of contacts) if (c.other === 'target' || c.other === 'neighbor') hitF = Math.max(hitF, c.f);
  const impactSpeed = _vPre.length();
  if (hitF > 3e5 && impactSpeed > BREAK_SPEED) breakAround(impactSpeed);
  game.frameForce = Math.max(game.frameForce, hitF);
  game.sampleForce = Math.max(game.sampleForce, hitF);
  game.tension += (tension - game.tension) * 0.2;
  game.load = clamp(game.tension / (ball.mass * G) / 4, 0, 1);
}

// Structural damage: rigid panels don't shatter, so a hard hit punches the nearest pieces out along the ball's path.
// Whatever they were holding up then falls under real physics.
const _dir = new THREE.Vector3(), _pp = new THREE.Vector3();
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
    // Pieces right at the impact shatter into chunks; the ones around it crack and get shoved
    const parts = FRACTURE.hit && falloff > 0.55 && speed > BREAK_SPEED * 1.6 ? shatter(piece, { x: bt.x, y: bt.y, z: bt.z, r: BALL_R + 0.1 }) : [piece];
    if (parts.length === 1 && !piece.broken && falloff > 0.15) crack(piece);
    for (const part of parts) {
      const m = part.body.mass(), f = falloff * (parts.length > 1 ? 0.6 + Math.random() * 0.6 : 1);
      part.body.wakeUp();
      part.body.applyImpulse({ x: _pp.x * m * power * f, y: _pp.y * m * power * f * 0.5, z: _pp.z * m * power * f }, true);
      part.body.applyTorqueImpulse({ x: (Math.random() - 0.5) * m * 2, y: (Math.random() - 0.5) * m * 2, z: (Math.random() - 0.5) * m * 2 }, true);
    }
  }
  if (hits.length) emitDust(_v.set(bt.x, bt.y, bt.z), 10 + hits.length * 4, 3);
}

// ---------- Excavators: tool forces, crusher damage, bucket payload ----------
let crushShape = null, lastWakeT = -1;
const _inv = new THREE.Matrix4();
// Soil carried in a curled bucket follows the bucket (rigid clods otherwise leak out of a thin-walled kinematic bucket);
// it is released as soon as the operator opens the bucket to dump
const _cl = new THREE.Vector3();
const bucketAngle = () => game.joints.boom + game.joints.arm + game.joints.bucket;
const _mouth = new THREE.Vector3(), _bq = new THREE.Quaternion();
const PUSH = 3, SLICK = 0.15, MOUTH = 0.5, FLING = 0.8;   // pour assist: push (m/s²), friction while pouring, mouth tilt to pour, max kick (m/s)
const _pv = new THREE.Vector3(), _pvPrev = new THREE.Vector3();
function excavatorPreStep() {
  if (rig.tool !== 'bucket' || !level.clods.length) return;
  // Where the bucket mouth points in the world (the bucket opens toward local -Y)
  rig.toolPivot.getWorldQuaternion(_bq);
  _mouth.set(0, -1, 0).applyQuaternion(_bq);
  rig.toolPivot.getWorldPosition(_pv);
  const pvx = (_pv.x - _pvPrev.x) / DT, pvz = (_pv.z - _pvPrev.z) / DT;
  _pvPrev.copy(_pv);
  // Pouring: the operator is opening the bucket and the mouth has tipped over far enough for loose soil to slide.
  // Soil is let go at once, made slippery and eased out of the mouth, so a quick flick of the stick empties the bucket.
  // (Also when the bucket is held tipped up in the air; never while it digs, where an open bucket must keep its soil.)
  const pour = _mouth.y < MOUTH && (game.vel.bucket < -0.12 || (_mouth.y < 0.2 && _pv.y > 3.0));
  if (bucketAngle() < 1.75) for (const cl of level.clods) cl.grip = null;
  for (const cl of level.clods) {
    if (pour && cl.inBucket) {
      // Soil slides off the tipped bucket: let go of the grip and make it slippery
      cl.grip = null;
      if (!cl.slick) { cl.col.setFriction(SLICK); cl.slick = true; }
      cl.slickT = game.t;
    }
    if (cl.slick) {
      if (game.t - cl.slickT > 0.3) { cl.col.setFriction(0.95); cl.slick = false; }
      else {
        // Ease it down out of the mouth. Clods packed in the bucket push each other apart once let go and the
        // sweeping bucket shoves them, so cap that kick: soil pours out instead of being shot over the truck
        const v = cl.body.linvel(), k = cl.inBucket ? Math.min(1, (MOUTH - _mouth.y) * 1.5) * PUSH * DT : 0;
        const lim = (a, b) => b + clamp(a - b, -FLING, FLING);
        cl.body.setLinvel({ x: lim(v.x, pvx), y: Math.min(v.y, 0.3) - k, z: lim(v.z, pvz) }, true);
        continue;
      }
    }
    if (!cl.grip) continue;
    _cl.copy(cl.grip).applyMatrix4(rig.toolPivot.matrixWorld);
    const t = cl.body.translation();
    cl.body.setLinvel({ x: (_cl.x - t.x) / DT, y: (_cl.y - t.y) / DT, z: (_cl.z - t.z) / DT }, true);
  }
}
function excavatorPostStep(contacts) {
  game.toolSpeed = _tipVel.length();
  let hitF = 0, digF = 0;
  for (const c of contacts) {
    if (c.other === 'target' || c.other === 'neighbor') {
      hitF = Math.max(hitF, c.f);
      // The crusher cracks every panel it pushes hard against; cracked panels stop carrying the floors above
      const piece = pieceByCollider.get(c.handle);
      if (piece && rig.tool === 'crusher' && c.f > 4e4 && game.t - piece.hitAt > 0.25) {
        piece.hitAt = game.t;
        // A bite cracks a wall that is still standing (so the floors above lose support); loose slabs and panels
        // that have already come down get crushed into chunks
        const parts = piece.broken && piece.moved && FRACTURE.crush ? shatter(piece) : (piece.broken || crack(piece), [piece]);
        const sp = Math.max(0.5, game.toolSpeed);
        _dir.copy(_tipVel).normalize();
        for (const part of parts) {
          const m = part.body.mass();
          part.hitAt = game.t;
          part.body.wakeUp();
          part.body.applyImpulse({ x: _dir.x * m * sp * 0.8, y: _dir.y * m * sp * 0.4, z: _dir.z * m * sp * 0.8 }, true);
        }
        if (Math.random() < 0.5) {
          const t = piece.body.translation(); emitDust(_v.set(t.x, t.y, t.z), 6, 1.5); audioHit(0.35, 900);
        }
        // Neighbouring panels around the jaws are damaged too
        crushShape ||= new RAPIER.Ball(1.3);
        rig.cavity.getWorldPosition(_v);
        world.intersectionsWithShape(_v, { x: 0, y: 0, z: 0, w: 1 }, crushShape, cc => {
          const p2 = pieceByCollider.get(cc.handle);
          if (p2 && !p2.broken && Math.random() < 0.35) { crack(p2); p2.body.wakeUp(); }
          return true;
        });
      }
    } else if (c.other === 'soil') digF += c.f;
  }
  // Wake the soil around the bucket so nothing is left hanging when it digs underneath
  if (digF > 0 && game.t - lastWakeT > 0.2) {
    lastWakeT = game.t;
    rig.tip.getWorldPosition(_v);
    for (const cl of level.clods) {
      if (!cl.body.isSleeping()) continue;
      const t = cl.body.translation();
      if ((t.x - _v.x) ** 2 + (t.z - _v.z) ** 2 < 6.5) cl.body.wakeUp();
    }
  }
  // Payload: soil clods sitting in the bucket
  let payload = 0;
  if (level.clods.length && rig.tool === 'bucket') {
    _inv.copy(rig.toolPivot.matrixWorld).invert();
    const grip = bucketAngle() > 1.95 && !(game.vel.bucket < -0.12 && _mouth.y < MOUTH);
    for (const cl of level.clods) {
      cl.inBucket = false;
      if (cl.body.isSleeping()) { cl.grip = null; continue; }
      const t = cl.body.translation();
      _v.set(t.x, t.y, t.z).applyMatrix4(_inv);
      if (Math.abs(_v.x) < 0.62 && _v.y > -0.75 && _v.y < 0.15 && _v.z > 0 && _v.z < 1.5) {
        payload += CLOD_KG;
        cl.inBucket = true;
        if (t.y > 1.2) cl.carried = true;
        if (!cl.grip && grip) cl.grip = _v.clone();
      } else cl.grip = null;
    }
  }
  game.payload += (payload - game.payload) * 0.2;
  game.frameForce = Math.max(game.frameForce, hitF);
  game.sampleForce = Math.max(game.sampleForce, hitF, digF);
  const loadTarget = clamp(Math.max(hitF, digF) / (rig.tool === 'crusher' ? 6e5 : 1.2e5) + game.payload / 4000 + (game.groundPress ? 0.35 : 0), 0, 1);
  game.load += (loadTarget - game.load) * (loadTarget > game.load ? 0.25 : 0.04);
}

// A cracked piece shrinks a little and loses its grip, so it no longer carries the floors above it
const _crackCol = new THREE.Color();
function crack(piece) {
  piece.broken = true;
  piece.size = piece.size.map(v => v * 0.82);
  piece.collider.setHalfExtents({ x: piece.size[0] / 2, y: piece.size[1] / 2, z: piece.size[2] / 2 });
  piece.collider.setFriction(0.25);
  piece.mesh.setColorAt(piece.idx, _crackCol.setHex(piece.color).multiplyScalar(0.7));
  piece.mesh.instanceColor.needsUpdate = true;
}

// ---------- Fracture: a piece breaks into rough chunks, each its own rigid body ----------
// Chunks keep the piece's motion, show the grey concrete core, and large chunks can break once more.
const DEBRIS_MAX = 1400;          // chunk budget per lot (keeps the solver fast on phones)
// Collision groups (membership << 16 | filter): the crusher reaches through loose chunks at the foot of a wall
// instead of nibbling the rubble pile forever; chunks still collide with everything else
const CRUSHER_GROUPS = (0x0002 << 16) | 0xffff, DEBRIS_GROUPS = (0x0004 << 16) | (0xffff & ~0x0002);
const FRACTURE = { dv: 5.5, groundY: 2.0, hit: true, crush: true, passCrusher: true };  // dv: a sudden velocity change (m/s) this big, i.e. a hard landing, breaks a piece
const SHATTER_MIN = 1.1;          // pieces smaller than this (m) don't break further
const _ax = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], _fq = new THREE.Quaternion(), _fo = new THREE.Vector3();
const _hide = new THREE.Matrix4().makeScale(0, 0, 0), _dc = new THREE.Color(), _core = new THREE.Color(0x8d8a83);
function debrisSlot() {
  if (!level.debrisMesh) {
    const m = level.debrisMesh = new THREE.InstancedMesh(unitBox, structMat, DEBRIS_MAX);
    m.castShadow = m.receiveShadow = true;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.count = 0;
    m.setColorAt(0, _dc.setHex(0xffffff));
    m.frustumCulled = false;
    scene.add(m);
  }
  return level.debrisMesh.count++;
}
// avoid: a sphere (the wrecking ball) - chunks that would start inside it are pulverised to dust instead
function shatter(piece, avoid = null) {
  const [w, h, d] = piece.size;
  if (Math.max(w, h, d) < SHATTER_MIN || piece.gen >= 2) return [piece];
  // Number of chunks along each axis: thin panels split in their plane only
  const n = piece.size.map(v => v < 0.45 ? 1 : clamp(Math.round(v / 1.3), 1, 3));
  const total = n[0] * n[1] * n[2];
  if (total < 2 || (level.debrisMesh?.count || 0) + total > DEBRIS_MAX) return [piece];
  // Rough, uneven cut lines
  const cuts = n.map((k, a) => {
    const c = [-piece.size[a] / 2];
    for (let i = 1; i < k; i++) c.push(piece.size[a] * (i / k - 0.5 + (Math.random() - 0.5) * 0.3 / k));
    c.push(piece.size[a] / 2);
    return c;
  });
  const body = piece.body, t = body.translation(), r = body.rotation(), lv = body.linvel(), av = body.angvel();
  _fq.set(r.x, r.y, r.z, r.w);
  const frags = [];
  for (let i = 0; i < n[0]; i++) for (let j = 0; j < n[1]; j++) for (let k = 0; k < n[2]; k++) {
    const sz = [cuts[0][i + 1] - cuts[0][i], cuts[1][j + 1] - cuts[1][j], cuts[2][k + 1] - cuts[2][k]];
    _fo.set((cuts[0][i] + cuts[0][i + 1]) / 2, (cuts[1][j] + cuts[1][j + 1]) / 2, (cuts[2][k] + cuts[2][k + 1]) / 2).applyQuaternion(_fq);
    // Shrink a little so neighbouring chunks don't start interpenetrating
    // Crumbled edges: chunks are a bit smaller than their share, so a broken wall no longer carries the floor above
    frags.push({ size: sz.map((v, a) => Math.max(0.08, v * 0.86 - (n[a] > 1 ? 0.04 : 0))), off: _fo.clone() });
  }
  if (avoid) {
    const keep = frags.filter(f => Math.hypot(t.x + f.off.x - avoid.x, t.y + f.off.y - avoid.y, t.z + f.off.z - avoid.z) > avoid.r + Math.hypot(...f.size) / 2);
    if (!keep.length) return [piece];
    frags.length = 0; frags.push(...keep);
  }
  const out = [];
  frags.forEach((f, i) => {
    const x = t.x + f.off.x, y = t.y + f.off.y, z = t.z + f.off.z;
    // Velocity of that point of the old piece (v + ω × r) plus a small burst apart
    const vx = lv.x + av.y * f.off.z - av.z * f.off.y + f.off.x * 0.6 + (Math.random() - 0.5) * 0.6;
    const vy = lv.y + av.z * f.off.x - av.x * f.off.z + f.off.y * 0.3 + Math.random() * 0.4;
    const vz = lv.z + av.x * f.off.y - av.y * f.off.x + f.off.z * 0.6 + (Math.random() - 0.5) * 0.6;
    let p;
    if (i === 0) {
      // The original body becomes the first chunk, so everything that refers to the piece stays valid
      p = piece;
      body.setTranslation({ x, y, z }, true);
      piece.collider.setHalfExtents({ x: f.size[0] / 2, y: f.size[1] / 2, z: f.size[2] / 2 });
      if (piece.mesh !== level.debrisMesh) {
        piece.mesh.setMatrixAt(piece.idx, _hide); piece.mesh.instanceMatrix.needsUpdate = true;
        piece.idx = debrisSlot(); piece.mesh = level.debrisMesh;
      }
    } else {
      const b = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z).setRotation(r)
        .setLinearDamping(0.05).setAngularDamping(0.2));
      const c = world.createCollider(RAPIER.ColliderDesc.cuboid(f.size[0] / 2, f.size[1] / 2, f.size[2] / 2)
        .setDensity(piece.density).setFriction(0.3).setRestitution(0.02), b);
      colliderTag.set(c.handle, piece.kind);
      p = { group: 'debris', body: b, collider: c, size: f.size, origin: piece.origin, color: piece.color, moved: true, broken: true,
        idx: debrisSlot(), mesh: level.debrisMesh, hitAt: game.t, kind: piece.kind, gen: 0, density: piece.density, pv: null, debris: true };
      pieceByCollider.set(c.handle, p);
      level.debris.push(p);
    }
    p.size = f.size; p.gen = piece.gen + 1; p.broken = true; p.moved = true; p.pv = null;
    p.collider.setFriction(0.3);
    if (FRACTURE.passCrusher) p.collider.setCollisionGroups(DEBRIS_GROUPS);
    p.body.setLinvel({ x: vx, y: vy, z: vz }, true);
    p.body.setAngvel({ x: av.x + (Math.random() - 0.5) * 1.5, y: av.y + (Math.random() - 0.5) * 1.5, z: av.z + (Math.random() - 0.5) * 1.5 }, true);
    // Broken faces show the grey concrete core
    level.debrisMesh.setColorAt(p.idx, _dc.setHex(piece.color).lerp(_core, 0.25 + Math.random() * 0.45).multiplyScalar(0.8 + Math.random() * 0.15));
    out.push(p);
  });
  level.debrisMesh.instanceColor.needsUpdate = true;
  _v.set(t.x, t.y, t.z);
  emitDust(_v, 4 + total, Math.max(w, h, d) * 0.6);
  if (game.t - game.lastShatterSound > 0.08) { game.lastShatterSound = game.t; audioHit(Math.min(0.5, 0.15 + total * 0.03), 300 + Math.random() * 500); }
  return out;
}
// Hard landings: a piece whose velocity changes abruptly (it slammed into the ground or the rubble) breaks apart
function debrisPostStep() {
  const q = game.shatterQ;
  const check = p => {
    if (p.body.isSleeping()) { p.pv = null; return; }
    const v = p.body.linvel();
    if (p.pv) {
      const dv = Math.hypot(v.x - p.pv.x, v.y - p.pv.y, v.z - p.pv.z);
      // Only pieces that fell from an upper floor and hit the ground: floors landing on the floor below stay whole so
      // they keep crushing it (progressive collapse), and the ground-floor walls that hold the building up never shatter
      if (dv > FRACTURE.dv && p.moved && p.gen < 2 && Math.max(...p.size) >= SHATTER_MIN) {
        const y = p.body.translation().y;
        if (y < FRACTURE.groundY && p.origin.y - y > 2.5) q.push(p);
      }
      p.pv.x = v.x; p.pv.y = v.y; p.pv.z = v.z;
    } else p.pv = { x: v.x, y: v.y, z: v.z };
  };
  for (const h of level.houses) for (const p of h.pieces) check(p);
  for (const p of level.debris) {
    check(p);
    // Safety net: a chunk born in a tight spot must not be shot across the site by the contact solver
    if (!p.body.isSleeping()) {
      const v = p.body.linvel(), sp = Math.hypot(v.x, v.y, v.z);
      if (sp > 14) p.body.setLinvel({ x: v.x * 14 / sp, y: v.y * 14 / sp, z: v.z * 14 / sp }, true);
    }
  }
  // A few per step, so a whole building collapsing doesn't stall a frame
  for (let i = 0; i < 4 && q.length; i++) {
    const p = q.shift();
    if (!q.includes(p)) shatter(p);
  }
  if (q.length > 40) q.length = 40;
}

// Overlap test of every machine part against intact building pieces and fixed blockers (trucks, gas line)
const _qp = new THREE.Vector3(), _qq = new THREE.Quaternion();
function rigBlocked() {
  for (const part of machine.parts) {
    part.obj.matrixWorld.decompose(_p, _qq, _s);
    for (const { shape, off } of part.shapes) {
      _qp.copy(off).applyQuaternion(_qq).add(_p);
      let found = null;
      world.intersectionsWithShape(_qp, _qq, shape, c => {
        const b = blockers.get(c.handle);
        if (b) { found = b; return false; }
        if (part.tag === 'tool') return true;                    // the tool is meant to hit buildings
        const piece = pieceByCollider.get(c.handle);
        if (!piece || piece.gen > 0) return true;                // loose chunks of rubble don't stop the boom
        if (part.tag === 'machine' && piece.moved) return true;  // the crawler may shove loose rubble
        found = 'building'; return false;
      });
      if (found) return { part: part.tag, what: found };
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
  if (level.debrisMesh && level.debris.length) {
    let dirty = force;
    for (const p of level.debris) {
      if (!force && p.body.isSleeping()) continue;
      const t = p.body.translation(), r = p.body.rotation();
      _p.set(t.x, t.y, t.z); _q.set(r.x, r.y, r.z, r.w); _sc.set(...p.size);
      level.debrisMesh.setMatrixAt(p.idx, _m4.compose(_p, _q, _sc));
      dirty = true;
    }
    if (dirty) level.debrisMesh.instanceMatrix.needsUpdate = true;
  }
  if (level.clodMesh) {
    let dirty = force;
    for (const cl of level.clods) {
      if (!force && cl.body.isSleeping()) continue;
      const t = cl.body.translation(), r = cl.body.rotation();
      _p.set(t.x, t.y, t.z); _q.set(r.x, r.y, r.z, r.w); _sc.set(...cl.size);
      level.clodMesh.setMatrixAt(cl.idx, _m4.compose(_p, _q, _sc));
      dirty = true;
    }
    if (dirty) level.clodMesh.instanceMatrix.needsUpdate = true;
    if (force) level.clodMesh.instanceColor.needsUpdate = true;
  }
  if (M.id === 'crane') {
    const t = ball.body.translation(), r = ball.body.rotation();
    ballMesh.position.set(t.x, t.y, t.z); ballMesh.quaternion.set(r.x, r.y, r.z, r.w);
  }
}
function updateRopes() {
  if (M.id !== 'crane') return;
  rig.tip.getWorldPosition(_tip);
  _n.subVectors(_tip, ballMesh.position).normalize();
  _v.copy(ballMesh.position).addScaledVector(_n, BALL_R + 0.12);
  shackle.position.copy(_v); shackle.quaternion.setFromUnitVectors(_up, _n);
  stretchRope(ropes.hoist, _tip, _v);
  const dragging = game.phase === 'play' && game.delayed && game.delayed.drag > 0.02;
  ropes.drag.visible = dragging;
  if (dragging) {
    rig.fairlead.getWorldPosition(_f);
    _p.subVectors(_f, ballMesh.position).normalize().multiplyScalar(BALL_R).add(ballMesh.position);
    stretchRope(ropes.drag, _f, _p);
  }
  if (ui.dragTag) ui.dragTag.style.display = dragging ? '' : 'none';
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
  const prevPct = Math.floor(game.demo * 10);
  mission().judge();
  if (game.phase === 'play' && Math.floor(game.demo * 10) > prevPct) logEvent(M.mission === 'excavation' ? 'loading' : 'demolition', { ratio: +game.demo.toFixed(3) });
  if (game.phase === 'play') {
    const done = game.cleared >= game.targets;
    ui.finishHint.style.display = done ? 'block' : 'none';
    if (done && !game.finishedOnce) { game.finishedOnce = true; toast('Job complete! You can finish now', 2400); logEvent('target_reached', {}); }
  }
}
function judgeDemolition() {
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
  game.demo = game.targets ? sum / game.targets : 0;
  game.cleared = cleared;
}
function judgeExcavation() {
  const counts = level.trucks.map(() => 0), H = level.heap;
  let spilled = 0;
  for (const cl of level.clods) {
    const t = cl.body.translation();
    _v.set(t.x, t.y, t.z);
    if (!cl.moved && _v.distanceTo(cl.origin) > 0.6) cl.moved = true;
    if (!cl.moved) continue;
    cl.truck = truckIndexAt(_v);
    if (cl.truck >= 0) { counts[cl.truck]++; continue; }
    // Spill: soil that was lifted in the bucket and then dropped on open ground instead of in a truck
    cl.spilled = cl.carried && _v.y < 0.6 && Math.hypot(_v.x - H.x, _v.z - H.z) > H.r + 0.6;
    if (cl.spilled) spilled++;
  }
  let loaded = 0, full = 0;
  level.trucks.forEach((tr, i) => {
    tr.count = counts[i];
    loaded += Math.min(tr.count, game.truckCap);
    if (!tr.full && tr.count >= game.truckCap) {
      tr.full = true; tr.lamp.material.color.setHex(0x3ddc84);
      if (game.phase === 'play') { logEvent('truck_loaded', { truck: i + 1, clods: tr.count, t: r3(game.t) }); toast(`🚚 Truck ${i + 1} is loaded!`, 2400); haptic(0.8, 300); }
    }
    if (tr.full) full++;
  });
  if (game.phase === 'play' && spilled > game.collateral && Math.floor(spilled / 10) > Math.floor(game.collateral / 10)) logEvent('spill', { count: spilled });
  game.collateral = spilled;
  game.loaded = loaded;
  game.demo = game.goal ? loaded / game.goal : 0;
  game.cleared = full;
}

// ====================== Telemetry ======================
const r3 = v => Math.round(v * 1000) / 1000;
const cap = s => s[0].toUpperCase() + s.slice(1);
function logEvent(type, data) {
  const e = { t: r3(game.t), type, ...data };
  game.events.push(e);
}
function takeSample() {
  const j = game.joints, id = game.ideal, raw = game.raw, d = game.delayed, st = raw.sticks;
  rig.tip.getWorldPosition(_v);
  const o = {
    t: r3(game.t), src: raw.src, machine: M.id,
    inLX: r3(st.lx), inLY: r3(st.ly), inRX: r3(st.rx), inRY: r3(st.ry),
    inTrackL: r3(clamp(raw.drive - raw.turn, -1, 1)), inTrackR: r3(clamp(raw.drive + raw.turn, -1, 1)),
    tipX: r3(_v.x), tipY: r3(_v.y), tipZ: r3(_v.z),
    baseX: r3(game.base.x), baseZ: r3(game.base.z), heading: r3(game.base.heading * DEG),
    load: r3(game.load), impulse: r3(game.sampleForce / 1000), latencyMs: game.latency,
  };
  // Per joint: raw command, delivered command, actual value and ideal (no latency, no lag) value
  for (const n in M.joints) {
    const k = M.joints[n].unit === 'deg' ? DEG : 1, C = cap(n);
    o['in' + C] = r3(raw[n] || 0); o['d' + C] = r3(d[n] || 0);
    o[n] = r3(j[n] * k); o['tgt' + C] = r3(id[n] * k);
  }
  M.sample(o);
  game.samples.push(o);
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
  sendPadState(true);
  toast(`${mission().name}: ${game.jobNames.join(' + ')}`, 3000);
  logEvent('start', { player, latencyMs: game.latency, machine: M.id, machineName: M.name, mission: M.mission, buildings: game.jobNames,
    joints: Object.entries(M.joints).map(([k, J]) => ({ key: cap(k), label: J.label, unit: J.unit === 'deg' ? '°' : 'm' })),
    loadLabel: M.loadLabel, lot: level.layout });
  try {
    const { id } = await api('/api/session/start', { player, latencyMs: game.latency, machine: M.id, mission: M.mission });
    game.sessionId = id; setOnline(true);
  } catch { setOnline(false); }
}
function tryFinish() {
  if (game.phase !== 'play') return;
  if (game.cleared < game.targets) { toast(M.mission === 'excavation' ? `Load every truck first (${game.cleared}/${game.targets})` : `Bring down every building first (${game.cleared}/${game.targets})`); return; }
  endGame(true, 'finished');
}
async function endGame(completed, reason) {
  if (game.phase !== 'play') return;
  game.phase = 'result';
  ui.finishHint.style.display = 'none';
  const minutes = Math.max(game.t / 60, 0.25);
  const smooth = Math.round(clamp(100 - (game.reversals / minutes) * 2.5, 0, 100));
  const ms = mission();
  const stars = completed ? 1 + (ms.clean() ? 1 : 0) + (smooth >= 60 ? 1 : 0) : 0;
  const score = Math.max(0, ms.score(minutes, smooth, completed));
  const result = { completed, score, stars, time: r3(game.t), demolished: r3(game.demo), collateral: game.collateral,
    treasures: game.cleared, buildings: game.targets, boomStrikes: game.strikes, smoothness: smooth, reason, machine: M.id, mission: M.mission };
  logEvent('finish', result);
  sendPadState(false, { score, stars });
  ui.rTitle.textContent = completed ? 'Job done!' : (reason === 'timeout' ? 'Time\'s up: project overdue' : 'Job aborted');
  ui.rStars.innerHTML = [0, 1, 2].map(i => `<span class="${i < stars ? '' : 'off'}">★</span>`).join('');
  const row = (k, v) => `<tr><td>${k}</td><td>${v}</td></tr>`;
  ui.rTable.innerHTML = row('Machine', `${M.icon} ${esc(M.name)}`) + ms.resultRows().map(([k, v]) => row(k, v)).join('')
    + row('Time', fmtTime(game.t)) + row('Smoothness', smooth + ' / 100') + row('Network latency', game.latency + ' ms')
    + row('Telemetry samples', game.sampleCount.toLocaleString()) + row('<b>Score</b>', `<b>${score.toLocaleString()}</b>`);
  ui.againBtn.textContent = M.mission === 'excavation' ? 'Next site' : 'Next lot';
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
ui.againBtn.addEventListener('click', () => resetLevel(true));
ui.menuBtn.addEventListener('click', () => resetLevel(false));
const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// Look around: hold right mouse button and drag
let looking = false;
renderer.domElement.addEventListener('contextmenu', e => e.preventDefault());
renderer.domElement.addEventListener('mousedown', e => { if (e.button === 2) looking = true; });
addEventListener('mouseup', e => { if (e.button === 2) looking = false; });
addEventListener('mousemove', e => {
  if (!looking) return;
  game.headYaw = clamp(game.headYaw - e.movementX * 0.004, -1.7, 1.7);
  game.headPitch = clamp(game.headPitch - e.movementY * 0.004, -0.8, 0.9);
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
  const [f0, f1] = M.hitForce;
  const hit = clamp((game.frameForce - f0) / f1, 0, 1);
  if (hit > 0.03) {
    game.shake = Math.max(game.shake, hit * 0.1);
    emitDust(M.workPoint(_v), Math.ceil(hit * 30), 2.5);
    audioHit(0.3 + hit * 0.7, 250 + hit * 700);
    if (hit > 0.2) haptic(hit, 120);
    if (hit > 0.4 && game.phase === 'play') { game.bigHits++; logEvent('impact', { kN: r3(game.frameForce / 1000) }); }
  }
  game.shake *= Math.pow(0.02, dt);
  updateDust(dt);
  let act = 0; for (const n in M.joints) act += Math.abs(game.vel[n]) / M.joints[n].speed;
  audioUpdate(Math.min(1, act / 1.5), game.load);

  // Cameras
  fpCam.rotation.set(M.camPitch + game.headPitch, game.headYaw, 0);
  fpCam.position.set((Math.random() - .5) * game.shake, (Math.random() - .5) * game.shake, 0);
  if (thirdPerson) {
    rig.house.updateWorldMatrix(true, false);
    tpCam.position.copy(_v.set(...M.tp[0]).applyMatrix4(rig.house.matrixWorld));
    tpCam.lookAt(_v.set(...M.tp[1]).applyMatrix4(rig.house.matrixWorld));
  }

  // Telemetry
  if (game.phase === 'play') {
    if (now - game.lastSampleAt >= SAMPLE_MS) { game.lastSampleAt = now; takeSample(); }
    if (now - game.lastUploadAt >= UPLOAD_MS) { game.lastUploadAt = now; upload(); }
    if (game.t >= game.timeLimit) endGame(game.cleared >= game.targets, 'timeout');
  }
  if (now - padStateAt > 500 && pad.pads) {
    padStateAt = now;
    sendPadState(true, { demo: Math.round(game.demo * 100), progress: mission().progressLabel, time: Math.round(game.t), load: r3(game.load), latency: game.latency });
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
  ui.demoBar.style.width = Math.min(100, M.mission === 'demolition' ? game.demo / CLEAR_RATIO * 100 : game.demo * 100) + '%';
  mission().rows.forEach(([, val, bad], i) => {
    const el = $('hRow' + i); if (!el) return;
    el.textContent = val(); el.style.color = bad && bad() ? 'var(--red)' : '';
  });
  ui.hSamples.textContent = game.sampleCount.toLocaleString();
  const srcName = { kbd: 'Keyboard', gamepad: 'Gamepad', phone: '📱 Phone' };
  ui.hPad.textContent = pad.pads ? '📱 Phone connected' : (game.gamepad ? 'Gamepad' : 'Keyboard');
  if (game.lastSrc !== '-' && !pad.pads) ui.hPad.textContent = game.lastSrc.split('+').map(s => srcName[s] || s).join(' + ');
  M.gauges.forEach(([, fn], i) => { const el = $('g' + i); if (el) el.textContent = fn(); });
  ui.loadBar.style.width = Math.round(game.load * 100) + '%';
}

// ====================== Boot ======================
game.phase = 'menu';
resetLevel();
setLatency(+ui.latency.value || 0);
infoReady.finally(connectPadRelay);
requestAnimationFrame(frame);
window.__game = { game, level, get rig() { return rig; }, get M() { return M; }, MACHINES, pad, keys, ball, startGame, endGame, resetLevel, selectMachine,
  setLatency, TEMPLATES, physicsStep, judge, syncDynamicMeshes, FRACTURE };
