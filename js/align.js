// Align manually transcribed utterances to audio time, using Whisper's timed
// words as a guide.
//
// The manual transcript is treated as the truth: Whisper only provides timing.
// 1. Both transcripts are tokenised into normalised words.
// 2. A (banded) Needleman–Wunsch alignment pairs manual words with Whisper
//    words, scoring pairs by fuzzy character similarity so misspelled or
//    mis-heard words still anchor.
// 3. Manual words paired with a sufficiently similar Whisper word take that
//    word's time ("anchors"). The remaining words are spread between the
//    neighbouring anchors over detected speech (VAD) time, by character length.
// 4. Each utterance spans its first to last word; boundaries are snapped to
//    nearby VAD segment edges and overlaps between utterances are resolved.

export const DEFAULTS = Object.freeze({
  minAnchorSimilarity: 0.6, // pair similarity needed for a word to take Whisper's time
  gapPenalty: -0.5,
  snapDistance: 0.3,        // seconds; snap utterance edges to VAD edges this close
  maxCells: 30_000_000,     // above this, the DP is banded around the diagonal
});

// ── Text normalisation ─────────────────────────────────────────────────────

export function normalizeWord(word) {
  return String(word)
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, '')
    .trim();
}

function baseForm(word) {
  // Compare without diacritics so e.g. "ngā" ~ "nga" still match strongly
  return word.normalize('NFD').replace(/\p{M}/gu, '');
}

export function tokenize(text) {
  return String(text ?? '')
    .split(/\s+/)
    .map(normalizeWord)
    .filter(Boolean);
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  let cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** Similarity of two normalised words in [0, 1]. */
export function wordSimilarity(a, b) {
  if (a === b) return 1;
  const x = baseForm(a);
  const y = baseForm(b);
  if (x === y) return 0.95;
  const len = Math.max(x.length, y.length);
  return len ? 1 - levenshtein(x, y) / len : 0;
}

// ── Sequence alignment ─────────────────────────────────────────────────────

const DIAG = 0, UP = 1, LEFT = 2;

/**
 * Globally align token arrays `a` (manual) and `b` (ASR).
 * Returns an array `pairs` where pairs[i] = { j, sim } for a[i] aligned to b[j],
 * or null when a[i] is aligned to a gap.
 */
export function alignTokens(a, b, opts = {}) {
  const { gapPenalty, maxCells } = { ...DEFAULTS, ...opts };
  const M = a.length, N = b.length;
  const pairs = new Array(M).fill(null);
  if (!M || !N) return pairs;

  // Band around the diagonal for long inputs; full matrix otherwise
  let W = Math.max(M, N);
  if ((M + 1) * (N + 1) > maxCells) {
    W = Math.max(50, Math.ceil(maxCells / (M + 1) / 2), Math.ceil(N / M) + 10);
  }
  const lo = new Int32Array(M + 1), hi = new Int32Array(M + 1);
  for (let i = 0; i <= M; i++) {
    const c = Math.round((i * N) / M);
    lo[i] = Math.max(0, c - W);
    hi[i] = Math.min(N, c + W);
  }

  const trace = new Array(M + 1);
  const simCache = new Map();
  const sim = (i, j) => {
    const key = a[i] + '\u0000' + b[j];
    let s = simCache.get(key);
    if (s === undefined) { s = wordSimilarity(a[i], b[j]); simCache.set(key, s); }
    return s;
  };

  let prevLo = lo[0];
  let prev = new Float64Array(hi[0] - lo[0] + 1);
  trace[0] = new Uint8Array(prev.length).fill(LEFT);
  for (let j = lo[0]; j <= hi[0]; j++) prev[j - prevLo] = j * gapPenalty;

  for (let i = 1; i <= M; i++) {
    const L = lo[i], H = hi[i];
    const cur = new Float64Array(H - L + 1);
    const tr = new Uint8Array(H - L + 1);
    const prevHi = prevLo + prev.length - 1;
    for (let j = L; j <= H; j++) {
      let best = -Infinity, dir = UP;
      if (j >= prevLo && j <= prevHi) {               // UP: a[i-1] against a gap
        best = prev[j - prevLo] + gapPenalty; dir = UP;
      }
      if (j > 0 && j - 1 >= prevLo && j - 1 <= prevHi) { // DIAG: a[i-1] ~ b[j-1]
        const v = prev[j - 1 - prevLo] + (2 * sim(i - 1, j - 1) - 1);
        if (v > best) { best = v; dir = DIAG; }
      }
      if (j > L) {                                    // LEFT: b[j-1] against a gap
        const v = cur[j - 1 - L] + gapPenalty;
        if (v > best) { best = v; dir = LEFT; }
      }
      cur[j - L] = best;
      tr[j - L] = dir;
    }
    trace[i] = tr;
    prev = cur;
    prevLo = L;
  }

  let i = M, j = N;
  while (i > 0 || j > 0) {
    const dir = i === 0 ? LEFT : trace[i][j - lo[i]];
    if (dir === DIAG) { pairs[i - 1] = { j: j - 1, sim: sim(i - 1, j - 1) }; i--; j--; }
    else if (dir === UP) { i--; }
    else { j--; }
  }
  return pairs;
}

// ── Speech-time mapping ────────────────────────────────────────────────────

/** Merge VAD segments into sorted, non-overlapping speech intervals. */
export function speechIntervals(segments) {
  const sorted = (segments || [])
    .map(s => [Number(s.start), Number(s.end)])
    .filter(([s, e]) => e > s)
    .sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [s, e] of sorted) {
    if (out.length && s <= out[out.length - 1][1]) out[out.length - 1][1] = Math.max(out[out.length - 1][1], e);
    else out.push([s, e]);
  }
  return out;
}

