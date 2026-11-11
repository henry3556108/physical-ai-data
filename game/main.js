// 遠端都更挖土機：第一人稱 + Rapier 物理
import * as THREE from 'three';
import RAPIER from 'rapier';

await RAPIER.init();

// ====================== 常數 ======================
const DT = 1 / 60;
const TIME_LIMIT = 240;          // 秒
const FINISH_RATIO = 0.75;       // 拆除率達標門檻
const SAMPLE_MS = 50;            // 20Hz 遙測
const UPLOAD_MS = 1000;
const BRICK_DENSITY = 1800;
const DEG = 180 / Math.PI;

// 關節（數值是 three.js 的 rotation 值；大臂負值 = 抬高）
const JOINTS = {
  swing:  { min: -Infinity, max: Infinity, speed: 0.7, dir: +1 },
  boom:   { min: -1.05, max: 0.45, speed: 0.55, dir: +1 }, // 指令 + = 大臂下降
  arm:    { min: 0.35, max: 2.7, speed: 0.75, dir: -1 },   // 指令 + = 小臂伸出
  bucket: { min: -0.7, max: 2.4, speed: 1.1, dir: +1 },    // 指令 + = 收斗
};
const JOINT_ACCEL = 3.2;
const START_POSE = { swing: 0, boom: -0.5, arm: 1.75, bucket: 0.7 };

// 場地配置
const TARGET = { cx: 0, cz: 11, w: 6, d: 4.8, stories: 2, courses: 5, bh: 0.6, t: 0.4 };
const NEIGHBOR = { cx: -8.6, cz: 11, w: 4.2, d: 4.2, stories: 1, courses: 5, bh: 0.6, t: 0.35 };
const TRUCK = { cx: 8.2, cz: 5.5, w: 3.0, d: 4.6, floorY: 1.1, wallH: 1.0 };

// ====================== DOM ======================
const $ = id => document.getElementById(id);
const ui = {
  startOverlay: $('startOverlay'), resultOverlay: $('resultOverlay'),
  startBtn: $('startBtn'), againBtn: $('againBtn'), playerName: $('playerName'),
  latency: $('latency'), latencyVal: $('latencyVal'),
  hud: ['hudTL', 'hudTR', 'hudB', 'help'].map($),
  hTime: $('hTime'), hDemo: $('hDemo'), demoBar: $('demoBar').firstElementChild,
  hTreasure: $('hTreasure'), hCollateral: $('hCollateral'), hLatency: $('hLatency'),
  hSamples: $('hSamples'), hView: $('hView'), hRec: $('hRec'), hPad: $('hPad'),
  gSwing: $('gSwing'), gBoom: $('gBoom'), gArm: $('gArm'), gBucket: $('gBucket'),
  loadBar: $('loadBar').firstElementChild, toast: $('toast'), finishHint: $('finishHint'),
  rTitle: $('rTitle'), rStars: $('rStars'), rTable: $('rTable'), rRank: $('rRank'),
  pairQr: $('pairQr'), pairUrl: $('pairUrl'), pairRoom: $('pairRoom'), pairStatus: $('pairStatus'),
};
const store = {
  get(k, d) { try { const v = localStorage.getItem('exc.' + k); return v == null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('exc.' + k, v); } catch { /* 無痕模式 */ } },
};
ui.playerName.value = store.get('name', '');
ui.latency.value = store.get('latency', '0');
ui.latencyVal.textContent = ui.latency.value + ' ms';
ui.latency.addEventListener('input', () => { ui.latencyVal.textContent = ui.latency.value + ' ms'; });

// ====================== Three.js 場景 ======================
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
scene.fog = new THREE.Fog(0xa9c7e4, 60, 220);

scene.add(new THREE.HemisphereLight(0xe3edff, 0x5a4a35, 1.0));
const sun = new THREE.DirectionalLight(0xfff3dd, 2.4);
sun.position.set(18, 30, -6);
sun.target.position.set(0, 0, 8);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -22, right: 22, top: 22, bottom: -22, near: 1, far: 80 });
sun.shadow.bias = -0.0005;
scene.add(sun, sun.target);

const fpCam = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.05, 400);
const tpCam = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 400);
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

// 地面：程式產生的泥土貼圖
function dirtTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#8a7558'; g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 9000; i++) {
    const v = 100 + Math.random() * 60;
    g.fillStyle = `rgba(${v + 20},${v},${v - 30},${Math.random() * 0.35})`;
    g.fillRect(Math.random() * 512, Math.random() * 512, 2 + Math.random() * 4, 2 + Math.random() * 4);
  }
  g.strokeStyle = 'rgba(60,45,30,.25)'; g.lineWidth = 2;
  for (let i = 0; i <= 512; i += 64) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 512); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(512, i); g.stroke(); }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(40, 40); t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ map: dirtTexture(), roughness: 1 }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

// 背景：遠方城市量體與工地圍籬（純裝飾）
{
  const cityMat = [mat(0x9aa3ad), mat(0xb3aa9c), mat(0x8c97a3), mat(0xc2bdb4)];
  for (let i = 0; i < 46; i++) {
    const a = (i / 46) * Math.PI * 2 + Math.random() * 0.05;
    const r = 70 + Math.random() * 50;
    const h = 8 + Math.random() * 38;
    const b = box(8 + Math.random() * 10, h, 8 + Math.random() * 10, cityMat[i % 4], Math.cos(a) * r, h / 2, Math.sin(a) * r + 10);
    b.castShadow = false;
    scene.add(b);
  }
  const fenceA = mat(0xf5b800), fenceB = mat(0x1d1f22);
  const R = 24;
  for (let i = -R; i < R; i += 2) {
    for (const [x, z, ry] of [[i + 1, 10 + R, 0], [i + 1, 10 - R, 0], [R, 10 + i + 1, Math.PI / 2], [-R, 10 + i + 1, Math.PI / 2]]) {
      const p = box(2, 1.6, 0.08, (i / 2) % 2 ? fenceA : fenceB, x, 0.8, z); p.rotation.y = ry; scene.add(p);
    }
  }
}

