import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClock, formatClock, normalizeRange, mergeSegments } from '../js/range.js';

test('parseClock accepts seconds, mm:ss and h:mm:ss', () => {
  assert.equal(parseClock('12.5'), 12.5);
  assert.equal(parseClock('01:02.5'), 62.5);
  assert.equal(parseClock('1:00:02'), 3602);
  assert.equal(parseClock('1:02,5'), 62.5);
  assert.equal(parseClock(''), null);
  assert.equal(parseClock('abc'), null);
  assert.equal(parseClock('1:2:3:4'), null);
});

test('formatClock round-trips through parseClock', () => {
  for (const t of [0, 9.5, 62.3, 3725.1]) assert.equal(parseClock(formatClock(t)), t);
  assert.equal(formatClock(62.34), '01:02.3');
});

test('normalizeRange clamps, orders, and treats the whole recording as no range', () => {
  assert.deepEqual(normalizeRange(5, 20, 31), { start: 5, end: 20 });
  assert.deepEqual(normalizeRange(20, 5, 31), { start: 5, end: 20 });
  assert.deepEqual(normalizeRange(-3, 99, 31), null);
  assert.equal(normalizeRange(5, 5.2, 31).invalid, true);
});

test('mergeSegments replaces only the segments inside the range', () => {
  const existing = [{ id: 1, start: 0, end: 3 }, { id: 2, start: 4, end: 7 }, { id: 3, start: 9, end: 12 }];
  const fresh = [{ start: 4.2, end: 5 }, { start: 5.5, end: 7 }];
  assert.deepEqual(mergeSegments(existing, fresh, { start: 3.5, end: 8 }), [
    { id: 1, start: 0, end: 3 }, { id: 4, start: 4.2, end: 5 }, { id: 5, start: 5.5, end: 7 }, { id: 3, start: 9, end: 12 },
  ]);
  assert.deepEqual(mergeSegments(existing, fresh, null).map(s => s.id), [1, 2]);
});
