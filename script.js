(function () {
  const inputText = document.getElementById('inputText');
  const wpmSlider = document.getElementById('wpm');
  const chunkSlider = document.getElementById('chunkSize');
  const wpmVal = document.getElementById('wpmVal');
  const chunkVal = document.getElementById('chunkVal');
  const wordCountEl = document.getElementById('wordCount');
  const estTimeEl = document.getElementById('estTime');
  const goBtn = document.getElementById('goBtn');
  const sampleBtn = document.getElementById('sampleBtn');
  const clearBtn = document.getElementById('clearBtn');
  const wpmPresets = document.getElementById('wpmPresets');
  const presetBtns = Array.from(wpmPresets.querySelectorAll('.preset-btn'));

  const setupPanel = document.getElementById('setup');
  const stagePanel = document.getElementById('stage');
  const reader = document.getElementById('reader');
  const progressFill = document.getElementById('progressFill');
  const playPauseBtn = document.getElementById('playPauseBtn');
  const restartBtn = document.getElementById('restartBtn');
  const backBtn = document.getElementById('backBtn');
  const fullscreenBtn = document.getElementById('fullscreenBtn');
  const liveWpm = document.getElementById('liveWpm');
  const chunkPos = document.getElementById('chunkPos');

  const SAMPLE = `Attention is the scarcest resource of the information age, not because there is too little of it, but because everything around us has been engineered to fracture it. The average reader's eyes no longer move smoothly across a line of text; they jump, stall, and drift toward the next notification before a paragraph finishes making its point. Speed reading systems exist to fight exactly this drift by imposing an external rhythm on an internal process that has become erratic.

The classic technique, rapid serial visual presentation, flashes one word at a time in a fixed spot so the eyes never have to move at all. That approach is powerful but exhausting, because it strips away the peripheral context that normally helps a reader anticipate what comes next. A gentler variant keeps the full passage visible and instead moves a highlight across it, chunk by chunk, at a pace the reader chooses in advance. The eyes still get guided, but they retain the surrounding sentence as a map, which reduces the feeling of being force fed language one syllable at a time.

Chunking matters as much as raw speed. Reading three or four words together, rather than one, mirrors how skilled readers already process text: in short saccades and fixations rather than a strict linear scan. Grouping words into small clusters and highlighting a cluster at a time can therefore feel more natural than a single flashing word, especially at moderate speeds. The right chunk size depends on the reader and the material; technical prose usually wants smaller chunks, while narrative prose tolerates larger ones.

The goal of a tool like this is not to turn every reader into a machine that consumes text as fast as physically possible. It is to rebuild a muscle that constant interruption has allowed to atrophy: the ability to hold sustained visual and cognitive attention on a single unbroken stream of language for a few uninterrupted minutes. If the pacing works, the reader finishes a passage having actually read it, rather than having scanned it while thinking about something else entirely.`;

  let words = [];        // array of {text, trail} for each raw word token
  let chunks = [];        // array of [startIdx, endIdx] inclusive ranges into words
  let chunkDurations = []; // ms per chunk
  let currentChunk = 0;
  let playing = false;
  let timer = null;
  let chunkStartTime = 0;
  let currentDuration = 0;
  let pausedRemaining = null; // ms left in the in-progress chunk, or null to start fresh
  let highlightBoxes = []; // pool of floating highlight divs, reused across chunks

  function updateWpmLabel() { wpmVal.textContent = wpmSlider.value; }
  function updateChunkLabel() { chunkVal.textContent = chunkSlider.value; }
  function updatePresetActiveState() {
    presetBtns.forEach(b => b.classList.toggle('active', b.dataset.wpm === wpmSlider.value));
  }

  function tokenize(text) {
    // split keeping trailing whitespace/punctuation attached to each word
    const matches = text.match(/\S+\s*/g) || [];
    return matches.map(m => {
      const trimmed = m.trimEnd();
      const trail = m.slice(trimmed.length);
      return { text: trimmed, trail: trail || ' ' };
    });
  }

  function updateCounts() {
    const w = tokenize(inputText.value);
    wordCountEl.textContent = `${w.length} words`;
    const wpm = parseInt(wpmSlider.value, 10);
    const mins = w.length / wpm;
    const totalSec = Math.round(mins * 60);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    estTimeEl.textContent = `~${m}:${s.toString().padStart(2, '0')}`;
  }

  wpmSlider.addEventListener('input', () => { updateWpmLabel(); updateCounts(); updatePresetActiveState(); });
  chunkSlider.addEventListener('input', () => { updateChunkLabel(); updateCounts(); });
  inputText.addEventListener('input', updateCounts);
  sampleBtn.addEventListener('click', () => { inputText.value = SAMPLE; updateCounts(); });
  clearBtn.addEventListener('click', () => { inputText.value = ''; updateCounts(); inputText.focus(); });

  presetBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      wpmSlider.value = btn.dataset.wpm;
      updateWpmLabel();
      updateCounts();
      updatePresetActiveState();
    });
  });

  function buildChunks() {
    words = tokenize(inputText.value);
    const size = parseInt(chunkSlider.value, 10);
    const wpm = parseInt(wpmSlider.value, 10);
    const baseMsPerWord = 60000 / wpm;

    chunks = [];
    chunkDurations = [];
    for (let i = 0; i < words.length; i += size) {
      const end = Math.min(i + size - 1, words.length - 1);
      chunks.push([i, end]);
      let dur = 0;
      for (let j = i; j <= end; j++) dur += baseMsPerWord;
      // small natural pause on sentence-ending punctuation
      const lastWord = words[end].text;
      if (/[.!?]["')\]]?$/.test(lastWord)) dur += baseMsPerWord * 1.4;
      else if (/[,;:]["')\]]?$/.test(lastWord)) dur += baseMsPerWord * 0.6;
      chunkDurations.push(dur);
    }
  }

  function renderReader() {
    reader.innerHTML = '';
    highlightBoxes = [];
    const frag = document.createDocumentFragment();
    words.forEach((w, idx) => {
      const span = document.createElement('span');
      span.className = 'word';
      span.dataset.idx = idx;
      span.textContent = w.text + w.trail;
      frag.appendChild(span);
    });
    reader.appendChild(frag);
  }

  function getHighlightBox(i) {
    if (!highlightBoxes[i]) {
      const box = document.createElement('div');
      box.className = 'highlight-box';
      box.dataset.active = '0';
      reader.appendChild(box);
      highlightBoxes[i] = box;
    }
    return highlightBoxes[i];
  }

  // Slide (or, for a freshly-activated box, snap) the highlight over the
  // word span range [start, end]. Uses Range.getClientRects() so a chunk
  // that wraps across a line break gets one glowing segment per line,
  // instead of one box stretching across the gap.
  function positionHighlight(start, end) {
    const spans = reader.querySelectorAll('.word');
    const startSpan = spans[start];
    const endSpan = spans[end];
    if (!startSpan || !endSpan) return;

    const range = document.createRange();
    range.setStartBefore(startSpan);
    range.setEndAfter(endSpan);
    const rawRects = Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0);
    const readerRect = reader.getBoundingClientRect();

    // Each word is its own positioned span, so getClientRects() returns one
    // rect per word instead of one per visual line. Merge rects that share
    // a line into a single contiguous box so a multi-word chunk highlights
    // as one unbroken bar instead of several separate/gapped boxes.
    const lines = [];
    rawRects.forEach(r => {
      const line = lines.find(l => Math.abs(l.top - r.top) < 2);
      if (line) {
        line.left = Math.min(line.left, r.left);
        line.right = Math.max(line.right, r.right);
        line.top = Math.min(line.top, r.top);
        line.bottom = Math.max(line.bottom, r.bottom);
      } else {
        lines.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
      }
    });

    lines.forEach((l, i) => {
      const box = getHighlightBox(i);
      const left = l.left - readerRect.left + reader.scrollLeft - 2;
      const top = l.top - readerRect.top + reader.scrollTop - 1;
      const width = Math.max(0, (l.right - l.left) - 1);
      const height = (l.bottom - l.top) + 2;

      if (box.dataset.active !== '1') {
        // Reactivating a hidden box: place it instantly, no slide-in from
        // its stale last position.
        box.classList.add('snap');
        box.style.left = `${left}px`;
        box.style.top = `${top}px`;
        box.style.width = `${width}px`;
        box.style.height = `${height}px`;
        void box.offsetWidth; // force reflow so the snap applies before we remove it
        box.classList.remove('snap');
      } else {
        box.style.left = `${left}px`;
        box.style.top = `${top}px`;
        box.style.width = `${width}px`;
        box.style.height = `${height}px`;
      }
      box.style.opacity = '1';
      box.dataset.active = '1';
    });

    // Hide any pool boxes left over from a wider chunk.
    for (let i = lines.length; i < highlightBoxes.length; i++) {
      highlightBoxes[i].style.opacity = '0';
      highlightBoxes[i].dataset.active = '0';
    }
  }

  function highlightChunk(idx) {
    const [start, end] = chunks[idx];
    const spans = reader.querySelectorAll('.word');
    spans.forEach((s, i) => {
      s.classList.remove('current', 'read');
      if (i < start) s.classList.add('read');
      else if (i >= start && i <= end) s.classList.add('current');
    });
    positionHighlight(start, end);
    const firstCurrent = reader.querySelector('.word.current');
    if (firstCurrent) firstCurrent.scrollIntoView({ block: 'center', behavior: 'smooth' });

    progressFill.style.width = `${Math.round(((idx + 1) / chunks.length) * 100)}%`;
    chunkPos.textContent = `${idx + 1} / ${chunks.length}`;
  }

  function showAndSchedule() {
    highlightChunk(currentChunk);
    const dur = pausedRemaining != null ? pausedRemaining : chunkDurations[currentChunk];
    pausedRemaining = null;
    currentDuration = dur;
    chunkStartTime = performance.now();
    timer = setTimeout(() => {
      currentChunk++;
      if (currentChunk >= chunks.length) {
        playing = false;
        playPauseBtn.textContent = 'Restart';
        backBtn.hidden = false;
        return;
      }
      if (playing) showAndSchedule();
    }, dur);
  }

  function play() {
    if (currentChunk >= chunks.length) {
      currentChunk = 0;
      pausedRemaining = null;
    }
    playing = true;
    playPauseBtn.textContent = 'Pause';
    backBtn.hidden = true;
    showAndSchedule();
  }

  function pause() {
    playing = false;
    playPauseBtn.textContent = 'Play';
    backBtn.hidden = false;
    clearTimeout(timer);
    const elapsed = performance.now() - chunkStartTime;
    pausedRemaining = Math.max(50, currentDuration - elapsed);
  }

  function seek(delta) {
    clearTimeout(timer);
    currentChunk = Math.max(0, Math.min(chunks.length - 1, currentChunk + delta));
    pausedRemaining = null;
    highlightChunk(currentChunk);
    if (playing) showAndSchedule();
  }

  function startSession() {
    if (!inputText.value.trim()) return;
    buildChunks();
    if (chunks.length === 0) return;
    renderReader();
    currentChunk = 0;
    pausedRemaining = null;
    liveWpm.textContent = `${wpmSlider.value} wpm`;
    setupPanel.style.display = 'none';
    stagePanel.classList.add('active');
    play();
  }

  goBtn.addEventListener('click', startSession);

  playPauseBtn.addEventListener('click', () => {
    if (playPauseBtn.textContent === 'Restart') {
      currentChunk = 0;
      pausedRemaining = null;
      play();
    } else if (playing) {
      pause();
    } else {
      play();
    }
  });

  restartBtn.addEventListener('click', () => {
    clearTimeout(timer);
    currentChunk = 0;
    pausedRemaining = null;
    play();
  });

  backBtn.addEventListener('click', () => {
    clearTimeout(timer);
    playing = false;
    stagePanel.classList.remove('active');
    setupPanel.style.display = 'block';
  });

  // ---- Books (.epub / .txt): only one ~1000-word passage is loaded into the reader at a time ----
  const bookBar = document.getElementById('bookBar');
  const bookTitle = document.getElementById('bookTitle');
  const partSelect = document.getElementById('partSelect');
  const prevPartBtn = document.getElementById('prevPartBtn');
  const nextPartBtn = document.getElementById('nextPartBtn');
  const openBookBtn = document.getElementById('openBookBtn');
  const bookFile = document.getElementById('bookFile');
  const bookStatus = document.getElementById('bookStatus');
  const nextPassageBtn = document.getElementById('nextPassageBtn');

  let book = null; // { title, parts: [{ chapter, label, text, words }] }

  const positionKey = title => `rereader:pos:${title}`;
  function savePosition(idx) {
    try { localStorage.setItem(positionKey(book.title), String(idx)); } catch (e) {}
  }
  function loadPosition() {
    try {
      const n = parseInt(localStorage.getItem(positionKey(book.title)), 10);
      return Number.isInteger(n) && n >= 0 && n < book.parts.length ? n : null;
    } catch (e) { return null; }
  }

  function setStatus(msg, isError) {
    bookStatus.hidden = !msg;
    bookStatus.textContent = msg || '';
    bookStatus.classList.toggle('error', !!isError);
  }

  function showPart(idx) {
    if (!book) return;
    idx = Math.max(0, Math.min(book.parts.length - 1, idx));
    partSelect.value = String(idx);
    inputText.value = book.parts[idx].text;
    prevPartBtn.disabled = idx === 0;
    nextPartBtn.disabled = idx === book.parts.length - 1;
    nextPassageBtn.hidden = idx === book.parts.length - 1;
    savePosition(idx);
    updateCounts();
  }

  function populateParts() {
    partSelect.innerHTML = '';
    let group = null, lastChapter = null;
    book.parts.forEach((part, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = `${part.label} (${part.words} words)`;
      // group passages under their chapter when a chapter has several
      if (part.chapter && part.label !== part.chapter) {
        if (part.chapter !== lastChapter) {
          group = document.createElement('optgroup');
          group.label = part.chapter;
          partSelect.appendChild(group);
        }
        opt.textContent = `${part.label.slice(part.chapter.length + 3)} (${part.words} words)`;
        group.appendChild(opt);
      } else {
        group = null;
        partSelect.appendChild(opt);
      }
      lastChapter = part.chapter;
    });
  }

  openBookBtn.addEventListener('click', () => bookFile.click());

  bookFile.addEventListener('change', async () => {
    const file = bookFile.files[0];
    bookFile.value = '';
    if (!file) return;
    openBookBtn.disabled = true;
    setStatus(`Reading ${file.name}…`);
    try {
      book = await window.Book.load(file);
      bookTitle.textContent = book.title;
      populateParts();
      bookBar.hidden = false;
      const saved = loadPosition();
      showPart(saved !== null ? saved : book.start);
      setStatus(`${book.parts.length} passages found${saved !== null ? ' — resuming where you left off' : ''}.`);
    } catch (err) {
      setStatus(err.message || 'Could not read that file.', true);
    } finally {
      openBookBtn.disabled = false;
    }
  });

  partSelect.addEventListener('change', () => showPart(parseInt(partSelect.value, 10)));
  prevPartBtn.addEventListener('click', () => showPart(parseInt(partSelect.value, 10) - 1));
  nextPartBtn.addEventListener('click', () => showPart(parseInt(partSelect.value, 10) + 1));

  nextPassageBtn.addEventListener('click', () => {
    if (!book) return;
    clearTimeout(timer);
    playing = false;
    showPart(parseInt(partSelect.value, 10) + 1);
    startSession();
  });

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      const request = stagePanel.requestFullscreen || stagePanel.webkitRequestFullscreen;
      if (request) request.call(stagePanel).catch(() => {});
    } else if (document.exitFullscreen) {
      document.exitFullscreen();
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    }
  }

  fullscreenBtn.addEventListener('click', toggleFullscreen);

  document.addEventListener('fullscreenchange', () => {
    fullscreenBtn.textContent = document.fullscreenElement === stagePanel ? 'Exit full screen' : 'Full screen';
    // Font size and layout change between windowed/full screen, so the
    // sliding highlight needs an instant (non-sliding) reposition.
    if (chunks.length) {
      const [start, end] = chunks[currentChunk];
      highlightBoxes.forEach(b => b.dataset.active = '0');
      positionHighlight(start, end);
    }
  });

  window.addEventListener('resize', () => {
    if (!stagePanel.classList.contains('active') || !chunks.length) return;
    const [start, end] = chunks[currentChunk];
    highlightBoxes.forEach(b => b.dataset.active = '0'); // force instant reposition, no slide
    positionHighlight(start, end);
  });

  document.addEventListener('keydown', (e) => {
    if (!stagePanel.classList.contains('active')) return;
    if (e.code === 'Space') {
      e.preventDefault();
      playPauseBtn.click();
    } else if (e.code === 'ArrowRight') {
      seek(1);
    } else if (e.code === 'ArrowLeft') {
      seek(-1);
    } else if (e.code === 'F4') {
      e.preventDefault();
      toggleFullscreen();
    }
  });

  updateWpmLabel();
  updateChunkLabel();
  updateCounts();
  updatePresetActiveState();
})();
