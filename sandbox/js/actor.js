// Gameplay layer on top of Character: movement, combo state machine, hit detection.
// Player and NPCs share this; they only differ in where `input` comes from.
import * as THREE from 'three';
import { STANCES } from './character.js';
import { Trail } from './effects.js';
import { b2t } from './assets.js';

const FPS = 30;
const _a = new THREE.Vector3(), _b = new THREE.Vector3();

export function emptyInput() {
  return { move: new THREE.Vector2(), aim: null, attack: false, attackHeld: false, block: false, dodge: false };
}

function yawTo(dx, dz) { return Math.atan2(dx, dz); }
function angDiff(a, b) { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; }
function smooth01(t) { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); }

export class Actor {
  constructor(game, char, opts = {}) {
    this.game = game;
    this.char = char;
    this.name = opts.name || 'actor';
    this.isPlayer = !!opts.player;
    this.faction = opts.faction || (this.isPlayer ? 'player' : 'npc');
    this.radius = 0.35;
    this.height = 1.85;
    this.pos = char.root.position;
    this.facing = opts.facing || 0;
    this.vel = new THREE.Vector3();
    this.state = 'move';
    this.combo = 0;
    this.queued = false;
    this.hitSet = new Set();
    this.hp = opts.hp ?? 100;
    this.maxHp = this.hp;
    this.respawn = opts.respawn ?? 0;
    this.hittable = opts.hittable ?? true;
    this.trails = { mainhand: new Trail(game.scene, 0xfff3d6), offhand: new Trail(game.scene, 0xfff3d6) };
    this.stateT = 0;
    this.applyLocomotion(0);
  }

  get alive() { return this.state !== 'dead' && !this.disabled; }
  get forward() { return new THREE.Vector3(Math.sin(this.facing), 0, Math.cos(this.facing)); }
  st() { return STANCES[this.char.stance]; }

  // ------------------------------------------------------------------ helpers
  turnTo(yaw, rate, dt) {
    const d = angDiff(yaw, this.facing);
    const step = rate * dt;
    this.facing += Math.abs(d) <= step ? d : Math.sign(d) * step;
  }

  faceAim(input, dt, rate = 18) {
    if (!input.aim) return;
    const dx = input.aim.x - this.pos.x, dz = input.aim.z - this.pos.z;
    if (dx * dx + dz * dz > 0.04) this.turnTo(yawTo(dx, dz), rate, dt);
  }

  applyLocomotion(speed, guard = false, stand = null, walk = null) {
    const c = this.char, s = this.st();
    if (guard) {
      // stand / walk: lower-body clips while guarding / aiming (the bow's side-on stance and walk)
      const has = n => n && this.game.assets.meta(n);
      const still = has(stand) ? stand : s.idle, moving = has(walk) ? walk : 'walk_guard';
      // a race's stride scales the clip's travel: play faster with shorter legs (planted feet)
      c.setSlot('base', speed > 0.2 ? moving : still, { mask: 'lower', timeScale: Math.max(0.6, speed / 1.8) / c.locoStride });
    } else if (speed > 0.3) {
      c.setSlot('base', s.run, { timeScale: THREE.MathUtils.clamp(speed / 4.6, 0.6, 1.3) / c.locoStride });
    } else {
      c.setSlot('base', s.idle, { fade: 0.2 });
    }
    // shield arm overlay keeps the shield up and readable
    const wantLeft = c.hasShield && !c.slots.upper && ['move', 'attack'].includes(this.state) &&
      !(c.slots.base && c.slots.base.name === 'shield_bash');
    if (wantLeft && !c.slots.left) c.setSlot('left', 'shield_carry', { mask: 'leftArm', fade: 0.15 });
    if (!wantLeft && c.slots.left) c.setSlot('left', null, { fade: 0.15 });
    c.syncMasks();
  }

  setState(s) { this.state = s; this.stateT = 0; }

