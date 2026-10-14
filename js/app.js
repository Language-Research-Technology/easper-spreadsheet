import { decodeTo16kMono, computePeaks, SAMPLE_RATE } from './audio.js';
import { drawWaveform, formatClock, speakerColor } from './waveform.js';
import { readSpreadsheetFile, ACCEPT } from './spreadsheet.js';
import { alignUtterances } from './align.js';
import { toCsv, toEaf, download, formatTime } from './export.js';
import { formatClock as formatRangeClock, overlapsRange, mergeSegments } from './range.js';
import { createRangeSlider } from './range-slider.js';

const LANGUAGES = [
  ['auto', 'Auto-detect'], ['en', 'English'], ['id', 'Indonesian'], ['ms', 'Malay'], ['tl', 'Tagalog'],
  ['mi', 'Māori'], ['haw', 'Hawaiian'], ['sw', 'Swahili'], ['hi', 'Hindi'], ['bn', 'Bengali'],
  ['ta', 'Tamil'], ['ne', 'Nepali'], ['zh', 'Chinese'], ['ja', 'Japanese'], ['ko', 'Korean'],
  ['vi', 'Vietnamese'], ['th', 'Thai'], ['ar', 'Arabic'], ['fa', 'Persian'], ['tr', 'Turkish'],
  ['ru', 'Russian'], ['fr', 'French'], ['es', 'Spanish'], ['pt', 'Portuguese'], ['de', 'German'],
  ['it', 'Italian'], ['nl', 'Dutch'], ['yo', 'Yoruba'], ['ha', 'Hausa'], ['so', 'Somali'],
];

const $ = id => document.getElementById(id);
const el = {
  audioInput: $('audio-input'), fileName: $('file-name'), play: $('play-btn'),
  zoom: $('zoom'), zoomValue: $('zoom-value'), speed: $('speed'), speedValue: $('speed-value'),
  segRun: $('seg-run'), asrRun: $('asr-run'), asrModel: $('asr-model'), asrLanguage: $('asr-language'),
  asrCount: $('asr-count'), sheetInput: $('sheet-input'), sheetInfo: $('sheet-info'), manualCount: $('manual-count'),
  align: $('align-btn'), exportCsv: $('export-csv'), exportEaf: $('export-eaf'),
  status: $('status'), progress: $('progress'), progressBar: $('progress-bar'), steps: $('steps'),
  timeline: $('timeline'), content: $('timeline-content'), waveSticky: $('wave-sticky'), canvas: $('wave'),
  asrLane: $('asr-lane'), manualLane: $('manual-lane'), player: $('player'),
};

const state = {
  file: null, samples: null, peaks: null, duration: 0,
  segments: [],      // VAD segments [{id, start, end, speakerId}]
  speakerCount: 1,   // speakers found by diarization
  asr: {},           // segment id -> {text, words}
  utterances: [],    // manual transcript rows [{row, text, speaker}]
  aligned: [],       // alignment result
  range: null,       // {start, end} to process only part of the recording; null = whole
  pps: 24, selected: null, hoverTime: null, stopAt: null, busy: false,
};

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });

// ── Status & state ─────────────────────────────────────────────────────────

function setStatus(message, kind = '') {
  el.status.textContent = message;
  el.status.className = `status ${kind}`;
}
function setProgress(fraction) {
  el.progress.hidden = fraction == null;
  el.progressBar.style.width = `${Math.round((fraction ?? 0) * 100)}%`;
}
function setBusy(busy) {
  state.busy = busy;
  refreshControls();
}
function refreshControls() {
  const hasAudio = !!state.samples;
  const hasAsr = Object.keys(state.asr).length > 0;
  el.play.disabled = !hasAudio;
  el.segRun.disabled = !hasAudio || state.busy;
  el.asrRun.disabled = !state.segments.length || state.busy;
  el.align.disabled = !hasAudio || !state.utterances.length || state.busy;
  el.exportCsv.disabled = el.exportEaf.disabled = !state.aligned.length;
  el.asrCount.hidden = !hasAsr;
  el.asrCount.textContent = Object.keys(state.asr).length;
  el.manualCount.hidden = !state.utterances.length;
  el.manualCount.textContent = state.utterances.length;
  const done = { audio: hasAudio, segments: state.segments.length > 0, asr: hasAsr, manual: state.utterances.length > 0, aligned: state.aligned.length > 0 };
  for (const li of el.steps.children) li.classList.toggle('done', !!done[li.dataset.step]);
}