// ====================== Rapier 物理世界 ======================
let world, eventQueue;
const colliderTag = new Map(); // collider handle -> 'machine' | 'brick' | ...
function initWorld() {
  world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = DT;
  world.integrationParameters.numSolverIterations = 8;
  eventQueue = new RAPIER.EventQueue(true);
  colliderTag.clear();
  const g = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(RAPIER.ColliderDesc.cuboid(200, 0.5, 200).setTranslation(0, -0.5, 0).setFriction(1.0), g);
}

// ====================== 挖土機（運動學剛體，由關節角度驅動） ======================
const yellow = mat(0xf2b416, { roughness: 0.55, metalness: 0.2 });
const darkSteel = mat(0x2b2e33, { roughness: 0.7, metalness: 0.4 });
const blackRubber = mat(0x151617, { roughness: 0.95 });
const steel = mat(0x6c7178, { roughness: 0.5, metalness: 0.6 });

const rig = {};
rig.chassis = new THREE.Group(); scene.add(rig.chassis);
box(0.75, 0.9, 4.6, blackRubber, 1.25, 0.45, 0, rig.chassis);
box(0.75, 0.9, 4.6, blackRubber, -1.25, 0.45, 0, rig.chassis);
box(1.8, 0.5, 3.0, darkSteel, 0, 0.75, 0, rig.chassis);

rig.house = new THREE.Group(); rig.house.position.set(0, 1.0, 0); rig.chassis.add(rig.house);
box(2.9, 1.0, 3.2, yellow, 0, 0.5, -0.3, rig.house);
box(2.9, 0.9, 0.9, darkSteel, 0, 0.55, -2.2, rig.house); // 配重
// 駕駛艙（左前方，x 為正）
const cabMat = mat(0x24272c, { roughness: 0.6, metalness: 0.3 });
const glass = new THREE.MeshStandardMaterial({ color: 0x9fc3d8, transparent: true, opacity: 0.1, roughness: 0.05, metalness: 0.2, depthWrite: false, side: THREE.DoubleSide });
{
  const H = rig.house;
  // 支柱
  for (const [x, z] of [[0.42, 1.0], [1.38, 1.0], [0.42, -0.2], [1.38, -0.2]]) box(0.07, 1.9, 0.07, cabMat, x, 1.95, z, H);
  box(1.0, 0.08, 1.28, yellow, 0.9, 2.92, 0.4, H);      // 車頂
  box(1.0, 0.06, 0.07, cabMat, 0.9, 2.86, 1.0, H);      // 前上框
  box(1.0, 0.22, 0.07, cabMat, 0.9, 1.12, 1.0, H);      // 前下框（儀表板）
  box(0.5, 0.1, 0.35, darkSteel, 0.9, 1.25, 0.75, H);   // 儀表
  const gl = (w, h, x, y, z, ry = 0) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), glass); m.position.set(x, y, z); m.rotation.y = ry; H.add(m); };
  gl(0.92, 1.7, 0.9, 1.95, 1.0); gl(1.2, 1.8, 0.42, 1.95, 0.4, Math.PI / 2); gl(1.2, 1.8, 1.38, 1.95, 0.4, Math.PI / 2);
  // 操作桿（視覺）
  for (const x of [0.62, 1.18]) { box(0.04, 0.3, 0.04, cabMat, x, 1.3, 0.35, H); box(0.08, 0.1, 0.08, mat(0x111111), x, 1.47, 0.35, H); }
}
// 第一人稱鏡頭
rig.camMount = new THREE.Group(); rig.camMount.position.set(0.9, 1.75, 0.3); rig.camMount.rotation.y = Math.PI;
rig.house.add(rig.camMount);
fpCam.rotation.order = 'YXZ';
rig.camMount.add(fpCam);

const BOOM_L = 5.6, ARM_L = 2.9;
rig.boomPivot = new THREE.Group(); rig.boomPivot.position.set(-0.3, 0.95, 1.1); rig.house.add(rig.boomPivot);
box(0.5, 0.65, BOOM_L, yellow, 0, 0, BOOM_L / 2, rig.boomPivot);
box(0.16, 0.16, BOOM_L * 0.7, steel, 0, -0.45, BOOM_L * 0.4, rig.boomPivot); // 油壓缸
rig.armPivot = new THREE.Group(); rig.armPivot.position.set(0, 0, BOOM_L); rig.boomPivot.add(rig.armPivot);
box(0.42, 0.48, ARM_L, yellow, 0, 0, ARM_L / 2, rig.armPivot);
box(0.12, 0.12, ARM_L * 0.8, steel, 0, 0.35, ARM_L * 0.45, rig.armPivot);
rig.bucketPivot = new THREE.Group(); rig.bucketPivot.position.set(0, 0, ARM_L); rig.armPivot.add(rig.bucketPivot);
// 挖斗：開口朝區域 -Y
const BUCKET_PARTS = [
  [0.62, 0.05, 0.72, 0, 0.05, 0.72],      // 背板
  [0.05, 0.38, 0.64, 0.62, -0.33, 0.74],  // 側板
  [0.05, 0.38, 0.64, -0.62, -0.33, 0.74],
  [0.62, 0.36, 0.05, 0, -0.33, 0.05],     // 底板
  [0.62, 0.12, 0.05, 0, -0.08, 1.42],     // 斗齒
];
for (const [hx, hy, hz, x, y, z] of BUCKET_PARTS) box(hx * 2, hy * 2, hz * 2, darkSteel, x, y, z, rig.bucketPivot);
for (let i = -2; i <= 2; i++) box(0.1, 0.08, 0.22, steel, i * 0.28, -0.12, 1.55, rig.bucketPivot);
rig.tip = new THREE.Object3D(); rig.tip.position.set(0, -0.05, 1.5); rig.bucketPivot.add(rig.tip);
rig.heel = new THREE.Object3D(); rig.heel.position.set(0, -0.7, 0.05); rig.bucketPivot.add(rig.heel);
rig.back = new THREE.Object3D(); rig.back.position.set(0, 0.1, 0.72); rig.bucketPivot.add(rig.back);
rig.mouthL = new THREE.Object3D(); rig.mouthL.position.set(0, -0.7, 1.4); rig.bucketPivot.add(rig.mouthL);
rig.cavity = new THREE.Object3D(); rig.cavity.position.set(0, -0.35, 0.75); rig.bucketPivot.add(rig.cavity);

