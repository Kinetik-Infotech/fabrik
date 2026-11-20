// The animated-recipe player, lifted from prototype/sourdough-pizza/index.html.
// It reads the scene script and the clip lengths that build.mjs inlines as JSON, draws each scene's SVG into
// the stage, and plays it with tweens, captions, the clock, units and narration.
//
// window.TOTAL is the length in seconds and window.renderAt(t) draws the frame at t, the same every time.
// window.READY resolves once fonts are in and every chip is sized, so a recorder waits for it before stepping.
// ?record shows only the drawing and the caption band (1600 × 900), with no controls and no sound.
// ?style=line|storyboard|comic|anime (or #anime) and ?units=metric|us pick the treatment and the units.
(() => {
  const $ = id => document.getElementById(id);
  const DATA = JSON.parse($('script-data').textContent);
  const VOICE = JSON.parse($('durations-data').textContent).files || {};
  const AUDIO = document.body.dataset.audio || 'audio/';
  const params = new URLSearchParams(location.search);
  const RECORD = params.has('record');
  if (RECORD) document.documentElement.classList.add('rec');

  const EASE = {
    l: p => p,
    i: p => p * p * p,
    o: p => 1 - Math.pow(1 - p, 3),
    io: p => p < .5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2,
    b: p => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); }
  };
  const DEF = { o: 1, x: 0, y: 0, s: 1, sx: 1, sy: 1, r: 0 };

  // Script tweens are data: [elementId, t0, t1, props, ease = 'io'], or a shorthand [name, elementId, t, d?].
  // Times are seconds before the scene is stretched to fit its narration.
  const T = (id, t0, t1, p, e = 'io') => {
    if (!EASE[e]) throw new Error(`tween ${id}: unknown ease "${e}"`);
    return { id, t0, t1, p, e };
  };
  const SHORT = {
    pop: (id, t, d = .9) => T(id, t, t + d, { o: [0, 1], s: [.3, 1] }, 'b'),
    fadeUp: (id, t, d = 1) => T(id, t, t + d, { o: [0, 1], y: [16, 0] }, 'o'),
    fadeOut: (id, t, d = .6) => T(id, t, t + d, { o: [1, 0] })
  };
  const tween = w => SHORT[w[0]] ? SHORT[w[0]](w[1], w[2], w[3]) : T(w[0], w[1], w[2], w[3], w[4]);

  const SC = DATA.scenes.map(s => ({
    id: s.id, title: s.title, dur: s.dur, kit: s.kit || '', vo: s.vo, voUS: s.voUS || s.vo,
    clock: s.clock ? s.clock.map(k => [...k]) : null,
    cap: s.cap.map(c => [...c]),
    capUS: (s.capUS || s.cap).map(c => c[1]),
    tw: s.tw.map(tween)
  }));

  // Each scene's drawing goes in as <g class="scene" id="…">, in script order, behind the near-utensil layer.
  const svgEl = document.querySelector('svg.art');
  const sceneSlot = svgEl.querySelector('.kit-fg');
  DATA.scenes.forEach(s => {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'scene');
    g.id = s.id;
    g.innerHTML = s.svg;
    svgEl.insertBefore(g, sceneSlot);
  });

  // Narration: one MP3 per scene (and a -us.mp3 where the US wording differs). Each scene lasts a short lead-in,
  // its longer clip (metric or US) and a pause, or its scripted length if that is longer; tweens, clock keys and
  // captions stretch with it. Both units share the timing.
  const LEAD = .5, TAIL = 1.3, WPS = 2.5;
  const voiceLen = s => Math.max(VOICE[s.id + '.mp3'] || 0, VOICE[s.id + '-us.mp3'] || 0);
  SC.forEach(s => {
    const words = Math.max(s.vo ? s.vo.split(/\s+/).length : 0, s.voUS ? s.voUS.split(/\s+/).length : 0);
    const need = voiceLen(s) ? LEAD + voiceLen(s) + TAIL : words / WPS + 1.2;
    const f = Math.max(1, need / s.dur);
    s.fit = f;
    s.dur *= f;
    s.tw.forEach(w => { w.t0 *= f; w.t1 *= f; });
    if (s.clock) s.clock.forEach(k => { k[0] *= f; });
    s.cap.forEach(c => { c[0] *= f; });
  });
  let total = 0;
  SC.forEach(s => { s.start = total; total += s.dur; });
  // The still shown before play: the first scene once its last tween has finished.
  const POSTER = SC[0].tw.reduce((a, w) => Math.max(a, w.t1), 0) || SC[0].dur / 2;

  const stage = $('stage'), pic = $('pic'), capEl = $('cap'), playBtn = $('play'), scrub = $('scrub'), timeEl = $('time');
  const STYLES = { line: 'st-line', storyboard: 'st-board', comic: 'st-comic', anime: 'st-anime' };
  const stylePick = $('style-pick');
  let style = (() => {
    const q = params.get('style'), h = location.hash.slice(1);
    if (STYLES[q]) return q;
    if (STYLES[h]) return h;
    if (!RECORD) try { const s = localStorage.getItem('animator-style'); if (STYLES[s]) return s; } catch (e) {}
    return 'line';
  })();
  stage.classList.remove('st-line'); stage.classList.add(STYLES[style]);
  stylePick.value = style;
  const hudN = $('hud-n'), hudT = $('hud-t'), hudClock = $('hud-clock'), hudD = $('hud-d'), hudDay = $('hud-day'), hudH = $('hud-h'), hudM = $('hud-m');
  const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  $('eyebrow').innerHTML = `<span>Animated tutorial</span> · <span>${SC.length} steps · ${fmt(total)}</span>`;
  scrub.max = total.toFixed(2);

  function compile(s) {
    const map = new Map();
    s.tw.forEach(tw => {
      const el = $(tw.id);
      if (!el) { console.warn('missing element', tw.id); return; }
      let m = map.get(el);
      if (!m) { m = { el, props: {} }; map.set(el, m); }
      for (const k in tw.p) (m.props[k] = m.props[k] || []).push({ t0: tw.t0, t1: tw.t1, a: tw.p[k][0], b: tw.p[k][1], e: EASE[tw.e] });
    });
    for (const m of map.values()) for (const k in m.props) m.props[k].sort((a, b) => a.t0 - b.t0);
    s.items = [...map.values()];
    s.g = $(s.id);
  }
  function val(list, t) {
    if (t < list[0].t0) return list[0].a;
    let cur = list[0];
    for (const w of list) { if (w.t0 <= t) cur = w; else break; }
    const p = Math.min(1, Math.max(0, (t - cur.t0) / Math.max(1e-6, cur.t1 - cur.t0)));
    return cur.a + (cur.b - cur.a) * cur.e(p);
  }
  function applyItem(m, t) {
    const v = { ...DEF }; let tf = false, n = null;
    for (const k in m.props) {
      const x = val(m.props[k], t);
      if (k === 'n') n = x; else { v[k] = x; if (k !== 'o') tf = true; }
    }
    if ('o' in m.props) m.el.style.opacity = v.o;
    if (tf) m.el.style.transform = `translate(${v.x}px,${v.y}px) rotate(${v.r}deg) scale(${v.s * v.sx},${v.s * v.sy})`;
    if (n !== null) m.el.textContent = Math.round(n) + (m.el.dataset.suffix || '');
  }
  function kf(k, t) {
    if (t <= k[0][0]) return k[0][1];
    for (let j = 1; j < k.length; j++) {
      if (t <= k[j][0]) { const [t0, a] = k[j - 1], [t1, b] = k[j]; return a + (b - a) * EASE.io((t - t0) / (t1 - t0)); }
    }
    return k[k.length - 1][1];
  }

  const chapters = $('chapters');
  SC.forEach((s, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = `<span class="n">${String(i + 1).padStart(2, '0')}</span><span></span>`;
    b.lastChild.textContent = s.title;
    b.addEventListener('click', () => { closeMenu(); go(i); });
    chapters.appendChild(b);
  });
  const burger = $('burger');
  function closeMenu() { chapters.hidden = true; burger.setAttribute('aria-expanded', 'false'); chrome(); }
  burger.addEventListener('click', () => {
    const open = chapters.hidden;
    chapters.hidden = !open;
    burger.setAttribute('aria-expanded', String(open));
    chrome();
    if (open) (chapters.querySelector('[aria-current="true"]') || chapters.firstChild).focus();
  });
  document.addEventListener('click', e => { if (!chapters.hidden && !chapters.contains(e.target) && !burger.contains(e.target)) closeMenu(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !chapters.hidden) { closeMenu(); burger.focus(); } });

  let t = RECORD ? 0 : POSTER, cur = -1, playing = false, last = 0, posterOn = !RECORD, capText = null;

  function render(time) {
    t = Math.max(0, Math.min(total, time));
    let i = SC.findIndex(s => t < s.start + s.dur);
    if (i < 0) i = SC.length - 1;
    const s = SC[i], lt = t - s.start;
    if (cur !== i) {
      SC.forEach((x, j) => { x.g.style.display = j === i ? '' : 'none'; });
      cur = i;
      stage.dataset.scene = s.id;
      stage.dataset.kit = s.kit;
      hudN.textContent = String(i + 1).padStart(2, '0');
      hudT.textContent = s.title.toUpperCase();
      [...chapters.children].forEach((b, j) => b.setAttribute('aria-current', j === i ? 'true' : 'false'));
    }
    const fin = i === 0 ? 1 : Math.min(1, lt / .3);
    const fout = i === SC.length - 1 ? 1 : Math.min(1, (s.dur - lt) / .3);
    s.g.style.opacity = Math.max(0, Math.min(fin, fout));
    s.items.forEach(m => applyItem(m, lt));

    if (!s.clock) hudClock.style.opacity = 0;
    else {
      hudClock.style.opacity = 1;
      const m = kf(s.clock, lt), mm = Math.floor(m);
      hudD.textContent = `${String(Math.floor((mm % 1440) / 60)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`;
      hudDay.textContent = `DAY ${Math.floor(mm / 1440) + 1}`;
      hudH.setAttribute('transform', `rotate(${((m % 720) / 720) * 360} 1500 74)`);
      hudM.setAttribute('transform', `rotate(${(m % 60) * 6} 1500 74)`);
    }

    let ci = 0;
    s.cap.forEach((c, j) => { if (c[0] <= lt) ci = j; });
    const c0 = s.cap[ci][0], c1 = ci + 1 < s.cap.length ? s.cap[ci + 1][0] : s.dur;
    const isLastCap = ci === s.cap.length - 1;
    const co = Math.max(0, Math.min(1, (lt - c0) / .25, isLastCap && i === SC.length - 1 ? 1 : (c1 - lt) / .25));
    const capNow = units === 'us' ? s.capUS[ci] : s.cap[ci][1];
    if (capText !== capNow) { capText = capNow; capEl.textContent = capText; }
    capEl.style.opacity = (i === 0 && posterOn) ? 1 : co;

    scrub.value = t.toFixed(2);
    scrub.style.setProperty('--p', (t / total * 100).toFixed(2) + '%');
    timeEl.textContent = `${fmt(t)} / ${fmt(total)}`;
  }

  // stopAt: when a step is started from pause, play only that step and hold its last full frame
  // (0.3 s before the end, ahead of the cross-fade).
  let stopAt = null, loop = 0;
  function frame(ts, id) {
    if (!playing || id !== loop) return;
    if (!voiceWaiting(ts)) t += (ts - last) / 1000; // hold the picture while the next clip loads, so no words are skipped
    last = ts;
    if (stopAt !== null && t >= stopAt) { render(stopAt); pause(); return; }
    if (t >= total) { render(total); pause(); return; }
    render(t);
    voiceSync();
    requestAnimationFrame(n => frame(n, id));
  }

  // One audio element, reused for every scene, so a phone that unlocked it on the first tap keeps it unlocked.
  // Every clip is downloaded up front into memory, so switching scenes never waits on the network.
  // Each clip starts from its first word; if one is still loading, the animation waits for it.
  const voice = new Audio(); voice.preload = 'auto';
  let muted = RECORD || (() => { try { return localStorage.getItem('animator-muted') === '1'; } catch (e) { return false; } })();
  const BLOB = {};
  let preloadStarted = false;
  function voicePreload() {
    if (preloadStarted || RECORD) return; preloadStarted = true;
    Object.keys(VOICE).forEach(n => fetch(AUDIO + n).then(r => r.ok ? r.blob() : null)
      .then(b => { if (b) BLOB[n] = URL.createObjectURL(b); }).catch(() => {}));
  }
  const voiceFile = s => {
    if (!s) return null;
    const us = s.id + '-us.mp3', m = s.id + '.mp3';
    const n = units === 'us' && VOICE[us] ? us : m;
    return VOICE[n] ? { key: n, len: VOICE[n] } : null;
  };
  function voiceSet(f) { voice.dataset.key = f.key; voice.src = BLOB[f.key] || AUDIO + f.key; }
  const voiceOffset = () => t - SC[cur].start - LEAD;
  const startAt = off => off > .3 ? off : 0; // only jump in when someone seeked mid-sentence
  voice.addEventListener('loadedmetadata', () => { if (playing && cur >= 0) voice.currentTime = startAt(Math.max(0, voiceOffset())); });
  let waitSince = 0;
  function voiceWaiting(ts) { // true while the clip that should be speaking is not ready yet (gives up after 6 s)
    const f = cur >= 0 ? voiceFile(SC[cur]) : null, off = cur >= 0 ? voiceOffset() : -1;
    const want = playing && !muted && f && off >= 0 && off < f.len && !voice.error;
    const notReady = want && (voice.dataset.key !== f.key || voice.readyState < 3 || voice.seeking);
    if (!notReady) { waitSince = 0; return false; }
    if (!waitSince) waitSince = ts;
    return ts - waitSince < 6000;
  }
  function voiceSync() {
    const f = cur >= 0 ? voiceFile(SC[cur]) : null, off = cur >= 0 ? voiceOffset() : -1;
    if (!playing || muted || !f || off < 0 || off >= f.len) { if (!voice.paused) voice.pause(); return; }
    if (voice.dataset.key !== f.key) { voiceSet(f); voice.play().catch(() => {}); return; }
    if (voice.readyState >= 3 && !voice.seeking && Math.abs(voice.currentTime - off) > .4) voice.currentTime = off;
    if (voice.paused) voice.play().catch(() => {});
  }
  function voiceUnlock() { // called inside the tap or click that starts playback
    if (muted) return;
    const f = voiceFile(SC[Math.max(0, cur)]) || voiceFile(SC[0]);
    voicePreload();
    if (f && voice.dataset.key !== f.key) voiceSet(f);
    voice.play().then(voiceSync, () => {});
  }
  const muteBtn = $('mute');
  function setMuteUI() { muteBtn.classList.toggle('is-muted', muted); muteBtn.setAttribute('aria-pressed', String(muted)); muteBtn.setAttribute('aria-label', muted ? 'Turn narration on' : 'Mute narration'); }
  muteBtn.addEventListener('click', () => {
    muted = !muted;
    try { localStorage.setItem('animator-muted', muted ? '1' : '0'); } catch (e) {}
    setMuteUI();
    if (!muted && playing) voiceUnlock(); else voiceSync();
  });
  setMuteUI();
  voicePreload();
  function hidePoster() { posterOn = false; }
  function setPlayUI() { playBtn.classList.toggle('is-playing', playing); playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play'); }

  // Player chrome (controls + burger): always shown while paused or while the step menu is open;
  // while playing it shows on activity and hides after 2.8 s.
  let chromeTimer = null;
  function chrome(delay = 2800) {
    clearTimeout(chromeTimer);
    stage.classList.add('chrome');
    if (playing && chapters.hidden) chromeTimer = setTimeout(() => stage.classList.remove('chrome'), delay);
  }

  function play() {
    if (RECORD) return;
    if (posterOn) { hidePoster(); t = 0; }
    if (t >= total - .01) t = 0;
    playing = true; stopAt = null; setPlayUI();
    last = performance.now();
    const id = ++loop;
    requestAnimationFrame(n => frame(n, id));
    render(t); voiceUnlock();
    chrome();
  }
  function pause() { playing = false; stopAt = null; setPlayUI(); voiceSync(); chrome(); }
  function go(i) {
    const s = SC[Math.max(0, Math.min(SC.length - 1, i))];
    const wasPaused = !playing;
    hidePoster(); render(s.start);
    if (wasPaused) { play(); stopAt = s.start + s.dur - .3; }
  }
  const prevIndex = () => (playing && t - SC[cur].start > 3) ? cur : cur - 1;

  playBtn.addEventListener('click', () => playing ? pause() : play());
  $('restart').addEventListener('click', () => { hidePoster(); render(0); if (!playing) play(); });
  $('next').addEventListener('click', () => go(cur + 1));
  $('prev').addEventListener('click', () => go(prevIndex()));
  scrub.addEventListener('input', () => { hidePoster(); render(parseFloat(scrub.value)); chrome(); });
  $('ctrl').addEventListener('click', () => chrome());

  // Mouse: hovering shows the chrome, clicking the picture plays/pauses.
  // Touch: the first tap shows the chrome; a tap while it is showing plays/pauses.
  let pointer = 'mouse';
  pic.addEventListener('pointerdown', e => { pointer = e.pointerType; });
  pic.addEventListener('pointermove', e => { if (e.pointerType === 'mouse') chrome(); });
  pic.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse' && playing && chapters.hidden) chrome(600); });
  pic.addEventListener('click', e => {
    if (!e.target.isConnected || e.target.closest('.ctrl, .burger, .chapters') || !chapters.hidden) return;
    playing ? pause() : play();
  });

  document.addEventListener('keydown', e => {
    if (RECORD || e.target.closest('button, input')) return;
    if (e.code === 'Space') { e.preventDefault(); playing ? pause() : play(); }
    else if (e.key === 'ArrowRight') { go(cur + 1); chrome(); }
    else if (e.key === 'ArrowLeft') { go(prevIndex()); chrome(); }
  });

  function sizeChips() {
    document.querySelectorAll('.chip').forEach(g => {
      const tx = g.querySelector('text'), r = g.querySelector('rect'), b = tx.getBBox();
      r.setAttribute('x', b.x - 14); r.setAttribute('y', b.y - 8);
      r.setAttribute('width', b.width + 28); r.setAttribute('height', b.height + 16);
    });
  }
  // Line weight scales with the stage; the step title starts just right of the burger button.
  const setK = () => {
    const scale = svgEl.getBoundingClientRect().width / 1600;
    if (!scale) return;
    stage.style.setProperty('--k', Math.max(.34, scale).toFixed(3));
    const x = (burger.offsetLeft + burger.offsetWidth) / scale + 28;
    hudN.setAttribute('x', x.toFixed(1));
    hudT.setAttribute('x', (x + 48).toFixed(1));
  };
  if (window.ResizeObserver) new ResizeObserver(setK).observe(svgEl);
  setK();

  // Hand-drawn feel: dough, levain, crust and sauce circles become slightly irregular outlines.
  // The seed comes from the geometry, so stacked copies of one shape stay identical.
  function rng(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let x = Math.imul(a ^ a >>> 15, 1 | a); x = x + Math.imul(x ^ x >>> 7, 61 | x) ^ x; return ((x ^ x >>> 14) >>> 0) / 4294967296; }; }
  function blobXY(cx, cy, rx, ry, wob, n, seed) {
    const R = rng(seed), ph = [R() * 6.28, R() * 6.28, R() * 6.28], p = [];
    for (let i = 0; i < n; i++) {
      const a = i / n * Math.PI * 2, k = 1 + wob * (Math.sin(3 * a + ph[0]) * .5 + Math.sin(5 * a + ph[1]) * .3 + Math.sin(7 * a + ph[2]) * .2);
      p.push([cx + rx * k * Math.cos(a), cy + ry * k * Math.sin(a)]);
    }
    const f = v => v.toFixed(1);
    let d = `M${f(p[0][0])} ${f(p[0][1])}`;
    for (let i = 0; i < n; i++) {
      const p0 = p[(i - 1 + n) % n], p1 = p[i], p2 = p[(i + 1) % n], p3 = p[(i + 2) % n];
      d += ` C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`;
    }
    return d + 'Z';
  }
  function organic() {
    document.querySelectorAll('svg.art .scene circle, svg.art .scene ellipse').forEach(el => {
      const cls = (el.getAttribute('class') || '').trim();
      if ((!/\bf-(d|l|c|sa)\b/.test(cls) && cls !== 'ln') || el.hasAttribute('transform')) return;
      const r = +el.getAttribute('r') || 0, rx = +el.getAttribute('rx') || r, ry = +el.getAttribute('ry') || r;
      if (Math.min(rx, ry) < 18) return;
      const cx = +el.getAttribute('cx'), cy = +el.getAttribute('cy');
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      for (const a of [...el.attributes]) if (!['cx', 'cy', 'r', 'rx', 'ry'].includes(a.name)) p.setAttribute(a.name, a.value);
      p.setAttribute('d', blobXY(cx, cy, rx, ry, .028, 32, Math.round(cx * 7 + cy * 13 + rx * 17 + ry * 19)));
      el.replaceWith(p);
    });
  }

  function relayout() {
    if (!init.done) return;
    SC.forEach(s => { $(s.id).style.display = ''; });
    sizeChips();
    cur = -1;
    render(t);
    setK();
  }
  function setStyle(name) {
    if (!STYLES[name]) name = 'line';
    style = name;
    stage.classList.remove(...Object.values(STYLES));
    stage.classList.add(STYLES[name]);
    stylePick.value = name;
    if (!RECORD) try { localStorage.setItem('animator-style', name); } catch (e) {}
    if (location.hash !== '#' + name) location.hash = name;
    relayout();
  }
  stylePick.addEventListener('change', () => setStyle(stylePick.value));

  // Units: metric (grams, °C, litres, cm) or US (cups and spoons, °F, quarts, inches).
  // Every drawn label with a measurement carries its US wording in data-us (and a new x in data-usx if it moves).
  const unitsPick = $('units-pick');
  let units = (() => {
    const q = params.get('units');
    if (q === 'us' || q === 'metric') return q;
    if (!RECORD) try { const u = localStorage.getItem('animator-units'); if (u === 'us' || u === 'metric') return u; } catch (e) {}
    return 'metric';
  })();
  function applyUnits() {
    stage.classList.toggle('units-us', units === 'us');
    unitsPick.value = units;
    document.querySelectorAll('svg.art [data-us]').forEach(el => {
      if (el.dataset.m === undefined) el.dataset.m = el.textContent;
      el.textContent = units === 'us' ? el.dataset.us : el.dataset.m;
    });
    document.querySelectorAll('svg.art [data-usx]').forEach(el => {
      if (el.dataset.mx === undefined) el.dataset.mx = el.getAttribute('x');
      el.setAttribute('x', units === 'us' ? el.dataset.usx : el.dataset.mx);
    });
  }
  function setUnits(u) {
    units = u === 'us' ? 'us' : 'metric';
    if (!RECORD) try { localStorage.setItem('animator-units', units); } catch (e) {}
    applyUnits();
    capText = null;
    relayout();
  }
  unitsPick.addEventListener('change', () => setUnits(unitsPick.value));
  window.addEventListener('hashchange', () => { const h = location.hash.slice(1); if (STYLES[h] && h !== style) setStyle(h); });

  let ready;
  const READY = new Promise(r => { ready = r; });
  function init() {
    if (init.done) return; init.done = true;
    organic();
    applyUnits();
    SC.forEach(s => { $(s.id).style.display = ''; });
    sizeChips();
    SC.forEach(compile);
    render(t);
    setPlayUI();
    stage.classList.add('ready');
    const fonts = ['400 24px "Courier Prime"', '700 24px "Courier Prime"', '40px "Mochiy Pop One"', '800 24px "M PLUS Rounded 1c"', '700 24px "Comic Neue"', '40px Bangers', '500 40px "Cormorant Garamond"', 'italic 500 20px "Cormorant Garamond"'];
    const done = () => { relayout(); ready(); };
    if (document.fonts) Promise.all(fonts.map(f => document.fonts.load(f))).then(done, done); else done();
  }

  // The recorder's interface: the length, and a frame drawn the same way every time for a given t.
  window.TOTAL = total;
  window.READY = READY;
  window.renderAt = x => { init(); render(x); };
  window.seek = x => { init(); pause(); hidePoster(); render(x); };
  window.TUTORIAL = { total, scenes: SC.map(s => ({ id: s.id, title: s.title, start: s.start, dur: s.dur, vo: s.vo, voUS: s.voUS, capUS: [...s.capUS], cap: s.cap.map(c => [c[0], c[1]]) })) };
  (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(init);
  setTimeout(init, 2500);
})();
