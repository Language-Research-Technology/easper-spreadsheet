import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignTokens, alignUtterances, chunksToWords, dropRepetitions, speechText, tokenize, wordSimilarity } from '../js/align.js';

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

test('unmatched words with no speech of their own share time with the next matched word', () => {
  // Whisper misheard "by noon the boat" in a short segment as "the following report"
  const asr = [
    ...timedWords('circled overhead', 15.5, 0.8),
    { text: 'The', start: 19.3, end: 19.5 }, { text: 'following', start: 19.5, end: 19.9 },
    { text: 'report', start: 19.9, end: 20.2 }, { text: 'was', start: 20.2, end: 20.4 }, { text: 'ready', start: 20.4, end: 20.67 },
  ];
  const segs = [{ start: 14.27, end: 17.15 }, { start: 19.3, end: 20.67 }];
  const [a, b] = alignUtterances([{ text: 'circled overhead.' }, { text: 'By noon the boat was ready.' }], asr, segs, 25);
  assert.equal(a.end, 17.15);
  assert.equal(b.start, 19.3);
  assert.equal(b.end, 20.67);
});

test('a transcript longer than the processed audio: only the rows that were spoken get times', () => {
  // The transcript has 9 rows; only rows 4-6 were in the segmented range (100-106 s)
  const rows = ['uno dos tres', 'cuatro cinco', 'seis siete ocho', 'que te compró tu mami', 'amor pero que me lo mida',
    'le quedó grande', 'van a comprar la camioneta', 'es lo mismo que nosotros', 'hacemos por ejemplo'];
  const utterances = rows.map(text => ({ text }));
  const asr = [...timedWords('que te compro tu mami', 100), ...timedWords('amor pero que me lo mira', 102.5), ...timedWords('le quedo grande', 105.5)];
  const segs = [{ start: 100, end: 102.45 }, { start: 102.5, end: 105.45 }, { start: 105.5, end: 106.95 }];
  const out = alignUtterances(utterances, asr, segs, 600);
  assert.deepEqual(out.map(r => r.status), ['outside', 'outside', 'outside', 'matched', 'matched', 'matched', 'outside', 'outside', 'outside']);
  assert.equal(out[3].start, 100);
  assert.equal(out[5].end, 106.95);
  assert.equal(out[0].start, null);
});

test('re-timing neighbouring matches is capped, so crowded rows cannot wipe out every match', () => {
  // Far more transcript than speech: without the cap, borrowing cascaded and nothing matched
  const asr = timedWords('a b c d e f g h i j', 0, 0.2);
  const utterances = [{ text: 'a b c d e' }, { text: 'zz yy xx ww vv uu tt ss rr qq pp oo' }, { text: 'f g h i j' }];
  const out = alignUtterances(utterances, asr, [{ start: 0, end: 2 }], 2);
  assert.equal(out[0].status, 'matched');
  assert.ok(out[2].matchedWords >= 2, JSON.stringify(out[2]));
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

test('dropRepetitions collapses Whisper loops and caps the speaking rate', () => {
  const loop = timedWords('sabes ' + 'que lo que me hace es '.repeat(20) + 'fin', 0, 0.05);
  assert.deepEqual(dropRepetitions(loop, 0, 10).map(w => w.text).join(' '), 'sabes que lo que me hace es fin');
  // Ordinary repeats ("no no") are kept
  assert.equal(dropRepetitions(timedWords('no no quiero'), 0, 2).length, 3);
  assert.equal(dropRepetitions(timedWords('a b c d e f g h i j k l m'), 0, 1).length, 6);
});

test('speechText drops transcription conventions that are not speech', () => {
  assert.deepEqual(tokenize(speechText('...(6.0) Qué te compró tu mami? ((A HAS JUST GOT OFF THE PHONE FROM HER))')), ['qué', 'te', 'compró', 'tu', 'mami']);
  assert.deepEqual(tokenize(speechText('XX --')), []);
  assert.deepEqual(tokenize(speechText('[Me=] -- pero que me lo mi=da,')), ['me', 'pero', 'que', 'me', 'lo', 'mida']);
  assert.deepEqual(tokenize(speechText('Xavier dijo')), ['xavier', 'dijo']);
});