const machine = { parts: [] }; // { obj, body }
function createMachineBodies() {
  machine.parts = [];
  const mk = (obj, shapes) => {
    obj.updateWorldMatrix(true, false);
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    obj.matrixWorld.decompose(p, q, s);
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(p.x, p.y, p.z).setRotation(q));
    for (const [hx, hy, hz, x, y, z] of shapes) {
      const c = world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z).setFriction(0.9)
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(300), body);
      colliderTag.set(c.handle, 'machine');
    }
    machine.parts.push({ obj, body });
  };
  mk(rig.chassis, [[1.65, 0.48, 2.3, 0, 0.48, 0]]);
  mk(rig.house, [[1.45, 0.5, 1.6, 0, 0.5, -0.3], [0.5, 0.95, 0.62, 0.9, 1.95, 0.4]]);
  mk(rig.boomPivot, [[0.25, 0.33, BOOM_L / 2 - 0.3, 0, 0, BOOM_L / 2 + 0.3]]);
  mk(rig.armPivot, [[0.21, 0.24, ARM_L / 2, 0, 0, ARM_L / 2]]);
  mk(rig.bucketPivot, BUCKET_PARTS);
}

// ====================== 建築（可破壞的磚塊堆疊） ======================
const unitBox = new THREE.BoxGeometry(1, 1, 1);
const level = { houses: [], treasures: [], extraMeshes: [] };

function buildHouse(cfg, palette, kind) {
  const bricks = []; // { body, size:[w,h,d], origin:Vector3, color }
  const add = (w, h, d, x, y, z, color, density = BRICK_DENSITY) => {
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z).setSleeping(true)
      .setLinearDamping(0.05).setAngularDamping(0.1));
    const c = world.createCollider(RAPIER.ColliderDesc.cuboid(w / 2, h / 2, d / 2).setDensity(density).setFriction(0.85).setRestitution(0.02), body);
    colliderTag.set(c.handle, kind);
    bricks.push({ body, size: [w, h, d], origin: new THREE.Vector3(x, y, z), color });
  };
  const { cx, cz, w, d, bh, t } = cfg;
  let base = 0;
  for (let s = 0; s < cfg.stories; s++) {
    for (let c = 0; c < cfg.courses; c++) {
      const y = base + c * bh + bh / 2;
      const even = (c + s) % 2 === 0;
      const longLen = even ? w : w - 2 * t;      // 沿 X 的牆
      const shortLen = even ? d - 2 * t : d;     // 沿 Z 的牆
      const nl = Math.max(1, Math.round(longLen / 1.2)), ns = Math.max(1, Math.round(shortLen / 1.2));
      const pick = () => palette[(Math.random() * palette.length) | 0];
      for (const zs of [-1, 1]) for (let i = 0; i < nl; i++) {
        const bl = longLen / nl;
        add(bl - 0.004, bh - 0.002, t, cx - longLen / 2 + bl * (i + 0.5), y, cz + zs * (d / 2 - t / 2), pick());
      }
      for (const xs of [-1, 1]) for (let i = 0; i < ns; i++) {
        const bl = shortLen / ns;
        add(t, bh - 0.002, bl - 0.004, cx + xs * (w / 2 - t / 2), y, cz - shortLen / 2 + bl * (i + 0.5), pick());
      }
    }
    base += cfg.courses * bh;
    // 樓板（分成兩片，拆起來比較有層次）
    for (const xs of [-1, 1]) add(w / 2 - 0.01, 0.3, d, cx + xs * w / 4, base + 0.15, cz, 0x9a9a95, 700);
    base += 0.3;
  }
  // 視覺：InstancedMesh
  const mesh = new THREE.InstancedMesh(unitBox, mat(0xffffff, { roughness: 0.9 }), bricks.length);
  mesh.castShadow = mesh.receiveShadow = true;
  const col = new THREE.Color();
  bricks.forEach((b, i) => mesh.setColorAt(i, col.setHex(b.color)));
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(mesh);
  const house = { kind, bricks, mesh, displaced: 0 };
  level.houses.push(house);
  return house;
}

