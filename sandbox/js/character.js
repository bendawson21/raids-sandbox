// Modular character: one cloned skeleton, palette material, equipment visibility,
// weapon sockets, layered animation slots, procedural cape + bow string.
import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { b2t } from './assets.js';

export const ARMOUR_SLOTS = ['helmet', 'chest', 'legs', 'boots', 'gloves', 'back'];
export const WEAPON_SLOTS = ['mainhand', 'offhand'];

export const STANCES = {
  fists: { idle: 'idle_fists', run: 'run', combo: ['punch_1', 'punch_2', 'punch_3', 'punch_2'] },
  '1h': { idle: 'idle_1h', run: 'run_1h', combo: ['attack_1h_1', 'attack_1h_2', 'attack_1h_3'] },
  dual: { idle: 'idle_dual', run: 'run_dual', combo: ['attack_dual_1', 'attack_dual_2', 'attack_dual_3'] },
  '2h': { idle: 'idle_2h', run: 'run_2h', combo: ['attack_2h_1', 'attack_2h_2', 'attack_2h_3'] },
  bow: { idle: 'idle_bow', run: 'run_bow', combo: [] },
  spear: { idle: 'idle_spear', run: 'run_spear', combo: ['attack_spear_1', 'attack_spear_2', 'attack_spear_3'] },
  spear_shield: { idle: 'idle_spear_shield', run: 'run_spear_shield', combo: ['attack_spsh_1', 'attack_spsh_2', 'attack_spsh_3'] },
};

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion();
const Y = new THREE.Vector3(0, 1, 0);

export class Character {
  constructor(assets, loadout = {}, style = 'lowpoly') {
    this.assets = assets;
    this.style = style;
    this.root = new THREE.Group();
    this.loadout = Object.assign({ race: 'human', palette: 'hero', hair: 'short', beard: null, helmet: null, chest: null, legs: null,
      boots: null, gloves: null, back: null, mainhand: null, offhand: null }, loadout);
    this.weapons = {};
    this.slots = { base: null, upper: null, left: null };
    this.cape = [0, 0, 0].map(() => ({ x: 0, vx: 0, z: 0, vz: 0 }));
    this.drawAmount = 0;
    this.animSpeed = 1;
    this._lastChest = null;
    this.build();
  }

  // ------------------------------------------------------------------ build
  build() {
    const prev = this.slots;
    if (this.model) {
      this.mixer.stopAllAction();
      this.root.remove(this.model);
    }
    const lib = this.assets.lib(this.style, this.race);
    this.model = SkeletonUtils.clone(lib.rig);
    this.root.add(this.model);
    this.material = new THREE.MeshStandardMaterial({
      map: this.assets.palette(this.loadout.palette, this.race), vertexColors: true, flatShading: true,
      metalnessMap: lib.mrTex, roughnessMap: lib.mrTex, metalness: 1, roughness: 1, envMapIntensity: 2.2,
    });
    this.meshes = {};
    this.bones = {};
    this.model.traverse(o => {
      if (o.isBone) this.bones[o.name] = o;
      if (o.isSkinnedMesh) {
        this.meshes[o.name] = o;
        o.material = this.material;
        o.frustumCulled = false;
        o.castShadow = true;
      }
    });
    this.capeRest = ['cape_1', 'cape_2', 'cape_3'].map(n => this.bones[n].quaternion.clone());
    this.mixer = new THREE.AnimationMixer(this.model);
    this.slots = { base: null, upper: null, left: null };
    this.weapons = {};
    this.attachWeapons();
    this.refresh();
    // restore animation slots after a rebuild (style switch)
    for (const k of ['base', 'upper', 'left']) {
      const s = prev && prev[k];
      if (s) this.setSlot(k, s.name, Object.assign({}, s.opts, { fade: 0, time: s.action.time }));
    }
  }

  setStyle(style) {
    if (style === this.style || !this.assets.lib(style, this.race)) return;
    this.style = style;
    this.build();
  }

  // races: own proportions (skeleton), clips, skin tone and item scale (catalog.races)
  get race() { return this.assets.bundles[this.loadout.race] ? this.loadout.race : 'human'; }
  get raceInfo() { return this.assets.race(this.race); }
  get stride() { return this.raceInfo.stride || 1; }
  // gameplay trait: heavy races move slower (the run then plays slower, feet planted)
  get moveSpeed() { return this.raceInfo.move_speed || 1; }
  // stride for locomotion playback: the true stride (planted feet), unless that would
  // step faster than the race's max_cadence (x human run) - then a little foot slide
  get locoStride() {
    const cap = this.raceInfo.max_cadence;
    return cap ? Math.max(this.stride, this.moveSpeed / cap) : this.stride;
  }

  async setRace(race) {
    await this.assets.loadRace(race);
    this.loadout.race = race;
    this._lastChest = null;
    this.build();
  }

  // ------------------------------------------------------------- equipment
  item(id) { return id ? this.assets.item(id) : null; }