  // ------------------------------------------------------------------ update
  update(dt, input) {
    const c = this.char;
    this.stateT += dt;
    const moving = input.move.lengthSq() > 0.01;
    switch (this.state) {
      case 'move': this.updateMove(dt, input, moving); break;
      case 'attack': this.updateAttack(dt, input, moving); break;
      case 'block': this.updateBlock(dt, input, moving); break;
      case 'aim': this.updateAim(dt, input, moving); break;
      case 'release': this.updateRelease(dt, input, moving); break;
      case 'xaim': this.updateXAim(dt, input, moving); break;
      case 'xshoot': this.updateXShoot(dt, input, moving); break;
      case 'reload': this.updateReload(dt, input, moving); break;
      case 'dodge': this.updateDodge(dt, input, moving); break;
      case 'dead': this.updateDead(dt); break;
      case 'preview': {
        // show the clip's lunge as a visual offset (resets every loop) so planted feet read as planted
        const pm = this.game.assets.meta(c.slots.base ? c.slots.base.name : '');
        const pf = c.baseTime() * FPS;
        c.model.position.z = pm.lunge && pm.lunge_window && !pm.loop
          ? smooth01((pf - pm.lunge_window[0]) / (pm.lunge_window[1] - pm.lunge_window[0])) * pm.lunge * c.stride : 0;
        if (moving || input.attack) {
          c.model.position.z = 0;
          this.char.setSlot('base', null); this.setState('move'); this.applyLocomotion(0);
        }
        break;
      }
    }
    // hit reaction on the upper layer fades out by itself
    if (this.hitTimer > 0) {
      this.hitTimer -= dt;
      if (this.hitTimer <= 0 && c.slots.upper && c.slots.upper.name === 'hit') {
        c.setSlot('upper', null, { fade: 0.15 });
        c.syncMasks();
        if (this.state === 'move') this.applyLocomotion(this.vel.length());
      }
    }
    // integrate
    this.pos.addScaledVector(this.vel, dt);
    this.game.collide(this);
    c.root.rotation.y = this.facing;
    c.update(dt);
    this.updateTrails();
  }

  updateMove(dt, input, moving) {
    const c = this.char;
    if (input.dodge) return this.startDodge(input);
    if (c.stance === 'bow' && input.attack) return this.startAim();
    if (c.stance === 'crossbow' && input.attack) return c.xbowLoaded ? this.startXAim() : this.startReload();
    if (input.block && c.hasShield) return this.startBlock();
    if (input.attack && this.st().combo.length) return this.startAttack(0, input);
    const speed = 4.6 * c.moveSpeed;
    const target = new THREE.Vector3(input.move.x, 0, input.move.y).multiplyScalar(speed);
    this.vel.lerp(target, 1 - Math.exp(-14 * dt));
    if (moving) this.turnTo(yawTo(input.move.x, input.move.y), 13, dt);
    this.applyLocomotion(this.vel.length());
  }

  // ------------------------------------------------------------------ attacks
  startAttack(i, input, clip) {
    const c = this.char;
    const name = clip || this.st().combo[i];
    this.combo = i;
    this.queued = false;
    this.hitSet.clear();
    this.attackClip = name;
    this.meta = this.game.assets.meta(name);
    if (input && input.aim) {
      const dx = input.aim.x - this.pos.x, dz = input.aim.z - this.pos.z;
      if (dx * dx + dz * dz > 0.04) this.facing = yawTo(dx, dz);
    }
    this.vel.multiplyScalar(0.2);
    this.setState('attack');
    if (c.slots.upper) c.setSlot('upper', null, { fade: 0.06 });
    c.setSlot('base', name, { once: true, restart: true, fade: 0.06 });
    this.applyLocomotionOverlayOnly();
    this.lastF = 0;
    this.lungeDone = 0;
  }

  applyLocomotionOverlayOnly() {
    const c = this.char;
    const wantLeft = c.hasShield && this.attackClip !== 'shield_bash';
    if (wantLeft && !c.slots.left) c.setSlot('left', 'shield_carry', { mask: 'leftArm', fade: 0.1 });
    if (!wantLeft && c.slots.left) c.setSlot('left', null, { fade: 0.08 });
    c.syncMasks(0.06);
  }

