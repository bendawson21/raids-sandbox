// Battle sim (sandbox indulgence, not game code): five race factions on a pentagon arena,
// each spawning along its own edge, all drawn to a central objective.  Whoever holds the
// centre fans out to roam and defend it.  Units respawn as soon as they fall, so every
// faction keeps a constant head count.  Melee attackers per target are capped so fights
// stay spread out instead of collapsing into blobs.
import * as THREE from 'three';
import { Assets } from './assets.js';
import { Game } from './game.js';
import { emptyInput } from './actor.js';

// ---------------------------------------------------------------- tuning
const ARENA = 34;                 // pentagon circumradius (m)
const OBJ_R = 6;                  // the central objective's radius
const CAPTURE_T = 4;              // seconds alone on the objective to claim it
const MELEE_CAP = 2;              // melee attackers allowed on one target at once
const RESPAWN_T = 2.6;            // seconds a body lies before the unit respawns at its edge

// faction = race.  Head counts skewed by strength (100 in all); palette = their colours.
const FACTIONS = [
  { race: 'human', name: 'Humans', count: 21, palette: 'knight' },
  { race: 'dwarf', name: 'Dwarves', count: 16, palette: 'hero' },
  { race: 'orc', name: 'Orcs', count: 15, palette: 'horde' },
  { race: 'elf', name: 'Elves', count: 18, palette: 'ranger' },
  { race: 'goblin', name: 'Goblins', count: 30, palette: 'noble' },
];
// race stats: humans are the baseline
const RACE_STATS = {
  human: { hp: 100, dmg: 1.0 }, elf: { hp: 95, dmg: 1.05 }, dwarf: { hp: 150, dmg: 1.15 },   // dwarves: slow, so tougher
  orc: { hp: 165, dmg: 1.35 }, goblin: { hp: 60, dmg: 0.7 },
};
// the finished outfits (an even mix; the orc brute is rare), with their own hp / damage
const UNITS = [
  { lo: 'levy', w: 1, hp: 0.9 }, { lo: 'billman', w: 1, hp: 1.0 }, { lo: 'sergeant', w: 1, hp: 1.0 },
  { lo: 'archer', w: 1, hp: 0.85 }, { lo: 'ranger', w: 1, hp: 0.85 }, { lo: 'crossbowman', w: 1, hp: 0.9 },
  { lo: 'man_at_arms', w: 1, hp: 1.15 }, { lo: 'knight', w: 1, hp: 1.25 }, { lo: 'hold_guard', w: 1, hp: 1.35 },
  { lo: 'plate_knight', w: 1, hp: 1.4 }, { lo: 'captain', w: 1, hp: 1.4, dmg: 1.1 },
  { lo: 'lieutenant', w: 1, hp: 1.2 }, { lo: 'sergeant_plume', w: 1, hp: 1.05 },
  { lo: 'orc_brute', w: 0.25, hp: 1.5, dmg: 1.2 },
];

// ---------------------------------------------------------------- boot
const loading = document.getElementById('loading');
const assets = new Assets();
try {
  await assets.load(s => { loading.textContent = `Loading… ${s}`; });
  for (const f of FACTIONS) { loading.textContent = `Loading ${f.name}…`; await assets.loadRace(f.race); }
} catch (e) {
  loading.textContent = 'Failed to load assets: ' + e.message;
  throw e;
}
loading.remove();

const corners = FACTIONS.map((_, i) => {
  const a = (i / FACTIONS.length) * Math.PI * 2 + Math.PI;
  return new THREE.Vector3(Math.sin(a) * ARENA, 0, Math.cos(a) * ARENA);
});

// phones / tablets: a lighter render (no shadows, 1x pixels) - 100 skinned soldiers
const TOUCH = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;

