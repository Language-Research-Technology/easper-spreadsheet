// Vertical waveform in the style of Easper web's transcriber: time runs top to
// bottom, amplitude is mirrored around the centre line, and detected speech /
// segments tint the bars. Only the visible part is drawn onto a canvas that
// stays pinned to the viewport while the timeline scrolls.
import { PEAKS_PER_SECOND } from './audio.js';

const COLORS = {
  bg: '#090d16',
  gutter: '#070b13',
  grid: '#1e293b',
  label: '#64748b',
  silence: '#64748b',
  vad: '#10b981',
  vadFill: 'rgba(16, 185, 129, 0.16)',
  manual: '#f59e0b',
  selected: '#38bdf8',
  playhead: '#ef4444',
};

// Easper's speaker palette
export const SPEAKER_COLORS = {
  1: { primary: '#0284c7', fill: 'rgba(2, 132, 199, 0.22)', bg: '#e0f2fe' },
  2: { primary: '#7c3aed', fill: 'rgba(124, 58, 237, 0.22)', bg: '#ede9fe' },
  3: { primary: '#059669', fill: 'rgba(5, 150, 105, 0.22)', bg: '#d1fae5' },
  4: { primary: '#d97706', fill: 'rgba(217, 119, 6, 0.22)', bg: '#fef3c7' },
  5: { primary: '#e11d48', fill: 'rgba(225, 29, 72, 0.22)', bg: '#ffe4e6' },
};
export const speakerColor = id => SPEAKER_COLORS[id] ?? SPEAKER_COLORS[1];

const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

export function formatClock(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const mm = String(m).padStart(2, '0'), ss = String(r).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {object} v  { peaks, duration, pps, scrollTop, segments, asrSegments, aligned, selected, currentTime, hoverTime }
 */
export function drawWaveform(canvas, v) {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth, height = canvas.clientHeight;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, width, height);

  if (!v.peaks?.length) {
    ctx.fillStyle = '#334155';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Awaiting audio…', width / 2, 40);
    ctx.restore();
    return;
  }

  const gutter = 54;
  const laneLeft = gutter, laneWidth = width - gutter - 6;
  const centre = laneLeft + laneWidth / 2, half = (laneWidth / 2) * 0.92;
  const { pps, scrollTop } = v;
  const t0 = scrollTop / pps, t1 = (scrollTop + height) / pps;
  const y = t => (t - t0) * pps;

  // Time gutter
  ctx.fillStyle = COLORS.gutter;
  ctx.fillRect(0, 0, gutter, height);
  ctx.strokeStyle = COLORS.grid;
  ctx.beginPath(); ctx.moveTo(gutter, 0); ctx.lineTo(gutter, height); ctx.stroke();
  const step = TICK_STEPS.find(s => s * pps >= 28) ?? 600;
  ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let t = Math.ceil(t0 / step) * step; t <= Math.min(t1, v.duration); t += step) {
    const yy = y(t);
    ctx.strokeStyle = COLORS.grid;
    ctx.beginPath(); ctx.moveTo(gutter - 5, yy); ctx.lineTo(width, yy); ctx.stroke();
    ctx.fillStyle = COLORS.label;
    ctx.fillText(formatClock(t), gutter - 7, yy);
  }

  // Region fills: VAD segments, then manual utterances as a right-edge bar
  const segs = v.segments || [];
  for (const s of segs) {
    if (s.end < t0 || s.start > t1) continue;
    const top = y(s.start), h = Math.max(2, (s.end - s.start) * pps);
    const c = speakerColor(s.speakerId);
    const coloured = v.asrSegments?.[s.id] || v.speakerCount > 1;
    ctx.fillStyle = coloured ? c.fill : COLORS.vadFill;
    ctx.fillRect(laneLeft, top, laneWidth, h);
    ctx.fillStyle = coloured ? c.primary : COLORS.vad;
    ctx.fillRect(laneLeft, top, 3.5, h);
  }
  for (const u of v.aligned || []) {
    if (u.end < t0 || u.start > t1 || u.end <= u.start) continue;
    ctx.fillStyle = u.index === v.selected ? COLORS.selected : COLORS.manual;
    ctx.fillRect(laneLeft + laneWidth - 3, y(u.start), 3, Math.max(2, (u.end - u.start) * pps));
  }
  const sel = v.aligned?.[v.selected];
  if (sel) {
    ctx.fillStyle = 'rgba(56, 189, 248, 0.18)';
    ctx.fillRect(laneLeft, y(sel.start), laneWidth, Math.max(2, (sel.end - sel.start) * pps));
    ctx.strokeStyle = COLORS.selected;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(laneLeft, y(sel.start), laneWidth, Math.max(2, (sel.end - sel.start) * pps));
  }

  // Amplitude bars, one per pixel row (max of the peaks it covers)
  const peaks = v.peaks;
  let segIdx = 0;
  ctx.lineWidth = 1;
  for (let row = 0; row < height; row++) {
    const ta = t0 + row / pps, tb = t0 + (row + 1) / pps;
    const pa = Math.floor(ta * PEAKS_PER_SECOND), pb = Math.max(pa + 1, Math.ceil(tb * PEAKS_PER_SECOND));
    if (pa >= peaks.length) break;
    let m = 0;
    for (let p = Math.max(0, pa); p < Math.min(peaks.length, pb); p++) if (peaks[p] > m) m = peaks[p];
    if (m < 0.01) continue;
    const t = (ta + tb) / 2;
    while (segIdx < segs.length && segs[segIdx].end < t) segIdx++;
    const inSeg = segIdx < segs.length && t >= segs[segIdx].start;
    const seg = inSeg ? segs[segIdx] : null;
    ctx.strokeStyle = !seg ? COLORS.silence : v.asrSegments?.[seg.id] || v.speakerCount > 1 ? speakerColor(seg.speakerId).primary : COLORS.vad;
    const w = half * m;
    ctx.beginPath(); ctx.moveTo(centre - w, row + 0.5); ctx.lineTo(centre + w, row + 0.5); ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.beginPath(); ctx.moveTo(centre, 0); ctx.lineTo(centre, height); ctx.stroke();

  // Hover line and playhead
  if (v.hoverTime != null && v.hoverTime >= t0 && v.hoverTime <= t1) {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(laneLeft, y(v.hoverTime)); ctx.lineTo(width, y(v.hoverTime)); ctx.stroke();
    ctx.setLineDash([]);
  }
  if (v.currentTime >= t0 && v.currentTime <= t1) {
    const yy = y(v.currentTime);
    ctx.strokeStyle = COLORS.playhead;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(laneLeft, yy); ctx.lineTo(width, yy); ctx.stroke();
    ctx.fillStyle = COLORS.playhead;
    ctx.beginPath(); ctx.arc(laneLeft + 3, yy, 4, 0, Math.PI * 2); ctx.fill();
    ctx.font = 'bold 9px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'right';
    ctx.fillText(formatClock(v.currentTime), gutter - 6, yy);
  }
  ctx.restore();
}
