import * as THREE from 'three';
import { Assets } from './assets.js';
import { Game } from './game.js';
import { Panel } from './ui.js';
import { drill, archer, wander, spar } from './ai.js';

const loading = document.getElementById('loading');
const assets = new Assets();
try {
  await assets.load(s => { loading.textContent = `Loading… ${s}`; });
} catch (e) {
  loading.textContent = 'Failed to load assets: ' + e.message;
  throw e;
}
loading.remove();

const game = new Game(assets, document.getElementById('app'));
window.game = game;   // handy for debugging in the console
const V = (x, z) => new THREE.Vector3(x, 0, z);
const LO = assets.catalog.loadouts;
const loadout = (name, extra = {}) => {
  const lo = LO[name];
  const L = { palette: lo.palette, hair: lo.hair || null, beard: lo.beard || null,
    mainhand: lo.mainhand || null, offhand: lo.offhand || null };
  for (const id of lo.items) L[assets.item(id).slot] = id;
  return Object.assign(L, extra);
};

// player
game.player = game.spawn(loadout('knight', { palette: 'hero' }), V(0, 1.5),
  { player: true, name: 'player', facing: Math.PI, hittable: true, hp: 1e9 });

// NPCs: same skeleton, same clips, different outfits & palettes
const npc = (lo, pos, ai, opts = {}) => {
  const a = game.spawn(loadout(lo, opts.extra || {}), pos, Object.assign({ name: lo, facing: Math.PI, hittable: false }, opts));
  a.ai = ai;
  game.npcs.push(a);
  return a;
};
npc('noble', V(8.0, -4.2), drill(game.drillDummyA, { rest: 1.8 }));
npc('warlord', V(-8.0, -4.15), drill(game.drillDummyB, { rest: 2.4 }));
npc('ranger', V(-10.2, -4.0), archer(game.archTargets[0]));
{ // a crossbowman shooting from behind his planted pavise
  const t = game.archTargets[2], x = npc('crossbowman', V(10.2, -6.4), archer(t, { every: 4.2 }));
  x.facing = Math.atan2(t.pos.x - x.pos.x, t.pos.z - x.pos.z);
  game.togglePavise(x);
}
npc('mage', V(-6.5, 6.5), wander({ radius: 2.5 }), { facing: 0 });
npc('peasant', V(-3.5, 9), wander({ radius: 4 }), { facing: 0 });
npc('bandit', V(6.5, 4.5), spar(game), { hittable: true, hp: 70, respawn: 4, faction: 'bandit' });

game.setNpcsVisible = v => {
  game.npcsVisible = v;
  for (const a of game.npcs) { a.char.root.visible = v; a.disabled = !v; }
};

const panel = new Panel(document.getElementById('panel'), game);
if (new URLSearchParams(location.search).has('dev')) {
  const { installDevTools } = await import('./devtools.js');
  installDevTools(game, panel);
}

game.onKey = e => {
  const names = Object.keys(LO);
  if (/^Digit[1-9]$/.test(e.code)) {
    const i = parseInt(e.code.slice(5)) - 1;
    if (names[i]) panel.applyLoadout(names[i]);
  }
  if (e.code === 'KeyT') { game.showTrails = !game.showTrails; panel.render(); }
  if (e.code === 'KeyG') { game.showArcs = !game.showArcs; panel.render(); }
  if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
    const s = [0.1, 0.25, 0.5, 1];
    let i = s.findIndex(x => x >= game.timeScale - 1e-3);
    i = THREE.MathUtils.clamp(i + (e.code === 'BracketRight' ? 1 : -1), 0, s.length - 1);
    game.timeScale = s[i];
    panel.render();
  }
  if (e.code === 'KeyP') { game.paused = !game.paused; panel.render(); }
  if (e.code === 'KeyF') game.togglePavise(game.player);
  if (e.code === 'KeyR') { game.camYaw = game.CAM_HOME.yaw; game.camPitch = game.CAM_HOME.pitch; }
};

const stats = document.getElementById('stats');
let last = performance.now(), acc = 0, frames = 0;
function loop(now) {
  const dt = (now - last) / 1000;
  last = now;
  if (!game.manual) game.step(dt);
  acc += dt; frames++;
  if (acc > 0.5) {
    const p = game.player, info = game.renderer.info.render;
    stats.textContent = `${Math.round(frames / acc)} fps · ${info.triangles.toLocaleString()} tris · ${info.calls} draws · ` +
      `${p.state}${p.attackClip && p.state === 'attack' ? ' ' + p.attackClip : ''} · ${p.char.stance} · time ×${game.timeScale}`;
    acc = 0; frames = 0;
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