class BattleGame extends Game {
  buildWorld() {
    this.dummies = [];
    if (TOUCH) {
      this.renderer.setPixelRatio(1);
      this.renderer.shadowMap.enabled = false;
      this.sun.castShadow = false;
    }
    this.quiet = true;                       // no damage numbers / hit-stop / camera shake
    this.showTrails = false;
    this.camMax = 95;
    this.camDist = 62;
    this.camPitch = THREE.MathUtils.degToRad(58);
    this.scene.fog = new THREE.Fog(0x9fb4c4, 90, 200);
    this.camera.far = 400; this.camera.updateProjectionMatrix();
    const sc = this.sun.shadow.camera;
    sc.left = -45; sc.right = 45; sc.top = 45; sc.bottom = -45; sc.far = 120; sc.updateProjectionMatrix();
    this.sun.shadow.mapSize.set(4096, 4096);
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    // ground: a big flat field, the pentagon floor slightly lighter
    const field = new THREE.Mesh(new THREE.CircleGeometry(160, 48),
      new THREE.MeshStandardMaterial({ color: 0x6f7f4f, roughness: 1 }));
    field.rotation.x = -Math.PI / 2; field.position.y = -0.02; field.receiveShadow = true;
    this.scene.add(field);
    const shape = new THREE.Shape(corners.map(c => new THREE.Vector2(c.x, -c.z)));
    const floor = new THREE.Mesh(new THREE.ShapeGeometry(shape),
      new THREE.MeshStandardMaterial({ color: 0x8f8c6a, roughness: 1 }));
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
    this.scene.add(floor);
    // each faction's edge, a strip in its colour
    this.edgeMats = [];
    FACTIONS.forEach((f, i) => {
      const a = corners[i], b = corners[(i + 1) % corners.length];
      const len = a.distanceTo(b);
      const col = new THREE.Color(assets.catalog.palettes[f.palette].team1);
      const m = new THREE.Mesh(new THREE.BoxGeometry(len, 0.08, 0.5), new THREE.MeshStandardMaterial({ color: col, roughness: 0.8 }));
      m.position.copy(a).add(b).multiplyScalar(0.5).setY(0.04);
      m.rotation.y = -Math.atan2(b.z - a.z, b.x - a.x);
      this.scene.add(m);
    });
    // the objective: a raised stone dais, a ring, a banner pole whose flag takes the holder's colour
    const stone = new THREE.MeshStandardMaterial({ color: 0x9a968c, roughness: 0.95, flatShading: true });
    const dais = new THREE.Mesh(new THREE.CylinderGeometry(OBJ_R, OBJ_R + 0.4, 0.18, 10), stone);
    dais.position.y = 0.09; dais.receiveShadow = true; this.scene.add(dais);
    this.objRing = new THREE.Mesh(new THREE.TorusGeometry(OBJ_R, 0.12, 4, 40),
      new THREE.MeshStandardMaterial({ color: 0xdddddd, emissive: 0x222222 }));
    this.objRing.rotation.x = Math.PI / 2; this.objRing.position.y = 0.2; this.scene.add(this.objRing);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 5, 6), new THREE.MeshStandardMaterial({ color: 0x5c4129 }));
    pole.position.y = 2.5; pole.castShadow = true; this.scene.add(pole);
    this.flag = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.0, 0.05), new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.8 }));
    this.flag.position.set(0.85, 4.4, 0); this.flag.castShadow = true; this.scene.add(this.flag);
  }
}

const game = new BattleGame(assets, document.getElementById('app'));
window.game = game;
game.player = null;
// the whole arena in view: further back on a narrow (portrait) screen
const homeDist = () => 62 * Math.max(1, 0.95 / game.camera.aspect);
game.camMax = Math.max(95, homeDist() * 1.25);
game.camDist = homeDist();
game.camera.far = Math.max(400, homeDist() * 3); game.camera.updateProjectionMatrix();
game.scene.fog.far = Math.max(200, homeDist() * 2.5);

// keep everyone inside the pentagon
const inward = corners.map((a, i) => {
  const b = corners[(i + 1) % corners.length];
  const e = b.clone().sub(a);
  return { a, n: new THREE.Vector3(-e.z, 0, e.x).normalize() };          // inward normal (CCW)
});
if (inward[0].n.dot(corners[2].clone().sub(corners[0])) < 0) inward.forEach(s => s.n.negate());
game.clampArena = p => {
  for (const s of inward) {
    const d = (p.x - s.a.x) * s.n.x + (p.z - s.a.z) * s.n.z;
    if (d < 0.4) { p.x += s.n.x * (0.4 - d); p.z += s.n.z * (0.4 - d); }
  }
};