const TREASURE_TYPES = [
  { name: '金條', size: [0.55, 0.28, 0.32], color: 0xffcc33, pts: 300, emissive: 0x664400 },
  { name: '古董花瓶', size: [0.38, 0.6, 0.38], color: 0x2bb3a3, pts: 400, emissive: 0x0a3a35 },
  { name: '老保險箱', size: [0.6, 0.6, 0.6], color: 0x3f5f3a, pts: 500, emissive: 0x1a2a10 },
  { name: '玉珮', size: [0.35, 0.18, 0.35], color: 0x7fe0a0, pts: 600, emissive: 0x1a5a30 },
];
function placeTreasures(n) {
  const { cx, cz, w, d, courses, bh } = TARGET;
  for (let i = 0; i < n; i++) {
    const tp = TREASURE_TYPES[(Math.random() * TREASURE_TYPES.length) | 0];
    const upstairs = i === n - 1 && Math.random() < 0.5;
    const x = cx + (Math.random() - 0.5) * (w - 2.0);
    const z = cz + (Math.random() - 0.5) * (d - 1.8);
    const y = (upstairs ? courses * bh + 0.3 : 0) + tp.size[1] / 2 + 0.01;
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z).setSleeping(true).setCcdEnabled(true));
    const c = world.createCollider(RAPIER.ColliderDesc.cuboid(...tp.size.map(s => s / 2)).setDensity(900).setFriction(1.0), body);
    colliderTag.set(c.handle, 'treasure');
    const m = box(...tp.size, mat(tp.color, { emissive: tp.emissive, emissiveIntensity: 0.6, metalness: 0.5, roughness: 0.35 }));
    scene.add(m); level.extraMeshes.push(m);
    level.treasures.push({ ...tp, body, mesh: m, delivered: false });
  }
}

function buildTruck() {
  const { cx, cz, w, d, floorY, wallH } = TRUCK;
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const parts = [
    [w / 2, floorY / 2, d / 2, cx, floorY / 2, cz, 0x3a3f46],              // 車斗底座
    [0.06, wallH / 2, d / 2, cx - w / 2, floorY + wallH / 2, cz, 0xd9d4c7], // 側板
    [0.06, wallH / 2, d / 2, cx + w / 2, floorY + wallH / 2, cz, 0xd9d4c7],
    [w / 2, wallH / 2, 0.06, cx, floorY + wallH / 2, cz - d / 2, 0xd9d4c7],
    [w / 2, wallH / 2, 0.06, cx, floorY + wallH / 2, cz + d / 2, 0xd9d4c7],
    [w / 2, 1.1, 0.9, cx, 1.1, cz + d / 2 + 1.0, 0x2f6fb5],                  // 車頭
  ];
  for (const [hx, hy, hz, x, y, z, color] of parts) {
    world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z).setFriction(0.9), body);
    const m = box(hx * 2, hy * 2, hz * 2, mat(color), x, y, z); scene.add(m); level.extraMeshes.push(m);
  }
  // 車斗標示
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.2, d - 0.2), new THREE.MeshBasicMaterial({ color: 0xf5b800, transparent: true, opacity: 0.25 }));
  sign.rotation.x = -Math.PI / 2; sign.position.set(cx, floorY + 0.01, cz); scene.add(sign); level.extraMeshes.push(sign);
}
function inTruck(p) {
  const { cx, cz, w, d, floorY, wallH } = TRUCK;
  return Math.abs(p.x - cx) < w / 2 && Math.abs(p.z - cz) < d / 2 && p.y > floorY - 0.05 && p.y < floorY + wallH + 1.0;
}

// ====================== 粒子（粉塵） ======================
const DUST_N = 400;
const dust = {
  pos: new Float32Array(DUST_N * 3), vel: new Float32Array(DUST_N * 3), life: new Float32Array(DUST_N), i: 0,
};
const dustGeo = new THREE.BufferGeometry();
dustGeo.setAttribute('position', new THREE.BufferAttribute(dust.pos, 3));
const dustPts = new THREE.Points(dustGeo, new THREE.PointsMaterial({ color: 0xcdbb9c, size: 0.28, transparent: true, opacity: 0.6, depthWrite: false }));
dustPts.frustumCulled = false; scene.add(dustPts);
for (let i = 0; i < DUST_N; i++) dust.pos[i * 3 + 1] = -100;
function emitDust(p, n) {
  for (let k = 0; k < n; k++) {
    const i = dust.i = (dust.i + 1) % DUST_N;
    dust.pos.set([p.x + (Math.random() - .5) * .6, p.y + Math.random() * .4, p.z + (Math.random() - .5) * .6], i * 3);
    dust.vel.set([(Math.random() - .5) * 2.2, 0.6 + Math.random() * 1.8, (Math.random() - .5) * 2.2], i * 3);
    dust.life[i] = 1.2 + Math.random();
  }
}
function updateDust(dt) {
  for (let i = 0; i < DUST_N; i++) {
    if (dust.life[i] <= 0) continue;
    dust.life[i] -= dt;
    for (let a = 0; a < 3; a++) dust.pos[i * 3 + a] += dust.vel[i * 3 + a] * dt;
    dust.vel[i * 3 + 1] -= 0.6 * dt;
    if (dust.life[i] <= 0) dust.pos[i * 3 + 1] = -100;
  }
  dustGeo.attributes.position.needsUpdate = true;
}