/**
 * Returns f(fraction, isStart) -> time, mapping a fraction of the speech inside
 * [t0, t1] to a time. Falls back to linear when [t0, t1] contains no speech.
 * Slivers of speech (e.g. the tail of the previous anchor's segment) are ignored
 * when there is real speech in the gap. A start that falls exactly on the end of
 * one speech part is placed at the beginning of the next.
 */
function speechMapper(intervals, t0, t1, minPart = 0.2) {
  let parts = [];
  for (const [s, e] of intervals) {
    const a = Math.max(s, t0), b = Math.min(e, t1);
    if (b > a) parts.push([a, b]);
  }
  const substantial = parts.filter(([a, b]) => b - a >= minPart);
  if (substantial.length) parts = substantial;
  const total = parts.reduce((acc, [a, b]) => acc + (b - a), 0);
  if (total <= 0) return f => t0 + f * (t1 - t0);
  return (f, isStart = false) => {
    let remaining = f * total;
    for (const [a, b] of parts) {
      if (isStart ? remaining < b - a : remaining <= b - a) return a + remaining;
      remaining -= b - a;
    }
    return parts[parts.length - 1][1];
  };
}

// ── Main entry point ───────────────────────────────────────────────────────

/**
 * @param {Array<{text:string, speaker?:string, row?:number}>} utterances  manual transcript, in spoken order
 * @param {Array<{text:string, start:number, end:number}>} asrWords        Whisper words in time order
 * @param {Array<{start:number, end:number}>} vadSegments                   detected speech segments
 * @param {number} duration                                                 audio length in seconds
 * @returns {Array<{index, row, speaker, text, start, end, confidence, matchedWords, totalWords, status}>}
 */