// ---------------------------------------------------------------- units
const LO = assets.catalog.loadouts;
const pool = UNITS.filter(u => LO[u.lo]);
const wsum = pool.reduce((s, u) => s + u.w, 0);
function pickUnit() {
  let r = Math.random() * wsum;
  for (const u of pool) { r -= u.w; if (r <= 0) return u; }
  return pool[0];
}
function loadoutFor(u, f) {
  const lo = LO[u.lo];
  const L = { palette: f.palette, race: f.race, hair: lo.hair || null, beard: lo.beard || null,
    mainhand: lo.mainhand || null, offhand: lo.offhand || null };
  for (const id of lo.items) L[assets.item(id).slot] = id;
  return L;
}

const sim = { owner: -1, progress: FACTIONS.map(() => 0), kills: FACTIONS.map(() => 0), deaths: FACTIONS.map(() => 0) };

function spawnUnit(fi) {
  const f = FACTIONS[fi];
  const a = corners[fi], b = corners[(fi + 1) % corners.length];
  const t = 0.1 + Math.random() * 0.8;
  const pos = a.clone().lerp(b, t).addScaledVector(inward[fi].n, 1.5 + Math.random() * 2.5);
  const u = pickUnit(), rs = RACE_STATS[f.race];
  const hp = Math.round(rs.hp * u.hp);
  const act = game.spawn(loadoutFor(u, f), pos, {
    name: u.lo, faction: f.race, hittable: true, hp, facing: Math.atan2(-pos.x, -pos.z) });
  act.dmgMul = rs.dmg * (u.dmg || 1);
  act.fi = fi;
  act.unit = u.lo;
  // a personal approach lane: a point on the objective's rim (spreads the advance)
  act.bt = { target: null, retarget: Math.random() * 0.5, cd: 0.5 + Math.random(), chain: 0, hold: 0,
    lane: Math.random() * Math.PI * 2, laneR: 2 + Math.random() * (OBJ_R - 1), roam: null, block: 0, strafe: Math.random() < 0.5 ? 1 : -1 };
  act.ai = battleAI;
  return act;
}

function removeUnit(act) {
  act.char.root.removeFromParent();
  for (const tr of Object.values(act.trails)) tr.mesh.removeFromParent();
  game.actors.splice(game.actors.indexOf(act), 1);
  game.targets.splice(game.targets.indexOf(act), 1);
}

// ---------------------------------------------------------------- AI
const _v = new THREE.Vector2();
function steer(a, goal, stop) {
  const d = new THREE.Vector2(goal.x - a.pos.x, goal.z - a.pos.z);
  const len = d.length();
  if (len <= stop) return d.set(0, 0);
  return d.divideScalar(len).multiplyScalar(Math.min(1, (len - stop) * 1.2));
}
// push away from nearby allies (no blobs)
function separate(a, move, radius = 2.0, k = 0.9) {
  for (const o of game.actors) {
    if (o === a || !o.alive || o.fi !== a.fi) continue;
    const dx = a.pos.x - o.pos.x, dz = a.pos.z - o.pos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < radius * radius && d2 > 1e-4) {
      const d = Math.sqrt(d2), w = (radius - d) / radius * k;
      move.x += dx / d * w; move.y += dz / d * w;
    }
  }
  if (move.lengthSq() > 1) move.normalize();
  return move;
}
const ranged = a => a.char.stance === 'bow' || a.char.stance === 'crossbow';
let engaged = new Map();            // target -> melee attackers closing on it (rebuilt each tick)

function pickTarget(a) {
  const R = ranged(a) ? 24 : 11;
  let best = null, bestD = 1e9;
  for (const t of game.actors) {
    if (!t.alive || t.fi === a.fi) continue;
    const d = a.pos.distanceTo(t.pos);
    if (d > R) continue;
    let score = d;
    if (!ranged(a)) {
      const n = engaged.get(t) || 0;
      if (n >= MELEE_CAP && a.bt.target !== t) continue;      // already locked in combat: find another
      score += n * 2.5;                                        // prefer the less crowded
    }
    if (score < bestD) { bestD = score; best = t; }
  }
  return best;
}

