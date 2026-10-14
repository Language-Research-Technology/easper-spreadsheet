// Segmentation, ported from Easper web (easper.au) so results match:
// Silero VAD v5 over 512-sample windows, then the same segments_cleanup pass.

export const VAD_DEFAULTS = Object.freeze({
  threshold: 0.5,
  negThreshold: 0.35,
  minSilenceDurationMs: 300,
  speechPadMs: 60,
  minSegment: 0.5,          // seconds; also the minimum speech duration
  minSilence: 0.5,          // seconds; merge same-speaker segments closer than this
  maxSegmentDuration: 30,   // seconds
});

const SR = 16000;

/**
 * Run Silero VAD over 16 kHz mono audio.
 * @param ort  onnxruntime-web module
 * @param session  InferenceSession for silero_vad.onnx (v5)
 */
export async function sileroVad(ort, session, audio, options = {}, onProgress = null) {
  const o = { ...VAD_DEFAULTS, ...options };
  const WINDOW = 512, CONTEXT = 64;
  // As in Easper: minSegment sets the minimum speech length unless it's null (diarization)
  const minSpeech = Math.round(SR * (o.minSegment != null ? o.minSegment : (o.minSpeechDurationMs ?? 250) / 1000));
  const minSilence = Math.round((SR * o.minSilenceDurationMs) / 1000);
  const pad = Math.round((SR * o.speechPadMs) / 1000);
  const maxSpeech = Math.round(SR * o.maxSegmentDuration);

  const context = new Float32Array(CONTEXT);
  const input = new Float32Array(CONTEXT + WINDOW);
  let state = new ort.Tensor('float32', new Float32Array(256), [2, 1, 128]);
  const sr = new ort.Tensor('int64', new BigInt64Array([BigInt(SR)]), []);

  const raw = [];
  let current = null, silenceStart = 0;
  const frames = Math.floor(audio.length / WINDOW);
  const step = Math.max(1, Math.floor(frames / 50));

  for (let f = 0; f < frames; f++) {
    const offset = f * WINDOW;
    const chunk = audio.subarray(offset, offset + WINDOW);
    input.set(context, 0);
    input.set(chunk, CONTEXT);
    context.set(chunk.subarray(WINDOW - CONTEXT, WINDOW));
    const out = await session.run({ input: new ort.Tensor('float32', input, [1, CONTEXT + WINDOW]), state, sr });
    const prob = out.output.data[0];
    state = out.stateN;

    if (prob >= o.threshold) {
      silenceStart = 0;
      if (!current) current = { startSample: offset };
      else if (offset - current.startSample >= maxSpeech) {
        raw.push({ startSample: current.startSample, endSample: offset });
        current = { startSample: offset };
      }
    } else if (prob < o.negThreshold && current) {
      if (silenceStart === 0) silenceStart = offset;
      if (offset - silenceStart >= minSilence) {
        if (silenceStart - current.startSample >= minSpeech) raw.push({ startSample: current.startSample, endSample: silenceStart });
        current = null;
        silenceStart = 0;
      }
    }
    if (onProgress && (f % step === 0 || f === frames - 1)) onProgress((f + 1) / frames);
  }
  if (current) {
    const end = silenceStart || audio.length;
    if (end - current.startSample >= minSpeech) raw.push({ startSample: current.startSample, endSample: end });
  }

  // Pad speech, splitting short gaps between neighbours
  for (let n = 0; n < raw.length; n++) {
    const seg = raw[n];
    if (n === 0) seg.startSample = Math.max(0, seg.startSample - pad);
    if (n !== raw.length - 1) {
      const next = raw[n + 1];
      const gap = next.startSample - seg.endSample;
      if (gap < 2 * pad) {
        const half = Math.floor(gap / 2);
        seg.endSample += half;
        next.startSample = Math.max(0, next.startSample - half);
      } else {
        seg.endSample = Math.min(audio.length, seg.endSample + pad);
        next.startSample = Math.max(0, next.startSample - pad);
      }
    } else seg.endSample = Math.min(audio.length, seg.endSample + pad);
  }
  return raw.map(s => ({ start: s.startSample / SR, end: s.endSample / SR, speakerId: 1 }));
}

/**
 * Easper's segments_cleanup: split long segments, merge close same-speaker
 * segments, drop short ones, remove contained segments, and split overlaps.
 */
export function segmentsCleanup(segments, options = {}) {
  const { minSegment, minSilence, maxSegmentDuration } = { ...VAD_DEFAULTS, ...options };
  if (!segments?.length) return [];

  const split = [];
  for (const seg of segments) {
    let s = seg.start;
    while (seg.end - s > maxSegmentDuration) {
      split.push({ ...seg, start: s, end: s + maxSegmentDuration });
      s += maxSegmentDuration;
    }
    if (seg.end - s > 0) split.push({ ...seg, start: s, end: seg.end });
  }

  const bySpeaker = new Map();
  for (const seg of split) {
    const k = seg.speakerId ?? 1;
    if (!bySpeaker.has(k)) bySpeaker.set(k, []);
    bySpeaker.get(k).push(seg);
  }
  const merged = [];
  for (const list of bySpeaker.values()) {
    list.sort((a, b) => a.start - b.start);
    const out = [{ ...list[0] }];
    for (let n = 1; n < list.length; n++) {
      const seg = list[n], last = out[out.length - 1];
      if (seg.start - last.end < minSilence) {
        if (seg.end - last.start < maxSegmentDuration) last.end = Math.max(last.end, seg.end);
        else out.push({ ...seg });
      } else if (last.end - last.start < minSegment) out[out.length - 1] = { ...seg };
      else out.push({ ...seg });
    }
    merged.push(...out);
  }

  const long = merged.filter(s => s.end - s.start >= minSegment);
  const outer = long.filter(s => !long.some(o => o !== s && s.start >= o.start && s.end <= o.end && (s.start > o.start || s.end < o.end)));
  if (!outer.length) return [];
  outer.sort((a, b) => a.start - b.start);

  const result = [{ ...outer[0] }];
  for (let n = 1; n < outer.length; n++) {
    const seg = outer[n], last = result[result.length - 1];
    if (seg.start <= last.end) {
      const mid = seg.start + (last.end - seg.start) / 2;
      if (mid - last.start < minSegment) result[result.length - 1] = { ...seg };
      else {
        last.end = mid;
        if (seg.end - mid >= minSegment) result.push({ ...seg, start: mid });
      }
    } else result.push({ ...seg });
  }
  return result.map((s, n) => ({
    id: n + 1,
    start: Math.round(s.start * 100) / 100,
    end: Math.round(s.end * 100) / 100,
    speakerId: s.speakerId ?? 1,
  }));
}
