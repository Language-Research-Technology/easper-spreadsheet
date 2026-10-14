// Decode a media file to 16 kHz mono samples and compute waveform peaks.

export const SAMPLE_RATE = 16000;
export const PEAKS_PER_SECOND = 100;

export async function decodeTo16kMono(file) {
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  try {
    const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
    const n = buffer.length;
    const mono = new Float32Array(n);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < n; i++) mono[i] += data[i] / buffer.numberOfChannels;
    }
    return mono;
  } finally {
    ctx.close();
  }
}

/** Max absolute amplitude per 10 ms, normalised to [0, 1]. */
export function computePeaks(samples) {
  const bucket = SAMPLE_RATE / PEAKS_PER_SECOND;
  const peaks = new Float32Array(Math.ceil(samples.length / bucket));
  let max = 0;
  for (let p = 0; p < peaks.length; p++) {
    let m = 0;
    const end = Math.min(samples.length, (p + 1) * bucket);
    for (let i = p * bucket; i < end; i++) {
      const v = Math.abs(samples[i]);
      if (v > m) m = v;
    }
    peaks[p] = m;
    if (m > max) max = m;
  }
  if (max > 0) for (let p = 0; p < peaks.length; p++) peaks[p] /= max;
  return peaks;
}
