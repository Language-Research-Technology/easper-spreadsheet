import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatClock, mergeSegments } from '../js/range.js';

test('formatClock shows tenths, with hours only when needed', () => {
  assert.equal(formatClock(0), '00:00.0');
  assert.equal(formatClock(62.34), '01:02.3');
  assert.equal(formatClock(3725.1), '1:02:05.1');
});

test('mergeSegments replaces only the segments inside the range', () => {
  const existing = [{ id: 1, start: 0, end: 3 }, { id: 2, start: 4, end: 7 }, { id: 3, start: 9, end: 12 }];
  const fresh = [{ start: 4.2, end: 5 }, { start: 5.5, end: 7 }];
  assert.deepEqual(mergeSegments(existing, fresh, { start: 3.5, end: 8 }), [
    { id: 1, start: 0, end: 3 }, { id: 4, start: 4.2, end: 5 }, { id: 5, start: 5.5, end: 7 }, { id: 3, start: 9, end: 12 },
  ]);
  assert.deepEqual(mergeSegments(existing, fresh, null).map(s => s.id), [1, 2]);
});
