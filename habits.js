// Reading habits: daily goal, streak (with one rest day per 7 days) and a calendar heatmap.
// Everything is stored in this browser's localStorage under one key.
// Exposes window.Habits.{record, render, onGoalReached}.
(function () {
  const KEY = 'rereader:habits';
  const GOAL_OPTIONS = [5, 10, 15, 20, 30, 45, 60]; // minutes per day
  const DAY_MS = 86400000;

  // state = { goalMin, best, days: { 'YYYY-MM-DD': { ms, words } } }
  let state = load();
  const goalListeners = [];

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY));
      if (s && s.days) return { goalMin: 15, best: 0, ...s };
    } catch (e) {}
    return { goalMin: 15, best: 0, days: {} };
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
  }

  const pad = n => String(n).padStart(2, '0');
  const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const daysBetween = (a, b) => Math.round((startOfDay(a) - startOfDay(b)) / DAY_MS);

  const minutesOn = d => { const r = state.days[dayKey(d)]; return r ? r.ms / 60000 : 0; };
  const goalMetOn = d => minutesOn(d) >= state.goalMin;

  // Count consecutive goal days back from today. Today doesn't break the streak while it's
  // still in progress, and one missed day in any 7-day window is forgiven as a rest day.
  function computeStreak() {
    const today = startOfDay(new Date());
    let d = goalMetOn(today) ? today : addDays(today, -1);
    let count = 0, lastRest = null, pendingRest = null;
    for (let i = 0; i < 3660; i++, d = addDays(d, -1)) {
      if (goalMetOn(d)) {
        count++;
        // a missed day only becomes a rest day once there's a goal day before it
        if (pendingRest) { lastRest = pendingRest; pendingRest = null; }
        continue;
      }
      if (!pendingRest && (lastRest === null || daysBetween(lastRest, d) >= 7)) { pendingRest = d; continue; }
      break;
    }
    if (count > state.best) { state.best = count; save(); }
    const restUsedRecently = lastRest && daysBetween(today, lastRest) < 7;
    return {
      count,
      best: state.best,
      todayDone: goalMetOn(today),
      restUsed: !!restUsedRecently,
      restFreeOn: restUsedRecently ? addDays(lastRest, 7) : null,
    };
  }

  // Consistency (0-100): long-run proof of practice, separate from the streak.
  // Every day you hit your goal adds 1 day of credit; every day you don't drains 1/3 of a day,
  // so a missed day costs a little and a long break slowly erodes it. Credit turns into a score
  // with diminishing returns: 7 days -> 41, 30 days -> 75, 90 days -> 90.
  const CREDIT_HALF = 10;     // credit (in days) at which the score reaches 50
  const DRAIN_PER_DAY = 1 / 3;
  function consistency() {
    const goalDays = Object.keys(state.days).filter(k => state.days[k].ms / 60000 >= state.goalMin).sort();
    if (!goalDays.length) return { score: 0, credit: 0, practiceDays: 0 };
    const [y, m, dd] = goalDays[0].split('-').map(Number);
    const today = startOfDay(new Date());
    let credit = 0, practiceDays = 0;
    for (let d = new Date(y, m - 1, dd); d <= today; d = addDays(d, 1)) {
      if (goalMetOn(d)) { credit += 1; practiceDays++; }
      else if (+d !== +today) credit = Math.max(0, credit - DRAIN_PER_DAY); // today isn't over yet
    }
    return { score: Math.round(100 * credit / (credit + CREDIT_HALF)), credit, practiceDays };
  }

  // Called by the reader with time actually spent playing (ms) and words completed.
  function record(ms, words) {
    if (!(ms > 0) && !(words > 0)) return;
    const key = dayKey(new Date());
    const rec = state.days[key] || (state.days[key] = { ms: 0, words: 0 });
    const before = rec.ms / 60000;
    rec.ms += Math.max(0, ms || 0);
    rec.words += Math.max(0, words || 0);
    save();
    if (before < state.goalMin && rec.ms / 60000 >= state.goalMin) {
      const s = computeStreak();
      goalListeners.forEach(fn => { try { fn(s); } catch (e) {} });
    }
  }

  function fmtMinutes(min) {
    const m = Math.floor(min);
    if (m < 60) return `${m} min`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  }

  // ---------- rendering ----------
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  function ring(fraction) {
    const r = 34, c = 2 * Math.PI * r;
    const f = Math.max(0, Math.min(1, fraction));
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 80 80');
    svg.setAttribute('class', 'habit-ring-svg');
    svg.setAttribute('aria-hidden', 'true');
    const track = document.createElementNS(ns, 'circle');
    track.setAttribute('class', 'ring-track');
    const fill = document.createElementNS(ns, 'circle');
    fill.setAttribute('class', 'ring-fill' + (f >= 1 ? ' done' : ''));
    for (const circle of [track, fill]) {
      circle.setAttribute('cx', '40'); circle.setAttribute('cy', '40'); circle.setAttribute('r', String(r));
    }
    fill.setAttribute('stroke-dasharray', `${c * f} ${c}`);
    svg.append(track, fill);
    return svg;
  }

  function heatLevel(min) {
    if (min <= 0) return 0;
    if (min < state.goalMin / 2) return 1;
    if (min < state.goalMin) return 2;
    if (min < state.goalMin * 2) return 3;
    return 4;
  }

  function heatmap(width) {
    const weeks = Math.max(10, Math.min(26, Math.floor((width - 30) / 17)));
    const today = startOfDay(new Date());
    const mondayOffset = (today.getDay() + 6) % 7; // 0 = Monday
    const thisMonday = addDays(today, -mondayOffset);
    const first = addDays(thisMonday, -7 * (weeks - 1));

    const wrap = el('div', 'heatmap');
    wrap.style.setProperty('--weeks', weeks);

    // month labels along the top
    const months = el('div', 'heat-months');
    let lastMonth = -1;
    for (let w = 0; w < weeks; w++) {
      const d = addDays(first, w * 7);
      const label = el('span', '', d.getMonth() !== lastMonth && d.getDate() <= 7
        ? d.toLocaleDateString(undefined, { month: 'short' }) : '');
      if (label.textContent) lastMonth = d.getMonth();
      months.appendChild(label);
    }

    const days = el('div', 'heat-days');
    ['Mon', '', 'Wed', '', 'Fri', '', ''].forEach(t => days.appendChild(el('span', '', t)));

    const grid = el('div', 'heat-grid');
    for (let w = 0; w < weeks; w++) {
      for (let dow = 0; dow < 7; dow++) {
        const d = addDays(first, w * 7 + dow);
        const cell = el('span', 'heat-cell');
        if (d > today) { cell.classList.add('future'); grid.appendChild(cell); continue; }
        const rec = state.days[dayKey(d)];
        const min = rec ? rec.ms / 60000 : 0;
        cell.dataset.level = heatLevel(min);
        if (+d === +today) cell.classList.add('today');
        const label = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
        cell.title = min > 0
          ? `${label}: ${fmtMinutes(min)}, ${rec.words.toLocaleString()} words${min >= state.goalMin ? ' ✓' : ''}`
          : `${label}: no reading`;
        grid.appendChild(cell);
      }
    }

    const legend = el('div', 'heat-legend');
    legend.appendChild(el('span', '', 'Less'));
    for (let i = 0; i <= 4; i++) { const c = el('span', 'heat-cell'); c.dataset.level = i; legend.appendChild(c); }
    legend.appendChild(el('span', '', 'More'));

    wrap.append(months, days, grid, legend);
    return wrap;
  }

  function weekTotals() {
    const today = startOfDay(new Date());
    let ms = 0, words = 0;
    for (let i = 0; i < 7; i++) {
      const r = state.days[dayKey(addDays(today, -i))];
      if (r) { ms += r.ms; words += r.words; }
    }
    return { min: ms / 60000, words };
  }

  function render(container) {
    const s = computeStreak();
    const todayMin = minutesOn(new Date());
    container.innerHTML = '';

    const top = el('div', 'habit-top');

    // goal ring
    const ringBox = el('div', 'habit-ring');
    ringBox.appendChild(ring(todayMin / state.goalMin));
    const ringText = el('div', 'habit-ring-text');
    ringText.appendChild(el('strong', '', s.todayDone ? '✓' : String(Math.floor(todayMin))));
    ringText.appendChild(el('span', '', s.todayDone ? 'done' : `/ ${state.goalMin} min`));
    ringBox.appendChild(ringText);
    ringBox.setAttribute('role', 'img');
    ringBox.setAttribute('aria-label', `Today: ${Math.floor(todayMin)} of ${state.goalMin} minutes`);

    // streak + goal picker
    const info = el('div', 'habit-info');
    const streakLine = el('div', 'habit-streak');
    streakLine.appendChild(el('span', 'habit-flame' + (s.count ? '' : ' cold'), '🔥'));
    streakLine.appendChild(el('strong', '', String(s.count)));
    streakLine.appendChild(el('span', '', ` day streak`));
    info.appendChild(streakLine);

    let sub;
    if (!s.count) sub = `Read ${state.goalMin} minutes today to start a streak.`;
    else if (!s.todayDone) sub = `${Math.max(1, Math.ceil(state.goalMin - todayMin))} min left today to keep it going.`;
    else sub = 'Goal reached today. See you tomorrow!';
    info.appendChild(el('p', 'habit-sub', sub));

    const restText = s.restUsed
      ? `Rest day used · next one ${s.restFreeOn.toLocaleDateString(undefined, { weekday: 'short' })}`
      : 'Rest day available';
    const wk = weekTotals();
    info.appendChild(el('p', 'habit-meta',
      `Best ${s.best} · ${restText} · This week ${fmtMinutes(wk.min)}, ${wk.words.toLocaleString()} words`));

    const goalLabel = el('label', 'habit-goal');
    goalLabel.appendChild(el('span', '', 'Daily goal'));
    const select = el('select');
    GOAL_OPTIONS.forEach(m => {
      const o = el('option', '', `${m} min`);
      o.value = String(m);
      if (m === state.goalMin) o.selected = true;
      select.appendChild(o);
    });
    if (!GOAL_OPTIONS.includes(state.goalMin)) {
      const o = el('option', '', `${state.goalMin} min`); o.value = String(state.goalMin); o.selected = true;
      select.appendChild(o);
    }
    select.addEventListener('change', () => {
      state.goalMin = parseInt(select.value, 10);
      save();
      render(container);
    });
    goalLabel.appendChild(select);
    info.appendChild(goalLabel);

    top.append(ringBox, info);
    container.appendChild(top);
    container.appendChild(heatmap(container.clientWidth || 600));
  }

  window.Habits = {
    consistency,
    record,
    render,
    onGoalReached(fn) { goalListeners.push(fn); },
  };
})();