  updateAttack(dt, input, moving) {
    const c = this.char, m = this.meta;
    const a = c.slots.base && c.slots.base.action;
    const f = (a ? a.time : 0) * FPS;
    const len = m.length;
    this.vel.multiplyScalar(Math.exp(-12 * dt));
    // lunge: ease the forward travel over the wind-up -> strike window
    if (m.lunge && m.hit) {
      // the clip may declare its own window; its feet are authored against this curve
      const [f0, f1] = m.lunge_window || [Math.max(0, m.hit[0] - 3), m.hit[1] + 1];
      const done = smooth01((f - f0) / (f1 - f0)) * m.lunge * c.stride;     // the race's legs
      const step = done - this.lungeDone;
      this.lungeDone = done;
      if (step > 0) this.pos.addScaledVector(this.forward, step);
    }
    if (m.hit && this.lastF <= m.hit[1] + 0.999 && f >= m.hit[0]) this.sweep(this.lastF, f, m);
    if (m.shake && this.lastF < m.hit[1] && f >= m.hit[1]) {
      this.game.shake(m.shake);
      if (m.slam) this.game.slam(this.pos.clone().addScaledVector(this.forward, 1.3 * c.mainReach), 2.4);
    }
    this.lastF = f;
    if (input.attack && f > 2) this.queued = true;
    const combo = this.st().combo;
    if (this.queued && m.combo != null && f >= m.combo && this.attackClip === combo[this.combo] &&
        this.combo < combo.length - 1) {
      return this.startAttack(this.combo + 1, input);
    }
    if (this.attackClip === 'shield_bash' && input.block && f >= (m.cancel || len)) return this.startBlock();
    if (f >= (m.cancel ?? len)) {
      if (input.dodge) return this.startDodge(input);
      if (moving || (input.attack && !this.queued)) { this.setState('move'); this.applyLocomotion(this.vel.length()); return; }
    }
    if (f >= len - 0.5) {
      this.setState('move');
      this.applyLocomotion(0);
    }
  }

  // swept-sector hit test between two anim frames
  sweep(f0, f1, m) {
    const c = this.char;
    const h0 = m.hit[0], h1 = m.hit[1];
    const u0 = THREE.MathUtils.clamp((f0 - h0) / Math.max(1, h1 - h0), 0, 1);
    const u1 = THREE.MathUtils.clamp((f1 - h0) / Math.max(1, h1 - h0), 0, 1);
    const arc = m.arc || [30, -30];
    let a0 = arc[0] + (arc[1] - arc[0]) * u0, a1 = arc[0] + (arc[1] - arc[0]) * u1;
    const lo = Math.min(a0, a1) - 12, hi = Math.max(a0, a1) + 12;
    const reach = (m.reach || 1) * c.mainReach + 0.25;
    this.game.debugArc(this, lo, hi, reach);
    for (const t of this.game.targets) {
      if (t === this || t.actor === this || !t.alive || this.hitSet.has(t)) continue;
      if (t.faction && t.faction === this.faction && t.faction !== 'neutral') continue;
      const dx = t.pos.x - this.pos.x, dz = t.pos.z - this.pos.z;
      const dist = Math.hypot(dx, dz) - (t.radius || 0.3);
      if (dist > reach) continue;
      let ang = THREE.MathUtils.radToDeg(angDiff(yawTo(dx, dz), this.facing));
      if (m.spin || (ang >= lo && ang <= hi)) {
        this.hitSet.add(t);
        const dir = new THREE.Vector3(dx, 0, dz).normalize();
        const heavy = this.char.stance === '2h' || this.combo === 2;
        const dmg = Math.round((heavy ? 24 : 14) * (0.85 + Math.random() * 0.3) * (this.dmgMul || 1));
        t.onHit(this, dir, dmg, heavy || !!m.knockback);
        this.game.hitStop(heavy ? 0.09 : 0.055, this, t);
      }
    }
  }

  // ------------------------------------------------------------------ shield
  startBlock() {
    this.setState('block');
    this.char.setSlot('upper', 'block', { mask: 'upper', fade: 0.1 });
    this.applyLocomotion(0, true);
  }