function battleAI(a, dt) {
  const inp = emptyInput();
  const B = a.bt;
  if (!a.alive) return inp;
  B.retarget -= dt; B.cd -= dt;
  if (B.target && (!B.target.alive || B.target.char.root.parent == null)) B.target = null;
  if (B.retarget <= 0) { B.target = pickTarget(a); B.retarget = 0.5 + Math.random() * 0.4; }
  const T = B.target;
  if (T) {
    inp.aim = T.pos.clone();
    const d = a.pos.distanceTo(T.pos);
    if (ranged(a)) return rangedAI(a, T, d, dt, inp);
    return meleeAI(a, T, d, dt, inp);
  }
  // no fight: the objective
  let goal;
  if (sim.owner === a.fi) {
    if (!B.roam || a.pos.distanceTo(B.roam) < 1.5 || Math.random() < dt * 0.05) {
      const ang = Math.random() * Math.PI * 2, r = OBJ_R + Math.random() * 13;
      B.roam = new THREE.Vector3(Math.sin(ang) * r, 0, Math.cos(ang) * r);
    }
    goal = B.roam;
    inp.move.copy(steer(a, goal, 0.5)).multiplyScalar(0.55);
  } else {
    goal = new THREE.Vector3(Math.sin(B.lane) * B.laneR, 0, Math.cos(B.lane) * B.laneR);
    inp.move.copy(steer(a, goal, 0.8)).multiplyScalar(0.85);
  }
  separate(a, inp.move);
  return inp;
}

function meleeAI(a, T, d, dt, inp) {
  const B = a.bt, c = a.char;
  const reach = c.mainReach * 0.95 + 0.35;
  if (a.state === 'move' || a.state === 'block') {
    if (d > reach) {
      inp.move.copy(steer(a, T.pos, reach * 0.8));
      separate(a, inp.move, 1.6, 0.6);
    } else {
      const dx = T.pos.x - a.pos.x, dz = T.pos.z - a.pos.z;
      a.turnTo(Math.atan2(dx, dz), 9, dt);
      if (B.cd <= 0) {
        inp.attack = true;
        B.cd = 1.1 + Math.random() * 1.4;
        B.chain = Math.random() < 0.55 ? (Math.random() < 0.4 ? 3 : 2) : 1;
      } else {
        // circle a little while waiting (no rooted face-off)
        _v.set(-dz, dx).normalize().multiplyScalar(0.28 * B.strafe);
        inp.move.copy(_v);
        if (Math.random() < dt * 0.4) B.strafe *= -1;
        if (c.hasShield && T.state === 'attack' && d < reach + 0.5 && Math.random() < 0.6) B.block = 0.6;
      }
    }
  } else if (a.state === 'attack' && B.chain > 1 && a.combo < B.chain - 1) inp.attack = true;
  if (B.block > 0) { B.block -= dt; inp.block = true; inp.attack = false; }
  return inp;
}

function rangedAI(a, T, d, dt, inp) {
  const B = a.bt;
  const xbow = a.char.stance === 'crossbow';
  if (a.state === 'move') {
    if (d < 5) { inp.move.copy(steer(a, T.pos, 0)).multiplyScalar(-0.9); separate(a, inp.move); }   // back off
    else if (d > 20) { inp.move.copy(steer(a, T.pos, 18)).multiplyScalar(0.8); separate(a, inp.move); }
    else {
      const dx = T.pos.x - a.pos.x, dz = T.pos.z - a.pos.z;
      a.turnTo(Math.atan2(dx, dz), 8, dt);
      if (B.cd <= 0) {
        inp.attack = true; inp.attackHeld = true;
        B.hold = xbow ? 0.55 + Math.random() * 0.3 : 0.95 + Math.random() * 0.5;
        B.cd = (xbow ? 0.6 : 0.8) + Math.random() * 1.2;
      }
    }
  }
  if (a.state === 'aim' || a.state === 'xaim') { B.hold -= dt; inp.attackHeld = B.hold > 0; }
  return inp;
}

