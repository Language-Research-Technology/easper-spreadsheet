// Speaker diarization, ported from Easper web (easper.au) so results match:
// sliding 1 s windows over the speech regions, a CAM++ speaker embedding per
// window (from Kaldi-style 80-bin fbank features), average-linkage clustering
// to the requested number of speakers, then merging windows into speaker turns.

export const EMBEDDING_MODEL_URL =
  'https://huggingface.co/csukuangfj/speaker-embedding-models/resolve/main/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx';

export const DIARIZATION_DEFAULTS = Object.freeze({
  // Easper uses 1 s; 2 s gives CAM++ enough speech to tell voices apart more reliably
  windowSec: 2,
  periodSec: 0.5,
  // Finer VAD settings Easper uses when diarizing, so turns aren't merged across speakers
  vad: { minSilenceDurationMs: 100, speechPadMs: 30, minSpeechDurationMs: 250, maxSegmentDuration: Infinity },
});

const SR = 16000;

// ── Fbank features (Kaldi-compatible) ──────────────────────────────────────

const melScale = f => 1127 * Math.log(1 + f / 700);

function melBanks(numFilters, nFft, sampleRate, lowFreq, highFreq) {
  const bins = nFft >> 1;
  const high = highFreq > 0 ? highFreq : sampleRate / 2 + highFreq;
  const melLow = melScale(lowFreq);
  const delta = (melScale(high) - melLow) / (numFilters + 1);
  const binHz = sampleRate / nFft;
  const banks = [];
  for (let m = 0; m < numFilters; m++) {
    const left = melLow + m * delta, centre = left + delta, right = centre + delta;
    const bank = new Float32Array(bins);
    for (let b = 0; b < bins; b++) {
      const mel = melScale(binHz * b);
      if (mel > left && mel <= centre) bank[b] = (mel - left) / (centre - left);
      else if (mel > centre && mel < right) bank[b] = (right - mel) / (right - centre);
    }
    banks.push(bank);
  }
  return banks;
}

function poveyWindow(n) {
  const w = new Float32Array(n), a = (2 * Math.PI) / (n - 1);
  for (let i = 0; i < n; i++) w[i] = Math.pow(0.5 - 0.5 * Math.cos(a * i), 0.85);
  return w;
}

/** In-place radix-2 FFT of (re, im). */
function fft(re, im) {
  const n = re.length;
  for (let i = 0, j = 0; i < n - 1; i++) {
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    let k = n >> 1;
    while (k <= j) { j -= k; k >>= 1; }
    j += k;
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, angle = (-2 * Math.PI) / size, wr = Math.cos(angle), wi = Math.sin(angle);
    for (let start = 0; start < n; start += size) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = start + k, b = a + half;
        const tr = cr * re[b] - ci * im[b], ti = cr * im[b] + ci * re[b];
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const next = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = next;
      }
    }
  }
}

let cachedBanks = null, cachedWindow = null;