// ── Layout & drawing ───────────────────────────────────────────────────────

const yOf = t => t * state.pps;

function layout() {
  const viewH = el.timeline.clientHeight;
  el.waveSticky.style.height = `${viewH}px`;
  el.content.style.height = `${Math.max(viewH, yOf(state.duration) + 40)}px`;
  renderLanes();
  draw();
}

function draw() {
  drawWaveform(el.canvas, {
    peaks: state.peaks, duration: state.duration, pps: state.pps, scrollTop: el.timeline.scrollTop,
    segments: state.segments, asrSegments: state.asr, aligned: state.aligned, selected: state.selected, speakerCount: state.speakerCount,
    currentTime: el.player.currentTime, hoverTime: state.hoverTime, range: state.range,
  });
}

function blockStyle(node, start, end) {
  node.style.top = `${yOf(start)}px`;
  node.style.height = `${Math.max(26, yOf(end - start))}px`;
}

function renderLanes() {
  el.asrLane.replaceChildren();
  if (!state.segments.length) {
    el.asrLane.append(Object.assign(document.createElement('div'), { className: 'lane-empty', textContent: state.samples ? 'Run Auto Segmentation, then Speech Recognition.' : '' }));
  }
  for (const seg of state.segments) {
    const asr = state.asr[seg.id];
    const node = document.createElement('div');
    node.className = `block asr-block${asr ? ' done' : ''}`;
    blockStyle(node, seg.start, seg.end);
    const colour = speakerColor(seg.speakerId);
    if (asr || state.speakerCount > 1) node.style.borderLeftColor = colour.primary;
    node.innerHTML = `<div class="block-meta">${state.speakerCount > 1 ? `<span class="chip" style="background:${colour.primary}">S${seg.speakerId}</span>` : ''}${formatClock(seg.start)}–${formatClock(seg.end)}</div>`;
    node.append(document.createTextNode(asr ? asr.text || '(no speech recognised)' : '…'));
    node.addEventListener('click', () => playSpan(seg.start, seg.end));
    el.asrLane.append(node);
  }

  el.manualLane.replaceChildren();
  if (!state.aligned.length) {
    const msg = state.utterances.length
      ? `${state.utterances.length} utterances loaded. Click Align to find their timecodes.`
      : state.samples ? 'Upload your manual transcript spreadsheet, then click Align.' : '';
    el.manualLane.append(Object.assign(document.createElement('div'), { className: 'lane-empty', textContent: msg }));
    return;
  }
  for (const u of state.aligned) {
    const node = document.createElement('div');
    node.className = `block manual-block${u.index === state.selected ? ' selected' : ''}`;
    blockStyle(node, u.start, u.end);
    const meta = document.createElement('div');
    meta.className = 'block-meta';
    const diar = state.speakerCount > 1 && u.diarizedSpeaker
      ? `<span class="chip" style="background:${speakerColor(u.diarizedSpeaker).primary}" title="Diarized speaker with the most overlap">S${u.diarizedSpeaker}</span>` : '';
    meta.innerHTML = `${diar}${u.speaker ? `<span class="chip sheet-speaker" title="Speaker from the spreadsheet"></span>` : ''}<button class="play-mini" title="Play">▶</button>
      <span>${formatTime(u.start)} – ${formatTime(u.end)}</span>
      <span class="conf ${u.status}" title="${u.matchedWords}/${u.totalWords} words matched Whisper">${u.status === 'interpolated' ? 'estimated' : Math.round(u.confidence * 100) + '%'}</span>
      <span>row ${u.row}</span>`;
    if (u.speaker) meta.querySelector('.sheet-speaker').textContent = u.speaker;
    node.append(meta, document.createTextNode(u.text));
    node.addEventListener('click', () => selectUtterance(u.index, true));
    meta.querySelector('.play-mini').addEventListener('click', e => { e.stopPropagation(); selectUtterance(u.index, true); });
    el.manualLane.append(node);
  }
}