  updateBlock(dt, input, moving) {
    if (input.dodge) { this.char.setSlot('upper', null); return this.startDodge(input); }
    if (!input.block || !this.char.hasShield) {
      this.char.setSlot('upper', null, { fade: 0.15 });
      this.setState('move');
      this.applyLocomotion(this.vel.length());
      return;
    }
    if (input.attack) return this.startAttack(0, input, 'shield_bash');
    const target = new THREE.Vector3(input.move.x, 0, input.move.y).multiplyScalar(1.8 * this.char.moveSpeed);
    this.vel.lerp(target, 1 - Math.exp(-12 * dt));
    this.faceAim(input, dt, 10);
    this.applyLocomotion(this.vel.length(), true);
  }

  // ------------------------------------------------------------------ bow
  startAim() {
    this.setState('aim');
    this.char.setSlot('upper', 'bow_draw', { mask: 'upper', once: true, restart: true, fade: 0.08 });
    this.applyLocomotion(0, true, 'bow_stance', 'bow_walk');
  }

  updateAim(dt, input, moving) {
    const c = this.char;
    const up = c.slots.upper;
    const full = (this.game.assets.meta('bow_draw').full || 11) / FPS;
    if (up && up.name === 'bow_draw') {
      c.drawAmount = smooth01((up.action.time - 0.12) / (full - 0.12));
      if (up.action.time >= this.game.assets.meta('bow_draw').duration - 0.01) c.setSlot('upper', 'bow_aim', { mask: 'upper', fade: 0.1 });
    } else c.drawAmount = 1;
    if (input.dodge) { c.drawAmount = 0; c.setSlot('upper', null); return this.startDodge(input); }
    const target = new THREE.Vector3(input.move.x, 0, input.move.y).multiplyScalar(1.8 * this.char.moveSpeed);
    this.vel.lerp(target, 1 - Math.exp(-12 * dt));
    this.faceAim(input, dt, 12);
    this.applyLocomotion(this.vel.length(), true, 'bow_stance', 'bow_walk');
    if (!input.attackHeld) {
      if (c.drawAmount > 0.9) this.fire(input);
      else { c.drawAmount = 0; c.setSlot('upper', null, { fade: 0.15 }); this.setState('move'); this.applyLocomotion(0); }
    }
  }

  fire(input) {
    const c = this.char;
    const bow = c.weapons.offhand;
    const from = new THREE.Vector3();
    if (bow && c.nockLocal) from.copy(c.nockLocal).applyMatrix4(bow.matrixWorld);
    else from.copy(this.pos).setY(1.45);
    let dir = this.forward;
    if (input.aim) {
      const d = new THREE.Vector3(input.aim.x - from.x, 0, input.aim.z - from.z);
      if (d.lengthSq() > 0.25) dir = d.normalize();
    }
    this.game.spawnArrow(this, from, dir);
    c.drawAmount = 0;
    this.setState('release');
    c.setSlot('upper', 'bow_release', { mask: 'upper', once: true, restart: true, fade: 0.03 });
  }

  updateRelease(dt, input, moving) {
    const c = this.char;
    const a = c.slots.upper && c.slots.upper.action;
    const t = a ? a.time : 1;
    this.vel.multiplyScalar(Math.exp(-10 * dt));
    this.faceAim(input, dt, 10);
    this.applyLocomotion(this.vel.length(), true, 'bow_stance', 'bow_walk');
    if (t * FPS >= 6 && input.attack) return this.startAim();
    if (t >= this.game.assets.meta('bow_release').duration - 0.02 || (t * FPS > 8 && moving)) {
      c.setSlot('upper', null, { fade: 0.2 });
      this.setState('move');
      this.applyLocomotion(this.vel.length());
    }
  }

  // ------------------------------------------------------------------ crossbow
  // hold to raise and aim, release to loose; then it spans itself (xbow_reload, upper
  // body: walkable at a crawl) - the string follows the left hand over meta.pull
  xlower(speed) { this.applyLocomotion(speed, true, 'xbow_stance', 'walk_guard'); }