// ---------------------------------------------------------------- spawn + tick
FACTIONS.forEach((f, i) => { for (let k = 0; k < f.count; k++) spawnUnit(i); });

const hud = document.getElementById('stats');
let hudT = 0, objT = 0;
function simTick(dt) {
  // melee engagement counts
  engaged = new Map();
  for (const a of game.actors) {
    const t = a.bt && a.bt.target;
    if (t && a.alive && !ranged(a) && a.pos.distanceTo(t.pos) < 4) engaged.set(t, (engaged.get(t) || 0) + 1);
  }
  // deaths -> respawn at the edge (constant head count)
  for (const a of [...game.actors]) {
    if (a.state === 'dead' && !a.counted) {
      a.counted = true;
      sim.deaths[a.fi]++;
      const killer = a.lastHitBy;
      if (killer && killer.fi != null) sim.kills[killer.fi]++;
    }
    if (a.state === 'dead' && a.stateT > RESPAWN_T) { const fi = a.fi; removeUnit(a); spawnUnit(fi); }
  }
  // the objective
  objT -= dt;
  if (objT <= 0) {
    objT = 0.25;
    const present = FACTIONS.map(() => 0);
    for (const a of game.actors) if (a.alive && Math.hypot(a.pos.x, a.pos.z) < OBJ_R) present[a.fi]++;
    const here = present.map((n, i) => n > 0 ? i : -1).filter(i => i >= 0);
    if (here.length === 1) {
      const f = here[0];
      if (f !== sim.owner) {
        sim.progress[f] += 0.25;
        if (sim.progress[f] >= CAPTURE_T) { sim.owner = f; sim.progress = FACTIONS.map(() => 0); }
      }
    }
    for (let i = 0; i < FACTIONS.length; i++) if (!here.includes(i)) sim.progress[i] = Math.max(0, sim.progress[i] - 0.25);
    const col = sim.owner >= 0 ? assets.catalog.palettes[FACTIONS[sim.owner].palette].team1 : '#dddddd';
    game.flag.material.color.set(col);
    game.objRing.material.color.set(col);
  }
  hudT -= dt;
  if (hudT <= 0) {
    hudT = 0.5;
    const rows = FACTIONS.map((f, i) => {
      const alive = game.actors.filter(a => a.fi === i && a.alive).length;
      const cap = sim.progress[i] > 0 ? ` capturing ${Math.round(sim.progress[i] / CAPTURE_T * 100)}%` : '';
      return `${sim.owner === i ? '★' : ' '} ${f.name.padEnd(8)} ${String(alive).padStart(3)} alive  kills ${String(sim.kills[i]).padStart(4)}${cap}`;
    });
    hud.innerHTML = `<pre style="margin:0">${rows.join('\n')}\n${Math.round(1 / Math.max(1e-3, fpsAvg))} fps</pre>`;
  }
}

// remember who landed each hit (kill credit)
const _onHit = Object.getPrototypeOf(game.actors[0]).onHit;
Object.getPrototypeOf(game.actors[0]).onHit = function (attacker, ...rest) {
  if (this.alive) this.lastHitBy = attacker;
  return _onHit.call(this, attacker, ...rest);
};