function selectUtterance(index, play = false) {
  state.selected = index;
  for (const node of el.manualLane.querySelectorAll('.manual-block')) node.classList.remove('selected');
  el.manualLane.children[index]?.classList.add('selected');
  const u = state.aligned[index];
  if (play && u) playSpan(u.start, u.end);
  draw();
}

// ── Playback ───────────────────────────────────────────────────────────────

function playSpan(start, end) {
  el.player.currentTime = start;
  state.stopAt = end;
  el.player.play();
}

function tick() {
  if (state.stopAt != null && el.player.currentTime >= state.stopAt) {
    el.player.pause();
    state.stopAt = null;
  }
  rangeSlider.setPlayhead(el.player.currentTime);
  if (!el.player.paused) {
    // Keep the playhead in view
    const y = yOf(el.player.currentTime), top = el.timeline.scrollTop, h = el.timeline.clientHeight;
    if (y < top || y > top + h * 0.8) el.timeline.scrollTop = Math.max(0, y - h * 0.3);
    draw();
  }
  requestAnimationFrame(tick);
}

el.play.addEventListener('click', () => {
  state.stopAt = null;
  if (el.player.paused) el.player.play(); else el.player.pause();
});
el.player.addEventListener('play', () => { el.play.textContent = '❚❚ Pause'; });
el.player.addEventListener('pause', () => { el.play.textContent = '▶ Play'; draw(); });

el.canvas.addEventListener('click', e => {
  const t = (el.timeline.scrollTop + e.offsetY) / state.pps;
  el.player.currentTime = Math.min(state.duration, Math.max(0, t));
  draw();
});
el.canvas.addEventListener('mousemove', e => { state.hoverTime = (el.timeline.scrollTop + e.offsetY) / state.pps; draw(); });
el.canvas.addEventListener('mouseleave', () => { state.hoverTime = null; draw(); });

el.zoom.addEventListener('input', () => {
  // Zoom around the centre of the view
  const centre = (el.timeline.scrollTop + el.timeline.clientHeight / 2) / state.pps;
  state.pps = Number(el.zoom.value);
  el.zoomValue.textContent = state.pps;
  layout();
  el.timeline.scrollTop = Math.max(0, centre * state.pps - el.timeline.clientHeight / 2);
  draw();
});
el.speed.addEventListener('input', () => {
  el.player.playbackRate = Number(el.speed.value);
  el.speedValue.textContent = `${Number(el.speed.value).toFixed(2)}x`;
});
el.timeline.addEventListener('scroll', draw);
window.addEventListener('resize', layout);

// Close other menus when one opens
for (const menu of document.querySelectorAll('details.menu')) {
  menu.addEventListener('toggle', () => {
    if (menu.open) for (const other of document.querySelectorAll('details.menu')) if (other !== menu) other.open = false;
  });
}
document.addEventListener('click', e => {
  if (!e.target.closest('details.menu')) for (const m of document.querySelectorAll('details.menu')) m.open = false;
});

// ── Audio ──────────────────────────────────────────────────────────────────

