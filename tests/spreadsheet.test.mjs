import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseSheet, columnLetter, describeColumns, detectMapping, parseDelimited, parseTextFile, rowsToUtterances, toUtterances } from '../js/spreadsheet.js';
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

test('workbook: picks the transcript sheet, the IU column and the Name column', () => {
  const pivot = [[], [], ['Row Labels', 'Count of Transcript'], ['1', '83'], ['2', '70']];
  const rows = [['Transcript', 'Time', 'IU #', 'Name', 'IU', 'Comments']];
  for (let i = 1; i <= 10; i++) rows.push(['03 Familia', '', String(i), i % 2 ? 'Ángela' : 'Santi', `frase número ${i}`, '']);
  const { name, utterances } = chooseSheet([{ name: 'Sheet2', rows: pivot }, { name: 'Sheet1', rows }]);
  assert.equal(name, 'Sheet1');
  assert.deepEqual(utterances[0], { row: 2, text: 'frase número 1', speaker: 'Ángela' });
  assert.equal(utterances.length, 10);
});

test('columnLetter follows spreadsheet naming', () => {
  assert.deepEqual([0, 4, 25, 26, 27, 701, 702].map(columnLetter), ['A', 'E', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
});

test('detectMapping and describeColumns support choosing columns by hand', () => {
  const rows = [[], ['Recording', 'Who', 'Utterance text', 'Notes'], ['r1', 'Ana', 'hola', ''], ['r1', 'Ben', 'qué tal', 'x'], ['r1', 'Ana', '', '']];
  // Unrecognised headers: no header assumed, first column with text used
  assert.deepEqual(detectMapping(rows), { headerRow: -1, textCol: 0, speakerCol: -1 });
  const cols = describeColumns(rows, 1);
  assert.deepEqual(cols.map(c => [c.letter, c.header, c.sample]), [['A', 'Recording', 'r1'], ['B', 'Who', 'Ana'], ['C', 'Utterance text', 'hola'], ['D', 'Notes', 'x']]);
  // The user's choice: header on row 2, text in C, speaker in B
  assert.deepEqual(toUtterances(rows, { headerRow: 1, textCol: 2, speakerCol: 1 }), [
    { row: 3, text: 'hola', speaker: 'Ana' }, { row: 4, text: 'qué tal', speaker: 'Ben' },
  ]);
  assert.deepEqual(toUtterances(rows, { headerRow: -1, textCol: 2, speakerCol: -1 }).map(u => u.text), ['Utterance text', 'hola', 'qué tal']);
});
