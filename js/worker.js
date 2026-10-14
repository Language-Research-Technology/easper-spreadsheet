// Background worker: Silero VAD segmentation and Whisper ASR (transformers.js),
// matching Easper web's pipeline.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js';
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.wasm.min.mjs';
import { sileroVad, segmentsCleanup } from './segments.js';
import { DIARIZATION_DEFAULTS, EMBEDDING_MODEL_URL, embed, slidingWindows, clusterEmbeddings, mergeWindows } from './diarize.js';
import { chunksToWords } from './align.js';

const SILERO_URL = 'https://huggingface.co/onnx-community/silero-vad/resolve/main/onnx/model.onnx';
const SR = 16000;

env.allowLocalModels = false;
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';

let audio = null;
let vadSession = null;
let asr = null, asrKey = null;

const post = (type, payload = {}) => self.postMessage({ type, ...payload });
const status = message => post('status', { message });

async function cachedModel(url, cacheName, label) {
  const cache = await caches.open(cacheName).catch(() => null);
  let res = cache && await cache.match(url);
  if (!res) {
    status(`Downloading ${label}…`);
    res = await fetch(url);
    if (!res.ok) throw new Error(`Could not download ${label} (${res.status})`);
    if (cache) await cache.put(url, res.clone());
  }
  return new Uint8Array(await res.arrayBuffer());
}

async function loadVad() {
  if (vadSession) return vadSession;
  status('Loading Silero VAD model…');
  vadSession = await ort.InferenceSession.create(await cachedModel(SILERO_URL, 'silero-vad-cache-v1', 'Silero VAD'), { executionProviders: ['wasm'] });
  return vadSession;
}

let speakerSession = null;
async function loadSpeakerModel() {
  if (speakerSession) return speakerSession;
  status('Loading speaker embedding model (CAM++)…');
  const bytes = await cachedModel(EMBEDDING_MODEL_URL, 'speaker-diarizer-cache-v2', 'speaker embedding model (30 MB)');
  speakerSession = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  return speakerSession;
}

async function loadAsr(modelId) {
  if (asr && asrKey === modelId) return asr;
  status(`Loading ${modelId}…`);
  const files = {};
  asr = await pipeline('automatic-speech-recognition', modelId, {
    device: 'wasm',
    dtype: 'q8',
    progress_callback: p => {
      if (p.status === 'progress' && p.total) {
        files[p.file] = [p.loaded, p.total];
        const [loaded, total] = Object.values(files).reduce((a, [l, t]) => [a[0] + l, a[1] + t], [0, 0]);
        status(`Downloading ${modelId}: ${Math.round((loaded / total) * 100)}% of ${(total / 1e6).toFixed(0)} MB`);
      }
    },
  });
  asrKey = modelId;
  return asr;
}

async function runVad({ options, speakers = 1, diarization = {}, range = null }) {
  const session = await loadVad();
  const diarize = speakers >= 2;
  // Work on the selected range only (as Easper does), then shift times back to the whole recording
  const offset = range ? range.start : 0;
  const clip = range ? audio.subarray(Math.floor(range.start * SR), Math.ceil(range.end * SR)) : audio;
  const shift = result => ({
    ...result,
    range,
    segments: result.segments.map(s => ({ ...s, start: round2(s.start + offset), end: round2(s.end + offset) })),
  });
  status(range ? `Scanning ${fmt(range.start)}–${fmt(range.end)} for speech…` : 'Scanning audio for speech…');
  const vadOptions = diarize ? { ...options, ...DIARIZATION_DEFAULTS.vad, minSegment: null } : options;
  const raw = await sileroVad(ort, session, clip, vadOptions, f => post('progress', { fraction: f }));
  if (!diarize || !raw.length) {
    post('vad_result', shift({ segments: segmentsCleanup(raw, options), speakers: 1 }));
    return;
  }

  try {
    post('vad_result', shift(await diarizeRegions(clip, raw, speakers, options, diarization)));
  } catch (err) {
    // As in Easper: if diarization fails, keep the speech segments with one speaker
    console.warn('Diarization failed:', err);
    post('warning', { message: `Speaker diarization failed (${err?.message || err}); segments use a single speaker.` });
    post('vad_result', shift({ segments: segmentsCleanup(raw, options), speakers: 1 }));
  }
}