  startXAim() {
    this.setState('xaim');
    this.char.setSlot('upper', 'xbow_raise', { mask: 'upper', once: true, restart: true, fade: 0.08 });
    this.xlower(0);
  }

  updateXAim(dt, input, moving) {
    const c = this.char, up = c.slots.upper;
    const raised = !(up && up.name === 'xbow_raise');
    if (up && up.name === 'xbow_raise' && up.action.time >= this.game.assets.meta('xbow_raise').duration - 0.01) {
      c.setSlot('upper', 'xbow_aim', { mask: 'upper', fade: 0.08 });
    }
    if (input.dodge) { c.setSlot('upper', null); return this.startDodge(input); }
    const target = new THREE.Vector3(input.move.x, 0, input.move.y).multiplyScalar(1.6 * c.moveSpeed);
    this.vel.lerp(target, 1 - Math.exp(-12 * dt));
    this.faceAim(input, dt, 12);
    this.xlower(this.vel.length());
    if (!input.attackHeld) {
      if (raised) this.fireBolt(input);
      else { c.setSlot('upper', null, { fade: 0.15 }); this.setState('move'); this.applyLocomotion(0); }
    }
  }

  fireBolt(input) {
    const c = this.char, xb = c.weapons.mainhand, it = c.itemMeta(c.loadout.mainhand);
    const from = new THREE.Vector3();
    if (xb && it && it.muzzle) from.copy(b2t(it.muzzle)).applyMatrix4(xb.matrixWorld);
    else from.copy(this.pos).setY(1.45);
    // a flat, fast shot: pitched at torso height (1.1 m) over the aimed spot, plus the drop
    // over the distance (a bolt has no arrow's arc to bring it down onto a short target)
    const SPEED = 46, GRAV = 4.5;
    let dir = this.forward, dist = 12;
    if (input.aim) {
      const d = new THREE.Vector3(input.aim.x - from.x, 0, input.aim.z - from.z);
      if (d.lengthSq() > 0.25) { dist = d.length(); dir = d.normalize(); }
    }
    const t = dist / SPEED;
    const vy = (1.1 - from.y) / t + 0.5 * GRAV * t;
    this.game.spawnArrow(this, from, dir, { mesh: 'proj_bolt', speed: SPEED, lift: vy, dmg: [26, 34] });
    c.xbowLoaded = false;
    this.setState('xshoot');
    c.setSlot('upper', 'xbow_shoot', { mask: 'upper', once: true, restart: true, fade: 0.03 });
  }

  updateXShoot(dt, input, moving) {
    const a = this.char.slots.upper && this.char.slots.upper.action;
    this.vel.multiplyScalar(Math.exp(-10 * dt));
    this.faceAim(input, dt, 10);
    this.xlower(this.vel.length());
    if (!a || a.time >= this.game.assets.meta('xbow_shoot').duration - 0.02) this.startReload();
  }

  startReload() {
    this.setState('reload');
    this.char.setSlot('upper', 'xbow_reload', { mask: 'upper', once: true, restart: true, fade: 0.1 });
    this.xlower(this.vel.length());
  }

  updateReload(dt, input, moving) {
    const c = this.char, m = this.game.assets.meta('xbow_reload');
    const a = c.slots.upper && c.slots.upper.action;
    const f = a ? a.time * FPS : 1e9;
    const [p0, p1] = m.pull || [14, 30];
    if (!c.xbowLoaded) {
      c.xbowPull = f < p0 ? 0 : 1;
      if (f >= p1) { c.xbowLoaded = true; c.xbowPull = 0; }
    }
    const target = new THREE.Vector3(input.move.x, 0, input.move.y).multiplyScalar(1.0 * c.moveSpeed);
    this.vel.lerp(target, 1 - Math.exp(-10 * dt));
    if (moving) this.turnTo(yawTo(input.move.x, input.move.y), 6, dt);
    this.xlower(this.vel.length());
    if (!a || a.time >= m.duration - 0.02) {
      c.xbowLoaded = true; c.xbowPull = 0;
      c.setSlot('upper', null, { fade: 0.2 });
      this.setState('move');
      this.applyLocomotion(this.vel.length());
    }
  }

