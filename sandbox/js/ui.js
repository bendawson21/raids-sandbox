// Side panel: style, outfits, per-slot equipment, palettes, animation viewer, debug toggles.
const SLOT_LABELS = { helmet: 'Helmet', chest: 'Chest', legs: 'Legs', boots: 'Boots', gloves: 'Gloves', back: 'Back',
  mainhand: 'Main hand', offhand: 'Off hand' };

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'on') for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
    else if (k === 'class') e.className = v;
    else e.setAttribute(k, v);
  }
  for (const k of kids) e.append(k);
  return e;
}

function select(options, value, onChange) {
  const s = el('select');
  for (const [v, label] of options) {
    const o = el('option', { value: v ?? '' }, label);
    if ((v ?? '') === (value ?? '')) o.selected = true;
    s.append(o);
  }
  s.addEventListener('change', () => onChange(s.value || null));
  return s;
}

export class Panel {
  constructor(root, game) {
    this.root = root;
    this.game = game;
    root.addEventListener('pointerdown', e => e.stopPropagation());
    this.render();
  }

  get player() { return this.game.player; }

  render() {
    const g = this.game, cat = g.assets.catalog, p = this.player.char;
    const r = this.root;
    r.innerHTML = '';
    r.append(el('h2', {}, 'Character Sandbox'));

    // --- race (own proportions, clips, skin tone and item scale; loaded on first pick)
    const rseg = el('div', { class: 'seg' });
    for (const race of g.assets.raceNames()) {
      const b = el('button', { class: p.race === race ? 'on' : '' }, race);
      b.onclick = async () => {
        b.textContent = 'loading…';
        await p.setRace(race);
        this.afterEquip();
      };
      rseg.append(b);
    }
    r.append(el('h3', {}, 'Race'), rseg);

    // --- outfits
    const grid = el('div', { class: 'grid' });
    Object.keys(cat.loadouts).forEach((name, i) => {
      const b = el('button', { title: `key ${i + 1}` }, name);
      b.onclick = () => this.applyLoadout(name);
      grid.append(b);
    });
    const rnd = el('button', {}, 'random');
    rnd.onclick = () => this.randomize();
    grid.append(rnd);
    r.append(el('h3', {}, 'Outfits'), grid);

    // --- equipment
    r.append(el('h3', {}, 'Equipment'));
    const items = Object.entries(cat.items);
    for (const slot of ['helmet', 'chest', 'legs', 'boots', 'gloves', 'back']) {
      const opts = [[null, '—']].concat(items.filter(([, it]) => it.slot === slot).map(([id, it]) => [id, it.name]));
      r.append(el('div', { class: 'row' }, el('label', {}, SLOT_LABELS[slot]),
        select(opts, p.loadout[slot], v => { p.equip(slot, v); this.afterEquip(); })));
    }
    const main = [[null, '— (fists)']].concat(items.filter(([, it]) => it.slot === 'mainhand')
      .map(([id, it]) => [id, `${it.name} (${it.kind})`]));
    const off = [[null, '—']].concat(items.filter(([, it]) => it.kind === 'shield' || it.kind === 'bow' || it.kind === '1h')
      .map(([id, it]) => [id, `${it.name} (${it.kind})`]));
    r.append(el('div', { class: 'row' }, el('label', {}, 'Main hand'),
      select(main, p.loadout.mainhand, v => { p.equip('mainhand', v); this.afterEquip(); })));
    r.append(el('div', { class: 'row' }, el('label', {}, 'Off hand'),
      select(off, p.loadout.offhand, v => { p.equip('offhand', v); this.afterEquip(); })));
    r.append(el('div', { class: 'note' }, `Stance: ${p.stance}${p.hasShield ? ' + shield' : ''}`));

    // --- look
    r.append(el('h3', {}, 'Look'));
    r.append(el('div', { class: 'row' }, el('label', {}, 'Palette'),
      select(Object.keys(cat.palettes).map(k => [k, k]), p.loadout.palette, v => { p.setPalette(v); })));
    const ri = g.assets.race(p.race), hairs = ri.hair || cat.hair, beards = ri.beard || cat.beard;   // per race
    r.append(el('div', { class: 'row' }, el('label', {}, 'Hair'),
      select([[null, 'bald']].concat(hairs.map(h => [h, h])), p.loadout.hair, v => { p.loadout.hair = v; p.refresh(); })));
    r.append(el('div', { class: 'row' }, el('label', {}, 'Beard'),
      select([[null, 'none']].concat(beards.map(h => [h, h])), p.loadout.beard, v => { p.loadout.beard = v; p.refresh(); })));

    // --- animation viewer
    r.append(el('h3', {}, 'Animation viewer'));
    const clips = Object.keys(cat.anims).sort();
    this.clipSel = select(clips.map(c => [c, c]), this.clipSel ? this.clipSel.value : 'attack_1h_1', () => {});
    const play = el('button', {}, '▶ Play');
    play.onclick = () => this.preview(this.clipSel.value);
    r.append(el('div', { class: 'row' }, el('label', {}, 'Clip'), this.clipSel));
    const ctrl = el('div', { class: 'seg' });
    const pause = el('button', { class: g.paused ? 'on' : '' }, g.paused ? 'Paused' : 'Pause');
    pause.onclick = () => { g.paused = !g.paused; this.render(); };
    const step = el('button', {}, 'Step +1f');
    step.onclick = () => { g.paused = true; g.stepOnce = true; };
    ctrl.append(play, pause, step);
    r.append(ctrl);
    const speed = el('input', { type: 'range', min: '0.05', max: '1.5', step: '0.05', value: String(g.timeScale) });
    const sl = el('label', {}, `Time ×${g.timeScale.toFixed(2)}`);
    speed.oninput = () => { g.timeScale = parseFloat(speed.value); sl.textContent = `Time ×${g.timeScale.toFixed(2)}`; };
    r.append(el('div', { class: 'row' }, sl, speed));
    this.speedInput = speed; this.speedLabel = sl;

    // --- debug
    r.append(el('h3', {}, 'Display'));
    const chk = el('div', { class: 'chk' });
    const tog = (label, get, set) => {
      const c = el('input', { type: 'checkbox' });
      c.checked = get();
      c.onchange = () => set(c.checked);
      chk.append(el('label', {}, c, label));
    };
    tog('weapon trails', () => g.showTrails, v => g.showTrails = v);
    tog('hit arcs', () => g.showArcs, v => g.showArcs = v);
    tog('NPCs', () => g.npcsVisible !== false, v => g.setNpcsVisible(v));
    r.append(chk);
    r.append(el('div', { class: 'note' },
      'Everything here is generated from tools/blender (python). One skeleton + one clip set drive the player and every NPC in both styles.'));
  }

