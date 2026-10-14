// World, camera, input, props, NPC drills, projectiles, combat feedback.
import * as THREE from 'three';
import { Character } from './character.js';
import { Actor, emptyInput } from './actor.js';
import { Particles, Rings, Floaters } from './effects.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const ARENA_R = 17;

// ---------------------------------------------------------------------------
// Training dummy: spring-mounted, wobbles and flashes when struck
// ---------------------------------------------------------------------------
class Dummy {
  constructor(game, id, pos, yaw = 0) {
    this.game = game;
    this.id = id;
    this.root = new THREE.Group();
    this.root.position.copy(pos);
    this.root.rotation.y = yaw;
    this.pivot = new THREE.Group();
    this.root.add(this.pivot);
    this.pos = this.root.position;
    this.alive = true;
    this.faction = 'neutral';
    const meta = game.assets.item(id) || {};
    this.radius = meta.radius || 0.32;
    this.rigid = id === 'prop_pavise';        // a planted shield: no wobble, splinters
    this.height = meta.height || 1.8;
    this.tilt = new THREE.Vector2(); this.tv = new THREE.Vector2();
    this.flash = 0;
    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, metalness: 1, roughness: 1 });
    this.build();
    game.scene.add(this.root);
  }
  build() {
    const lib = this.game.assets.styles[this.game.style];
    this.pivot.clear();
    this.material.map = this.game.assets.palette('hero');
    this.material.metalnessMap = this.material.roughnessMap = lib.mrTex;
    this.material.needsUpdate = true;
    for (const [name, parent] of [[this.id, this.pivot], [this.id === 'prop_dummy' ? 'prop_dummy_stand' : null, this.root]]) {
      if (!name || !lib.statics[name]) continue;
      if (parent === this.root && this.stand) { this.stand.removeFromParent(); }
      const m = lib.statics[name].clone();
      m.material = this.material;
      m.castShadow = m.receiveShadow = true;
      m.position.set(0, 0, 0);
      parent.add(m);
      if (parent === this.root) this.stand = m;
    }
  }
  onHit(attacker, dir, dmg, heavy) {
    if (this.rigid) {
      this.flash = 0.6;
      this.game.burst(this.pos.clone().setY(0.8), dir, 'wood');
      return;
    }
    const local = dir.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), -this.root.rotation.y);
    const k = heavy ? 5.5 : 3.2;
    this.tv.x += local.z * k; this.tv.y += -local.x * k;
    this.flash = 1;
    this.game.floater(this.pos.clone().setY(this.height + 0.3), String(dmg), heavy);
    this.game.burst(this.pos.clone().setY(1.2), dir, 'straw');
  }
  update(dt) {
    // damped spring
    this.tv.x += -this.tilt.x * 90 * dt; this.tv.y += -this.tilt.y * 90 * dt;
    this.tv.multiplyScalar(Math.exp(-5.5 * dt));
    this.tilt.addScaledVector(this.tv, dt);
    this.pivot.rotation.set(this.tilt.x * 0.35, 0, this.tilt.y * 0.35);
    this.flash = Math.max(0, this.flash - dt * 6);
    this.material.emissive.setRGB(this.flash * 0.9, this.flash * 0.75, this.flash * 0.5);
  }
}