export function alignUtterances(utterances, asrWords, vadSegments, duration, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const speech = speechIntervals(vadSegments);
  const speechStart = speech.length ? speech[0][0] : 0;
  const speechEnd = speech.length ? speech[speech.length - 1][1] : duration;

  // Flatten manual words, remembering their utterance
  const manual = [];
  utterances.forEach((u, ui) => {
    for (const w of tokenize(u.text)) manual.push({ w, ui });
  });
  const asr = [];
  for (const word of asrWords || []) {
    for (const w of tokenize(word.text)) asr.push({ w, start: word.start, end: word.end });
  }

  const pairs = alignTokens(manual.map(m => m.w), asr.map(x => x.w), o);

  // Word timings: anchors from Whisper, everything else interpolated
  const times = manual.map(() => null);
  const sims = manual.map(() => 0);
  pairs.forEach((p, i) => {
    if (p && p.sim >= o.minAnchorSimilarity) {
      times[i] = [asr[p.j].start, asr[p.j].end];
      sims[i] = p.sim;
    }
  });
  // Keep anchors monotonic (Whisper word times can jitter backwards)
  let last = -Infinity;
  for (let i = 0; i < times.length; i++) {
    if (!times[i]) continue;
    if (times[i][0] < last) { times[i] = null; sims[i] = 0; continue; }
    last = times[i][1];
  }

  let i = 0;
  while (i < manual.length) {
    if (times[i]) { i++; continue; }
    let k = i;
    while (k < manual.length && !times[k]) k++;
    // Unanchored run manual[i..k-1], between the previous anchor and the next one
    const t0 = i > 0 ? times[i - 1][1] : speechStart;
    const t1 = k < manual.length ? times[k][0] : speechEnd;
    const map = speechMapper(speech, Math.min(t0, t1), Math.max(t0, t1));
    const weights = manual.slice(i, k).map(m => m.w.length + 1);
    const total = weights.reduce((x, y) => x + y, 0);
    let acc = 0;
    for (let n = i; n < k; n++) {
      const a = acc / total;
      acc += weights[n - i];
      times[n] = [map(a, true), map(acc / total)];
    }
    i = k;
  }

  // Collect utterance spans
  const result = utterances.map((u, ui) => ({
    index: ui,
    row: u.row ?? ui + 1,
    speaker: u.speaker ?? '',
    text: u.text,
    start: null,
    end: null,
    confidence: 0,
    matchedWords: 0,
    totalWords: 0,
    status: 'empty',
  }));
  manual.forEach((m, n) => {
    const r = result[m.ui];
    const [s, e] = times[n];
    r.start = r.start === null ? s : Math.min(r.start, s);
    r.end = r.end === null ? e : Math.max(r.end, e);
    r.totalWords++;
    if (sims[n] > 0) { r.matchedWords++; r.confidence += sims[n]; }
  });

  // Utterances without any words (blank rows) sit at the end of the previous one
  let prevEnd = speechStart;
  for (const r of result) {
    if (r.start === null) { r.start = r.end = prevEnd; continue; }
    prevEnd = r.end;
  }

  for (const r of result) {
    if (!r.totalWords) continue;
    r.confidence = r.confidence / r.totalWords;
    r.status = r.matchedWords === 0 ? 'interpolated' : r.confidence >= 0.75 ? 'matched' : 'partial';
  }

  snapAndResolve(result, speech, o.snapDistance, duration);
  for (const r of result) {
    r.start = round3(r.start);
    r.end = round3(r.end);
    r.confidence = Math.round(r.confidence * 100) / 100;
  }
  return result;
}

function snapAndResolve(result, speech, snapDistance, duration) {
  const starts = speech.map(s => s[0]);
  const ends = speech.map(s => s[1]);
  const nearest = (list, t) => {
    let best = null;
    for (const x of list) if (Math.abs(x - t) <= snapDistance && (best === null || Math.abs(x - t) < Math.abs(best - t))) best = x;
    return best;
  };
  for (const r of result) {
    if (!r.totalWords) continue;
    const s = nearest(starts, r.start);
    const e = nearest(ends, r.end);
    if (s !== null && s < r.end) r.start = s;
    if (e !== null && e > r.start) r.end = e;
  }
  // Utterances are in spoken order: never overlap, never run backwards
  const spoken = result.filter(r => r.totalWords);
  for (let n = 1; n < spoken.length; n++) {
    const a = spoken[n - 1], b = spoken[n];
    if (b.start < a.end) {
      const mid = (Math.max(a.start, b.start) + Math.min(a.end, b.end)) / 2;
      a.end = Math.max(a.start, mid);
      b.start = Math.max(a.end, Math.min(b.start, mid));
      if (b.end < b.start) b.end = b.start;
    }
  }
  for (const r of result) {
    r.start = Math.max(0, Math.min(duration, r.start));
    r.end = Math.max(r.start, Math.min(duration, r.end));
  }
}

const round3 = x => Math.round(x * 1000) / 1000;

/**
 * Turn Whisper chunk output into timed words. Word-level chunks are used as-is;
 * longer chunks have their time shared among their words by character length.
 */
export function chunksToWords(chunks, segStart, segEnd) {
  const words = [];
  for (const chunk of chunks || []) {
    const text = String(chunk.text ?? '').trim();
    if (!text) continue;
    const [cs, ce] = Array.isArray(chunk.timestamp) ? chunk.timestamp : [null, null];
    const s = Number.isFinite(cs) ? cs : segStart;
    const e = Number.isFinite(ce) && ce > s ? ce : segEnd;
    const parts = text.split(/\s+/).filter(Boolean);
    const total = parts.reduce((acc, p) => acc + p.length, 0) || 1;
    let t = s;
    for (const p of parts) {
      const d = (e - s) * (p.length / total);
      words.push({ text: p, start: round3(t), end: round3(t + d) });
      t += d;
    }
  }
  return words;
}
