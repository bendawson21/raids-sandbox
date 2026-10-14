// Tiny NPC behaviours that drive Actors through the same input struct as the player.
import * as THREE from 'three';
import { emptyInput } from './actor.js';

function toward(a, p, stop) {
  const d = new THREE.Vector2(p.x - a.pos.x, p.z - a.pos.z);
  const len = d.length();
  if (len <= stop) return new THREE.Vector2();
  return d.divideScalar(len).multiplyScalar(Math.min(1, (len - stop) * 1.5));
}

// Walk to a station next to a dummy and run through full combos on it.
export function drill(dummy, { rest = 2.2, station = null } = {}) {
  const S = { t: rest * Math.random(), presses: 0 };
  return (a, dt, game) => {
    const inp = emptyInput();
    inp.aim = dummy.pos.clone();
    S.t -= dt;
    const home = station || a.home;
    if (a.state === 'move') {
      inp.move.copy(toward(a, home, 0.15));
      if (inp.move.lengthSq() < 0.01 && S.t <= 0) {
        S.presses = a.st().combo.length || 1;
        S.t = rest + Math.random();
      }
      if (inp.move.lengthSq() < 0.01) {
        // idle facing the dummy
        const dx = dummy.pos.x - a.pos.x, dz = dummy.pos.z - a.pos.z;
        a.turnTo(Math.atan2(dx, dz), 6, dt);
      }
    }
    if (S.presses > 0) {
      if (a.state === 'attack' && a.combo >= S.presses - 1) S.presses = 0;
      else if (a.state === 'move' || a.state === 'attack') inp.attack = true;
    }
    return inp;
  };
}

// Shoot arrows (or crossbow bolts: it spans itself after each shot) at a target on a timer.
export function archer(target, { every = 3.2 } = {}) {
  const S = { t: 1 + Math.random() * every, hold: 0 };
  return (a, dt) => {
    const inp = emptyInput();
    inp.aim = target.pos.clone().setY(0);
    S.t -= dt;
    if (a.state === 'move') {
      inp.move.copy(toward(a, a.home, 0.15));
      const dx = target.pos.x - a.pos.x, dz = target.pos.z - a.pos.z;
      a.turnTo(Math.atan2(dx, dz), 6, dt);
    }
    if (S.t <= 0 && a.state === 'move') { inp.attack = true; inp.attackHeld = true; S.hold = 1.0 + Math.random() * 0.5; S.t = every; }
    if (a.state === 'aim' || a.state === 'xaim') { S.hold -= dt; inp.attackHeld = S.hold > 0; }
    return inp;
  };
}

// Mill about between random points near home.
export function wander({ radius = 3 } = {}) {
  const S = { goal: null, wait: 1 };
  return (a, dt) => {
    const inp = emptyInput();
    if (!S.goal || (S.wait <= 0 && a.pos.distanceTo(S.goal) < 0.3)) {
      const ang = Math.random() * Math.PI * 2, r = Math.random() * radius;
      S.goal = a.home.clone().add(new THREE.Vector3(Math.sin(ang) * r, 0, Math.cos(ang) * r));
      S.wait = 1.5 + Math.random() * 3;
    }
    if (a.pos.distanceTo(S.goal) > 0.3) inp.move.copy(toward(a, S.goal, 0.2)).multiplyScalar(0.45);
    else S.wait -= dt;
    return inp;
  };
}

// Sparring partner: squares up to the player and trades blows.
export function spar(game, { range = 1.5, cooldown = 2.4, aggro = 7 } = {}) {
  const S = { cd: cooldown };
  return (a, dt) => {
    const inp = emptyInput();
    const p = game.player;
    if (!p || !a.alive) return inp;
    const d = a.pos.distanceTo(p.pos);
    S.cd -= dt;
    if (d > aggro || !p.alive) {
      inp.move.copy(toward(a, a.home, 0.2)).multiplyScalar(0.5);
      return inp;
    }
    inp.aim = p.pos.clone();
    if (a.state === 'move') {
      const dx = p.pos.x - a.pos.x, dz = p.pos.z - a.pos.z;
      a.turnTo(Math.atan2(dx, dz), 8, dt);
      if (d > range) inp.move.copy(toward(a, p.pos, range)).multiplyScalar(0.55);
      else if (S.cd <= 0) { inp.attack = true; S.cd = cooldown + Math.random(); S.chain = Math.random() < 0.5 ? 2 : 1; }
    } else if (a.state === 'attack' && S.chain > 1 && a.combo < S.chain - 1) inp.attack = true;
    return inp;
  };
}
