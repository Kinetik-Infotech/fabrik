/* Back to top: shown once the page is nearly a screen past the top. */
(function () {
  var btn = document.querySelector('.to-top'), still = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (!btn) return;
  function update() { btn.classList.toggle('is-shown', window.scrollY > window.innerHeight * 0.9); }
  window.addEventListener('scroll', update, { passive: true }); update();
  btn.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: still.matches ? 'auto' : 'smooth' }); });
})();

/* Burger: below 1100px the section links sit in a panel this button opens. Tapping a link closes it, and so does Escape. */
(function () {
  var nav = document.querySelector('.nav'), btn = nav && nav.querySelector('.navburger'), links = nav && nav.querySelector('.navlinks');
  if (!btn || !links) return;
  function setOpen(open) {
    nav.classList.toggle('is-open', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.setAttribute('aria-label', open ? 'Close the menu' : 'Open the menu');
  }
  btn.addEventListener('click', function () { setOpen(btn.getAttribute('aria-expanded') !== 'true'); });
  links.addEventListener('click', function (e) { if (e.target.closest('a')) setOpen(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && nav.classList.contains('is-open')) { setOpen(false); btn.focus(); } });
})();

/* The tape measure: one wavy path down the left edge, from below the header to the foot of the window, with a tick at every tenth of its length.
   It shows from 900 pixels wide, drawn as far as the page has been scrolled. With reduced motion it is
   drawn in full and stays still. The path is rebuilt in window pixels on every resize, so the strokes never stretch. */
(function () {
  var tape = document.querySelector('.tape'), bar = document.querySelector('.topbar');
  if (!tape) return;
  var svg = tape.querySelector('svg'), paths = tape.querySelectorAll('.edge, .band'), ticks = tape.querySelector('.ticks');
  var still = window.matchMedia('(prefers-reduced-motion: reduce)'), wide = window.matchMedia('(min-width: 900px)');
  var NS = 'http://www.w3.org/2000/svg', marks = [];

  function build() {
    if (!wide.matches) return;
    tape.style.top = (bar ? Math.round(bar.getBoundingClientRect().height) + 6 : 0) + 'px';
    var w = tape.clientWidth, h = tape.clientHeight, x = w / 2, a = w * 0.17, top = wide.matches ? 40 : 4;
    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    var d = 'M' + x + ' ' + top +
      ' C' + (x + a) + ' ' + (h * 0.18) + ' ' + (x - a) + ' ' + (h * 0.32) + ' ' + x + ' ' + (h * 0.5) +
      ' S' + (x + a) + ' ' + (h * 0.82) + ' ' + x + ' ' + (h - 10);
    paths.forEach(function (p) { p.setAttribute('d', d); p.setAttribute('stroke-dasharray', '1 2'); });
    ticks.textContent = '';
    marks = [];
    var len = paths[0].getTotalLength(), half = wide.matches ? 4.5 : 2;
    for (var i = 1; i < 10; i++) {
      var pt = paths[0].getPointAtLength(len * i / 10), line = document.createElementNS(NS, 'line');
      line.setAttribute('class', 'tick');
      line.setAttribute('x1', pt.x - half); line.setAttribute('x2', pt.x + half);
      line.setAttribute('y1', pt.y); line.setAttribute('y2', pt.y);
      ticks.appendChild(line);
      marks.push(line);
    }
    draw();
  }
  function draw() {
    var room = document.documentElement.scrollHeight - window.innerHeight;
    var done = still.matches || !wide.matches || room <= 0 ? 1 : Math.min(1, Math.max(0.02, window.scrollY / room));
    paths.forEach(function (p) { p.setAttribute('stroke-dashoffset', String(1 - done)); });
    marks.forEach(function (m, i) { m.classList.toggle('on', done >= (i + 1) / 10); });
  }
  window.addEventListener('scroll', draw, { passive: true });
  window.addEventListener('resize', build);
  still.addEventListener('change', draw);
  wide.addEventListener('change', build);
  build();
})();

/* Search: pressing a way's line or its result picks that way in both. When the section first scrolls into view,
   the three ways are picked in turn, ending on Graph. A press stops the turns. With reduced motion nothing turns. */
(function () {
  var box = document.querySelector('#search .find');
  if (!box) return;
  var picks = box.querySelectorAll('[data-way]'), still = window.matchMedia('(prefers-reduced-motion: reduce)'), timer = null;
  function pick(way) {
    picks.forEach(function (el) {
      var on = el.getAttribute('data-way') === way;
      el.classList.toggle('on', on);
      el.setAttribute('aria-pressed', on ? 'true' : 'false');
      el.classList.remove('said');
      if (on && !still.matches) { void el.offsetWidth; el.classList.add('said'); }
    });
  }
  box.addEventListener('click', function (e) {
    var el = e.target.closest('[data-way]');
    if (!el) return;
    clearTimeout(timer); timer = null;
    pick(el.getAttribute('data-way'));
  });
  if (still.matches || !('IntersectionObserver' in window)) return;
  var seen = new IntersectionObserver(function (entries) {
    if (!entries[0].isIntersecting) return;
    seen.disconnect();
    var order = ['keyword', 'semantic', 'graph'], i = 0;
    (function next() { pick(order[i]); if (++i < order.length) timer = setTimeout(next, 1400); })();
  }, { threshold: 0.5 });
  seen.observe(box);
})();
