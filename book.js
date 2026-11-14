// Book loading: turns an .epub or .txt file into a list of ~1000-word passages.
// Exposes window.Book.load(file) -> Promise<{ title, parts: [{ label, text, words }] }>
(function () {
  const TARGET_WORDS = 1000;   // aim for passages about this long
  const MIN_TAIL_WORDS = 300;  // a trailing passage shorter than this is merged into the previous one
  const MIN_SECTION_WORDS = 150; // spine items shorter than this are treated as front/back matter

  // epub:type values / file names that mark non-story content
  const SKIP_TYPES = /\b(cover|toc|titlepage|halftitlepage|copyright-page|frontmatter|backmatter|index|colophon|acknowledgments|dedication|imprint|loi|lot|landmarks|page-list|bibliography|glossary|appendix)\b/i;
  const SKIP_NAMES = /(cover|toc|contents|copyright|title|nav|index|colophon|acknowledg|dedication|imprint|about|also-by|halftitle|frontmatter|backmatter)/i;

  const countWords = s => (s.match(/\S+/g) || []).length;

  // Split paragraphs into passages of roughly TARGET_WORDS, never breaking a paragraph.
  function splitIntoPassages(paragraphs) {
    const passages = [];
    let cur = [], curWords = 0;
    for (const p of paragraphs) {
      const n = countWords(p);
      if (curWords > 0 && curWords + n > TARGET_WORDS * 1.2) {
        passages.push({ text: cur.join('\n\n'), words: curWords });
        cur = []; curWords = 0;
      }
      cur.push(p); curWords += n;
      if (curWords >= TARGET_WORDS) {
        passages.push({ text: cur.join('\n\n'), words: curWords });
        cur = []; curWords = 0;
      }
    }
    if (curWords > 0) {
      const last = passages[passages.length - 1];
      if (last && curWords < MIN_TAIL_WORDS) {
        last.text += '\n\n' + cur.join('\n\n');
        last.words += curWords;
      } else {
        passages.push({ text: cur.join('\n\n'), words: curWords });
      }
    }
    return passages;
  }

  // Resolve a relative href against the directory of a base path inside the zip.
  function resolvePath(base, href) {
    const parts = base.split('/');
    parts.pop();
    for (const seg of decodeURIComponent(href.split('#')[0]).split('/')) {
      if (seg === '..') parts.pop();
      else if (seg && seg !== '.') parts.push(seg);
    }
    return parts.join('/');
  }

  function parseXml(str, type) {
    let doc = new DOMParser().parseFromString(str, type);
    if (doc.getElementsByTagName('parsererror').length && type !== 'text/html') {
      doc = new DOMParser().parseFromString(str, 'text/html'); // sloppy XHTML fallback
    }
    return doc;
  }

  const clean = el => el.textContent.replace(/\s+/g, ' ').trim();

  // Pull readable text out of a spine document, split into sections at h1-h3 headings
  // (many EPUBs, e.g. Project Gutenberg's, put several chapters in one file).
  function extractSections(doc) {
    const body = doc.body || doc.getElementsByTagName('body')[0];
    if (!body) return [];
    body.querySelectorAll('script, style, nav, aside, figure, img, svg, table')
      .forEach(el => el.remove());

    const blockSel = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, div';
    const blocks = Array.from(body.querySelectorAll(blockSel))
      // keep only leaf blocks so nested markup isn't read twice
      .filter(el => !el.querySelector(blockSel));

    const sections = [];
    let cur = { heading: '', paragraphs: [] };
    for (const el of blocks) {
      const text = clean(el);
      if (!text) continue;
      if (/^h[1-3]$/i.test(el.localName) && text.length < 120) {
        if (cur.paragraphs.length) {
          sections.push(cur);
          cur = { heading: text, paragraphs: [] };
        } else {
          // consecutive headings ("CHAPTER I." + subtitle) become one label
          cur.heading = cur.heading ? `${cur.heading}: ${text}` : text;
        }
      } else {
        cur.paragraphs.push(text);
      }
    }
    if (cur.paragraphs.length) sections.push(cur);
    if (!sections.length) {
      const t = clean(body);
      if (t) sections.push({ heading: '', paragraphs: [t] });
    }
    return sections;
  }

  // "Piling up the fire. CHAPTER XI." -> "Chapter XI" (illustration captions often sit inside headings)
  function tidyHeading(h) {
    const m = h.match(/\b(chapter|part|book|volume|letter)\s+([0-9]+|[ivxlcdm]+\b|[a-z]+)/i);
    if (m) return m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() + ' ' + m[2].toUpperCase();
    return h.replace(/[.:\s]+$/, '');
  }

  // Drop Project Gutenberg's header/license wrapper if present.
  function stripGutenberg(sections) {
    const isStart = p => /^\*{3}\s*START OF (THE|THIS) PROJECT GUTENBERG/i.test(p);
    const isEnd = p => /^\*{3}\s*END OF (THE|THIS) PROJECT GUTENBERG/i.test(p);
    const si = sections.findIndex(s => s.paragraphs.some(isStart));
    if (si >= 0) {
      const sec = sections[si];
      sec.paragraphs = sec.paragraphs.slice(sec.paragraphs.findIndex(isStart) + 1);
      sections = sections.slice(si);
    }
    const ei = sections.findIndex(s => s.paragraphs.some(isEnd));
    if (ei >= 0) {
      const sec = sections[ei];
      sec.paragraphs = sec.paragraphs.slice(0, sec.paragraphs.findIndex(isEnd));
      sections = sections.slice(0, ei + 1);
    }
    return sections;
  }

  function isSkippable(item, doc, words) {
    if (item.linear === 'no') return true;
    if (/\bnav\b/.test(item.properties || '')) return true;
    const body = doc.body || doc.getElementsByTagName('body')[0];
    const typed = [body, ...(body ? body.querySelectorAll('section, div') : [])]
      .slice(0, 4)
      .map(el => el && (el.getAttribute('epub:type') || el.getAttribute('role') || ''))
      .join(' ');
    if (SKIP_TYPES.test(typed) && !/\b(bodymatter|chapter)\b/i.test(typed)) return true;
    if (words < MIN_SECTION_WORDS) return true;
    // a name hint only counts when the section is also short-ish
    if (SKIP_NAMES.test(item.href) && words < 600) return true;
    return false;
  }

  // Map spine hrefs -> chapter titles from the EPUB3 nav or EPUB2 NCX, if present.
  async function readTocLabels(zip, opfPath, opf, manifest) {
    const labels = {};
    try {
      const navItem = Array.from(manifest.values()).find(m => /\bnav\b/.test(m.properties || ''));
      if (navItem) {
        const navPath = resolvePath(opfPath, navItem.href);
        const doc = parseXml(await zip.file(navPath).async('string'), 'application/xhtml+xml');
        doc.querySelectorAll('nav a[href]').forEach(a => {
          const key = resolvePath(navPath, a.getAttribute('href'));
          if (!labels[key]) labels[key] = a.textContent.replace(/\s+/g, ' ').trim();
        });
      }
      const tocId = opf.querySelector('spine') && opf.querySelector('spine').getAttribute('toc');
      const ncxItem = tocId && manifest.get(tocId);
      if (ncxItem) {
        const ncxPath = resolvePath(opfPath, ncxItem.href);
        const doc = parseXml(await zip.file(ncxPath).async('string'), 'application/xml');
        doc.querySelectorAll('navPoint').forEach(np => {
          const text = np.querySelector('navLabel text');
          const src = np.querySelector('content');
          if (!text || !src) return;
          const key = resolvePath(ncxPath, src.getAttribute('src'));
          if (!labels[key]) labels[key] = text.textContent.replace(/\s+/g, ' ').trim();
        });
      }
    } catch (e) { /* TOC is optional */ }
    return labels;
  }

  async function loadEpub(file) {
    if (typeof JSZip === 'undefined') throw new Error('JSZip failed to load (are you offline?).');
    const zip = await JSZip.loadAsync(file);
    if (zip.file('META-INF/encryption.xml')) {
      const enc = await zip.file('META-INF/encryption.xml').async('string');
      if (/EncryptedData/.test(enc) && !/obfuscation/i.test(enc)) {
        throw new Error('This EPUB is DRM-protected and cannot be read.');
      }
    }

    const container = zip.file('META-INF/container.xml');
    if (!container) throw new Error('Not a valid EPUB (missing container.xml).');
    const cDoc = parseXml(await container.async('string'), 'application/xml');
    const rootfile = cDoc.querySelector('rootfile');
    const opfPath = rootfile && rootfile.getAttribute('full-path');
    if (!opfPath || !zip.file(opfPath)) throw new Error('Not a valid EPUB (missing package file).');

    const opf = parseXml(await zip.file(opfPath).async('string'), 'application/xml');
    const titleEl = opf.getElementsByTagNameNS('*', 'title')[0];
    const title = (titleEl && titleEl.textContent.trim()) || file.name.replace(/\.epub$/i, '');

    const manifest = new Map();
    opf.querySelectorAll('manifest > item').forEach(it => {
      manifest.set(it.getAttribute('id'), {
        href: it.getAttribute('href'),
        type: it.getAttribute('media-type') || '',
        properties: it.getAttribute('properties') || '',
      });
    });

    const tocLabels = await readTocLabels(zip, opfPath, opf, manifest);

    let sections = [];
    for (const ref of opf.querySelectorAll('spine > itemref')) {
      const m = manifest.get(ref.getAttribute('idref'));
      if (!m || !/html/.test(m.type)) continue;
      const path = resolvePath(opfPath, m.href);
      const f = zip.file(path);
      if (!f) continue;

      const doc = parseXml(await f.async('string'), 'application/xhtml+xml');
      const docSections = extractSections(doc);
      const words = docSections.reduce((n, sec) => n + sec.paragraphs.reduce((k, p) => k + countWords(p), 0), 0);
      if (isSkippable({ ...m, linear: ref.getAttribute('linear') }, doc, words)) continue;

      const prev = sections[sections.length - 1];
      if (docSections.length && !docSections[0].heading) {
        const label = tocLabels[path] ? tidyHeading(tocLabels[path]) : '';
        if (prev && (!label || label === prev.heading)) {
          // file break in the middle of a chapter: continue the previous section
          prev.paragraphs.push(...docSections.shift().paragraphs);
        } else {
          docSections[0].heading = label;
        }
      }
      for (const sec of docSections) {
        sec.heading = sec.heading && tidyHeading(sec.heading);
        const last = sections[sections.length - 1];
        if (last && sec.heading && sec.heading === last.heading) last.paragraphs.push(...sec.paragraphs);
        else sections.push(sec);
      }

      // let the UI breathe on big books
      await new Promise(r => setTimeout(r, 0));
    }
    sections = stripGutenberg(sections)
      .filter(sec => sec.paragraphs.reduce((n, p) => n + countWords(p), 0) >= MIN_SECTION_WORDS);

    const parts = [];
    sections.forEach((sec, n) => {
      const name = sec.heading || `Section ${n + 1}`;
      const passages = splitIntoPassages(sec.paragraphs);
      passages.forEach((p, i) => parts.push({
        chapter: name,
        label: passages.length > 1 ? `${name} — part ${i + 1}/${passages.length}` : name,
        text: p.text,
        words: p.words,
      }));
    });
    if (!parts.length) throw new Error('No readable chapters found in this EPUB.');
    const firstChapter = parts.findIndex(p =>
      /^(chapter|part|book)\s+(1|one|i)\b|^(1|i)\.?(\s|:|$)/i.test(p.chapter));
    return { title, parts, start: Math.max(0, firstChapter) };
  }

  async function loadTxt(file) {
    const raw = await file.text();
    const paragraphs = raw.replace(/\r\n?/g, '\n')
      .split(/\n\s*\n/)
      .map(p => p.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    const passages = splitIntoPassages(paragraphs);
    if (!passages.length) throw new Error('This file is empty.');
    return {
      start: 0,
      title: file.name.replace(/\.txt$/i, ''),
      parts: passages.map((p, i) => ({
        chapter: '',
        label: `Part ${i + 1}/${passages.length}`,
        text: p.text,
        words: p.words,
      })),
    };
  }

  window.Book = {
    load(file) {
      if (/\.epub$/i.test(file.name) || file.type === 'application/epub+zip') return loadEpub(file);
      if (/\.txt$/i.test(file.name) || file.type.startsWith('text/')) return loadTxt(file);
      return Promise.reject(new Error('Unsupported file type. Use .epub or .txt.'));
    },
  };
})();

// Library: books you've opened, saved (already parsed) in IndexedDB so they survive reloads.
// Exposes window.Library.{list, get, save, touch, remove}. Every call fails soft: if storage
// is unavailable (private window, blocked site data) the library just appears empty.
(function () {
  const DB_NAME = 'rereader', STORE = 'books';
  let dbPromise = null;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }).catch(err => { dbPromise = null; throw err; });
    }
    return dbPromise;
  }

  async function run(mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  window.Library = {
    // newest first; each entry is { id, title, parts, start, openedAt }
    async list() {
      try {
        const all = await run('readonly', st => st.getAll());
        return (all || []).sort((a, b) => b.openedAt - a.openedAt);
      } catch (e) { return []; }
    },
    async get(id) {
      try { return await run('readonly', st => st.get(id)); } catch (e) { return null; }
    },
    async save(book) {
      try {
        await run('readwrite', st => st.put({
          id: book.title, title: book.title, parts: book.parts, start: book.start, openedAt: Date.now(),
        }));
        return true;
      } catch (e) { return false; }
    },
    async touch(id) {
      try {
        const rec = await run('readonly', st => st.get(id));
        if (rec) { rec.openedAt = Date.now(); await run('readwrite', st => st.put(rec)); }
      } catch (e) {}
    },
    async remove(id) {
      try { await run('readwrite', st => st.delete(id)); } catch (e) {}
    },
  };
})();