  get stance() {
    const m = this.item(this.loadout.mainhand), o = this.item(this.loadout.offhand);
    if (o && o.kind === 'bow') return 'bow';
    if (!m) return 'fists';
    if (m.kind === 'spear') return this.hasShield ? 'spear_shield' : 'spear';
    if (m.kind === '2h') return '2h';
    if (o && o.kind === '1h') return 'dual';
    return '1h';
  }
  get hasShield() { const o = this.item(this.loadout.offhand); return !!(o && o.kind === 'shield'); }
  get mainReach() { const m = this.item(this.loadout.mainhand); return m ? (m.reach || 1.2) : 0.9; }

  equip(slot, id) {
    const L = this.loadout;
    L[slot] = id || null;
    const m = this.item(L.mainhand), o = this.item(L.offhand);
    if (slot === 'mainhand' && m && m.kind === '2h') L.offhand = null;
    // a spear goes two-handed, or one-handed with a shield
    if (slot === 'mainhand' && m && m.kind === 'spear' && o && o.kind !== 'shield') L.offhand = null;
    if (slot === 'mainhand' && m && o && o.kind === 'bow') L.offhand = null;
    if (slot === 'offhand' && o && (o.kind === 'bow')) L.mainhand = null;
    if (slot === 'offhand' && o && m && m.kind === '2h') L.mainhand = null;
    if (slot === 'offhand' && o && o.kind === '1h' && (!m || m.kind !== '1h')) {
      // dual wield needs a one-hander in the main hand too
      if (!m) L.mainhand = id;
    }
    this.attachWeapons();
    this.refresh();
  }

  setLoadout(lo) {
    Object.assign(this.loadout, { helmet: null, chest: null, legs: null, boots: null, gloves: null, back: null,
      mainhand: null, offhand: null, beard: null }, lo);
    this.attachWeapons();
    this.refresh();
  }

  setPalette(p) { this.loadout.palette = p; this.material.map = this.assets.palette(p, this.race); this.material.needsUpdate = true; }

  attachWeapons() {
    for (const s of WEAPON_SLOTS) {
      if (this.weapons[s]) { this.weapons[s].removeFromParent(); this.weapons[s] = null; }
    }
    const lib = this.assets.lib(this.style, this.race);
    const ws = this.raceInfo.weapon_scale || 1;
    for (const s of WEAPON_SLOTS) {
      const id = this.loadout[s];
      if (!id || !lib.statics[id]) continue;
      const m = lib.statics[id].clone();
      m.material = this.material;
      // glTF keeps bone-local axes as authored in Blender (Z-up) while mesh data is
      // converted to Y-up, so undo that conversion for meshes parented to bones.
      m.position.set(0, 0, 0); m.rotation.set(Math.PI / 2, 0, 0); m.scale.setScalar(ws);
      m.castShadow = true;
      this.bones[s === 'mainhand' ? 'weapon_R' : 'weapon_L'].add(m);
      this.weapons[s] = m;
      const it = this.item(id);
      if (it.kind === 'bow') this.makeBowString(m, it);
    }
  }

  makeBowString(bow, it) {
    const geo = new THREE.CylinderGeometry(0.006, 0.006, 1, 4, 1);
    geo.translate(0, 0.5, 0);
    const mat = new THREE.MeshBasicMaterial({ color: 0xe9e1c8 });
    const a = new THREE.Mesh(geo, mat), b = new THREE.Mesh(geo, mat);
    bow.add(a, b);
    bow.userData.string = { a, b, top: b2t(it.string[0]), bot: b2t(it.string[1]), nock: b2t(it.nock) };
    this.updateBowString();
  }

  refresh() {
    const cat = this.assets.catalog, L = this.loadout;
    const hidden = new Set(), hiddenSlots = new Set();
    for (const s of ARMOUR_SLOTS) {
      const it = this.item(L[s]);
      if (!it) continue;
      it.hides.forEach(h => hidden.add(h));
      (it.hides_slots || []).forEach(h => hiddenSlots.add(h));
    }
    for (const [name, mesh] of Object.entries(this.meshes)) {
      let vis = false;
      if (name.startsWith('body_')) vis = !hidden.has(name.slice(5));
      else if (name.startsWith('hair_')) vis = L.hair === name.slice(5) && !hidden.has('hair');
      else if (name.startsWith('beard_')) vis = L.beard === name.slice(6) && !hidden.has('beard');
      else {
        const it = cat.items[name];
        vis = !!it && L[it.slot] === name && !hiddenSlots.has(it.slot);
      }
      mesh.visible = vis;
    }
    this.material.map = this.assets.palette(L.palette, this.race);
  }

