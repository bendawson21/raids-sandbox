// Visual feedback: weapon smear trails, hit particles, shock rings, damage numbers.
import * as THREE from 'three';

export class Trail {
  constructor(scene, color = 0xfff2d0, maxPts = 24, life = 0.16) {
    this.max = maxPts;
    this.life = life;
    this.pts = [];
    this.color = new THREE.Color(color);
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(maxPts * 2 * 3);
    this.col = new Float32Array(maxPts * 2 * 3);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    const idx = [];
    for (let i = 0; i < maxPts - 1; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, b, c, b, d, c);
    }
    g.setIndex(idx);
    this.mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      side: THREE.DoubleSide,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    scene.add(this.mesh);
  }

  push(base, tip, now) {
    const last = this.pts[this.pts.length - 1];
    if (last && last.tip.distanceToSquared(tip) < 1e-5) return;
    // subdivide large jumps so fast swings stay smooth
    if (last) {
      const steps = Math.min(4, Math.floor(last.tip.distanceTo(tip) / 0.12));
      for (let s = 1; s <= steps; s++) {
        const t = s / (steps + 1);
        this.pts.push({ base: last.base.clone().lerp(base, t), tip: last.tip.clone().lerp(tip, t),
          t: last.t + (now - last.t) * t });
      }
    }
    this.pts.push({ base: base.clone(), tip: tip.clone(), t: now });
    while (this.pts.length > this.max) this.pts.shift();
  }

  update(now, enabled = true) {
    while (this.pts.length && now - this.pts[0].t > this.life) this.pts.shift();
    const n = this.pts.length;
    this.mesh.visible = enabled && n > 1;
    if (!this.mesh.visible) return;
    for (let i = 0; i < this.max; i++) {
      const p = this.pts[Math.min(i, n - 1)];
      const k = i * 6;
      this.pos.set([p.base.x, p.base.y, p.base.z, p.tip.x, p.tip.y, p.tip.z], k);
      const a = i < n ? Math.max(0, 1 - (now - p.t) / this.life) : 0;
      const ab = a * a * 0.15, at = a * 0.85;
      this.col.set([this.color.r * ab, this.color.g * ab, this.color.b * ab,
        this.color.r * at, this.color.g * at, this.color.b * at], k);
    }
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.mesh.geometry.attributes.color.needsUpdate = true;
    this.mesh.geometry.setDrawRange(0, (Math.max(n, 2) - 1) * 6);
  }

  clear() { this.pts.length = 0; }
}

export class Particles {
  constructor(scene, max = 400) {
    this.scene = scene;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    this.mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.8, flatShading: true }), max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.items = [];
    this.max = max;
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._c = new THREE.Color();
  }

  burst(pos, dir, { count = 10, color = 0xe0c46a, speed = 4, size = 0.06, up = 2.5, life = 0.7, spread = 1 } = {}) {
    for (let i = 0; i < count && this.items.length < this.max; i++) {
      const v = new THREE.Vector3(
        dir.x * speed + (Math.random() - 0.5) * speed * spread,
        up * (0.4 + Math.random()),
        dir.z * speed + (Math.random() - 0.5) * speed * spread);
      this.items.push({ p: pos.clone(), v, r: new THREE.Vector3(Math.random() * 6, Math.random() * 6, Math.random() * 6),
        rv: new THREE.Vector3(Math.random() * 12 - 6, Math.random() * 12 - 6, Math.random() * 12 - 6),
        s: size * (0.6 + Math.random() * 0.8), t: 0, life: life * (0.7 + Math.random() * 0.6),
        c: new THREE.Color(color).offsetHSL(0, 0, (Math.random() - 0.5) * 0.15) });
    }
  }

  update(dt) {
    let n = 0;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.t += dt;
      if (it.t > it.life) { this.items.splice(i, 1); continue; }
      it.v.y -= 12 * dt;
      it.p.addScaledVector(it.v, dt);
      if (it.p.y < it.s / 2) { it.p.y = it.s / 2; it.v.y *= -0.3; it.v.x *= 0.6; it.v.z *= 0.6; it.rv.multiplyScalar(0.6); }
      it.r.addScaledVector(it.rv, dt);
    }
    for (const it of this.items) {
      const k = 1 - Math.max(0, (it.t - it.life * 0.6) / (it.life * 0.4));
      this._q.setFromEuler(this._e.set(it.r.x, it.r.y, it.r.z));
      this._m.compose(it.p, this._q, new THREE.Vector3(it.s * k, it.s * k, it.s * k));
      this.mesh.setMatrixAt(n, this._m);
      this.mesh.setColorAt(n, it.c);
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

export class Rings {
  constructor(scene) {
    this.scene = scene;
    this.items = [];
    this.geo = new THREE.RingGeometry(0.85, 1, 40);
    this.geo.rotateX(-Math.PI / 2);
  }
  spawn(pos, { color = 0xfff1c0, size = 2.2, life = 0.35 } = {}) {
    const m = new THREE.Mesh(this.geo, new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending }));
    m.position.copy(pos); m.position.y = 0.03;
    this.scene.add(m);
    this.items.push({ m, t: 0, life, size });
  }
  update(dt) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const r = this.items[i];
      r.t += dt;
      const k = r.t / r.life;
      if (k >= 1) { this.scene.remove(r.m); r.m.material.dispose(); this.items.splice(i, 1); continue; }
      const s = 0.2 + (1 - (1 - k) * (1 - k)) * r.size;
      r.m.scale.set(s, 1, s);
      r.m.material.opacity = 1 - k;
    }
  }
}

// screen-space floating damage numbers
export class Floaters {
  constructor(el, camera, renderer) {
    this.el = el; this.camera = camera; this.renderer = renderer;
    this.items = [];
  }
  spawn(pos, text, crit = false) {
    const d = document.createElement('div');
    d.className = 'dmg' + (crit ? ' crit' : '');
    d.textContent = text;
    this.el.appendChild(d);
    this.items.push({ d, p: pos.clone(), t: 0, dx: (Math.random() - 0.5) * 0.6 });
  }
  update(dt) {
    const w = this.renderer.domElement.clientWidth, h = this.renderer.domElement.clientHeight;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const f = this.items[i];
      f.t += dt;
      if (f.t > 0.9) { f.d.remove(); this.items.splice(i, 1); continue; }
      const p = f.p.clone();
      p.y += f.t * 1.4; p.x += f.dx * f.t;
      p.project(this.camera);
      f.d.style.left = ((p.x + 1) / 2 * w) + 'px';
      f.d.style.top = ((1 - p.y) / 2 * h) + 'px';
      f.d.style.opacity = String(Math.min(1, (0.9 - f.t) * 4));
      const pop = f.t < 0.08 ? 1 + (0.08 - f.t) * 6 : 1;
      f.d.style.transform = `translate(-50%,-50%) scale(${pop})`;
    }
  }
}
