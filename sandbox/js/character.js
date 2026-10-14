// Modular character: one cloned skeleton, palette material, equipment visibility,
// weapon sockets, layered animation slots, procedural bow string.
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
  crossbow: { idle: 'idle_xbow', run: 'run_xbow', combo: [] },
  sling: { idle: 'idle_sling', run: 'run_1h', combo: [] },          // the goblin's sling: whirl + cast (actor)
  spear: { idle: 'idle_spear', run: 'run_spear', combo: ['attack_spear_1', 'attack_spear_2', 'attack_spear_3'] },
  spear_shield: { idle: 'idle_spear_shield', run: 'run_spear_shield', combo: ['attack_spsh_1', 'attack_spsh_2', 'attack_spsh_3'] },
};

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion();
const Y = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);

export class Character {
  constructor(assets, loadout = {}, style = 'lowpoly') {
    this.assets = assets;
    this.style = style;
    this.root = new THREE.Group();
    this.loadout = Object.assign({ race: 'human', palette: 'hero', hair: 'short', beard: null, helmet: null, chest: null, legs: null,
      boots: null, gloves: null, back: null, mainhand: null, offhand: null }, loadout);
    this.weapons = {};
    this.slots = { base: null, upper: null, left: null };
    this.drawAmount = 0;
    this.xbowLoaded = true;      // crossbow: spanned and a bolt on the deck
    this.xbowPull = 0;           // while spanning: 1 = the string follows the left hand
    this.animSpeed = 1;
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
    this.build();
  }

  // ------------------------------------------------------------- equipment
  item(id) { return id ? this.assets.item(id) : null; }
  // the item's catalog entry with this race's own build points (a crossbow built to the race)
  itemMeta(id) {
    const it = this.item(id);
    const ov = it && (this.raceInfo.item_meta || {})[id];
    return ov ? Object.assign({}, it, ov) : it;
  }

