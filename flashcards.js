// Flash cards: capture text while reading, blank words out, review with Forgot / Remembered.
//
// Card text marks the blank with double brackets: "She hid the letter inside the [[piano]]."
// Each card has exactly one blank: blanking 3 words in the editor saves 3 cards, one per word.
// Scheduling (a pared-down Anki):
//   Remembered -> next interval = 1 day for a new/lapsed card, otherwise interval x ease (2.5 to start)
//   Forgot     -> back to the end of today's review, interval reset, card gets a little harder
// Stored in this browser's localStorage; "Export for Anki" downloads a cloze file Anki can import.
//
// Exposes window.Flashcards.{init, renderLanding}.
(function () {
  const KEY = 'rereader:cards';
  const DAY = 86400000;
  const START_EASE = 2.5, MIN_EASE = 1.3;

  // ---------- storage ----------
  let cards = load();
  function load() {
    let c = [];
    try { const parsed = JSON.parse(localStorage.getItem(KEY)); if (Array.isArray(parsed)) c = parsed; } catch (e) {}
    // older cards could hold several blanks: split them into one card per blank
    const out = [];
    let changed = false;
    for (const card of c) {
      const parts = splitBlanks(card.text);
      if (parts.length <= 1) { out.push(card); continue; }
      changed = true;
      parts.forEach((text, i) => out.push(i === 0 ? { ...card, text } : { ...card, text, id: card.id + '-' + i }));
    }
    if (changed) { try { localStorage.setItem(KEY, JSON.stringify(out)); } catch (e) {} }
    return out;
  }

  // "a [[b]] c [[d]]" -> ["a [[b]] c d", "a b c [[d]]"]: one text per blank, others shown as plain words
  function splitBlanks(text) {
    const re = /\[\[([^\]]+)\]\]/g;
    const n = (text.match(re) || []).length;
    if (n <= 1) return [text];
    return Array.from({ length: n }, (_, keep) => {
      let i = 0;
      return text.replace(re, (m, word) => (i++ === keep ? m : word));
    });
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(cards)); return true; } catch (e) { return false; }
  }

  const startOfDay = t => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  const isDue = c => c.due <= Date.now();
  const dueCards = () => cards.filter(isDue).sort((a, b) => a.due - b.due);
  const hasBlank = text => /\[\[[^\]]+\]\]/.test(text);

  function addCard(text, source) {
    cards.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      text, source, created: Date.now(),
      due: Date.now(), interval: 0, ease: START_EASE, reps: 0, lapses: 0,
    });
    save();
  }

  function grade(card, remembered) {
    card.reps++;
    if (remembered) {
      card.interval = card.interval < 1 ? 1 : Math.max(card.interval + 1, Math.round(card.interval * card.ease));
      card.due = startOfDay(Date.now()) + card.interval * DAY; // due from the start of that day
    } else {
      card.lapses++;
      card.interval = 0;
      card.ease = Math.max(MIN_EASE, card.ease - 0.2);
      card.due = Date.now();
    }
    save();
  }

  // ---------- text <-> tokens ----------
  // tokens: { type: 'space' | 'word' | 'blank', text }
  function tokenize(text) {
    const out = [];
    const re = /\[\[([^\]]+)\]\]|(\s+)|([^\s[]+|\[)/g;
    let m;
    while ((m = re.exec(text))) {
      if (m[1] != null) out.push({ type: 'blank', text: m[1] });
      else if (m[2] != null) out.push({ type: 'space', text: m[2] });
      else out.push({ type: 'word', text: m[3] });
    }
    return out;
  }
  const untokenize = toks => toks.map(t => (t.type === 'blank' ? `[[${t.text}]]` : t.text)).join('');

  // Render card text into el. hidden: show blanks as gaps; otherwise show the answers highlighted.
  function renderText(el, text, hidden, onToggle) {
    el.textContent = '';
    const toks = tokenize(text);
    toks.forEach((t, i) => {
      if (t.type === 'space') { el.appendChild(document.createTextNode(t.text)); return; }
      const span = document.createElement('span');
      if (t.type === 'blank') {
        span.className = 'fc-blank' + (hidden ? '' : ' shown');
        span.textContent = hidden ? ' '.repeat(6) : t.text;
      } else {
        span.textContent = t.text;
      }
      if (onToggle) {
        span.classList.add('fc-tap');
        span.addEventListener('click', () => onToggle(toks, i));
      }
      el.appendChild(span);
    });
  }

  // Toggle a word in or out of a blank, keeping punctuation outside: "piano," -> "[[piano]],"
  function toggleToken(toks, i) {
    const t = toks[i];
    if (t.type === 'blank') {
      t.type = 'word';
    } else {
      const m = t.text.match(/^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u);
      if (!m || !m[2]) return untokenize(toks);
      toks.splice(i, 1,
        ...(m[1] ? [{ type: 'word', text: m[1] }] : []),
        { type: 'blank', text: m[2] },
        ...(m[3] ? [{ type: 'word', text: m[3] }] : []));
    }
    return untokenize(toks);
  }

  // ---------- DOM ----------
  const $ = id => document.getElementById(id);
  let opts = null;

  // editor
  const dialog = $('cardDialog');
  const dialogTitle = $('cardDialogTitle');
  const textArea = $('cardText');
  const preview = $('cardPreview');
  const sourceEl = $('cardSource');
  const saveBtn = $('cardSave');
  const deleteBtn = $('cardDelete');
  const saveHint = $('cardSaveHint');
  let editing = null;       // card being edited, or null for a new one
  let draftSource = '';

  function refreshPreview() {
    renderText(preview, textArea.value, false, (toks, i) => {
      textArea.value = toggleToken(toks, i);
      refreshPreview();
    });
    const ok = hasBlank(textArea.value);
    const n = ok ? splitBlanks(textArea.value).length : 0;
    saveBtn.disabled = !ok;
    saveBtn.textContent = n > 1 ? `Save ${n} cards` : 'Save card';
    saveHint.hidden = ok;
  }
  textArea.addEventListener('input', refreshPreview);

  function openEditor(text, source, card) {
    editing = card || null;
    draftSource = source;
    dialogTitle.textContent = card ? 'Edit flash card' : 'New flash card';
    textArea.value = text;
    sourceEl.textContent = source ? `From ${source}` : '';
    deleteBtn.hidden = !card;
    refreshPreview();
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
  }
  function closeEditor() {
    if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open');
  }

  saveBtn.addEventListener('click', () => {
    const text = textArea.value.trim();
    if (!hasBlank(text)) return;
    const parts = splitBlanks(text);
    if (editing) {
      // the edited card keeps its schedule for the first blank; any extra blanks become new cards
      editing.text = parts[0];
      parts.slice(1).forEach(t => addCard(t, editing.source));
      save();
    } else {
      parts.forEach(t => addCard(t, draftSource));
    }
    closeEditor();
    if (opts && opts.toast) {
      opts.toast(parts.length > 1 ? `🃏 ${parts.length} flash cards saved` : editing ? 'Card updated' : '🃏 Flash card saved');
    }
    afterChange();
  });
  $('cardCancel').addEventListener('click', closeEditor);
  deleteBtn.addEventListener('click', () => {
    if (!editing || !confirm('Delete this flash card?')) return;
    cards = cards.filter(c => c !== editing);
    save();
    closeEditor();
    afterChange();
  });

  // capture button over the reader
  const captureBtn = $('cardCapture');
  let captured = null; // { text }

  function selectionInReader() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!opts.reader.contains(range.commonAncestorContainer)) return null;
    const wordOf = node => (node.nodeType === 1 ? node : node.parentElement).closest('.word');
    const a = wordOf(range.startContainer), b = wordOf(range.endContainer);
    if (!a || !b) return null;
    const ia = +a.dataset.idx, ib = +b.dataset.idx;
    const from = Math.min(ia, ib), to = Math.max(ia, ib);
    const spans = opts.reader.querySelectorAll('.word');
    let text = '';
    for (let i = from; i <= to; i++) if (spans[i] && !spans[i].dataset.odd) text += spans[i].textContent;
    text = text.replace(/\s+/g, ' ').trim();
    return text ? { text, rect: range.getBoundingClientRect() } : null;
  }

  function updateCapture() {
    const s = selectionInReader();
    if (!s) { captureBtn.hidden = true; captured = null; return; }
    if (opts.onSelect) opts.onSelect(); // pause reading
    captured = s;
    const host = opts.stage.getBoundingClientRect();
    captureBtn.hidden = false;
    const w = captureBtn.offsetWidth;
    const left = Math.min(Math.max(8, s.rect.left - host.left + s.rect.width / 2 - w / 2), host.width - w - 8);
    // below the selection, where phones' own copy/paste menus don't usually sit
    captureBtn.style.left = `${left}px`;
    captureBtn.style.top = `${s.rect.bottom - host.top + 10}px`;
  }
  let selTimer = null;
  document.addEventListener('selectionchange', () => {
    clearTimeout(selTimer);
    selTimer = setTimeout(updateCapture, 120);
  });

  captureBtn.addEventListener('mousedown', e => e.preventDefault()); // keep the selection alive on desktop
  captureBtn.addEventListener('click', () => {
    if (!captured) return;
    const text = captured.text;
    captureBtn.hidden = true;
    window.getSelection().removeAllRanges();
    openEditor(text, opts.getSource ? opts.getSource() : '');
  });

  // ---------- landing card ----------
  function renderLanding() {
    const card = $('cardsCard');
    if (!cards.length) { card.hidden = true; return; }
    card.hidden = false;
    const due = dueCards().length;
    $('cardsStats').textContent = due
      ? `${due} due · ${cards.length} total`
      : `All caught up · ${cards.length} card${cards.length === 1 ? '' : 's'}`;
    $('reviewBtn').disabled = !due;
  }

  // ---------- review screen ----------
  const reviewBody = $('reviewBody');
  const browseBody = $('browseBody');
  const reviewCount = $('reviewCount');
  let queue = [];
  let current = null;
  let revealed = false;
  let mode = 'review'; // 'review' | 'browse'

  const btn = (label, cls, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    if (cls) b.className = cls;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  };

  function startReview() {
    mode = 'review';
    queue = dueCards();
    opts.showView('review');
    reviewBody.hidden = false;
    browseBody.hidden = true;
    nextCard();
  }

  function nextCard() {
    current = queue.shift() || null;
    revealed = false;
    drawReview();
  }

  function drawReview() {
    reviewBody.textContent = '';
    reviewCount.textContent = current ? `${queue.length + 1} left` : '';
    if (!current) {
      const done = document.createElement('div');
      done.className = 'fc-done';
      const upcoming = cards.filter(c => !isDue(c)).sort((a, b) => a.due - b.due)[0];
      const when = upcoming ? new Date(upcoming.due).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }) : null;
      done.append(
        Object.assign(document.createElement('p'), { className: 'fc-done-title', textContent: 'All done 🎉' }),
        Object.assign(document.createElement('p'), { className: 'fc-done-sub', textContent: when ? `Next card due ${when}.` : 'No cards scheduled.' }),
      );
      const row = document.createElement('div');
      row.className = 'fc-actions';
      row.append(btn('Back home', 'primary', () => opts.showView('landing')), btn('Browse cards', 'ghost', startBrowse));
      done.appendChild(row);
      reviewBody.appendChild(done);
      return;
    }
    const text = document.createElement('p');
    text.className = 'fc-text';
    renderText(text, current.text, !revealed);
    const src = document.createElement('p');
    src.className = 'fc-source';
    src.textContent = current.source || '';
    const row = document.createElement('div');
    row.className = 'fc-actions';
    if (!revealed) {
      row.append(btn('Reveal', 'primary fc-wide', reveal));
    } else {
      row.append(
        btn('✗ Forgot', 'fc-forgot', () => answer(false)),
        btn('✓ Remembered', 'primary', () => answer(true)),
      );
    }
    const edit = btn('Edit', 'ghost fc-edit', () => openEditor(current.text, current.source, current));
    reviewBody.append(text, src, row, edit);
    const first = row.querySelector('button.primary');
    if (first) first.focus();
  }

  function reveal() { revealed = true; drawReview(); }

  function answer(remembered) {
    grade(current, remembered);
    if (!remembered) queue.push(current); // see it again before the session ends
    nextCard();
  }

  // ---------- browse ----------
  function startBrowse() {
    mode = 'browse';
    opts.showView('review');
    reviewBody.hidden = true;
    browseBody.hidden = false;
    drawBrowse();
  }

  function drawBrowse() {
    browseBody.textContent = '';
    reviewCount.textContent = `${cards.length} card${cards.length === 1 ? '' : 's'}`;
    const top = document.createElement('div');
    top.className = 'fc-actions';
    if (dueCards().length) top.append(btn(`Review ${dueCards().length} due`, 'primary', startReview));
    top.append(btn('Export for Anki', 'ghost', exportAnki));
    browseBody.appendChild(top);

    const list = document.createElement('ul');
    list.className = 'fc-list';
    [...cards].sort((a, b) => b.created - a.created).forEach(c => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'fc-item';
      const t = document.createElement('span');
      t.className = 'fc-item-text';
      renderText(t, c.text, false);
      const meta = document.createElement('span');
      meta.className = 'fc-item-meta';
      const dueTxt = isDue(c) ? 'Due now' : `Due ${new Date(c.due).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
      meta.textContent = [dueTxt, c.source].filter(Boolean).join(' · ');
      b.append(t, meta);
      b.addEventListener('click', () => openEditor(c.text, c.source, c));
      li.appendChild(b);
      list.appendChild(li);
    });
    browseBody.appendChild(list);
  }

  // Anki: File > Import, picks up the Cloze note type from the header lines.
  function exportAnki() {
    const clean = s => s.replace(/[\t\r\n]+/g, ' ');
    const lines = ['#separator:tab', '#html:false', '#notetype:Cloze', '#columns:Text\tBack Extra'];
    for (const c of cards) lines.push(`${clean(c.text).replace(/\[\[([^\]]+)\]\]/g, '{{c1::$1}}')}\t${clean(c.source || '')}`);
    const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'rereader-flashcards.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // redraw whatever is on screen after a card is added, edited or deleted
  function afterChange() {
    renderLanding();
    if (opts.isReviewVisible()) {
      if (mode === 'browse') drawBrowse();
      else {
        if (current && !cards.includes(current)) nextCard();
        else drawReview();
      }
    }
  }

  // keyboard on the review screen
  document.addEventListener('keydown', e => {
    if (!opts || !opts.isReviewVisible() || mode !== 'review' || !current) return;
    if (e.target.closest('input, textarea, select, dialog')) return;
    if (!revealed && (e.code === 'Space' || e.code === 'Enter')) { e.preventDefault(); reveal(); }
    else if (revealed && (e.code === 'ArrowLeft' || e.code === 'KeyF')) answer(false);
    else if (revealed && (e.code === 'ArrowRight' || e.code === 'KeyR')) answer(true);
  });

  // opts: { reader, stage, showView(name), isReviewVisible(), getSource(), onSelect(), toast(msg) }
  function init(o) {
    opts = o;
    $('reviewBtn').addEventListener('click', startReview);
    $('browseBtn').addEventListener('click', startBrowse);
    $('reviewHome').addEventListener('click', () => opts.showView('landing'));
    renderLanding();
  }

  window.Flashcards = { init, renderLanding };
})();
