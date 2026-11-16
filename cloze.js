// Memory check: pick one sentence from a finished passage and one word in it to blank out.
// Pure heuristics, no network or language model.
// Exposes window.Cloze.pick(words, seen, n) -> up to n x { before, answer, after }, in passage order.
//   words: the reader's tokens [{ text, trail, odd? }]
//   seen(i): whether word i was actually shown to the reader (not skipped past)
(function () {
  // The ~250 most common English words: never worth blanking, they test grammar, not memory.
  const STOP = new Set((
    'a about above after again against all almost alone along already also although always am among an and ' +
    'another any anyone anything are around as at away back be became because become been before began behind ' +
    'being below between both but by came can cannot could did do does doing done down during each either else ' +
    'enough even ever every everything few for found from further gave get gets give given go goes going gone ' +
    'got had has have having he her here hers herself him himself his how however i if in indeed into is it its ' +
    'itself just keep kept know knew known last least less let like made make many may me might mine more most ' +
    'much must my myself near need never new next no nor not nothing now of off often on once one only onto or ' +
    'other others otherwise our ours ourselves out over own perhaps put quite rather really said same saw say ' +
    'says see seem seemed seen shall she should since so some something sometimes soon still such take taken ' +
    'than that the their theirs them themselves then there these they thing things think this those though ' +
    'thought three through thus till to together too took toward towards two under until up upon us very was ' +
    'way we well went were what whatever when where whether which while who whole whom whose why will with ' +
    'within without would yet you your yours yourself yourselves mr mrs miss sir lady lord yes oh ah first ' +
    'second time times day days year years man men woman women good great little long old young much every ' +
    'part told tell asked come comes coming look looked looking turned left right came went upon became'
  ).split(/\s+/));

  // Second words of fixed phrases: guessable from the first word, so skip them.
  const FIXED = new Set(['of course', 'at least', 'at last', 'in order', 'as well', 'no longer', 'each other',
    'one another', 'in fact', 'at once', 'of all', 'all right', 'so forth', 'and forth', 'kind of', 'sort of']);

  const norm = t => t.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '').replace(/[’]/g, "'");
  const endsSentence = w => /[.!?]["'”’)\]]*$/.test(w.text) || /\n/.test(w.trail);

  function sentences(words) {
    const out = [];
    let cur = [];
    words.forEach((w, i) => {
      cur.push(i);
      if (endsSentence(w)) { out.push(cur); cur = []; }
    });
    if (cur.length) out.push(cur);
    return out;
  }

  function pick(words, seen, n = 1) {
    // how often each word appears in the passage (odd words excluded)
    const freq = new Map();
    for (const w of words) if (!w.odd) { const n = norm(w.text); freq.set(n, (freq.get(n) || 0) + 1); }

    const all = sentences(words);
    // the last two sentences are still in short-term memory: too easy
    const pool = all.length >= 5 ? all.slice(0, -2) : all;

    const candidates = [];
    for (const idxs of pool) {
      if (idxs.length < 8 || idxs.length > 30) continue;
      if (idxs.some(i => words[i].odd || !seen(i))) continue;
      const inSentence = new Map();
      idxs.forEach(i => { const n = norm(words[i].text); inSentence.set(n, (inSentence.get(n) || 0) + 1); });

      const options = [];
      idxs.forEach((wi, pos) => {
        if (pos === 0) return; // its capital letter would be a clue
        const raw = words[wi].text;
        const n = norm(raw);
        if (n.length < 4 || !/^[a-z][a-z'-]*$/.test(n) || STOP.has(n)) return;
        if (inSentence.get(n) > 1) return;           // the sentence would give it away
        if ((freq.get(n) || 0) > 2) return;          // repeated all over: answered by frequency
        const prev = pos > 0 ? norm(words[idxs[pos - 1]].text) : '';
        if (FIXED.has(`${prev} ${n}`)) return;       // "of course", "at least"...
        // prefer later, longer, rarer words: usually the ones carrying the meaning
        const score = (pos / idxs.length) * 2 + Math.min(n.length, 10) / 5 + (freq.get(n) === 1 ? 1 : 0);
        options.push({ wi, score });
      });
      if (options.length) candidates.push({ idxs, options, richness: options.length / idxs.length });
    }
    if (!candidates.length || n < 1) return [];

    // Spread the questions over the passage: split the candidate sentences (in reading order)
    // into n equal sections and take one from each, so the cards cover the whole read.
    const groups = [];
    if (n >= candidates.length) candidates.forEach(c => groups.push([c]));
    else for (let g = 0; g < n; g++) {
      groups.push(candidates.slice(Math.floor(g * candidates.length / n), Math.floor((g + 1) * candidates.length / n)));
    }

    const join = arr => arr.map(i => words[i].text).join(' ');
    return groups.map(group => {
      // a random sentence from the section's more informative half, then one of its 3 best words
      const ranked = [...group].sort((a, b) => b.richness - a.richness);
      const top = ranked.slice(0, Math.max(1, Math.ceil(ranked.length / 2)));
      const s = top[Math.floor(Math.random() * top.length)];
      const best = [...s.options].sort((a, b) => b.score - a.score).slice(0, 3);
      const { wi } = best[Math.floor(Math.random() * best.length)];

      // split the blanked token so its punctuation stays visible: "piano," -> "____" + ","
      const m = words[wi].text.match(/^([^A-Za-z0-9]*)(.*?)([^A-Za-z0-9]*)$/);
      const at = s.idxs.indexOf(wi);
      return {
        before: (join(s.idxs.slice(0, at)) + ' ' + m[1]).trimStart(),
        answer: m[2],
        after: m[3] + (at < s.idxs.length - 1 ? ' ' + join(s.idxs.slice(at + 1)) : ''),
      };
    });
  }

  window.Cloze = { pick };
})();