  // ------------------------------------------------------------- animation
  // slot: base | upper | left.  opts: {mask, fade, once, timeScale, restart, time}
  setSlot(slot, name, opts = {}) {
    const cur = this.slots[slot];
    const fade = opts.fade ?? 0.12;
    if (!name) {
      if (cur) { cur.action.fadeOut(fade); this.slots[slot] = null; }
      return null;
    }
    const mask = opts.mask || 'full';
    if (cur && cur.name === name && cur.mask === mask && !opts.restart) {
      if (opts.timeScale != null) cur.action.timeScale = opts.timeScale;
      return cur.action;
    }
    const clip = this.assets.clip(name, mask, this.race);
    const action = this.mixer.clipAction(clip);
    let t = opts.time ?? 0;
    if (opts.time == null && cur && cur.name === name && !opts.restart) t = cur.action.time;   // re-mask keeps phase
    if (cur && cur.action !== action) cur.action.fadeOut(fade);
    action.reset();
    action.setLoop(opts.once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    action.clampWhenFinished = !!opts.once;
    action.timeScale = opts.timeScale ?? 1;
    action.time = t;
    action.setEffectiveWeight(1);
    if (fade > 0) action.fadeIn(fade);
    action.play();
    this.slots[slot] = { name, mask, action, opts: Object.assign({}, opts, { mask }) };
    return action;
  }

  // Re-mask the base slot depending on whether upper / left layers are active.
  syncMasks(fade = 0.15) {
    const leftOn = !!this.slots.left && !this.slots.upper;
    if (this.slots.left && this.slots.upper) this.setSlot('left', null, { fade });
    const want = this.slots.upper ? 'lower' : (leftOn ? 'noLeftArm' : 'full');
    const b = this.slots.base;
    if (b && b.mask !== want) this.setSlot('base', b.name, Object.assign({}, b.opts, { mask: want, fade }));
  }

  baseTime() { return this.slots.base ? this.slots.base.action.time : 0; }

  // ------------------------------------------------------------- per frame
  update(dt) {
    this.mixer.update(dt * this.animSpeed);
    this.model.updateMatrixWorld(true);
    this.updateCape(dt);
    this.updateBowString();
  }

  updateCape(dt) {
    if (!(this.meshes.back_cape?.visible || this.meshes.back_cape_tattered?.visible) || dt <= 0) return;
    const chest = this.bones.chest;
    chest.getWorldPosition(_v);
    if (!this._lastChest) this._lastChest = _v.clone();
    const vel = _v2.copy(_v).sub(this._lastChest).divideScalar(Math.max(dt, 1e-4));
    this._lastChest.copy(_v);
    chest.getWorldQuaternion(_q);
    // bone axes are Blender's: chest local +Z == character front, +X == character left
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(_q);
    const left = new THREE.Vector3(1, 0, 0).applyQuaternion(_q);
    const vf = vel.dot(fwd), vs = vel.dot(left);
    // keep the cape hanging when the chest pitches forward/back (gravity)
    const pitch = Math.asin(THREE.MathUtils.clamp(-fwd.y, -1, 1));
    const t = performance.now() / 1000;
    const speed = Math.min(1, Math.hypot(vf, vs) / 5);
    const lift = THREE.MathUtils.clamp(vf * 0.13, -0.2, 0.85);
    for (let i = 0; i < 3; i++) {
      const c = this.cape[i];
      const flutter = Math.sin(t * 11 + i * 1.7) * 0.07 * speed * (i + 1) * 0.6;
      let tx = (i === 0 ? lift - pitch * 0.85 : lift * 0.35) + flutter;
      if (i === 0) tx = Math.max(tx, -0.15);
      const tz = THREE.MathUtils.clamp(-vs * 0.03, -0.25, 0.25) * (i === 0 ? 1 : 0.5);
      c.vx += (tx - c.x) * 70 * dt; c.vx *= Math.exp(-9 * dt); c.x += c.vx * dt;
      c.vz += (tz - c.z) * 60 * dt; c.vz *= Math.exp(-9 * dt); c.z += c.vz * dt;
      const b = this.bones['cape_' + (i + 1)];
      b.quaternion.copy(this.capeRest[i]);
      b.rotateX(c.x);
      b.rotateZ(c.z);
    }
  }

  updateBowString() {
    const bow = this.weapons.offhand;
    const s = bow && bow.userData.string;
    if (!s) return;
    let nock = s.nock;
    if (this.drawAmount > 0.001) {
      this.bones.weapon_R.getWorldPosition(_v);
      bow.worldToLocal(_v);
      nock = _v2.copy(s.nock).lerp(_v, this.drawAmount);
    }
    this.nockLocal = nock.clone();
    for (const [seg, from] of [[s.a, s.top], [s.b, s.bot]]) {
      const d = new THREE.Vector3().subVectors(nock, from);
      seg.position.copy(from);
      seg.quaternion.setFromUnitVectors(Y, d.clone().normalize());
      seg.scale.set(1, d.length(), 1);
    }
  }

  // world-space blade segment for trails / effects
  bladeWorld(slot, out0, out1) {
    const w = this.weapons[slot];
    if (!w) return false;
    const it = this.item(this.loadout[slot]);
    const tr = it.trail || [0.1, 0.5];
    out0.set(0, 0, -tr[0]).applyMatrix4(w.matrixWorld);
    out1.set(0, 0, -tr[1]).applyMatrix4(w.matrixWorld);
    return true;
  }
}
