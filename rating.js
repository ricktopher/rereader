// Scores card: two separate numbers.
//
//  Attention   - how reliably you catch odd words, over your most recent 200 results.
//                Caught = 1, missed = 0, a tap when nothing was there = half a miss.
//                Reading speed, chunk size and reaction time play no part.
//                The catch rate is put on a rating scale (50% = 1000, 90% ~ 1380, 95% ~ 1510)
//                so differences near the top stay visible.
//  Memory      - your self-graded memory checks (cloze), over your most recent 100.
//                Got it = 1, missed it = 0, on the same scale as Attention.
//  Consistency - lives in habits.js (Habits.consistency()): days you hit your goal, built up
//                slowly and drained slowly. Rendered here alongside Attention.
//
// Exposes window.Rating.{hit, miss, falseTap, endPassage, current, render}
// and window.Memory.{record, current}.
(function () {
  const KEY = 'rereader:attention';
  const WINDOW = 200;       // results that count toward Attention
  const PRIOR = 2;          // start as if 2 caught + 2 missed, so 3/3 isn't instantly "perfect"
  const HISTORY_MAX = 120;  // one point per finished passage, for the sparkline

  const TITLES = [
    [0, 'Drifting'],
    [900, 'Present'],
    [1100, 'Focused'],
    [1300, 'Absorbed'],
    [1500, 'Undivided'],
  ];

  // state = { results: [{ c: 0|1, w: 1|0.5 }], best, history: [{ t, r }] }
  let state = load();

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY));
      if (s && Array.isArray(s.results)) return { best: 1000, history: [], ...s };
    } catch (e) {}
    return { results: [], best: 1000, history: [] };
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
  }

  const title = r => TITLES.reduce((t, [min, name]) => (r >= min ? name : t), TITLES[0][1]);

  function stats() {
    let caught = 0, weight = 0, odd = 0;
    for (const x of state.results) { caught += x.c; weight += x.w; if (x.w === 1) odd++; }
    const p = (caught + PRIOR) / (weight + 2 * PRIOR);
    const r = Math.round(1000 + 400 * Math.log10(p / (1 - p)));
    return { r, rate: weight ? caught / weight : 0, odd };
  }

  function push(c, w) {
    const before = stats().r;
    state.results.push({ c, w });
    if (state.results.length > WINDOW) state.results.splice(0, state.results.length - WINDOW);
    const after = stats().r;
    if (after > state.best) state.best = after;
    save();
    return after - before;
  }

  const hit = () => push(1, 1);
  const miss = () => push(0, 1);
  const falseTap = () => push(0, 0.5);

  function endPassage() {
    state.history.push({ t: Date.now(), r: stats().r });
    if (state.history.length > HISTORY_MAX) state.history.splice(0, state.history.length - HISTORY_MAX);
    save();
  }

  function current() {
    const s = stats();
    return { r: s.r, title: title(s.r), best: state.best, rate: s.rate, odd: s.odd, results: state.results.length };
  }

  // ---------- Memory (self-graded cloze checks) ----------
  const MEM_KEY = 'rereader:memory';
  const MEM_WINDOW = 100;
  let mem = (() => {
    try { const m = JSON.parse(localStorage.getItem(MEM_KEY)); if (m && Array.isArray(m.results)) return m; } catch (e) {}
    return { results: [] };
  })();
  function memStats() {
    const got = mem.results.reduce((n, x) => n + x, 0);
    const p = (got + PRIOR) / (mem.results.length + 2 * PRIOR);
    return { r: Math.round(1000 + 400 * Math.log10(p / (1 - p))), rate: mem.results.length ? got / mem.results.length : 0, n: mem.results.length };
  }
  function memRecord(ok) {
    const before = memStats().r;
    mem.results.push(ok ? 1 : 0);
    if (mem.results.length > MEM_WINDOW) mem.results.splice(0, mem.results.length - MEM_WINDOW);
    try { localStorage.setItem(MEM_KEY, JSON.stringify(mem)); } catch (e) {}
    return memStats().r - before;
  }

  // ---------- landing-page card ----------
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  function sparkline(vals) {
    const ns = 'http://www.w3.org/2000/svg';
    const W = 120, H = 36, P = 3;
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('class', 'rating-spark');
    svg.setAttribute('aria-hidden', 'true');
    const min = Math.min(...vals), max = Math.max(...vals);
    const span = Math.max(1, max - min);
    const xy = vals.map((v, i) => [
      P + (vals.length === 1 ? W - 2 * P : (i / (vals.length - 1)) * (W - 2 * P)),
      H - P - ((v - min) / span) * (H - 2 * P),
    ]);
    const line = document.createElementNS(ns, 'polyline');
    line.setAttribute('points', xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '));
    line.setAttribute('class', 'spark-line');
    const dot = document.createElementNS(ns, 'circle');
    const [lx, ly] = xy[xy.length - 1];
    dot.setAttribute('cx', lx.toFixed(1)); dot.setAttribute('cy', ly.toFixed(1)); dot.setAttribute('r', '3');
    dot.setAttribute('class', 'spark-dot');
    svg.append(line, dot);
    return svg;
  }

  function scoreBlock(label, value, accentText, sub) {
    const box = el('div', 'score');
    box.appendChild(el('div', 'rating-label', label));
    const v = el('div', 'rating-value');
    v.appendChild(el('strong', '', value));
    if (accentText) v.appendChild(el('span', 'rating-title', accentText));
    box.appendChild(v);
    box.appendChild(el('p', 'rating-sub', sub));
    return box;
  }

  function render(container) {
    container.innerHTML = '';

    // Attention
    const a = current();
    let aSub;
    if (!a.odd) aSub = 'Turn on “Catch the odd word” to measure it.';
    else {
      aSub = `Caught ${Math.round(a.rate * 100)}% of your last ${a.odd} odd word${a.odd === 1 ? '' : 's'}`;
      const nextT = TITLES.find(([min]) => min > a.r);
      if (nextT) aSub += ` · ${nextT[0] - a.r} to ${nextT[1]}`;
    }
    const att = scoreBlock('Attention', a.odd ? String(a.r) : '—', a.odd ? a.title : '', aSub);
    if (state.history.length > 1) att.appendChild(sparkline(state.history.slice(-40).map(h => h.r)));
    container.appendChild(att);

    // Memory
    const m = memStats();
    const mSub = m.n
      ? `Remembered ${Math.round(m.rate * 100)}% of your last ${m.n} memory check${m.n === 1 ? '' : 's'}`
      : 'Turn on “Memory check” to measure it.';
    container.appendChild(scoreBlock('Memory', m.n ? String(m.r) : '—', '', mSub));

    // Consistency
    const c = window.Habits && window.Habits.consistency ? window.Habits.consistency() : { score: 0, practiceDays: 0 };
    const cSub = c.practiceDays
      ? `${c.practiceDays} goal day${c.practiceDays === 1 ? '' : 's'} · builds with every day you hit your goal, fades slowly when you don't`
      : 'Hit your daily goal to start building it.';
    const con = scoreBlock('Consistency', String(c.score), '/ 100', cSub);
    const bar = el('div', 'consistency-bar');
    bar.style.setProperty('--pct', `${c.score}%`);
    con.appendChild(bar);
    container.appendChild(con);
  }

  window.Rating = { hit, miss, falseTap, endPassage, current, render };
  window.Memory = { record: memRecord, current: memStats };
})();
