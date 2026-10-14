import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignTokens, alignUtterances, chunksToWords, tokenize, wordSimilarity } from '../js/align.js';

// Whisper words at 0.5 s per word, starting at `t0`
function timedWords(text, t0 = 0, step = 0.5) {
  return text.split(' ').map((w, i) => ({ text: w, start: t0 + i * step, end: t0 + (i + 1) * step - 0.05 }));
}

test('tokenize normalises case and punctuation', () => {
  assert.deepEqual(tokenize('Kia ora, Mere!  "Tēnā" koe.'), ['kia', 'ora', 'mere', 'tēnā', 'koe']);
});

test('word similarity tolerates spelling and diacritic differences', () => {
  assert.equal(wordSimilarity('tēnā', 'tēnā'), 1);
  assert.equal(wordSimilarity('tēnā', 'tena'), 0.95);
  assert.ok(wordSimilarity('wharenui', 'farenui') > 0.7);
  assert.ok(wordSimilarity('dog', 'house') < 0.3);
});

test('alignTokens pairs equal words and skips insertions', () => {
  const pairs = alignTokens(['the', 'cat', 'sat'], ['uh', 'the', 'cat', 'sat']);
  assert.deepEqual(pairs.map(p => p && p.j), [1, 2, 3]);
});

test('banded alignment matches full alignment on long input', () => {
  const words = Array.from({ length: 3000 }, (_, i) => `w${i % 97}x${i % 13}`);
  const asr = words.filter((_, i) => i % 50 !== 0);   // Whisper dropped some words
  const banded = alignTokens(words, asr, { maxCells: 100_000 });
  const matched = banded.filter(p => p && p.sim === 1).length;
  assert.ok(matched >= asr.length * 0.98, `matched ${matched} of ${asr.length}`);
});

test('utterances get the times of the Whisper words they match', () => {
  const asr = [...timedWords('hello there my friend', 1), ...timedWords('how are you today', 5)];
  const utterances = [{ text: 'Hello there, my friend.' }, { text: 'How are you today?' }];
  const segs = [{ start: 1, end: 3 }, { start: 5, end: 7 }];
  const [a, b] = alignUtterances(utterances, asr, segs, 10);
  assert.equal(a.start, 1);
  assert.equal(a.end, 3);
  assert.equal(b.start, 5);
  assert.equal(b.end, 7);
  assert.equal(a.status, 'matched');
  assert.equal(b.matchedWords, 4);
});

test('manual text wins where Whisper is wrong; unmatched words are interpolated', () => {
  // Whisper misheard the middle utterance entirely
  const asr = [...timedWords('one two three', 0), ...timedWords('blah blah blah', 2), ...timedWords('seven eight nine', 4)];
  const utterances = [{ text: 'one two three' }, { text: 'four five six' }, { text: 'seven eight nine' }];
  const segs = [{ start: 0, end: 1.5 }, { start: 2, end: 3.5 }, { start: 4, end: 5.5 }];
  const [a, b, c] = alignUtterances(utterances, asr, segs, 6);
  assert.equal(b.status, 'interpolated');
  assert.equal(b.text, 'four five six');
  assert.ok(b.start >= a.end && b.end <= c.start, JSON.stringify([a, b, c]));
  // Snapped onto the speech segment Whisper heard in that gap
  assert.equal(b.start, 2);
  assert.equal(b.end, 3.5);
});

test('interpolation only spends time where there is speech', () => {
  // No Whisper words at all: times come from VAD speech alone, by text length
  const utterances = [{ text: 'aaaa' }, { text: 'bbbb' }];
  const segs = [{ start: 0, end: 2 }, { start: 10, end: 12 }];
  const [a, b] = alignUtterances(utterances, [], segs, 12);
  assert.deepEqual([a.start, a.end], [0, 2]);
  assert.deepEqual([b.start, b.end], [10, 12]);
});

test('utterances never overlap and stay in order', () => {
  const asr = timedWords('a b c d e f g h', 0, 0.3);
  const utterances = [{ text: 'a b c' }, { text: 'c d e' }, { text: 'f g h' }];
  const out = alignUtterances(utterances, asr, [{ start: 0, end: 2.4 }], 3);
  for (let i = 1; i < out.length; i++) assert.ok(out[i].start >= out[i - 1].end, JSON.stringify(out));
});

test('chunksToWords spreads segment-level chunks over their words', () => {
  const words = chunksToWords([{ text: ' ab cd', timestamp: [1, 2] }], 0, 5);
  assert.deepEqual(words, [{ text: 'ab', start: 1, end: 1.5 }, { text: 'cd', start: 1.5, end: 2 }]);
});
