// Working range: process only part of the recording, as Easper's interval option does.

/** Parse "h:mm:ss(.s)", "mm:ss(.s)" or seconds. Returns null if invalid. */
export function parseClock(text) {
  const parts = String(text ?? '').trim().replace(',', '.').split(':');
  if (!parts[0] && parts.length === 1) return null;
  if (parts.length > 3 || parts.some(p => !/^\d+(\.\d*)?$/.test(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}

/** Format seconds as h:mm:ss.s / mm:ss.s for the range inputs. */
export function formatClock(sec) {
  const s = Math.max(0, Math.round(sec * 10) / 10);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  const rest = (s % 60).toFixed(1).padStart(4, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${String(m).padStart(2, '0')}:${rest}`;
}

/**
 * Normalise a range against the recording: clamp, order, and return null when
 * it covers (practically) the whole recording.
 */
export function normalizeRange(start, end, duration) {
  let a = Math.max(0, Math.min(duration, start ?? 0));
  let b = Math.max(0, Math.min(duration, end ?? duration));
  if (b < a) [a, b] = [b, a];
  if (b - a < 0.5) return { invalid: true, start: a, end: b };
  if (a <= 0.05 && b >= duration - 0.05) return null;
  return { start: a, end: b };
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