// ---------------------------------------------------------------------------
export class Game {
  constructor(assets, container) {
    this.assets = assets;
    this.style = 'lowpoly';
    this.time = 0;
    this.timeScale = 1;
    this.paused = false;
    this.showTrails = true;
    this.showArcs = false;
    this.targets = [];
    this.actors = [];
    this.npcs = [];
    this.arrows = [];
    this.hitStopT = 0;
    this.shakeAmt = 0;

    const r = this.renderer = new THREE.WebGLRenderer({ antialias: true });
    r.setPixelRatio(Math.min(2, window.devicePixelRatio));
    r.setSize(container.clientWidth, container.clientHeight);
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.toneMapping = THREE.NeutralToneMapping;
    r.toneMappingExposure = 1.05;
    container.appendChild(r.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x9fb4c4);
    this.scene.fog = new THREE.Fog(0x9fb4c4, 30, 70);
    this.camera = new THREE.PerspectiveCamera(38, container.clientWidth / container.clientHeight, 0.3, 200);
    this.camDist = 15;
    this.camPitch = THREE.MathUtils.degToRad(56);
    this.camYaw = 0;                       // orbit around the player (middle-drag / Alt+drag, Q / E, R resets)
    this.CAM_HOME = { pitch: this.camPitch, yaw: 0 };
    this.camTarget = new THREE.Vector3();

    const pmrem = new THREE.PMREMGenerator(r);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.4;
    const hemi = new THREE.HemisphereLight(0xdfeaff, 0x5a5040, 0.9);
    this.scene.add(hemi);
    const sun = this.sun = new THREE.DirectionalLight(0xfff1dc, 2.4);
    sun.position.set(-8, 16, 6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -16; sc.right = 16; sc.top = 16; sc.bottom = -16; sc.near = 1; sc.far = 60;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.03;
    this.scene.add(sun, sun.target);

    this.particles = new Particles(this.scene);
    this.rings = new Rings(this.scene);
    this.floaters = new Floaters(document.getElementById('floaters'), this.camera, r);
    this.arcMeshes = [];

    this.buildWorld();
    this.setupInput(r.domElement);
    window.addEventListener('resize', () => {
      r.setSize(container.clientWidth, container.clientHeight);
      this.camera.aspect = container.clientWidth / container.clientHeight;
      this.camera.updateProjectionMatrix();
    });
  }

  // ------------------------------------------------------------------ world
  buildWorld() {
    const rnd = mulberry32(7);
    // ground: tinted low-poly tiles
    const tiles = 64, size = 1.25;
    const geo = new THREE.BoxGeometry(size, 0.2, size);
    const mat = new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true, envMapIntensity: 0.35 });
    const inst = new THREE.InstancedMesh(geo, mat, tiles * tiles);
    const m4 = new THREE.Matrix4(), col = new THREE.Color();
    let k = 0;
    for (let i = 0; i < tiles; i++) for (let j = 0; j < tiles; j++) {
      const x = (i - tiles / 2 + 0.5) * size, z = (j - tiles / 2 + 0.5) * size;
      const d = Math.hypot(x, z);
      const h = (rnd() - 0.5) * 0.04;
      m4.makeTranslation(x, -0.1 + h * (d > 9 ? 1 : 0.3), z);
      inst.setMatrixAt(k, m4);
      if (d < 9.5) col.setHSL(0.085, 0.22, 0.47 + (rnd() - 0.5) * 0.03, THREE.SRGBColorSpace);           // packed sand
      else if (d < 10.4) col.setHSL(0.075, 0.18, 0.38 + (rnd() - 0.5) * 0.03, THREE.SRGBColorSpace);      // edge
      else col.setHSL(0.24 + (rnd() - 0.5) * 0.03, 0.32, 0.34 + (rnd() - 0.5) * 0.04, THREE.SRGBColorSpace);  // grass
      inst.setColorAt(k, col);
      k++;
    }
    inst.receiveShadow = true;
    this.scene.add(inst);
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    // fence ring
    const wood = new THREE.MeshStandardMaterial({ color: 0x8a6440, roughness: 0.9, flatShading: true });
    const dark = new THREE.MeshStandardMaterial({ color: 0x5c4129, roughness: 0.9, flatShading: true });
    const postG = new THREE.BoxGeometry(0.22, 1.1, 0.22), railG = new THREE.BoxGeometry(0.1, 0.12, 1);
    const R = ARENA_R + 0.6, n = 40;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      if (Math.abs(Math.sin(a)) < 0.12 && Math.cos(a) > 0) continue;   // gate on the south side
      const p = new THREE.Mesh(postG, dark);
      p.position.set(Math.sin(a) * R, 0.55, Math.cos(a) * R);
      p.castShadow = true;
      this.scene.add(p);
      const a2 = ((i + 0.5) / n) * Math.PI * 2;
      if (Math.abs(Math.sin(a2)) < 0.12 && Math.cos(a2) > 0) continue;
      const len = 2 * R * Math.sin(Math.PI / n);
      for (const y of [0.45, 0.85]) {
        const rl = new THREE.Mesh(railG, wood);
        rl.scale.z = len + 0.1;
        rl.position.set(Math.sin(a2) * R, y, Math.cos(a2) * R);
        rl.rotation.y = a2 + Math.PI / 2;
        rl.castShadow = true;
        this.scene.add(rl);
      }
    }
    // trees + rocks outside the ring
    const trunk = new THREE.MeshStandardMaterial({ color: 0x6b4a2f, flatShading: true });
    const leaf = [0x4f7a3a, 0x5d8a40, 0x456e34].map(c => new THREE.MeshStandardMaterial({ color: c, flatShading: true }));
    const rock = new THREE.MeshStandardMaterial({ color: 0x8b8a86, flatShading: true });
    for (let i = 0; i < 26; i++) {
      const a = rnd() * Math.PI * 2, d = ARENA_R + 4 + rnd() * 14;
      const g = new THREE.Group();
      g.position.set(Math.sin(a) * d, 0, Math.cos(a) * d);
      const s = 0.8 + rnd() * 0.7;
      const t = new THREE.Mesh(new THREE.CylinderGeometry(0.15 * s, 0.22 * s, 1.4 * s, 6), trunk);
      t.position.y = 0.7 * s; t.castShadow = true; g.add(t);
      for (let j = 0; j < 3; j++) {
        const c = new THREE.Mesh(new THREE.ConeGeometry((1.3 - j * 0.3) * s, 1.4 * s, 7), leaf[(i + j) % 3]);
        c.position.y = (1.5 + j * 0.75) * s; c.rotation.y = rnd() * 3; c.castShadow = true; g.add(c);
      }
      this.scene.add(g);
    }
    for (let i = 0; i < 18; i++) {
      const a = rnd() * Math.PI * 2, d = ARENA_R + 1.5 + rnd() * 10;
      const m = new THREE.Mesh(new THREE.DodecahedronGeometry(0.3 + rnd() * 0.5, 0), rock);
      m.position.set(Math.sin(a) * d, 0.1, Math.cos(a) * d);
      m.rotation.set(rnd() * 3, rnd() * 3, rnd() * 3);
      m.scale.y = 0.6; m.castShadow = true; m.receiveShadow = true;
      this.scene.add(m);
    }

    // training props
    this.dummies = [];
    const addDummy = (id, x, z, yaw = 0) => { const d = new Dummy(this, id, new THREE.Vector3(x, 0, z), yaw); this.dummies.push(d); this.targets.push(d); return d; };
    addDummy('prop_dummy', -2.6, -4.2);
    addDummy('prop_dummy', 0, -5.2);
    addDummy('prop_dummy', 2.6, -4.2);
    this.drillDummyA = addDummy('prop_dummy', 8.0, -6.0);
    this.drillDummyB = addDummy('prop_dummy', -8.0, -6.0);
    this.archTargets = [addDummy('prop_target', -11.5, -10.5, 0.5), addDummy('prop_target', 4.5, -13.5), addDummy('prop_target', 8.5, -12.5, -0.3)];
  }

  // ------------------------------------------------------------------ actors
  spawn(loadout, pos, opts = {}) {
    const c = new Character(this.assets, loadout, this.style);
    c.root.position.copy(pos);
    this.scene.add(c.root);
    const a = new Actor(this, c, opts);
    a.ai = opts.ai || null;
    a.home = pos.clone();
    this.actors.push(a);
    if (a.hittable) this.targets.push(a);
    return a;
  }

  setStyle(style) {
    if (!this.assets.styles[style]) return;
    this.style = style;
    for (const a of this.actors) a.char.setStyle(style);
    for (const d of this.dummies) d.build();
  }

  // ------------------------------------------------------------------ pavise
  // F: a soldier with a slung pavise plants it in front of him (a prop that blocks
  // movement and stops arrows); F again next to it picks it back up
  togglePavise(actor) {
    const c = actor.char;
    if (actor.pavise) {
      const p = actor.pavise;
      if (p.pos.distanceTo(actor.pos) > 1.8) return false;
      p.root.removeFromParent();
      this.dummies.splice(this.dummies.indexOf(p), 1);
      this.targets.splice(this.targets.indexOf(p), 1);
      actor.pavise = null;
      c.equip('back', 'back_pavise');
      return true;
    }
    if (c.loadout.back !== 'back_pavise') return false;
    const pos = actor.pos.clone().addScaledVector(actor.forward, 0.85);
    const d = new Dummy(this, 'prop_pavise', pos, actor.facing);
    d.material.map = c.material.map;          // painted in its owner's colours
    d.root.scale.setScalar(c.raceInfo.weapon_scale || 1);   // the size it is on his back
    d.material.needsUpdate = true;
    this.dummies.push(d);
    this.targets.push(d);
    actor.pavise = d;
    c.equip('back', null);
    return true;
  }

  collide(a) {
    for (const o of this.actors) {
      if (o === a || !o.alive) continue;
      push(a.pos, o.pos, a.radius + o.radius);
    }
    for (const d of this.dummies) push(a.pos, d.pos, a.radius + d.radius);
    if (this.clampArena) this.clampArena(a.pos);          // the battle sim's pentagon
    else {
      const r = Math.hypot(a.pos.x, a.pos.z);
      if (r > ARENA_R) a.pos.multiplyScalar(ARENA_R / r);
    }
    a.pos.y = 0;
  }

  // ------------------------------------------------------------------ feedback
  floater(pos, text, crit) { if (!this.quiet) this.floaters.spawn(pos, text, crit); }
  burst(pos, dir, kind) {
    const presets = {
      straw: [{ count: 12, color: 0xe0c46a, speed: 3.5, size: 0.07 }, { count: 4, color: 0xb8963e, speed: 2.5, size: 0.1 }],
      hit: [{ count: 10, color: 0xd64545, speed: 3, size: 0.06 }, { count: 6, color: 0xfff0b0, speed: 5, size: 0.04, life: 0.3 }],
      spark: [{ count: 14, color: 0xffd36b, speed: 6, size: 0.04, life: 0.35, up: 3 }],
      wood: [{ count: 6, color: 0xa0703f, speed: 2, size: 0.05 }],
      dust: [{ count: 8, color: 0xc9b48a, speed: 1.4, size: 0.12, up: 0.8, life: 0.5, spread: 2 }],
    };
    for (const p of presets[kind] || presets.hit) this.particles.burst(pos, dir, p);
  }
  dust(pos, dir) { this.burst(pos.clone().setY(0.1), dir.clone().multiplyScalar(-1), 'dust'); }
  shake(a) { if (!this.quiet) this.shakeAmt = Math.max(this.shakeAmt, a); }
  slam(pos, radius) {
    this.rings.spawn(pos, { size: radius, color: 0xfff1c0 });
    this.burst(pos.clone().setY(0.1), new THREE.Vector3(), 'dust');
    for (const t of this.targets) {
      if (t.pos.distanceTo(pos) < radius && t.onHit && !(t.actor)) { /* ring is visual only */ }
    }
  }
  hitStop(t, ...who) {
    if (this.quiet) return;
    this.hitStopT = Math.max(this.hitStopT, t);
    this.hitStopWho = who;
    this.shake(0.12 + t);
  }

  debugArc(actor, lo, hi, reach) {
    if (!this.showArcs) return;
    const g = new THREE.RingGeometry(0.3, reach, 24, 1,
      THREE.MathUtils.degToRad(lo) + actor.facing - Math.PI / 2, THREE.MathUtils.degToRad(hi - lo));
    g.rotateX(Math.PI / 2);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xff5040, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }));
    m.position.copy(actor.pos).setY(0.04);
    m.scale.x = -1;
    this.scene.add(m);
    this.arcMeshes.push({ m, t: 0 });
  }

  // ------------------------------------------------------------------ arrows
  spawnArrow(owner, from, dir, opts = {}) {
    const lib = this.assets.styles[this.style];
    const src = lib.statics[opts.mesh || 'proj_arrow'];
    const g = new THREE.Group();
    const m = src.clone();
    m.material = owner.char.material;
    m.rotation.y = Math.PI;           // arrow tip (blender +Y) -> group +Z
    g.add(m);
    g.position.copy(from);
    this.scene.add(g);
    const vel = dir.clone().multiplyScalar(opts.speed || 30);
    vel.y = opts.lift ?? 1.0;
    const k = owner.dmgMul || 1;
    this.arrows.push({ g, vel, t: 0, owner, stuck: false, dmg: (opts.dmg || [16, 24]).map(x => x * k) });
  }

  updateArrows(dt) {
    for (let i = this.arrows.length - 1; i >= 0; i--) {
      const a = this.arrows[i];
      a.t += dt;
      if (a.t > 8) { a.g.removeFromParent(); this.arrows.splice(i, 1); continue; }
      if (a.stuck) continue;
      const prev = a.g.position.clone();
      a.vel.y -= 4.5 * dt;
      a.g.position.addScaledVector(a.vel, dt);
      a.g.lookAt(a.g.position.clone().add(a.vel));
      // hit test vs targets (vertical cylinders)
      for (const t of this.targets) {
        if (t === a.owner || !t.alive) continue;
        if (t.faction && a.owner && t.faction === a.owner.faction && t.faction !== 'neutral') continue;
        const p = closestOnSeg(prev, a.g.position, t.pos);
        const dx = p.x - t.pos.x, dz = p.z - t.pos.z;
        if (dx * dx + dz * dz < (t.radius + 0.05) ** 2 && p.y > 0.2 && p.y < (t.height || 1.8) + 0.1) {
          a.g.position.copy(p).addScaledVector(a.vel.clone().normalize(), 0.12);
          a.stuck = true;
          const dir = a.vel.clone().setY(0).normalize();
          t.onHit(a.owner, dir, Math.round(a.dmg[0] + Math.random() * (a.dmg[1] - a.dmg[0])), false);
          const host = t.pivot || (t.char && t.char.bones.chest) || null;
          if (host) host.attach(a.g);
          break;
        }
      }
      if (!a.stuck && a.g.position.y < 0.05) { a.g.position.y = 0.05; a.stuck = true; this.burst(a.g.position.clone(), new THREE.Vector3(), 'dust'); }
    }
  }

  // ------------------------------------------------------------------ input
  setupInput(el) {
    this.keys = new Set();
    this.mouse = new THREE.Vector2();
    this.lmb = false; this.rmb = false;
    this.pressed = { attack: false, dodge: false };
    window.addEventListener('keydown', e => {
      if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
      this.keys.add(e.code);
      if (e.code === 'Space') { this.pressed.dodge = true; e.preventDefault(); }
      this.onKey?.(e);
    });
    window.addEventListener('keyup', e => this.keys.delete(e.code));
    el.addEventListener('contextmenu', e => e.preventDefault());
    el.addEventListener('pointermove', e => {
      const r = el.getBoundingClientRect();
      this.mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    });
    el.addEventListener('pointerdown', e => {
      // camera orbit: middle-drag, or Alt + left-drag (trackpads)
      if (e.button === 1 || (e.button === 0 && e.altKey)) {
        this.orbit = { x: e.clientX, y: e.clientY };
        e.preventDefault();
        return;
      }
      if (e.button === 0) { this.lmb = true; this.pressed.attack = true; }
      if (e.button === 2) this.rmb = true;
    });
    window.addEventListener('pointermove', e => {
      if (!this.orbit) return;
      this.camYaw -= (e.clientX - this.orbit.x) * 0.008;
      this.camPitch = THREE.MathUtils.clamp(this.camPitch + (e.clientY - this.orbit.y) * 0.006,
        THREE.MathUtils.degToRad(6), THREE.MathUtils.degToRad(85));
      this.orbit.x = e.clientX; this.orbit.y = e.clientY;
    });
    window.addEventListener('pointerup', e => {
      if (this.orbit && (e.button === 1 || e.button === 0)) { this.orbit = null; return; }
      if (e.button === 0) this.lmb = false;
      if (e.button === 2) this.rmb = false;
    });
    el.addEventListener('auxclick', e => { if (e.button === 1) e.preventDefault(); });
    el.addEventListener('wheel', e => { this.camDist = THREE.MathUtils.clamp(this.camDist + e.deltaY * 0.01 * (this.camMax || 28) / 28, 7, this.camMax || 28); });
    this.raycaster = new THREE.Raycaster();
  }

  playerInput() {
    const inp = emptyInput();
    const k = this.keys;
    inp.move.set((k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0), (k.has('KeyS') ? 1 : 0) - (k.has('KeyW') ? 1 : 0));
    if (inp.move.lengthSq() > 1) inp.move.normalize();
    if (this.camYaw) inp.move.rotateAround(new THREE.Vector2(), -this.camYaw);   // WASD stays camera-relative
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const hit = new THREE.Vector3();
    if (this.raycaster.ray.intersectPlane(this.groundPlane, hit)) inp.aim = hit;
    inp.attack = this.pressed.attack;
    inp.attackHeld = this.lmb;
    inp.block = this.rmb;
    inp.dodge = this.pressed.dodge;
    this.pressed.attack = false; this.pressed.dodge = false;
    return inp;
  }

  // ------------------------------------------------------------------ loop
  step(realDt) {
    let dt = this.paused ? 0 : Math.min(realDt, 1 / 20) * this.timeScale;
    if (this.stepOnce) { dt = 1 / 30; this.stepOnce = false; }
    // hit-stop freezes the actors involved for a few frames (game feel)
    let freeze = 0;
    if (this.hitStopT > 0) { freeze = 1; this.hitStopT -= realDt; }
    this.time += dt;
    const pin = this.player ? this.playerInput() : null;
    for (const a of this.actors) {
      if (a.disabled) continue;
      const input = a === this.player ? pin : (a.ai ? a.ai(a, dt, this) : emptyInput());
      const frozen = freeze && this.hitStopWho && this.hitStopWho.includes(a);
      a.update(frozen ? dt * 0.05 : dt, input);
    }
    for (const d of this.dummies) d.update(dt);
    this.updateArrows(dt);
    this.particles.update(dt);
    this.rings.update(dt);
    this.floaters.update(this.paused ? 0 : realDt * Math.max(this.timeScale, 0.25));
    for (let i = this.arcMeshes.length - 1; i >= 0; i--) {
      const a = this.arcMeshes[i];
      a.t += realDt;
      a.m.material.opacity = 0.22 * (1 - a.t / 0.25);
      if (a.t > 0.25) { this.scene.remove(a.m); a.m.geometry.dispose(); this.arcMeshes.splice(i, 1); }
    }
    // camera (Q / E turn it around the player, R puts it back)
    const turn = (this.keys.has('KeyE') ? 1 : 0) - (this.keys.has('KeyQ') ? 1 : 0);
    if (turn) this.camYaw += turn * 1.6 * realDt;
    if (this.player) this.camTarget.lerp(this.player.pos.clone().setY(1.0), 1 - Math.exp(-8 * realDt));
    const cp = Math.cos(this.camPitch);
    const off = new THREE.Vector3(Math.sin(this.camYaw) * cp, Math.sin(this.camPitch), Math.cos(this.camYaw) * cp)
      .multiplyScalar(this.camDist);
    this.camera.position.copy(this.camTarget).add(off);
    if (this.shakeAmt > 0.001) {
      this.camera.position.x += (Math.random() - 0.5) * this.shakeAmt * 0.6;
      this.camera.position.y += (Math.random() - 0.5) * this.shakeAmt * 0.6;
      this.shakeAmt *= Math.exp(-14 * realDt);
    }
    this.camera.lookAt(this.camTarget);
    this.sun.position.copy(this.camTarget).add(new THREE.Vector3(-8, 16, 6));
    this.sun.target.position.copy(this.camTarget);
    this.renderer.render(this.scene, this.camera);
  }
}

function push(p, o, r) {
  const dx = p.x - o.x, dz = p.z - o.z;
  const d = Math.hypot(dx, dz);
  if (d < r && d > 1e-4) { p.x = o.x + dx / d * r; p.z = o.z + dz / d * r; }
}

function closestOnSeg(a, b, p) {
  const ab = b.clone().sub(a);
  const t = THREE.MathUtils.clamp(new THREE.Vector3(p.x, a.y, p.z).sub(a).dot(ab) / Math.max(1e-6, ab.lengthSq()), 0, 1);
  return a.clone().addScaledVector(ab, t);
}

export function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