/** 80-bin log-mel fbank, 25 ms frames every 10 ms, with mean normalisation. */
export function fbank(samples, numFilters = 80) {
  const frameLen = 400, shift = 160, nFft = 512, bins = nFft >> 1;
  let x = samples;
  if (x.length < frameLen) { const padded = new Float32Array(frameLen); padded.set(x); x = padded; }
  cachedBanks ??= melBanks(numFilters, nFft, SR, 20, 0);
  cachedWindow ??= poveyWindow(frameLen);

  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  const scale = peak > 0 && peak <= 1.05 ? 32768 : 1; // Kaldi expects 16-bit range

  const frames = Math.floor((x.length - frameLen) / shift) + 1;
  const feats = new Float32Array(frames * numFilters);
  const frame = new Float64Array(frameLen), re = new Float32Array(nFft), im = new Float32Array(nFft), power = new Float64Array(bins);
  for (let f = 0; f < frames; f++) {
    const off = f * shift;
    let mean = 0;
    for (let i = 0; i < frameLen; i++) { frame[i] = x[off + i] * scale; mean += frame[i]; }
    mean /= frameLen;
    for (let i = 0; i < frameLen; i++) frame[i] -= mean;
    for (let i = frameLen - 1; i > 0; i--) frame[i] -= 0.97 * frame[i - 1];
    frame[0] -= 0.97 * frame[0];
    re.fill(0); im.fill(0);
    for (let i = 0; i < frameLen; i++) re[i] = frame[i] * cachedWindow[i];
    fft(re, im);
    for (let b = 0; b < bins; b++) power[b] = re[b] * re[b] + im[b] * im[b];
    for (let m = 0; m < numFilters; m++) {
      const bank = cachedBanks[m];
      let e = 0;
      for (let b = 0; b < bins; b++) e += power[b] * bank[b];
      feats[f * numFilters + m] = Math.log(Math.max(e, 1.1920928955078125e-7));
    }
  }
  for (let m = 0; m < numFilters; m++) {
    let sum = 0;
    for (let f = 0; f < frames; f++) sum += feats[f * numFilters + m];
    const mean = sum / frames;
    for (let f = 0; f < frames; f++) feats[f * numFilters + m] -= mean;
  }
  return { features: feats, numFrames: frames, numFilters };
}

// ── Embeddings ─────────────────────────────────────────────────────────────

export function l2normalize(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s) || 1e-12;
  return Float32Array.from(v, x => x / n);
}

/** CAM++ embedding for one window of 16 kHz audio. */
export async function embed(ort, session, samples) {
  const input = session.inputNames[0] || 'x';
  let { features, numFrames } = fbank(samples);
  if (numFrames < 5) { const padded = new Float32Array(5 * 80); padded.set(features); features = padded; numFrames = 5; }
  const out = await session.run({ [input]: new ort.Tensor('float32', features, [1, numFrames, 80]) });
  return l2normalize(out[session.outputNames[0]].data);
}

// ── Windows, clustering and merging ────────────────────────────────────────

/** Sliding windows over [start, end]; a final window is aligned to the end. */
export function slidingWindows(start, end, windowSec = 1, periodSec = 0.5) {
  const len = end - start;
  if (len <= 0) return [];
  const r = x => Number(x.toFixed(3));
  if (len <= windowSec) return [{ start: r(start), end: r(end) }];
  const out = [];
  let t = start;
  for (; t + windowSec <= end; t += periodSec) out.push({ start: r(t), end: r(t + windowSec) });
  if (t < end) {
    const last = Math.max(start, end - windowSec);
    if (!out.length || Math.abs(out[out.length - 1].start - last) > 0.05) out.push({ start: r(last), end: r(end) });
  }
  return out;
}

const cosineDistance = (a, b) => {
  let dot = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) dot += a[i] * b[i];
  return 1 - Math.max(-1, Math.min(1, dot));
};

const AFFINITY_CAP = 3000;

/**
 * Average-linkage agglomerative clustering. With a target count, distances are
 * measured in "affinity space" (Euclidean distance between rows of the cosine
 * distance matrix), as Easper does. Labels are numbered by first appearance.
 */
