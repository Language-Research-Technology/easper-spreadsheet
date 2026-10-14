import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDelimited, parseTextFile, rowsToUtterances } from '../js/spreadsheet.js';
import { segmentsCleanup } from '../js/segments.js';
import { toCsv, toEaf } from '../js/export.js';

test('parseDelimited handles quotes, commas and newlines', () => {
  assert.deepEqual(parseDelimited('a,"b, c","say ""hi"""\r\n"multi\nline",x\n', ','), [
    ['a', 'b, c', 'say "hi"'],
    ['multi\nline', 'x'],
  ]);
});

test('header row picks text and speaker columns', () => {
  const u = rowsToUtterances([['#', 'Speaker', 'Transcription'], ['1', 'A', 'kia ora'], ['2', '', ''], ['3', 'B', 'tēnā koe']]);
  assert.deepEqual(u, [
    { row: 2, text: 'kia ora', speaker: 'A' },
    { row: 4, text: 'tēnā koe', speaker: 'B' },
  ]);
});

test('no header: first column is the text', () => {
  assert.deepEqual(parseTextFile('t.csv', 'first line,note\nsecond line,\n').map(u => u.text), ['first line', 'second line']);
  assert.deepEqual(parseTextFile('t.txt', '﻿one\n\ntwo\n').map(u => u.text), ['one', 'two']);
});

test('one-column csv keeps unquoted commas in the text', () => {
  assert.deepEqual(parseTextFile('t.csv', 'text\nBy noon, they left.\n').map(u => u.text), ['By noon, they left.']);
});

test('empty sheets are rejected', () => {
  assert.throws(() => parseTextFile('t.csv', 'text\n\n'), /No transcriptions/);
});

test('segmentsCleanup merges close segments and drops short ones like Easper', () => {
  const out = segmentsCleanup([
    { start: 0, end: 1, speakerId: 1 },
    { start: 1.2, end: 2, speakerId: 1 },   // gap 0.2 < 0.5: merged
    { start: 4, end: 4.3, speakerId: 1 },   // shorter than 0.5: dropped
    { start: 6, end: 40, speakerId: 1 },    // longer than 30: split
  ]);
  assert.deepEqual(out.map(s => [s.start, s.end]), [[0, 2], [6, 36], [36, 40]]);
});

test('exports include timecodes', () => {
  const aligned = [{ row: 2, speaker: 'A', start: 1.5, end: 3.25, confidence: 0.9, status: 'matched', text: 'hi, "you"' }];
  assert.equal(toCsv(aligned).split('\n')[1], '2,A,1.500,3.250,00:00:01.500,00:00:03.250,0.90,matched,"hi, ""you"""');
  const eaf = toEaf('rec.wav', [{ id: 'Manual', annotations: aligned }]);
  assert.match(eaf, /TIME_VALUE="1500"/);
  assert.match(eaf, /<ANNOTATION_VALUE>hi, &quot;you&quot;<\/ANNOTATION_VALUE>/);
});
