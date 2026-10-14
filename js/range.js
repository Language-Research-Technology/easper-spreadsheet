// Working range: process only part of the recording, as Easper's interval option does.

/** Format seconds as h:mm:ss.s / mm:ss.s for range labels. */
export function formatClock(sec) {
  const s = Math.max(0, Math.round(sec * 10) / 10);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  const rest = (s % 60).toFixed(1).padStart(4, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${String(m).padStart(2, '0')}:${rest}`;
}

export const overlapsRange = (seg, range) => !range || (seg.end > range.start + 0.05 && seg.start < range.end - 0.05);

/**
 * Replace the segments inside `range` with `fresh` ones, keeping the rest.
 * Kept segments keep their ids (and so their transcriptions); new ones get new ids.
 */
export function mergeSegments(existing, fresh, range) {
  if (!range) return fresh.map((s, i) => ({ ...s, id: i + 1 }));
  const kept = existing.filter(s => !overlapsRange(s, range));
  let nextId = Math.max(0, ...existing.map(s => s.id)) + 1;
  const added = fresh.map(s => ({ ...s, id: nextId++ }));
  return [...kept, ...added].sort((a, b) => a.start - b.start);
}
