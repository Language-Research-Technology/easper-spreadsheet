// Two-handle slider for the working range, styled after Easper's "Portion to segment".
import { formatClock } from './range.js';
import { formatClock as formatShortClock } from './waveform.js';

const MIN_GAP = 0.5; // seconds
const STEP = 0.1;

/**
 * @param root  container element; the slider markup is created inside it
 * @param onChange  called with {start, end} (or null for the whole recording) as the handles move
 */
export function createRangeSlider(root, onChange) {
  root.innerHTML = `
    <div class="rs-head">
      <span class="rs-title"><span aria-hidden="true">🕒</span> Portion to segment</span>
      <button type="button" class="rs-reset">Reset to full</button>
    </div>
    <div class="rs-track-wrap">
      <div class="rs-track"><div class="rs-fill"></div></div>
      <div class="rs-playhead" title="Playhead"></div>
      <button type="button" class="rs-thumb" data-end="start" role="slider" aria-label="Range start"></button>
      <button type="button" class="rs-thumb" data-end="end" role="slider" aria-label="Range end"></button>
    </div>
    <div class="rs-labels"><span class="rs-min">00:00</span><span class="rs-selected"></span><span class="rs-max">--:--</span></div>
    <div class="rs-times">
      <div><div class="rs-time-label">Start</div><div class="rs-time rs-start-time">--:--</div></div>
      <div class="rs-time-end"><div class="rs-time-label">End</div><div class="rs-time rs-end-time">--:--</div></div>
    </div>`;

  const wrap = root.querySelector('.rs-track-wrap');
  const fill = root.querySelector('.rs-fill');
  const playhead = root.querySelector('.rs-playhead');
  const thumbs = { start: root.querySelector('[data-end="start"]'), end: root.querySelector('[data-end="end"]') };
  const selected = root.querySelector('.rs-selected');
  const maxLabel = root.querySelector('.rs-max');
  const reset = root.querySelector('.rs-reset');
  const startTime = root.querySelector('.rs-start-time');
  const endTime = root.querySelector('.rs-end-time');

  let duration = 0, start = 0, end = 0;
  const pct = t => (duration ? (t / duration) * 100 : 0);
  const isFull = () => start <= 0.05 && end >= duration - 0.05;

  function render() {
    fill.style.left = `${pct(start)}%`;
    fill.style.width = `${pct(end) - pct(start)}%`;
    for (const [key, thumb] of Object.entries(thumbs)) {
      const t = key === 'start' ? start : end;
      thumb.style.left = `${pct(t)}%`;
      thumb.dataset.time = formatClock(t);
      thumb.setAttribute('aria-valuemin', '0');
      thumb.setAttribute('aria-valuemax', duration.toFixed(1));
      thumb.setAttribute('aria-valuenow', t.toFixed(1));
      thumb.setAttribute('aria-valuetext', formatClock(t));
      thumb.disabled = !duration;
    }
    selected.textContent = !duration ? '' : isFull() ? 'Whole recording' : `${(end - start).toFixed(1)}s selected`;
    selected.title = duration ? `${formatClock(start)} – ${formatClock(end)}` : '';
    maxLabel.textContent = duration ? formatShortClock(duration) : '--:--';
    reset.hidden = !duration || isFull();
    startTime.textContent = duration ? formatClock(start) : '--:--';
    endTime.textContent = duration ? formatClock(end) : '--:--';
  }

  function emit() {
    render();
    onChange(isFull() ? null : { start, end });
  }

  function setEnd(key, t) {
    t = Math.round(Math.max(0, Math.min(duration, t)) / STEP) * STEP;
    if (key === 'start') start = Math.min(t, end - MIN_GAP);
    else end = Math.max(t, start + MIN_GAP);
    start = Math.max(0, start);
    end = Math.min(duration, end);
  }

  const timeAt = clientX => {
    const r = wrap.getBoundingClientRect();
    return ((clientX - r.left) / r.width) * duration;
  };

  let dragging = null;
  wrap.addEventListener('pointerdown', e => {
    if (!duration) return;
    const t = timeAt(e.clientX);
    // Drag the handle that was grabbed, or the nearer one when the track is clicked
    dragging = e.target.dataset?.end ?? (Math.abs(t - start) <= Math.abs(t - end) ? 'start' : 'end');
    wrap.setPointerCapture(e.pointerId);
    thumbs[dragging].classList.add('active');
    thumbs[dragging].focus();
    setEnd(dragging, t);
    emit();
    e.preventDefault();
  });
  wrap.addEventListener('pointermove', e => {
    if (!dragging) return;
    setEnd(dragging, timeAt(e.clientX));
    emit();
  });
  const stop = () => {
    if (dragging) thumbs[dragging].classList.remove('active');
    dragging = null;
  };
  wrap.addEventListener('pointerup', stop);
  wrap.addEventListener('pointercancel', stop);

  for (const [key, thumb] of Object.entries(thumbs)) {
    thumb.addEventListener('keydown', e => {
      const big = e.shiftKey ? 10 : 1;
      const cur = key === 'start' ? start : end;
      const next = { ArrowLeft: cur - big, ArrowDown: cur - big, ArrowRight: cur + big, ArrowUp: cur + big, Home: 0, End: duration }[e.key];
      if (next === undefined) return;
      e.preventDefault();
      setEnd(key, next);
      emit();
    });
  }
  reset.addEventListener('click', () => { start = 0; end = duration; emit(); });

  return {
    setDuration(d) { duration = d; start = 0; end = d; render(); },
    setRange(range) {
      start = range ? range.start : 0;
      end = range ? range.end : duration;
      render();
    },
    setPlayhead(t) {
      playhead.hidden = !duration;
      playhead.style.left = `${pct(Math.min(duration, Math.max(0, t)))}%`;
    },
  };
}