// ====================== 音效（WebAudio 即時合成） ======================
const audio = { ctx: null };
function initAudio() {
  if (audio.ctx) return;
  try {
    const ctx = new AudioContext();
    const master = ctx.createGain(); master.gain.value = 0.5; master.connect(ctx.destination);
    const eng = ctx.createOscillator(); eng.type = 'sawtooth'; eng.frequency.value = 48;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 380;
    const eg = ctx.createGain(); eg.gain.value = 0.09;
    eng.connect(lp).connect(eg).connect(master); eng.start();
    const hyd = ctx.createOscillator(); hyd.type = 'triangle'; hyd.frequency.value = 320;
    const hg = ctx.createGain(); hg.gain.value = 0;
    hyd.connect(hg).connect(master); hyd.start();
    const noise = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    const ch = noise.getChannelData(0); for (let i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / ch.length, 2);
    Object.assign(audio, { ctx, master, eng, lp, eg, hyd, hg, noise, lastHit: 0 });
  } catch { /* 沒聲音也能玩 */ }
}
function audioUpdate(activity, load) {
  if (!audio.ctx) return;
  const t = audio.ctx.currentTime;
  audio.eng.frequency.setTargetAtTime(46 + activity * 18 + load * 26, t, 0.15);
  audio.lp.frequency.setTargetAtTime(340 + activity * 260 + load * 500, t, 0.15);
  audio.hyd.frequency.setTargetAtTime(260 + activity * 180 + load * 120, t, 0.1);
  audio.hg.gain.setTargetAtTime(0.012 * activity + 0.02 * load, t, 0.08);
}
function audioHit(strength, freq = 700) {
  if (!audio.ctx || strength < 0.04) return;
  const now = performance.now(); if (now - audio.lastHit < 70) return; audio.lastHit = now;
  const src = audio.ctx.createBufferSource(); src.buffer = audio.noise;
  const f = audio.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = freq;
  const g = audio.ctx.createGain(); g.gain.value = Math.min(1, strength) * 0.9;
  src.connect(f).connect(g).connect(audio.master); src.start();
}

// ====================== 輸入：鍵盤 / 手把 / 手機 ======================
const AXES = ['swing', 'arm', 'boom', 'bucket', 'drive', 'turn'];
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
    swing: kAxis('KeyA', 'KeyD'), arm: kAxis('KeyW', 'KeyS'), boom: kAxis('KeyI', 'KeyK'),
    bucket: kAxis('KeyJ', 'KeyL'), drive: kAxis('ArrowUp', 'ArrowDown'), turn: kAxis('ArrowLeft', 'ArrowRight'),
  };
}
const dz = v => Math.abs(v) < 0.12 ? 0 : (v - Math.sign(v) * 0.12) / 0.88;
// 搖桿原始值（右/下為正）→ 關節指令
function sticksToAxes(lx, ly, rx, ry) {
  return { swing: -dz(lx), arm: -dz(ly), boom: -dz(ry), bucket: -dz(rx) };
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
// 手機遙控器
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
      ui.pairStatus.textContent = m.pads ? `已連線 ${m.pads} 支手機` : '等待手機連線';
      ui.pairStatus.classList.toggle('on', m.pads > 0);
      toast(m.t === 'padJoined' ? '📱 手機遙控器已連線' : '📱 手機遙控器已斷線');
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
    ui.pairStatus.textContent = '重新連線中…'; ui.pairStatus.classList.remove('on');
    setTimeout(connectPadRelay, Math.min(8000, 1000 * 2 ** pad.retry++));
  };
}
function padSend(obj) { if (pad.ws && pad.ws.readyState === 1) pad.ws.send(JSON.stringify(obj)); }
function phoneInput() {
  // 安全機制：超過 400ms 沒收到手機訊號就當作放開搖桿
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

// ====================== 遊戲狀態 ======================
const game = {
  phase: 'menu', latency: 0, t: 0, joints: { ...START_POSE }, vel: { swing: 0, boom: 0, arm: 0, bucket: 0 },
  ideal: { ...START_POSE }, base: { x: 0, z: 0, heading: 0 }, load: 0, frameForce: 0, sampleForce: 0,
  inputHist: [], raw: null, delayed: null, sessionId: null, samples: [], events: [], sampleCount: 0,
  lastSampleAt: 0, lastUploadAt: 0, demo: 0, collateral: 0, treasures: 0, treasurePts: 0,
  reversals: 0, lastCmdSign: {}, bigHits: 0, shake: 0, headYaw: 0, headPitch: 0, finishedOnce: false,
  online: true, gamepad: null, lastSrc: '-',
};

function setLatency(v) {
  game.latency = clamp(Math.round(v / 50) * 50, 0, 500);
  ui.latency.value = game.latency; ui.latencyVal.textContent = game.latency + ' ms';
  ui.hLatency.textContent = game.latency + ' ms';
  store.set('latency', game.latency);
  if (game.phase === 'play') { logEvent('latency_change', { value: game.latency }); toast(`通訊延遲 ${game.latency} ms`); }
}
function toggleView() {
  thirdPerson = !thirdPerson;
  ui.hView.textContent = thirdPerson ? '第三人稱（除錯）' : '駕駛艙';
}
let toastTimer;
function toast(msg) {
  ui.toast.textContent = msg; ui.toast.style.opacity = 1;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { ui.toast.style.opacity = 0; }, 1600);
}
function haptic(strength, ms) {
  const gp = game.gamepad;
  try { gp && gp.vibrationActuator && gp.vibrationActuator.playEffect('dual-rumble', { duration: ms, strongMagnitude: Math.min(1, strength), weakMagnitude: Math.min(1, strength * 0.6) }); } catch { /* 不支援 */ }
  if (pad.pads) padSend({ t: 'haptic', ms: Math.round(ms), s: Math.min(1, strength) });
}

// ====================== 關卡建立 / 重置 ======================
function resetLevel() {
  for (const h of level.houses) { scene.remove(h.mesh); h.mesh.dispose(); }
  for (const m of level.extraMeshes) { scene.remove(m); m.geometry.dispose(); }
  level.houses = []; level.treasures = []; level.extraMeshes = [];
  if (world) world.free();
  initWorld();
  Object.assign(game, {
    joints: { ...START_POSE }, vel: { swing: 0, boom: 0, arm: 0, bucket: 0 }, ideal: { ...START_POSE },
    base: { x: 0, z: 0, heading: 0 }, load: 0, t: 0, inputHist: [], samples: [], events: [], sampleCount: 0,
    demo: 0, collateral: 0, treasures: 0, treasurePts: 0, reversals: 0, lastCmdSign: {}, bigHits: 0, shake: 0,
    finishedOnce: false, sessionId: null,
  });
  applyRig();
  createMachineBodies();
  buildHouse(TARGET, [0xb5654a, 0xa95a42, 0xbf7155, 0x9e5340, 0xc47a5c], 'target');
  buildHouse(NEIGHBOR, [0x8fa3b8, 0x9db0c4, 0x8496aa], 'neighbor');
  placeTreasures(3);
  buildTruck();
  syncDynamicMeshes();
  ui.resultOverlay.style.display = 'none';
  ui.finishHint.style.display = 'none';
  if (game.phase === 'result') { game.phase = 'menu'; startGame(); }
}

