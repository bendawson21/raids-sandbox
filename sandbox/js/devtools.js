// Dev-only helpers (loaded with ?dev): deterministic stepping + in-page contact sheets.
export function installDevTools(game, panel) {
  // run `frames` sim steps of 1/60s, optionally pressing inputs on the first step
  game.sim = (frames, o = {}) => {
    game.manual = true;
    for (let i = 0; i < frames; i++) {
      if (o.attack && (i === 0 || o.mash)) game.pressed.attack = true;
      if (o.dodge && i === 0) game.pressed.dodge = true;
      game.lmb = !!o.hold; game.rmb = !!o.block;
      game.keys = new Set(o.keys || []);
      game.step(1 / 60);
    }
  };

  // Capture a sequence: steps = [{n, ...simOpts}], one tile after each step.
  game.sheet = (steps, { cols = 6, tile = 300, crop = 0.55, label = '' } = {}) => {
    const src = game.renderer.domElement;
    // the pane may be hidden (0-size layout): render at a fixed size for captures
    game.renderer.setSize(1280, 720, false);
    game.camera.aspect = 1280 / 720;
    game.camera.updateProjectionMatrix();
    const rows = Math.ceil(steps.length / cols);
    const c = document.createElement('canvas');
    c.width = cols * tile; c.height = rows * tile + 24;
    const g = c.getContext('2d');
    g.fillStyle = '#111'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#eee'; g.font = '16px sans-serif'; g.fillText(label, 8, 18);
    steps.forEach((s, i) => {
      game.sim(s.n ?? 4, s);
      const w = src.width, h = src.height, sz = Math.min(w, h) * crop;
      g.drawImage(src, (w - sz) / 2, (h - sz) / 2 - sz * 0.08, sz, sz, (i % cols) * tile, 24 + Math.floor(i / cols) * tile, tile, tile);
      g.fillStyle = '#ffd36b'; g.font = '13px monospace';
      const p = game.player;
      g.fillText(`${p.state} ${(p.char.baseTime() * 30).toFixed(0)}`, (i % cols) * tile + 6, 24 + Math.floor(i / cols) * tile + 16);
    });
    let ov = document.getElementById('devsheet');
    if (!ov) {
      ov = document.createElement('img');
      ov.id = 'devsheet';
      Object.assign(ov.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', objectFit: 'contain',
        background: '#111', zIndex: 50 });
      ov.onclick = () => ov.remove();
      document.body.append(ov);
    }
    ov.src = c.toDataURL();
    return c.width + 'x' + c.height;
  };
  game.closeSheet = () => document.getElementById('devsheet')?.remove();
  game.panel = panel;
}