  get stance() {
    const m = this.item(this.loadout.mainhand), o = this.item(this.loadout.offhand);
    if (o && o.kind === 'bow') return 'bow';
    if (!m) return 'fists';
    if (m.kind === 'crossbow') return 'crossbow';
    if (m.kind === 'sling') return 'sling';
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
    if (slot === 'mainhand' && m && (m.kind === '2h' || m.kind === 'crossbow')) L.offhand = null;
    // a spear goes two-handed, or one-handed with a shield
    if (slot === 'mainhand' && m && m.kind === 'spear' && o && o.kind !== 'shield') L.offhand = null;
    if (slot === 'mainhand' && m && o && o.kind === 'bow') L.offhand = null;
    if (slot === 'offhand' && o && (o.kind === 'bow')) L.mainhand = null;
    if (slot === 'offhand' && o && m && (m.kind === '2h' || m.kind === 'crossbow')) L.mainhand = null;
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
    if (this.sling) { this.sling.pivot.removeFromParent(); this.sling = null; }
    const lib = this.assets.lib(this.style, this.race);
    const ws = this.raceInfo.weapon_scale || 1;
    for (const s of WEAPON_SLOTS) {
      const id = this.loadout[s];
      if (!id || !lib.statics[id]) continue;
      const m = lib.statics[id].clone();
      m.material = this.material;
      // glTF keeps bone-local axes as authored in Blender (Z-up) while mesh data is
      // converted to Y-up, so undo that conversion for meshes parented to bones.
      // the sling scales with the body's height (item meta height_scale), not the weapon factor
      const hs = this.item(id) && this.item(id).height_scale;
      const wsi = hs ? (this.raceInfo.height_ratio || 1) * hs : ws;
      m.position.set(0, 0, 0); m.rotation.set(Math.PI / 2, 0, 0); m.scale.setScalar(wsi);
      // a strapped shield's back must clear the race's forearm + sleeve (catalog races.*.forearm_clear)
      const it0 = this.item(id);
      if (it0 && it0.back != null) m.position.x = Math.max(0, (this.raceInfo.forearm_clear || 0) - it0.back * ws);
      m.castShadow = true;
      const it = this.item(id);
      if (it.kind === 'sling') {
        // a pivot between the hand and the sling: its physics swings it (updateSling)
        const pivot = new THREE.Group();
        this.bones.weapon_R.add(pivot);
        pivot.add(m);
        this.sling = { pivot, L: 0.46 * wsi, X: null, P: null, w: 1 };
      } else this.bones[s === 'mainhand' ? 'weapon_R' : 'weapon_L'].add(m);
      this.weapons[s] = m;
      if (it.kind === 'bow') this.makeBowString(m, it);
      if (it.kind === 'crossbow') this.makeXbowString(m, this.itemMeta(id));
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

  makeXbowString(xb, it) {
    // the string from the prod's tips to: the nut (spanned), the left hand (spanning) or
    // the slack line at the prod; a bolt on the deck while loaded (catalog item meta)
    const geo = new THREE.CylinderGeometry(0.005, 0.005, 1, 4, 1);
    geo.translate(0, 0.5, 0);
    const mat = new THREE.MeshBasicMaterial({ color: 0xe9e1c8 });
    const a = new THREE.Mesh(geo, mat), b = new THREE.Mesh(geo, mat);
    xb.add(a, b);
    const s = { a, b, top: b2t(it.string[0]), bot: b2t(it.string[1]), nock: b2t(it.nock), nut: b2t(it.nut) };
    const lib = this.assets.lib(this.style, this.race);
    if (lib.statics.proj_bolt) {
      const bolt = lib.statics.proj_bolt.clone();
      bolt.material = this.material;
      bolt.position.copy(b2t(it.bolt));
      // the bolt's tip (Blender +Y) is -Z in its glTF mesh space
      bolt.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), b2t(it.bolt_dir).normalize());
      xb.add(bolt);
      s.bolt = bolt;
    }
    xb.userData.xbow = s;
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
      if (s === 'helmet') (this.raceInfo.helmet_hides || []).forEach(h => hidden.add(h));   // pointed ears
    }
    for (const [name, mesh] of Object.entries(this.meshes)) {
      let vis = false;
      if (name.startsWith('body_')) vis = !hidden.has(name.slice(5));
      else if (name.startsWith('hair_')) vis = L.hair === name.slice(5) && !hidden.has('hair');
      else if (name.startsWith('beard_')) vis = L.beard === name.slice(6) && !hidden.has('beard');
      else {
        const it = cat.items[name];
        vis = !!it && L[it.slot] === name && !hiddenSlots.has(it.slot) &&
          (!it.races || it.races.includes(this.race));       // race-exclusive gear (the orc's war furnace)
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
    this.updateStruggle(dt);
    this.model.updateMatrixWorld(true);
    this.updateSling(dt);
    this.updateBowString();
  }

  // the sling's physics (owner: stiff in idle and the run): the pouch is one point on a
  // cord from the fist, swinging under gravity (verlet + the cord length), and the sling
  // is turned to point at it.  The whirl and the cast (sling_* clips on the upper slot)
  // drive it from the animation instead; the hand-over blends.  One point per unit: cheap.
  updateSling(dt) {
    const S = this.sling;
    if (!S || dt <= 0) return;
    const bone = this.bones.weapon_R;
    const up = this.slots.upper;
    const want = up && up.name && up.name.startsWith('sling_') ? 0 : 1;
    S.w += (want - S.w) * Math.min(1, dt * 12);
    const P = bone.getWorldPosition(_v);
    bone.getWorldQuaternion(_q);
    if (S.w < 0.02 || !S.X) {
      // animated (or first frame): follow the clip's cord (bone -Y)
      const cord = _v2.set(0, -1, 0).applyQuaternion(_q).multiplyScalar(S.L);
      S.X = (S.X || new THREE.Vector3()).copy(P).add(cord);
      S.P = (S.P || new THREE.Vector3()).copy(S.X);
      S.pivot.quaternion.identity();
      return;
    }
    // verlet: carry on, fall, damp; then hold the cord's length; keep it off the ground
    const h = Math.min(dt, 1 / 30);
    const nx = S.X.x + (S.X.x - S.P.x) * 0.955, ny = S.X.y + (S.X.y - S.P.y) * 0.955 - 9.8 * h * h,
      nz = S.X.z + (S.X.z - S.P.z) * 0.955;
    S.P.copy(S.X);
    S.X.set(nx, ny, nz).sub(P).setLength(S.L).add(P);
    if (S.X.y < 0.03) S.X.y = 0.03;
    // turn the sling (its cord: bone -Y) toward the pouch, in the bone's frame
    const d = _v2.copy(S.X).sub(P).normalize().applyQuaternion(_q.invert());
    const q = new THREE.Quaternion().setFromUnitVectors(DOWN, d);
    S.pivot.quaternion.identity().slerp(q, S.w);
  }

  // the orc's captive wheel (item meta struggle): its goblin strains against the ropes -
  // two shape keys blended either way, in quiet pauses (a slow small writhe) and thrashing
  // fits (fast, full), each a random length
  updateStruggle(dt) {
    const id = this.loadout.back, it = id && this.item(id);
    if (!it || !it.struggle) return;
    const m = this.meshes[id];
    if (!m || !m.visible || !m.morphTargetDictionary) return;
    const S = this.struggle || (this.struggle = { p: Math.random() * 6, a: 0, fit: false, left: 0.5 + Math.random() * 2 });
    if ((S.left -= dt) <= 0) {
      S.fit = !S.fit;
      S.left = S.fit ? 0.6 + Math.random() * 1.1 : 1.2 + Math.random() * 2.6;
      S.freq = 8 + Math.random() * 7;
    }
    S.a += ((S.fit ? 1 : 0.2) - S.a) * Math.min(1, dt * 6);
    S.p += dt * (S.fit ? S.freq : 2.0);
    const v = Math.sin(S.p) * S.a, inf = m.morphTargetInfluences, d = m.morphTargetDictionary;
    if (d.struggle_a !== undefined) inf[d.struggle_a] = Math.max(0, v);
    if (d.struggle_b !== undefined) inf[d.struggle_b] = Math.max(0, -v);
  }

  updateBowString() {
    const xb = this.weapons.mainhand && this.weapons.mainhand.userData.xbow;
    if (xb) {
      let to = this.xbowLoaded ? xb.nut : xb.nock;
      if (!this.xbowLoaded && this.xbowPull > 0.001) {
        this.bones.weapon_L.getWorldPosition(_v);
        this.weapons.mainhand.worldToLocal(_v);
        to = _v2.copy(xb.nock).lerp(_v, this.xbowPull);
      }
      for (const [seg, from] of [[xb.a, xb.top], [xb.b, xb.bot]]) {
        const d = new THREE.Vector3().subVectors(to, from);
        seg.position.copy(from);
        seg.quaternion.setFromUnitVectors(Y, d.clone().normalize());
        seg.scale.set(1, d.length(), 1);
      }
      if (xb.bolt) xb.bolt.visible = this.xbowLoaded;
    }
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
