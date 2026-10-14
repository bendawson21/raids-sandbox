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
    if (this.jetCd > 0) this.jetCd -= dt;
    switch (this.state) {
      case 'move': this.updateMove(dt, input, moving); break;
      case 'attack': this.updateAttack(dt, input, moving); break;
      case 'block': this.updateBlock(dt, input, moving); break;
      case 'aim': this.updateAim(dt, input, moving); break;
      case 'release': this.updateRelease(dt, input, moving); break;
      case 'xaim': this.updateXAim(dt, input, moving); break;
      case 'swhirl': this.updateWhirl(dt, input, moving); break;
      case 'sthrow': this.updateThrow(dt, input, moving); break;
      case 'xshoot': this.updateXShoot(dt, input, moving); break;
      case 'reload': this.updateReload(dt, input, moving); break;
      case 'dodge': this.updateDodge(dt, input, moving); break;
      case 'jet': this.updateJet(dt, input, moving); break;
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
    // killed (or knocked out of the jet) mid-air: drop to the ground
    if (this.state !== 'jet' && this.air > 0) this.air = Math.max(0, this.air - 9 * dt);
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
    if (c.stance === 'sling' && input.attack) return this.startWhirl();
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

  // ------------------------------------------------------------------ sling
  // hold to whirl it overhead (sling_whirl, upper body: walkable, slowly), release to cast
  // (sling_throw): the stone goes at the clip's release frame, from the hand
  startWhirl() {
    this.setState('swhirl');
    this.char.setSlot('upper', 'sling_whirl', { mask: 'upper', fade: 0.12 });
    this.applyLocomotion(0, true);
  }

  updateWhirl(dt, input, moving) {
    const c = this.char;
    if (input.dodge) { c.setSlot('upper', null); return this.startDodge(input); }
    const target = new THREE.Vector3(input.move.x, 0, input.move.y).multiplyScalar(2.2 * c.moveSpeed);
    this.vel.lerp(target, 1 - Math.exp(-12 * dt));
    this.faceAim(input, dt, 12);
    this.applyLocomotion(this.vel.length(), true);
    if (!input.attackHeld) {
      if (this.stateT > 0.35) {                     // wound up enough: cast
        this.setState('sthrow');
        this.stoneOut = false;
        this.throwAim = input.aim ? input.aim.clone() : null;
        c.setSlot('upper', 'sling_throw', { mask: 'upper', once: true, restart: true, fade: 0.04 });
      } else { c.setSlot('upper', null, { fade: 0.15 }); this.setState('move'); this.applyLocomotion(0); }
    }
  }

  updateThrow(dt, input, moving) {
    const c = this.char, m = this.game.assets.meta('sling_throw');
    const t = c.slots.upper ? c.slots.upper.action.time : 1;
    this.vel.multiplyScalar(Math.exp(-10 * dt));
    this.faceAim(input, dt, 10);
    this.applyLocomotion(this.vel.length(), true);
    if (!this.stoneOut && t * FPS >= (m.release || 5)) {
      this.stoneOut = true;
      const from = new THREE.Vector3();
      c.bones.weapon_R.getWorldPosition(from);
      from.addScaledVector(this.forward, 0.3);
      from.y += 0.1;
      let dir = this.forward;
      const aim = this.throwAim || input.aim;
      if (aim) {
        const d = new THREE.Vector3(aim.x - from.x, 0, aim.z - from.z);
        if (d.lengthSq() > 0.25) dir = d.normalize();
      }
      this.game.spawnArrow(this, from, dir, { mesh: 'proj_stone', speed: 24, lift: 2.2, dmg: [12, 18] });
    }
    if (t * FPS >= (m.cancel || 9) && input.attack) return this.startWhirl();
    if (t >= m.duration - 0.02 || (t * FPS > (m.cancel || 9) && moving)) {
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
    if (this.rollOut !== undefined) {
      const k = smooth01(this.stateT / 0.12);
      this.setSpin(this.rollOut * (1 - k), 0);
      if (k >= 1) { this.setSpin(0, 0); this.rollOut = undefined; }
    }
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

  // ------------------------------------------------------------------ jet (the goblin's firework jump pack)
  // F (or the battle AI) launches the wearer off in a semi-random arc the way it faces:
  // crouch (jet_launch), fly (jet_fly, the sandbox moves the root), land (jet_land).
  canJet() {
    const b = this.char.loadout.back;
    return !!(b && this.game.assets.item(b)?.jump) && this.state === 'move' && !(this.jetCd > 0);
  }

  startJet(yaw = this.facing, forceFail = false) {
    if (!this.canJet()) return false;
    const c = this.char;
    // most launches are clean: a neat arc.  One in five is a launch failure (owner; V in the
    // sandbox forces one): a big climb, head leading along the arc the whole way (upright
    // going up, head first coming down) while it spins three turns about its own feet-to-head
    // axis, weaving, then a head-first crash into a dodge roll.  The reach is the same.
    const R = () => Math.random();
    const fail = forceFail || R() < 0.2;
    const a = yaw + (R() - 0.5) * (fail ? 1.0 : 0.35);
    this.jet = fail ? {
      // a failure is simulated, not an arc: a slow sputtering lift-off of random length, then
      // the pack blows - a violent kick up, thrashing thrust while it burns, then a fall under
      // gravity, steered loosely toward the landing spot (owner: erratic, not a perfect arc)
      fail, dist: 6 + R() * 5, sputT: 0.5 + R() * 1.3, spinDir: R() < 0.5 ? -1 : 1, spin: 0, pitch: 0,
    } : {
      fail, dist: 6 + R() * 5, apex: 3.5 + R() * 1.5, T: 1.15 + R() * 0.3,
      wob: (R() - 0.5) * 0.6, wobF: 1 + R(), wob2: 0, wobF2: 1, bob: 0, bobF: 1, spins: 0,
    };
    Object.assign(this.jet, { phase: 'launch', t: 0, from: this.pos.clone(), dir: new THREE.Vector3(Math.sin(a), 0, Math.cos(a)),
      ph: R() * 6.28 });
    this.facing = a;
    this.setState('jet');
    c.drawAmount = 0;
    if (c.slots.upper) c.setSlot('upper', null, { fade: 0.05 });
    if (c.slots.left) c.setSlot('left', null, { fade: 0.05 });
    c.setSlot('base', 'jet_launch', { once: true, restart: true, fade: 0.12 });   // eased in from a run or idle
    c.syncMasks(0.05);
    this.vel.set(0, 0, 0);
    return true;
  }

  // pitch the model forward, after spinning it about its own feet-to-head axis, about the
  // body's middle (Euler XYZ: the spin is in the body's frame).  The root stays upright.
  setSpin(pitch, spin) {
    const m = this.char.model, h = 0.55 * (this.char.raceInfo.height || 1.0);
    m.rotation.set(pitch, spin, 0);
    _b.set(0, h, 0).applyEuler(m.rotation);
    m.position.set(-_b.x, h - _b.y, -_b.z);
  }

  jetSparks(n, strong = false) {
    const c = this.char;
    if (!c.bones.chest) return;
    c.bones.chest.getWorldPosition(_a);
    const back = this.forward.multiplyScalar(-0.22 * (c.raceInfo.height_ratio || 1) * 1.6);
    _a.add(back);
    _a.y -= 0.18;
    const g = this.game;
    g.particles.burst(_a, this.forward.multiplyScalar(-1), { count: n, color: 0xffc43d, speed: strong ? 3 : 1.6, size: 0.05,
      up: strong ? -5 : -3.5, life: 0.35, spread: 1.6 });
    g.particles.burst(_a, this.forward.multiplyScalar(-1), { count: Math.ceil(n / 2), color: 0xe0442e, speed: 1.2, size: 0.04,
      up: -2.5, life: 0.3, spread: 1.4 });
  }

  updateJet(dt, input, moving) {
    const j = this.jet, c = this.char;
    j.t += dt;
    this.vel.set(0, 0, 0);
    if (j.phase === 'launch') {
      if (j.t > 0.14) this.jetSparks(3);
      if (j.t >= 0.24) {
        j.phase = 'fly'; j.t = 0;
        c.setSlot('base', 'jet_fly', { fade: 0.08 });
        this.jetSparks(14, true);
        this.game.dust(this.pos, j.dir);
      }
      return;
    }
    if (j.phase === 'fly' && j.fail) return this.updateJetFail(dt, j, c);
    if (j.phase === 'fly') {
      // sparks first, from where it is now (set past an arena wall it sparked beyond it); a
      // failing pack sputters - gouts and gaps
      if (j.fail) { if (Math.random() < 0.55) this.jetSparks(Math.random() < 0.25 ? 9 : 3, true); }
      else if (j.t / j.T < 0.7) this.jetSparks(2);
      const s = Math.min(1, j.t / j.T);
      // stepped by the arc's change each frame, so walls (clamped in collide) stop it
      const side = new THREE.Vector3(j.dir.z, 0, -j.dir.x);
      const env = Math.sin(s * Math.PI);                           // erratic in the air, calm at both ends
      const wob = (Math.sin(s * Math.PI * j.wobF) * j.wob + Math.sin(s * Math.PI * j.wobF2 + j.ph) * j.wob2) * env;
      const ox = j.dir.x * j.dist * s + side.x * wob, oz = j.dir.z * j.dist * s + side.z * wob;
      this.pos.x += ox - (j.ox || 0); this.pos.z += oz - (j.oz || 0);
      j.ox = ox; j.oz = oz;
      this.air = 4 * j.apex * s * (1 - s) + Math.sin(s * Math.PI * j.bobF + j.ph) * j.bob * env;
      this.facing = Math.atan2(j.dir.x, j.dir.z) + Math.cos(s * Math.PI * j.wobF) * j.wob * 0.12;
      if (j.fail) {
        // head leads along the arc: the body's long axis on the flight direction (upright
        // climbing, level at the top, head down falling); the spin about that axis, eased only
        // at the ends so it finishes facing ahead
        const vh = j.dist / j.T, vy = 4 * j.apex * (1 - 2 * s) / j.T;
        j.pitch = Math.atan2(vh, vy) * Math.min(1, j.t / 0.15);
        const e = s - Math.sin(2 * Math.PI * s) / (2 * Math.PI);
        this.setSpin(j.pitch, e * j.spins * Math.PI * 2);
      } else this.setSpin((0.5 - s) * -0.5, 0);           // a clean arc: nose up, then down
      if (s >= 1) {
        j.phase = 'land'; j.t = 0;
        this.air = 0;
        if (!j.fail) this.setSpin(0, 0);
        if (j.fail) {                                              // a crash: tumble out of it in a dodge roll
          for (let k = 0; k < 4; k++) this.game.dust(this.pos, new THREE.Vector3(Math.sin(k * 1.57), 0, Math.cos(k * 1.57)));
          this.game.burst(this.pos.clone().setY(0.4), j.dir, 'spark');
          this.game.shake(0.25);
          this.jet = null;
          this.jetCd = 0.6;
          this.setState('move');
          this.startDodge({ move: new THREE.Vector2(j.dir.x, j.dir.z) });
          // the dodge is a forward somersault: join it at its head-down frame (6), so the
          // head-first dive runs straight into the roll; blend off the angle left over
          const ROLL_IN = 6;
          c.slots.base.action.time = ROLL_IN / FPS;
          this.dodgeDone = smooth01(ROLL_IN / 15) * (this.game.assets.meta('dodge').lunge || 3) * c.stride;
          this.rollOut = Math.max(0, j.pitch - 2.1);               // the clip is ~120 deg over at frame 6
          this.setSpin(this.rollOut, 0);
          return;
        }
        c.setSlot('base', 'jet_land', { once: true, restart: true, fade: 0.05 });
        this.game.dust(this.pos, j.dir);
        this.game.dust(this.pos, j.dir.clone().multiplyScalar(-1));

      }
      return;
    }
    const f = c.slots.base.action.time * FPS;
    const m = this.game.assets.meta('jet_land');
    if ((f >= (m.cancel || 9) && moving) || f >= m.length - 0.5) {
      this.jet = null;
      this.jetCd = 0.6;
      this.setState('move');
      this.applyLocomotion(moving ? 3 : 0);
    }
  }

  // a launch failure (owner's sketch, seen from the side): a slow sputtering rise with a
  // stall, then the pack blows - a hard climb that goes up and back over the top in a
  // backflip loop, crosses its own path and dives head first to the landing.  The head leads
  // along the path the whole way (so it flips backwards over the top), spinning about its
  // feet-to-head axis, weaving sideways into a spiral; into a head-first crash and roll.
  planJetFail(j) {
    const R = Math.random;
    const D = j.dist, H = (8 + R() * 3) / 1.11;              // the loop's top lands 8-11 m up
    const r = 0.85 + R() * 0.3, h1 = 1 + R() * 1.5;           // loop size, the sputter's height
    // (forward u, height y): the sketch, normalised by the reach D and the height H
    const sput = [[0, 0], [0.04, h1 * 0.55], [0.094, h1], [0.17, h1 * 0.88], [0.245, h1 * 0.86]];
    const loop = [[0.245, h1 * 0.86], [0.377 * r + 0.06, 0.396 * H], [0.49 * r, 0.547 * H], [0.566 * r, 0.755 * H],
      [0.585 * r, 0.98 * H], [0.51 * r, 1.09 * H], [0.358 * r, 1.11 * H], [0.245 * r, 0.887 * H], [0.32 * r, 0.66 * H],
      [0.47 * r, 0.50 * H], [0.717, 0.27 * H], [0.9, 0.08 * H], [1.0, 0]];
    const toM = q => q.map(([u, y], i) => [u * D, y]);
    j.sput = this.spline(toM(sput));
    j.loop = this.spline(toM(loop));
    j.side = (R() - 0.5) * 1.6; j.sideF = 1.5 + R() * 1.5;      // the spiral's weave
    j.blastT = 1.9 + R() * 0.6;
  }

  // a Catmull-Rom curve through pts, sampled by arc length: {p: [[u, y]...], len: [...], L}
  spline(pts) {
    const P = [pts[0], ...pts, pts[pts.length - 1]], out = [], len = [0];
    for (let i = 1; i < P.length - 2; i++) {
      for (let k = 0; k < 12; k++) {
        const t = k / 12, t2 = t * t, t3 = t2 * t;
        const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
        out.push([f(P[i - 1][0], P[i][0], P[i + 1][0], P[i + 2][0]), f(P[i - 1][1], P[i][1], P[i + 1][1], P[i + 2][1])]);
      }
    }
    out.push(pts[pts.length - 1]);
    for (let i = 1; i < out.length; i++) len.push(len[i - 1] + Math.hypot(out[i][0] - out[i - 1][0], out[i][1] - out[i - 1][1]));
    return { p: out, len, L: len[len.length - 1] };
  }

  // the point (and tangent) a fraction f along a sampled curve
  along(cv, f) {
    const d = Math.min(1, Math.max(0, f)) * cv.L;
    let i = 1;
    while (i < cv.len.length - 1 && cv.len[i] < d) i++;
    const a = cv.p[i - 1], b = cv.p[i], k = (d - cv.len[i - 1]) / Math.max(1e-6, cv.len[i] - cv.len[i - 1]);
    return { u: a[0] + (b[0] - a[0]) * k, y: a[1] + (b[1] - a[1]) * k, du: b[0] - a[0], dy: b[1] - a[1] };
  }

  updateJetFail(dt, j, c) {
    const R = Math.random;
    if (!j.stage) { this.planJetFail(j); j.stage = 'sputter'; j.st = 0; j.pu = 0; j.pw = 0; j.pitchU = 0; }
    j.st += dt;
    let q, w = 0;
    if (j.stage === 'sputter') {
      // wheezing up: slow, jerky, sparks in fits and gaps
      const k = j.st / j.sputT;
      q = this.along(j.sput, smooth01(k) + Math.sin(j.st * 23) * 0.015);
      q.y += Math.sin(j.st * 31) * 0.04 * k;
      if (R() < 0.35) this.jetSparks(R() < 0.15 ? 6 : 1);
      j.spin += j.spinDir * dt * 1.2 * k;
      if (k >= 1) {
        j.stage = 'blast'; j.st = 0; j.spin0 = j.spin;
        j.spinEnd = Math.round((j.spin + j.spinDir * 6 * Math.PI) / (2 * Math.PI)) * 2 * Math.PI;   // ~3 turns, on a whole turn
        for (let n = 0; n < 3; n++) this.jetSparks(16, true);
        this.game.burst(this.pos.clone().setY(this.air + 0.5), j.dir, 'spark');
        this.game.particles.burst(this.pos.clone().setY(this.air + 0.3), j.dir.clone().multiplyScalar(-1),
          { count: 14, color: 0x5a5550, speed: 2.5, size: 0.16, up: 1.0, life: 0.9, spread: 2.2 });
        this.game.shake(0.3);
      }
    } else {
      // speed along the loop: the blast's kick, slowing over the top, then full speed again
      // into the ground - a crash, no easing into the roll (owner)
      const tau = Math.min(1, j.st / j.blastT);
      const f = tau + 0.1 * Math.sin(2 * Math.PI * tau);
      q = this.along(j.loop, f);
      w = j.side * Math.sin(Math.PI * tau * j.sideF) * Math.sin(Math.PI * tau);
      if (tau < 0.45) this.jetSparks(4, true);
      else if (R() < 0.15) this.jetSparks(R() < 0.3 ? 7 : 2, true);
      // three turns about the long axis, still accelerating at impact, landing on a whole
      // turn (faces its roll)
      j.spin = j.spin0 + (j.spinEnd - j.spin0) * Math.pow(tau, 1.5);
      if (tau >= 1) q.y = 0;
    }
    // move by the path's change (walls clamp it in collide)
    const side = new THREE.Vector3(j.dir.z, 0, -j.dir.x);
    this.pos.addScaledVector(j.dir, q.u - j.pu).addScaledVector(side, w - j.pw);
    j.pu = q.u; j.pw = w;
    this.air = Math.max(0, q.y);
    this.facing = Math.atan2(j.dir.x, j.dir.z);
    // head leads along the tangent: pitch from vertical, forward positive, kept continuous
    // through the backflip (it goes back over the top: past -180)
    if (Math.hypot(q.du, q.dy) > 1e-5) {
      let want = Math.atan2(q.du, q.dy);
      while (want - j.pitchU > Math.PI) want -= Math.PI * 2;
      while (want - j.pitchU < -Math.PI) want += Math.PI * 2;
      j.pitchU += (want - j.pitchU) * Math.min(1, dt * (j.stage === 'sputter' ? 4 : 14));
    }
    // the sputter stays mostly upright (its stall runs level: leading head-first it lay flat)
    j.pitch = j.stage === 'sputter' ? j.pitchU * 0.35 + Math.sin(j.st * 7 + j.ph) * 0.15 : j.pitchU;
    this.setSpin(j.pitch, j.spin);
    if (j.stage === 'blast' && j.st >= j.blastT) {
      this.air = 0;
      for (let k = 0; k < 4; k++) this.game.dust(this.pos, new THREE.Vector3(Math.sin(k * 1.57), 0, Math.cos(k * 1.57)));
      this.game.burst(this.pos.clone().setY(0.4), j.dir, 'spark');
      this.game.shake(0.25);
      this.jet = null;
      this.jetCd = 0.6;
      this.setState('move');
      this.startDodge({ move: new THREE.Vector2(j.dir.x, j.dir.z) });
      // the dodge is a forward somersault: join it at its head-down frame (6)
      const ROLL_IN = 6, TAU = Math.PI * 2;
      c.slots.base.action.time = ROLL_IN / FPS;
      this.dodgeDone = smooth01(ROLL_IN / 15) * (this.game.assets.meta('dodge').lunge || 3) * c.stride;
      const pn = ((j.pitch % TAU) + TAU) % TAU;                 // head down, forward: ~135 deg
      this.rollOut = Math.max(0, pn - 2.1);
      this.setSpin(this.rollOut, 0);
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
      if (this.jet || this.rollOut !== undefined) { this.setSpin(0, 0); this.rollOut = undefined; }
      this.jet = null;
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