  afterEquip() {
    const a = this.player;
    if (a.state === 'move') a.applyLocomotion(a.vel.length());
    this.render();
  }

  applyLoadout(name) {
    const lo = this.game.assets.catalog.loadouts[name];
    const p = this.player.char;
    const L = { palette: lo.palette, hair: lo.hair || null, beard: lo.beard || null,
      mainhand: lo.mainhand || null, offhand: lo.offhand || null };
    for (const id of lo.items) L[this.game.assets.item(id).slot] = id;
    p.setLoadout(L);
    this.afterEquip();
  }

  randomize() {
    const cat = this.game.assets.catalog, p = this.player.char;
    const pick = arr => arr[Math.floor(Math.random() * arr.length)];
    const items = Object.entries(cat.items);
    const ri = this.game.assets.race(p.race);
    const L = { palette: pick(Object.keys(cat.palettes)), hair: pick((ri.hair || cat.hair).concat([null])),
      beard: Math.random() < 0.4 ? pick(ri.beard || cat.beard) : null };
    for (const slot of ['helmet', 'chest', 'legs', 'boots', 'gloves', 'back']) {
      const c = items.filter(([, it]) => it.slot === slot).map(([id]) => id);
      L[slot] = Math.random() < 0.8 ? pick(c) : null;
    }
    const kind = pick(['1h', '1h+shield', 'dual', '2h', 'bow', 'spear', 'spear+shield']);
    const ones = items.filter(([, it]) => it.kind === '1h').map(([id]) => id);
    if (kind === '2h') L.mainhand = pick(items.filter(([, it]) => it.kind === '2h').map(([id]) => id));
    else if (kind === 'spear' || kind === 'spear+shield') {
      L.mainhand = pick(items.filter(([, it]) => it.kind === 'spear').map(([id]) => id));
      if (kind === 'spear+shield') L.offhand = pick(items.filter(([, it]) => it.kind === 'shield').map(([id]) => id));
    }
    else if (kind === 'bow') L.offhand = pick(items.filter(([, it]) => it.kind === 'bow').map(([id]) => id));
    else {
      L.mainhand = pick(ones);
      if (kind === 'dual') L.offhand = pick(ones);
      if (kind === '1h+shield') L.offhand = pick(items.filter(([, it]) => it.kind === 'shield').map(([id]) => id));
    }
    p.setLoadout(L);
    this.afterEquip();
  }

  preview(clip) {
    const a = this.player, c = a.char;
    a.setState('preview');
    a.vel.set(0, 0, 0);
    c.drawAmount = clip.startsWith('bow_aim') || clip === 'bow_release' ? 1 : 0;
    c.setSlot('upper', null, { fade: 0.05 });
    c.setSlot('left', null, { fade: 0.05 });
    c.setSlot('base', clip, { restart: true, fade: 0.1 });
    c.syncMasks(0.05);
  }
}