export function clusterEmbeddings(embeddings, { targetClusters = null, threshold = 0.7 } = {}) {
  const n = embeddings.length;
  if (n === 0) return [];
  if (n === 1 || (targetClusters !== null && targetClusters <= 1)) return new Array(n).fill(0);
  const vecs = embeddings.map(l2normalize);

  let d = new Float32Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) d[i * n + j] = d[j * n + i] = cosineDistance(vecs[i], vecs[j]);
  if (targetClusters !== null && n <= AFFINITY_CAP) {
    const a = new Float32Array(n * n);
    for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) {
      let s = 0;
      for (let k = 0; k < n; k++) { const diff = d[i * n + k] - d[j * n + k]; s += diff * diff; }
      a[i * n + j] = a[j * n + i] = Math.sqrt(s);
    }
    d = a;
  }

  const active = new Uint8Array(n).fill(1), size = new Int32Array(n).fill(1);
  const firstMember = Int32Array.from({ length: n }, (_, i) => i), parent = Int32Array.from({ length: n }, (_, i) => i);
  const nearest = new Int32Array(n).fill(-1), nearestDist = new Float64Array(n).fill(Infinity);
  const updateNearest = i => {
    let best = -1, bd = Infinity;
    for (let j = 0; j < n; j++) if (j !== i && active[j] && d[i * n + j] < bd) { bd = d[i * n + j]; best = j; }
    nearest[i] = best; nearestDist[i] = bd;
  };
  for (let i = 0; i < n; i++) updateNearest(i);

  let clusters = n;
  while (clusters > 1 && !(targetClusters !== null && clusters <= targetClusters)) {
    let a = -1, best = Infinity;
    for (let i = 0; i < n; i++) if (active[i] && nearest[i] >= 0 && nearestDist[i] < best) { best = nearestDist[i]; a = i; }
    if (a < 0) break;
    if (targetClusters === null && best > threshold) break;
    const b = nearest[a], total = size[a] + size[b];
    for (let k = 0; k < n; k++) {
      if (!active[k] || k === a || k === b) continue;
      d[a * n + k] = d[k * n + a] = (size[a] * d[a * n + k] + size[b] * d[b * n + k]) / total;
    }
    active[b] = 0; parent[b] = a; size[a] = total; firstMember[a] = Math.min(firstMember[a], firstMember[b]);
    clusters--;
    updateNearest(a);
    for (let k = 0; k < n; k++) if (active[k] && k !== a && (nearest[k] === a || nearest[k] === b)) updateNearest(k);
  }

  const root = i => { while (parent[i] !== i) i = parent[i]; return i; };
  const roots = [];
  for (let i = 0; i < n; i++) if (active[i]) roots.push(i);
  roots.sort((x, y) => firstMember[x] - firstMember[y]);
  const label = new Map(roots.map((r, idx) => [r, idx]));
  return Array.from({ length: n }, (_, i) => label.get(root(i)) ?? 0);
}

/** Merge labelled windows into speaker turns. */
export function mergeWindows(windows, labels, { minSilence = 0.5, minSegment = 0.3 } = {}) {
  if (!windows.length) return [];
  const turns = [];
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i], label = labels[i];
    let start = w.start;
    if (i > 0) {
      const prev = windows[i - 1];
      // Overlapping windows of the same region with different speakers: split at the midpoint
      if (w.utteranceIdx === prev.utteranceIdx && labels[i - 1] !== label && prev.end > w.start) {
        start = Number(((prev.end + w.start) / 2).toFixed(3));
        if (turns.length) turns[turns.length - 1].end = start;
      }
    }
    turns.push({ start, end: w.end, cluster: label, utteranceIdx: w.utteranceIdx });
  }

  const out = [];
  let cur = null;
  const flushShort = seg => {
    const last = out[out.length - 1];
    if (last && seg.start - last.end <= minSilence) last.end = Math.max(last.end, seg.end);
    else out.push(seg);
  };
  for (const t of turns) {
    if (!cur) { cur = { ...t }; continue; }
    if (cur.cluster === t.cluster && t.utteranceIdx === cur.utteranceIdx && t.start - cur.end <= minSilence) {
      cur.end = Math.max(cur.end, t.end);
    } else {
      if (cur.end - cur.start >= minSegment || !out.length) out.push(cur);
      else flushShort(cur);
      cur = { ...t };
    }
  }
  if (cur) {
    if (cur.end - cur.start >= minSegment || !out.length) out.push(cur);
    else { const last = out[out.length - 1]; if (cur.start - last.end <= minSilence) last.end = Math.max(last.end, cur.end); }
  }
  return out.map(s => ({ start: Number(s.start.toFixed(2)), end: Number(s.end.toFixed(2)), cluster: s.cluster }));
}