el.audioInput.addEventListener('change', async () => {
  const file = el.audioInput.files[0];
  if (!file) return;
  el.audioInput.value = '';
  setBusy(true);
  setStatus(`Decoding ${file.name}…`);
  try {
    const samples = await decodeTo16kMono(file);
    Object.assign(state, {
      file, samples, peaks: computePeaks(samples), duration: samples.length / SAMPLE_RATE,
      segments: [], speakerCount: 1, asr: {}, aligned: [], selected: null, range: null,
    });
    rangeSlider.setDuration(state.duration);
    showRange();
    if (el.player.src) URL.revokeObjectURL(el.player.src);
    el.player.src = URL.createObjectURL(file);
    el.fileName.textContent = `${file.name} · ${formatClock(state.duration)}`;
    worker.postMessage({ type: 'set_audio', audio: samples.slice() });
    el.timeline.scrollTop = 0;
    layout();
    setStatus('Audio loaded. Run Auto Segmentation next.');
  } catch (err) {
    setStatus(`Could not decode ${file.name}: ${err.message}`, 'error');
  } finally {
    setBusy(false);
  }
});

// ── Segmentation & ASR (worker) ────────────────────────────────────────────

// ── Working range ──────────────────────────────────────────────────────────

const rangeSlider = createRangeSlider($('range-slider'), range => {
  state.range = range;
  showRange(false);
});

function showRange(updateSlider = true) {
  const r = state.range;
  if (updateSlider) rangeSlider.setRange(r);
  $('asr-range-note').textContent = r ? ` in the range ${formatRangeClock(r.start)}–${formatRangeClock(r.end)}` : '';
  el.segRun.textContent = r ? 'Run segmentation on range' : 'Run segmentation';
  el.asrRun.textContent = r ? 'Transcribe segments in range' : 'Transcribe segments';
  draw();
}

el.segRun.addEventListener('click', () => {
  $('seg-menu').open = false;
  setBusy(true);
  setProgress(0);
  worker.postMessage({
    type: 'vad',
    range: state.range,
    speakers: Number($('vad-speakers').value),
    diarization: { windowSec: Number($('diar-window').value), periodSec: Number($('diar-period').value) },
    options: {
      threshold: Number($('vad-threshold').value),
      minSilence: Number($('vad-min-silence').value),
      minSegment: Number($('vad-min-segment').value),
      maxSegmentDuration: Number($('vad-max-segment').value),
    },
  });
});

el.asrRun.addEventListener('click', () => {
  $('asr-menu').open = false;
  const targets = state.segments.filter(s => overlapsRange(s, state.range));
  if (!targets.length) {
    setStatus('There are no segments in the selected range. Run Auto Segmentation on it first.', 'warning');
    return;
  }
  for (const s of targets) delete state.asr[s.id];
  setBusy(true);
  setProgress(0);
  layout();
  worker.postMessage({
    type: 'asr',
    segments: targets.map(s => ({ id: s.id, start: s.start, end: s.end })),
    modelId: el.asrModel.value,
    language: el.asrLanguage.value,
  });
});

worker.onmessage = ({ data }) => {
  switch (data.type) {
    case 'status': setStatus(data.message); break;
    case 'warning': setStatus(data.message, 'warning'); break;
    case 'progress': setProgress(data.fraction); break;
    case 'vad_result': {
      // A range run replaces only the segments inside the range
      state.segments = mergeSegments(state.segments, data.segments, data.range);
      const ids = new Set(state.segments.map(s => s.id));
      for (const id of Object.keys(state.asr)) if (!ids.has(Number(id))) delete state.asr[id];
      state.speakerCount = Math.max(data.speakers, new Set(state.segments.map(s => s.speakerId)).size);
      state.aligned = [];
      setProgress(null);
      setBusy(false);
      layout();
      const where = data.range ? ` in ${formatRangeClock(data.range.start)}–${formatRangeClock(data.range.end)}` : '';
      setStatus(`Found ${data.segments.length} speech segments${where}${data.speakers > 1 ? ` from ${data.speakers} speakers` : ''}. Run Speech Recognition next.`);
      break;
    }
    case 'asr_segment': {
      state.asr[data.id] = { text: data.text, words: data.words };
      setProgress((data.index + 1) / data.total);
      refreshControls();
      renderLanes();
      draw();
      break;
    }
    case 'asr_done':
      setProgress(null);
      setBusy(false);
      setStatus('Whisper transcription complete. Upload your manual transcript, then click Align.');
      break;
    case 'error':
      setProgress(null);
      setBusy(false);
      setStatus(data.message, 'error');
      break;
  }
};

