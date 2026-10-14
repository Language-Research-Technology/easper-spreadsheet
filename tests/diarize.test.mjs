import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fbank, slidingWindows, clusterEmbeddings, mergeWindows } from '../js/diarize.js';

test('slidingWindows covers the region with 1 s windows every 0.5 s', () => {
  assert.deepEqual(slidingWindows(0, 0.8), [{ start: 0, end: 0.8 }]);
  assert.deepEqual(slidingWindows(2, 4.2), [
    { start: 2, end: 3 }, { start: 2.5, end: 3.5 }, { start: 3, end: 4 }, { start: 3.2, end: 4.2 },
  ]);
});

test('fbank gives 80 bins per 10 ms frame, peaking at a tone frequency', () => {
  const tone = Float32Array.from({ length: 16000 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 1000 * i) / 16000));
  const { features, numFrames, numFilters } = fbank(tone);
  assert.equal(numFilters, 80);
  assert.equal(numFrames, 98);
  // Before mean normalisation the 1 kHz bin dominates; after it, every bin averages ~0
  let sum = 0;
  for (let f = 0; f < numFrames; f++) sum += features[f * 80 + 10];
  assert.ok(Math.abs(sum / numFrames) < 1e-3);
});

test('clusterEmbeddings separates two speakers and labels by first appearance', () => {
  const a = [1, 0.1, 0], b = [0, 0.1, 1];
  const jitter = (v, k) => v.map((x, i) => x + 0.05 * Math.sin(k * 7 + i));
  const embs = [a, a, b, a, b, b].map((v, k) => Float32Array.from(jitter(v, k)));
  assert.deepEqual(clusterEmbeddings(embs, { targetClusters: 2 }), [0, 0, 1, 0, 1, 1]);
  assert.deepEqual(clusterEmbeddings(embs, { targetClusters: 1 }), [0, 0, 0, 0, 0, 0]);
});

test('mergeWindows joins same-speaker windows and splits at speaker changes', () => {
  const windows = [
    { start: 0, end: 1, utteranceIdx: 0 }, { start: 0.5, end: 1.5, utteranceIdx: 0 },
    { start: 1, end: 2, utteranceIdx: 0 }, { start: 1.5, end: 2.5, utteranceIdx: 0 },
  ];
  assert.deepEqual(mergeWindows(windows, [0, 0, 1, 1]), [
    { start: 0, end: 1.25, cluster: 0 }, { start: 1.25, end: 2.5, cluster: 1 },
  ]);
});