const round2 = x => Math.round(x * 100) / 100;
const fmt = sec => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

// Speaker diarization, as in Easper: embed sliding windows, cluster, merge into turns
async function diarizeRegions(clip, raw, speakers, options, { windowSec = DIARIZATION_DEFAULTS.windowSec, periodSec = DIARIZATION_DEFAULTS.periodSec } = {}) {
  const model = await loadSpeakerModel();
  const windows = raw.flatMap((seg, utteranceIdx) =>
    slidingWindows(seg.start, Math.max(seg.start + 0.1, seg.end), windowSec, periodSec)
      .map(w => ({ ...w, utteranceIdx })));
  const embeddings = [], kept = [];
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    const a = Math.max(0, Math.min(clip.length - 1, Math.floor(w.start * SR)));
    const b = Math.min(clip.length, Math.ceil(w.end * SR));
    embeddings.push(await embed(ort, model, clip.slice(a, Math.max(a + 1600, b))));
    kept.push(w);
    if (i % 8 === 0 || i === windows.length - 1) {
      status(`Extracting speaker embeddings: window ${i + 1} of ${windows.length}…`);
      post('progress', { fraction: (i + 1) / windows.length });
    }
  }
  status('Clustering speakers…');
  const target = Math.min(embeddings.length, speakers);
  const labels = clusterEmbeddings(embeddings, { targetClusters: target });
  const turns = mergeWindows(kept, labels, { minSilence: options.minSilence ?? 0.5, minSegment: options.minSegment ?? 0.5 });
  const segments = segmentsCleanup(turns.map(t => ({ start: t.start, end: t.end, speakerId: Math.min(5, t.cluster + 1) })), options);
  return { segments, speakers: target };
}

async function runAsr({ segments, modelId, language }) {
  const transcriber = await loadAsr(modelId);
  let timestamps = 'word';
  const lang = language && language !== 'auto' ? { language } : {};
  for (let n = 0; n < segments.length; n++) {
    const seg = segments[n];
    status(`Transcribing segment ${n + 1} of ${segments.length}…`);
    const slice = audio.subarray(Math.floor(seg.start * SR), Math.ceil(seg.end * SR));
    const opts = { chunk_length_s: 30, stride_length_s: 5, return_timestamps: timestamps, task: 'transcribe', ...lang };
    let out;
    try {
      out = await transcriber(slice, opts);
    } catch (err) {
      // Models exported without cross-attentions can't do word timestamps
      if (timestamps !== 'word') throw err;
      timestamps = true;
      post('warning', { message: 'This model has no word-level timestamps; using segment-level timestamps instead.' });
      out = await transcriber(slice, { ...opts, return_timestamps: true });
    }
    const text = String(out.text ?? '').replace(/\[BLANK_AUDIO\]/g, '').trim();
    const chunks = (out.chunks || []).map(c => ({
      text: String(c.text ?? '').replace(/\[BLANK_AUDIO\]/g, ''),
      timestamp: [c.timestamp?.[0] != null ? c.timestamp[0] + seg.start : null, c.timestamp?.[1] != null ? Math.min(seg.end, c.timestamp[1] + seg.start) : null],
    }));
    const words = chunksToWords(chunks.length ? chunks : [{ text, timestamp: [seg.start, seg.end] }], seg.start, seg.end);
    post('asr_segment', { id: seg.id, index: n, total: segments.length, text, words });
  }
  post('asr_done');
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'set_audio') { audio = data.audio; post('audio_ready'); }
    else if (data.type === 'vad') await runVad(data);
    else if (data.type === 'asr') await runAsr(data);
  } catch (err) {
    console.error(err);
    post('error', { message: err?.message || String(err) });
  }
};