// ── Manual transcript & alignment ──────────────────────────────────────────

el.sheetInput.accept = ACCEPT;
el.sheetInput.addEventListener('change', async () => {
  const file = el.sheetInput.files[0];
  if (!file) return;
  el.sheetInput.value = '';
  try {
    state.utterances = await readSpreadsheetFile(file);
    state.aligned = [];
    const speakers = new Set(state.utterances.map(u => u.speaker).filter(Boolean));
    el.sheetInfo.textContent = `${file.name}: ${state.utterances.length} utterances${speakers.size ? `, ${speakers.size} speaker(s)` : ''}.`;
    setStatus(`Loaded ${state.utterances.length} manual utterances from ${file.name}.`);
    refreshControls();
    renderLanes();
  } catch (err) {
    setStatus(`Could not read ${file.name}: ${err.message}`, 'error');
  }
});

el.align.addEventListener('click', () => {
  const words = state.segments.flatMap(s => state.asr[s.id]?.words ?? []);
  state.aligned = alignUtterances(state.utterances, words, state.segments, state.duration)
    .map(u => ({ ...u, diarizedSpeaker: dominantSpeaker(u, state.segments) }));
  state.selected = null;
  const counts = { matched: 0, partial: 0, interpolated: 0 };
  for (const u of state.aligned) if (u.status in counts) counts[u.status]++;
  const note = words.length ? '' : ' No Whisper words yet, so all times are estimated from speech activity.';
  setStatus(`Aligned ${state.aligned.length} utterances: ${counts.matched} matched, ${counts.partial} partial, ${counts.interpolated} estimated.${note}`, words.length ? '' : 'warning');
  refreshControls();
  renderLanes();
  draw();
});

/** Diarized speaker overlapping the utterance the most (null if none). */
function dominantSpeaker(u, segments) {
  const overlap = new Map();
  for (const s of segments) {
    const o = Math.min(u.end, s.end) - Math.max(u.start, s.start);
    if (o > 0) overlap.set(s.speakerId, (overlap.get(s.speakerId) ?? 0) + o);
  }
  let best = null, max = 0;
  for (const [id, o] of overlap) if (o > max) { max = o; best = id; }
  return best;
}

// ── Export ─────────────────────────────────────────────────────────────────

const baseName = () => (state.file?.name ?? 'transcript').replace(/\.[^.]+$/, '');

el.exportCsv.addEventListener('click', () => download(`${baseName()}_aligned.csv`, toCsv(state.aligned, state.speakerCount > 1), 'text/csv'));
el.exportEaf.addEventListener('click', () => {
  const speakers = [...new Set(state.aligned.map(u => u.speaker || 'Manual'))];
  const tiers = speakers.map(sp => ({
    id: sp === 'Manual' ? 'Manual' : `Manual - ${sp}`,
    annotations: state.aligned.filter(u => (u.speaker || 'Manual') === sp),
  }));
  // Whisper tier(s), one per diarized speaker as in Easper
  const speakerIds = [...new Set(state.segments.map(s => s.speakerId))].sort();
  for (const id of speakerIds) {
    tiers.push({
      id: state.speakerCount > 1 ? `Whisper - S${id}` : 'Whisper',
      annotations: state.segments.filter(s => s.speakerId === id && state.asr[s.id]?.text).map(s => ({ start: s.start, end: s.end, text: state.asr[s.id].text })),
    });
  }
  download(`${baseName()}_aligned.eaf`, toEaf(state.file?.name ?? 'audio.wav', tiers), 'application/xml');
});

// ── Init ───────────────────────────────────────────────────────────────────

for (const [code, name] of LANGUAGES) el.asrLanguage.append(new Option(name, code));
el.asrLanguage.value = 'en';
refreshControls();
layout();
showRange();
requestAnimationFrame(tick);