// camera: WASD pans, wheel zooms, middle-drag / Q E orbit
let last = performance.now(), fpsAvg = 1 / 60;
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  fpsAvg += (dt - fpsAvg) * 0.05;
  const k = game.keys;
  const mv = new THREE.Vector3((k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0), 0, (k.has('KeyS') ? 1 : 0) - (k.has('KeyW') ? 1 : 0));
  if (mv.lengthSq()) game.camTarget.add(mv.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), game.camYaw).multiplyScalar(dt * game.camDist * 0.6));
  if (!game.paused) simTick(dt * game.timeScale);
  game.step(dt);
  requestAnimationFrame(frame);
}
game.onKey = e => {
  if (e.code === 'KeyP') game.paused = !game.paused;
  if (e.code === 'KeyR') { game.camTarget.set(0, 0, 0); game.camDist = homeDist(); game.camYaw = 0; }
  if (e.code === 'BracketRight') game.timeScale = Math.min(2, game.timeScale * 2);
  if (e.code === 'BracketLeft') game.timeScale = Math.max(0.25, game.timeScale / 2);
};
// ---------------------------------------------------------------- touch controls
// one finger: pan · two fingers: pinch zoom, twist orbit, drag up / down to tilt
const canvas = game.renderer.domElement;
canvas.style.touchAction = 'none';
const touches = new Map();
let gesture = null;
function panBy(dx, dy) {
  const k = game.camDist * 0.0022;
  const v = new THREE.Vector3(-dx * k, 0, -dy * k / Math.max(0.35, Math.sin(game.camPitch)));
  game.camTarget.add(v.applyAxisAngle(new THREE.Vector3(0, 1, 0), game.camYaw));
}
function twoFinger() {
  const [a, b] = [...touches.values()];
  return { d: Math.hypot(a.x - b.x, a.y - b.y), ang: Math.atan2(b.y - a.y, b.x - a.x), y: (a.y + b.y) / 2 };
}
canvas.addEventListener('pointerdown', e => {
  if (e.pointerType !== 'touch') return;
  try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* synthetic / stale pointer */ }
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  gesture = touches.size === 2 ? twoFinger() : null;
});
canvas.addEventListener('pointermove', e => {
  if (e.pointerType !== 'touch' || !touches.has(e.pointerId)) return;
  const t = touches.get(e.pointerId);
  const dx = e.clientX - t.x, dy = e.clientY - t.y;
  t.x = e.clientX; t.y = e.clientY;
  if (touches.size === 1) panBy(dx, dy);
  else if (touches.size === 2 && gesture) {
    const g = twoFinger();
    game.camDist = THREE.MathUtils.clamp(game.camDist * gesture.d / Math.max(1, g.d), 7, game.camMax);
    let da = g.ang - gesture.ang;
    if (da > Math.PI) da -= 2 * Math.PI; if (da < -Math.PI) da += 2 * Math.PI;
    game.camYaw -= da;
    game.camPitch = THREE.MathUtils.clamp(game.camPitch + (g.y - gesture.y) * 0.004,
      THREE.MathUtils.degToRad(15), THREE.MathUtils.degToRad(85));
    gesture = g;
  }
});
const lift = e => { touches.delete(e.pointerId); gesture = touches.size === 2 ? twoFinger() : null; };
canvas.addEventListener('pointerup', lift);
canvas.addEventListener('pointercancel', lift);

// on-screen buttons (handy with a mouse too)
const bar = document.createElement('div');
bar.id = 'battlebar';
const btn = (label, title, fn) => {
  const b = document.createElement('button');
  b.textContent = label; b.title = title;
  b.addEventListener('click', e => { e.stopPropagation(); fn(b); });
  bar.appendChild(b);
  return b;
};
btn('Reset view', 'R', () => { game.camTarget.set(0, 0, 0); game.camDist = homeDist(); game.camYaw = 0; game.camPitch = THREE.MathUtils.degToRad(58); });
const pauseBtn = btn('Pause', 'P', b => { game.paused = !game.paused; b.textContent = game.paused ? 'Play' : 'Pause'; });
const speedLbl = document.createElement('span');
btn('Slower', '[', () => { game.timeScale = Math.max(0.25, game.timeScale / 2); speedLbl.textContent = `x${game.timeScale}`; });
speedLbl.textContent = 'x1'; bar.appendChild(speedLbl);
btn('Faster', ']', () => { game.timeScale = Math.min(2, game.timeScale * 2); speedLbl.textContent = `x${game.timeScale}`; });
document.body.appendChild(bar);
if (TOUCH) document.getElementById('help').innerHTML =
  '<b>Battle sim</b> · <b>drag</b> pan · <b>pinch</b> zoom · <b>twist</b> orbit · <b>two-finger drag</b> tilt' +
  ' · <a href="index.html" style="color:#e3b552;pointer-events:auto">sandbox</a>';
const _onKey = game.onKey;
game.onKey = e => { _onKey(e); pauseBtn.textContent = game.paused ? 'Play' : 'Pause'; speedLbl.textContent = `x${game.timeScale}`; };

window.battle = { sim, FACTIONS, spawnUnit, simTick };
requestAnimationFrame(frame);