  // ------------------------------------------------------------------ dodge
  startDodge(input) {
    const c = this.char;
    let dir = input.move.lengthSq() > 0.01 ? new THREE.Vector3(input.move.x, 0, input.move.y).normalize() : this.forward;
    this.dodgeDir = dir;
    this.facing = yawTo(dir.x, dir.z);
    this.setState('dodge');
    c.drawAmount = 0;
    if (c.slots.upper) c.setSlot('upper', null, { fade: 0.05 });
    if (c.slots.left) c.setSlot('left', null, { fade: 0.05 });
    c.setSlot('base', 'dodge', { once: true, restart: true, fade: 0.05 });
    c.syncMasks(0.05);
    this.dodgeDone = 0;
    this.vel.set(0, 0, 0);
    this.game.dust(this.pos, dir);
  }

  updateDodge(dt, input, moving) {
    const m = this.game.assets.meta('dodge');
    const a = this.char.slots.base.action;
    const f = a.time * FPS;
    const done = smooth01(f / 15) * (m.lunge || 3) * this.char.stride;
    this.pos.addScaledVector(this.dodgeDir, done - this.dodgeDone);
    this.dodgeDone = done;
    this.invulnerable = f >= m.iframes[0] && f <= m.iframes[1];
    if ((f >= m.cancel && moving) || f >= m.length - 0.5) {
      this.invulnerable = false;
      this.setState('move');
      this.applyLocomotion(moving ? 3 : 0);
    }
  }

  // ------------------------------------------------------------------ damage
  onHit(attacker, dir, dmg, heavy) {
    if (!this.alive || this.invulnerable) return;
    const c = this.char;
    const blocked = this.state === 'block' && dir.dot(this.forward) < -0.2;
    this.game.floater(this.pos.clone().setY(2.0), blocked ? 'Blocked' : String(dmg), heavy && !blocked);
    this.game.burst(this.pos.clone().setY(1.2), dir, blocked ? 'spark' : 'hit');
    if (blocked) { this.pos.addScaledVector(dir, 0.15); return; }
    this.hp -= dmg;
    this.pos.addScaledVector(dir, heavy ? 0.45 : 0.2);
    if (this.hp <= 0) {
      this.setState('dead');
      c.drawAmount = 0;
      c.setSlot('upper', null, { fade: 0.05 });
      c.setSlot('left', null, { fade: 0.05 });
      c.setSlot('base', 'death', { once: true, restart: true, fade: 0.08 });
      c.syncMasks(0.05);
      this.facing = yawTo(-dir.x, -dir.z);
      this.vel.set(0, 0, 0);
      return;
    }
    if (this.state === 'move' || this.state === 'block') {
      c.setSlot('upper', 'hit', { mask: 'upper', once: true, restart: true, fade: 0.04 });
      c.syncMasks(0.04);
      this.hitTimer = 0.32;
    }
  }

  updateDead(dt) {
    this.vel.set(0, 0, 0);
    if (this.respawn > 0 && this.stateT > this.respawn) {
      this.hp = this.maxHp;
      this.setState('move');
      this.char.setSlot('base', this.st().idle, { fade: 0.4 });
      this.applyLocomotion(0);
    }
  }

  // ------------------------------------------------------------------ trails
  updateTrails() {
    const now = this.game.time;
    const show = this.game.showTrails;
    const live = this.state === 'attack' && this.meta && this.meta.hit;
    let f = live ? this.char.baseTime() * FPS : -1;
    for (const slot of ['mainhand', 'offhand']) {
      const tr = this.trails[slot];
      const active = live && f >= this.meta.hit[0] - 2 && f <= this.meta.hit[1] + 2 &&
        (slot === 'mainhand' || this.meta.both || this.char.stance === 'dual');
      if (active && this.char.bladeWorld(slot, _a, _b)) tr.push(_a, _b, now);
      tr.update(now, show);
    }
  }

  dispose() { for (const t of Object.values(this.trails)) this.game.scene.remove(t.mesh); }
}
