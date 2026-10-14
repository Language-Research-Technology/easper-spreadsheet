// Background worker: Silero VAD segmentation and Whisper ASR (transformers.js),
// matching Easper web's pipeline.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js';
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.wasm.min.mjs';
import { sileroVad, segmentsCleanup } from './segments.js';
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

async function loadVad() {
  if (vadSession) return vadSession;
  status('Loading Silero VAD model…');
  const cache = await caches.open('silero-vad-cache-v1').catch(() => null);
  let res = cache && await cache.match(SILERO_URL);
  if (!res) {
    res = await fetch(SILERO_URL);
    if (!res.ok) throw new Error(`Could not download Silero VAD (${res.status})`);
    if (cache) await cache.put(SILERO_URL, res.clone());
  }
  vadSession = await ort.InferenceSession.create(new Uint8Array(await res.arrayBuffer()), { executionProviders: ['wasm'] });
  return vadSession;
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

async function runVad({ options }) {
  const session = await loadVad();
  status('Scanning audio for speech…');
  const raw = await sileroVad(ort, session, audio, options, f => post('progress', { stage: 'vad', fraction: f }));
  const segments = segmentsCleanup(raw, options);
  post('vad_result', { segments });
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
    post('asr_segment', { index: n, total: segments.length, text, words });
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
