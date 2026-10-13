// Asset loading: catalog, per-style part libraries, shared animation clips, palettes.
// Races (catalog.races): each race has its own skeleton proportions, so its own part
// libraries and clips (same bone names); human loads up front, others on first use.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const ROOT = '../assets/';
const loader = new GLTFLoader();

function loadGLB(url) {
  return new Promise((res, rej) => loader.load(url, res, undefined, rej));
}

export class Assets {
  constructor() {
    this.catalog = null;
    this.bundles = {};       // race -> { styles: {style: { rig, statics, mrTex }}, clips: {name: clip}, variants }
    this.loading = {};
    this.palettes = {};      // preset|race -> DataTexture
  }

  // human (the default race): kept as .styles / .clips for callers that don't care
  get styles() { return this.bundles.human.styles; }
  get clips() { return this.bundles.human.clips; }

  async load(onProgress) {
    this.catalog = await (await fetch(ROOT + 'catalog.json', { cache: 'no-store' })).json();
    onProgress?.('catalog');
    await this.loadRace('human', onProgress);
  }

  // stride: leg-length ratio (locomotion plays at speed / (meta.speed * stride), lunges
  // and dodge travel x stride, so planted feet stay planted); weapon_scale; skin roles
  race(name) {
    return (this.catalog.races || {})[name || 'human'] || { stride: 1, weapon_scale: 1, skin: null };
  }
  raceNames() { return Object.keys(this.catalog.races || { human: 1 }); }

  loadRace(race = 'human', onProgress) {
    if (this.bundles[race]) return Promise.resolve(this.bundles[race]);
    if (!this.loading[race]) this.loading[race] = (async () => {
      const files = this.race(race).files || {};
      const b = { styles: {}, clips: {}, variants: new Map() };
      const anim = await loadGLB(ROOT + (files.anims || 'characters/anims.glb') + '?v=' + Date.now());
      for (const c of anim.animations) {
        // cape bones are driven procedurally in-engine
        c.tracks = c.tracks.filter(t => !t.name.startsWith('cape_'));
        b.clips[c.name] = c;
      }
      onProgress?.('animations');
      for (const style of this.catalog.styles) {
        b.styles[style] = await this.loadStyle(ROOT + (files[style] || `characters/${style}.glb`));
        onProgress?.(style);
      }
      this.bundles[race] = b;
      return b;
    })();
    return this.loading[race];
  }

  lib(style, race = 'human') { return (this.bundles[race] || this.bundles.human).styles[style]; }

  async loadStyle(url) {
    const g = await loadGLB(`${url}?v=${Date.now()}`);
    const rig = g.scene.getObjectByName('rig');
    const statics = {};
    let mrTex = null;
    for (const c of [...g.scene.children]) {
      if (c === rig) continue;
      if (c.isMesh) { statics[c.name] = c; c.removeFromParent(); }
    }
    rig.traverse(o => {
      if (o.isSkinnedMesh) {
        mrTex = mrTex || o.material.metalnessMap;
        o.frustumCulled = false;     // skinned bounds are bind-pose only
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    for (const m of Object.values(statics)) { m.castShadow = true; m.receiveShadow = true; mrTex = mrTex || m.material.metalnessMap; }
    if (mrTex) { mrTex.magFilter = THREE.NearestFilter; mrTex.minFilter = THREE.NearestFilter; mrTex.generateMipmaps = false; }
    return { rig, statics, mrTex };
  }

  // palette preset -> 32x1 DataTexture (sRGB), shared across characters; a race's skin
  // tone replaces the preset's skin roles
  palette(preset, race = 'human') {
    const key = preset + '|' + race;
    if (this.palettes[key]) return this.palettes[key];
    const cat = this.catalog;
    const p = Object.assign({}, cat.palettes[preset] || cat.palettes.hero, this.race(race).skin || {});
    const data = new Uint8Array(cat.roles.length * 4);
    cat.roles.forEach((r, i) => {
      const hex = p[r] || cat.materials[r] || '#ff00ff';
      const c = parseInt(hex.slice(1), 16);
      data[i * 4] = (c >> 16) & 255; data[i * 4 + 1] = (c >> 8) & 255; data[i * 4 + 2] = c & 255; data[i * 4 + 3] = 255;
    });
    const t = new THREE.DataTexture(data, cat.roles.length, 1, THREE.RGBAFormat);
    t.colorSpace = THREE.SRGBColorSpace;
    t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter;
    t.flipY = false;
    t.needsUpdate = true;
    this.palettes[key] = t;
    return t;
  }

  // Clip filtered to a bone mask. masks: full | upper | lower | noLeftArm | leftArm
  clip(name, mask = 'full', race = 'human') {
    const b = this.bundles[race] || this.bundles.human;
    const key = name + '|' + mask;
    if (b.variants.has(key)) return b.variants.get(key);
    const src = b.clips[name];
    if (!src) throw new Error('missing clip ' + name);
    if (mask === 'full') { b.variants.set(key, src); return src; }
    const sk = this.catalog.skeleton;
    const upper = new Set(sk.upper), left = new Set(sk.left_arm);
    const keep = bone => {
      switch (mask) {
        case 'upper': return upper.has(bone);
        case 'lower': return !upper.has(bone);
        case 'noLeftArm': return !left.has(bone);
        case 'leftArm': return left.has(bone);
      }
      return true;
    };
    const c = new THREE.AnimationClip(key, src.duration, src.tracks.filter(t => keep(t.name.split('.')[0])));
    b.variants.set(key, c);
    return c;
  }

  meta(name) { return this.catalog.anims[name] || {}; }
  item(id) { return this.catalog.items[id]; }
}

// Blender (Z-up, -Y forward) -> glTF/three (Y-up, +Z forward) for points authored in Blender space
export function b2t(v) { return new THREE.Vector3(v[0], v[2], -v[1]); }