function applyRig() {
  const { joints: j, base } = game;
  rig.chassis.position.set(base.x, 0, base.z);
  rig.chassis.rotation.y = base.heading;
  rig.house.rotation.y = j.swing;
  rig.boomPivot.rotation.x = j.boom;
  rig.armPivot.rotation.x = j.arm;
  rig.bucketPivot.rotation.x = j.bucket;
  rig.chassis.updateMatrixWorld(true);
}
const _v = new THREE.Vector3(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
function bucketMinY() {
  let m = Infinity;
  for (const o of [rig.tip, rig.heel, rig.back, rig.mouthL]) m = Math.min(m, o.getWorldPosition(_v).y);
  return m;
}

// ====================== 每個物理步 ======================
function physicsStep() {
  const playing = game.phase === 'play';
  const cmd = playing && game.delayed ? game.delayed : null;
  const loadScale = 1 - 0.65 * game.load;
  const prev = { ...game.joints };
  const prevMin = bucketMinY();

  for (const name of ['swing', 'boom', 'arm', 'bucket']) {
    const J = JOINTS[name];
    const c = cmd ? cmd[name] : 0;
    const target = c * J.speed * J.dir * (name === 'swing' ? 1 : loadScale);
    const dv = target - game.vel[name];
    game.vel[name] += clamp(dv, -JOINT_ACCEL * DT, JOINT_ACCEL * DT);
    let a = game.joints[name] + game.vel[name] * DT;
    if (a < J.min || a > J.max) { a = clamp(a, J.min, J.max); game.vel[name] = 0; }
    game.joints[name] = a;
    // 理想軌跡：沒有延遲、沒有液壓遲滯時的關節角度（給後台比較用）
    const rc = playing && game.raw ? game.raw[name] : 0;
    let ia = game.ideal[name] + rc * J.speed * J.dir * DT;
    ia += (game.joints[name] - ia) * 0.5 * DT;
    game.ideal[name] = clamp(ia, J.min, J.max);
    // 方向反轉次數（平順度）
    const s = Math.abs(c) > 0.3 ? Math.sign(c) : 0;
    if (s && game.lastCmdSign[name] && s !== game.lastCmdSign[name]) game.reversals++;
    if (s) game.lastCmdSign[name] = s;
  }
  // 履帶
  const drive = cmd ? cmd.drive : 0, turn = cmd ? cmd.turn : 0;
  game.base.heading += turn * 0.5 * DT * (drive < 0 ? -1 : 1);
  game.base.x += Math.sin(game.base.heading) * drive * 1.6 * DT;
  game.base.z += Math.cos(game.base.heading) * drive * 1.6 * DT;
  game.base.x = clamp(game.base.x, -21, 21); game.base.z = clamp(game.base.z, -12, 32);

  applyRig();
  // 挖斗不能鑽進地面：往下壓就停住
  const minY = bucketMinY();
  game.groundPress = false;
  if (minY < 0.02 && minY < prevMin - 1e-5) {
    for (const n of ['boom', 'arm', 'bucket']) { game.joints[n] = prev[n]; game.vel[n] = 0; }
    applyRig();
    game.groundPress = true;
  }

  for (const { obj, body } of machine.parts) {
    obj.matrixWorld.decompose(_p, _q, _s);
    body.setNextKinematicTranslation(_p);
    body.setNextKinematicRotation(_q);
  }
  world.step(eventQueue);

  let maxF = 0;
  eventQueue.drainContactForceEvents(ev => {
    const a = colliderTag.get(ev.collider1()), b = colliderTag.get(ev.collider2());
    if (a === 'machine' || b === 'machine') maxF = Math.max(maxF, ev.totalForceMagnitude());
  });
  eventQueue.drainCollisionEvents(() => {});
  game.frameForce = Math.max(game.frameForce, maxF);
  game.sampleForce = Math.max(game.sampleForce, maxF);
  const loadTarget = clamp(maxF / 120000 + (game.groundPress ? 0.35 : 0), 0, 1);
  game.load += (loadTarget - game.load) * (loadTarget > game.load ? 0.25 : 0.04);
}

function syncDynamicMeshes() {
  const m4 = new THREE.Matrix4(), sc = new THREE.Vector3();
  for (const h of level.houses) {
    h.bricks.forEach((b, i) => {
      const t = b.body.translation(), r = b.body.rotation();
      _p.set(t.x, t.y, t.z); _q.set(r.x, r.y, r.z, r.w); sc.set(...b.size);
      h.mesh.setMatrixAt(i, m4.compose(_p, _q, sc));
    });
    h.mesh.instanceMatrix.needsUpdate = true;
  }
  for (const tr of level.treasures) {
    const t = tr.body.translation(), r = tr.body.rotation();
    tr.mesh.position.set(t.x, t.y, t.z); tr.mesh.quaternion.set(r.x, r.y, r.z, r.w);
  }
}

// ====================== 任務判定 ======================
let lastJudge = 0;
function judge(now) {
  if (now - lastJudge < 200) return; lastJudge = now;
  for (const h of level.houses) {
    let n = 0;
    for (const b of h.bricks) {
      const t = b.body.translation();
      _v.set(t.x, t.y, t.z);
      if (_v.distanceTo(b.origin) > (h.kind === 'target' ? 0.5 : 0.25)) n++;
    }
    if (h.kind === 'target') {
      const prevPct = Math.floor(game.demo * 10);
      game.demo = n / h.bricks.length;
      const pct = Math.floor(game.demo * 10);
      if (game.phase === 'play' && pct > prevPct) logEvent('demolition', { ratio: +game.demo.toFixed(3) });
    } else if (n > game.collateral) {
      if (game.phase === 'play') {
        logEvent('collateral', { count: n });
        toast('⚠️ 砸到隔壁鄰居了！'); haptic(1, 300);
      }
      game.collateral = n;
    }
  }
  for (const tr of level.treasures) {
    if (tr.delivered) continue;
    const t = tr.body.translation(), lv = tr.body.linvel();
    if (inTruck(t) && Math.hypot(lv.x, lv.y, lv.z) < 0.6) {
      tr.delivered = true; game.treasures++; game.treasurePts += tr.pts;
      if (game.phase === 'play') { logEvent('treasure', { name: tr.name, pts: tr.pts }); toast(`💰 ${tr.name} 入袋 +${tr.pts}`); haptic(0.6, 200); }
    }
  }
  if (game.phase === 'play') {
    ui.finishHint.style.display = game.demo >= FINISH_RATIO ? 'block' : 'none';
    if (game.demo >= FINISH_RATIO && !game.finishedOnce) { game.finishedOnce = true; toast('拆除達標！可以收工了'); logEvent('target_reached', {}); }
  }
}

// ====================== 遙測 ======================
const r3 = v => Math.round(v * 1000) / 1000;
function logEvent(type, data) {
  const e = { t: r3(game.t), type, ...data };
  game.events.push(e);
}
function takeSample() {
  const j = game.joints, id = game.ideal, raw = game.raw, d = game.delayed;
  rig.tip.getWorldPosition(_v);
  game.samples.push({
    t: r3(game.t), src: raw.src,
    inSwing: r3(raw.swing), inArm: r3(raw.arm), inBoom: r3(raw.boom), inBucket: r3(raw.bucket),
    inTrackL: r3(clamp(raw.drive - raw.turn, -1, 1)), inTrackR: r3(clamp(raw.drive + raw.turn, -1, 1)),
    dSwing: r3(d.swing), dArm: r3(d.arm), dBoom: r3(d.boom), dBucket: r3(d.bucket),
    swing: r3(j.swing * DEG), boom: r3(-j.boom * DEG), arm: r3(j.arm * DEG), bucket: r3(j.bucket * DEG),
    tgtSwing: r3(id.swing * DEG), tgtBoom: r3(-id.boom * DEG), tgtArm: r3(id.arm * DEG), tgtBucket: r3(id.bucket * DEG),
    tipX: r3(_v.x), tipY: r3(_v.y), tipZ: r3(_v.z),
    baseX: r3(game.base.x), baseZ: r3(game.base.z), heading: r3(game.base.heading * DEG),
    load: r3(game.load), impulse: r3(game.sampleForce / 1000), latencyMs: game.latency,
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
  ui.hRec.textContent = on ? 'REC 遙測紀錄中' : 'REC 離線暫存中';
}

// ====================== 流程 ======================
async function startGame() {
  if (game.phase !== 'menu') return;
  initAudio();
  if (audio.ctx && audio.ctx.state === 'suspended') audio.ctx.resume();
  const player = ui.playerName.value.trim() || '匿名';
  store.set('name', player);
  setLatency(+ui.latency.value || 0);
  ui.startOverlay.style.display = 'none';
  ui.hud.forEach(h => { h.style.display = ''; });
  game.phase = 'play'; game.t = 0;
  padSend({ t: 'state', phase: 'play' });
  logEvent('start', { player, latencyMs: game.latency, treasures: level.treasures.map(t => t.name) });
  try {
    const { id } = await api('/api/session/start', { player, latencyMs: game.latency });
    game.sessionId = id; setOnline(true);
  } catch { setOnline(false); }
}
function tryFinish() {
  if (game.phase !== 'play') return;
  if (game.demo < FINISH_RATIO) { toast(`拆除率還不到 ${FINISH_RATIO * 100}%`); return; }
  endGame(true, '收工');
}
async function endGame(completed, reason) {
  if (game.phase !== 'play') return;
  game.phase = 'result';
  ui.finishHint.style.display = 'none';
  const minutes = Math.max(game.t / 60, 0.25);
  const smooth = Math.round(clamp(100 - (game.reversals / minutes) * 2.5, 0, 100));
  const stars = completed ? 1 + (game.collateral === 0 ? 1 : 0) + (smooth >= 60 ? 1 : 0) : 0;
  const timeBonus = completed ? Math.round(Math.max(0, TIME_LIMIT - game.t) * 3) : 0;
  const score = Math.max(0, Math.round(game.demo * 1000) + game.treasurePts + timeBonus - game.collateral * 40 + smooth * 2);
  const result = { completed, score, stars, time: r3(game.t), demolished: r3(game.demo), collateral: game.collateral,
    treasures: game.treasures, smoothness: smooth, reason };
  logEvent('finish', result);
  padSend({ t: 'state', phase: 'result', score, stars });
  ui.rTitle.textContent = completed ? '收工！' : (reason === 'timeout' ? '時間到，工程延宕' : '工程中止');
  ui.rStars.innerHTML = [0, 1, 2].map(i => `<span class="${i < stars ? '' : 'off'}">★</span>`).join('');
  const row = (k, v) => `<tr><td>${k}</td><td>${v}</td></tr>`;
  ui.rTable.innerHTML = row('拆除率', Math.round(game.demo * 100) + '%') + row('用時', fmtTime(game.t))
    + row('寶物', `${game.treasures} 件（+${game.treasurePts}）`) + row('附帶損害', game.collateral + ' 塊')
    + row('操作平順度', smooth + ' / 100') + row('通訊延遲', game.latency + ' ms')
    + row('遙測樣本', game.sampleCount.toLocaleString() + ' 筆') + row('<b>總分</b>', `<b>${score.toLocaleString()}</b>`);
  ui.rRank.textContent = '上傳成績中…';
  ui.resultOverlay.style.display = 'flex';
  await upload(true);
  try {
    if (!game.sessionId) throw new Error('offline');
    const r = await api('/api/session/end', { sessionId: game.sessionId, result });
    ui.rRank.textContent = completed && r.rank ? `排行榜第 ${r.rank} 名。這局的 ${game.sampleCount.toLocaleString()} 筆操作數據已經存進訓練資料集。` : '這局的操作數據已經存進訓練資料集。';
  } catch { ui.rRank.textContent = '連不上伺服器，這局沒有存到排行榜。'; }
}
ui.startBtn.addEventListener('click', startGame);
ui.againBtn.addEventListener('click', resetLevel);
const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// 轉頭：按住右鍵拖曳
let looking = false;
renderer.domElement.addEventListener('contextmenu', e => e.preventDefault());
renderer.domElement.addEventListener('mousedown', e => { if (e.button === 2) looking = true; });
addEventListener('mouseup', e => { if (e.button === 2) looking = false; });
addEventListener('mousemove', e => {
  if (!looking) return;
  game.headYaw = clamp(game.headYaw - e.movementX * 0.004, -1.6, 1.6);
  game.headPitch = clamp(game.headPitch - e.movementY * 0.004, -0.7, 0.5);
});

// ====================== 主迴圈 ======================
let acc = 0, last = performance.now(), hudAt = 0, padStateAt = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000); last = now;

  // 輸入 → 延遲佇列
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
  judge(now);

  // 打擊感：鏡頭震動、粉塵、聲音、震動回饋
  const hit = clamp(game.frameForce / 90000, 0, 1);
  if (hit > 0.05) {
    game.shake = Math.max(game.shake, hit * 0.12);
    rig.tip.getWorldPosition(_v); emitDust(_v, Math.ceil(hit * 14));
    audioHit(hit, 500 + hit * 900);
    if (hit > 0.35) haptic(hit, 90);
    if (hit > 0.6 && game.phase === 'play') { game.bigHits++; logEvent('impact', { kN: r3(game.frameForce / 1000) }); }
  }
  game.shake *= Math.pow(0.02, dt);
  updateDust(dt);
  const activity = Math.min(1, ['swing', 'boom', 'arm', 'bucket'].reduce((s, n) => s + Math.abs(game.vel[n]), 0) / 1.2);
  audioUpdate(activity, game.load);

  // 鏡頭
  fpCam.rotation.set(-0.2 + game.headPitch, game.headYaw, 0);
  fpCam.position.set((Math.random() - .5) * game.shake, (Math.random() - .5) * game.shake, 0);
  if (thirdPerson) {
    rig.house.updateWorldMatrix(true, false);
    tpCam.position.copy(_v.set(5, 7, -9).applyMatrix4(rig.house.matrixWorld));
    tpCam.lookAt(_v.set(0, 1.5, 6).applyMatrix4(rig.house.matrixWorld));
  }

  // 遙測
  if (game.phase === 'play') {
    if (now - game.lastSampleAt >= SAMPLE_MS) { game.lastSampleAt = now; takeSample(); }
    if (now - game.lastUploadAt >= UPLOAD_MS) { game.lastUploadAt = now; upload(); }
    if (game.t >= TIME_LIMIT) endGame(game.demo >= FINISH_RATIO, 'timeout');
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
  const remain = Math.max(0, TIME_LIMIT - game.t);
  ui.hTime.textContent = fmtTime(remain);
  ui.hTime.style.color = remain < 30 ? 'var(--red)' : '';
  ui.hDemo.textContent = Math.round(game.demo * 100) + '%';
  ui.demoBar.style.width = Math.min(100, game.demo / FINISH_RATIO * 100) + '%';
  ui.hTreasure.textContent = `${game.treasures} / ${level.treasures.length}`;
  ui.hCollateral.textContent = game.collateral;
  ui.hCollateral.style.color = game.collateral ? 'var(--red)' : '';
  ui.hSamples.textContent = game.sampleCount.toLocaleString();
  const srcName = { kbd: '鍵盤', gamepad: '手把', phone: '📱 手機' };
  ui.hPad.textContent = pad.pads ? '📱 手機已連線' : (game.gamepad ? '手把' : '鍵盤');
  if (game.lastSrc !== '-' && !pad.pads) ui.hPad.textContent = game.lastSrc.split('+').map(s => srcName[s] || s).join('＋');
  const j = game.joints;
  ui.gSwing.textContent = Math.round(((j.swing * DEG) % 360 + 540) % 360 - 180) + '°';
  ui.gBoom.textContent = Math.round(-j.boom * DEG) + '°';
  ui.gArm.textContent = Math.round(j.arm * DEG) + '°';
  ui.gBucket.textContent = Math.round(j.bucket * DEG) + '°';
  ui.loadBar.style.width = Math.round(game.load * 100) + '%';
}

// ====================== 啟動 ======================
resetLevel();
setLatency(+ui.latency.value || 0);
infoReady.finally(connectPadRelay);
requestAnimationFrame(frame);
window.__game = { game, level, rig, pad, keys, startGame, endGame, resetLevel, setLatency, TARGET };
