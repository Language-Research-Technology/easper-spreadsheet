// Read a manual transcription spreadsheet into utterances.
// Expected: one utterance per row, in spoken order. A header row is optional;
// when present, a text/transcription column and an optional speaker column are
// picked up by name. Without a header, the first column is the text.
// In a workbook, the sheet that looks most like a transcript is used.

// In order of preference. "IU" is an intonation unit (Du Bois-style transcripts).
const TEXT_HEADERS = ['text', 'transcription', 'utterance', 'iu', 'intonation unit', 'sentence', 'annotation', 'value',
  'manual', 'manual transcription', 'transcript'];
const SPEAKER_HEADERS = ['speaker', 'tier', 'participant', 'speaker id', 'spk', 'name'];

export const ACCEPT = '.xlsx,.xls,.ods,.csv,.tsv,.txt';

/** Minimal RFC 4180 parser (quotes, escaped quotes, embedded newlines). */
export function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function norm(cell) {
  return String(cell ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

const cellText = c => String(c ?? '').trim();
const firstRowIndex = rows => rows.findIndex(r => r.some(c => cellText(c)));

/** Spreadsheet-style column letter: 0 -> A, 26 -> AA. */
export function columnLetter(i) {
  let s = '';
  for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

/**
 * Guess which rows/columns hold the transcript: {headerRow, textCol, speakerCol}.
 * headerRow is a row index (-1 for none); speakerCol is -1 for none.
 */
export function detectMapping(rows) {
  const top = firstRowIndex(rows);
  if (top < 0) return { headerRow: -1, textCol: 0, speakerCol: -1 };
  const header = rows[top].map(norm);
  const body = rows.slice(top + 1).map(r => r.map(cellText));
  // A column holding the same value in (nearly) every row, like the recording
  // name, is a label rather than the transcript
  const isConstant = col => {
    const values = body.map(r => r[col]).filter(Boolean);
    if (values.length <= 5) return false;
    const counts = new Map();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    return Math.max(...counts.values()) >= values.length * 0.98;
  };
  const findHeader = names => {
    for (const name of names) {
      const col = header.indexOf(name);
      if (col >= 0 && !isConstant(col)) return col;
    }
    return -1;
  };
  let textCol = findHeader(TEXT_HEADERS);
  const speakerCol = findHeader(SPEAKER_HEADERS);
  if (textCol < 0 && speakerCol < 0) {
    // No recognised header: assume none, and use the first column with text
    const first = rows[top].findIndex(c => cellText(c));
    return { headerRow: -1, textCol: Math.max(0, first), speakerCol: -1 };
  }
  // Header names a speaker column but no text column: take the first other column
  if (textCol < 0) textCol = header.findIndex((h, i) => i !== speakerCol && h);
  return { headerRow: top, textCol: Math.max(0, textCol), speakerCol };
}

/** Non-empty columns of a sheet, for column pickers: [{index, letter, header, sample}]. */
export function describeColumns(rows, headerRow = -1) {
  const width = Math.min(200, Math.max(0, ...rows.map(r => r.length)));
  const start = headerRow >= 0 ? headerRow + 1 : Math.max(0, firstRowIndex(rows));
  const columns = [];
  for (let c = 0; c < width; c++) {
    const header = headerRow >= 0 ? cellText(rows[headerRow]?.[c]) : '';
    let sample = '';
    for (let r = start; r < rows.length && !sample; r++) sample = cellText(rows[r]?.[c]);
    if (header || sample) columns.push({ index: c, letter: columnLetter(c), header, sample });
  }
  return columns;
}

/** Apply a mapping to a sheet's rows: [{row, text, speaker}], skipping rows without text. */
export function toUtterances(rows, { headerRow = -1, textCol = 0, speakerCol = -1 } = {}) {
  const utterances = [];
  for (let i = headerRow >= 0 ? headerRow + 1 : 0; i < rows.length; i++) {
    const cells = rows[i] || [];
    const text = cellText(cells[textCol]).replace(/\s+/g, ' ');
    if (!text) continue;
    utterances.push({ row: i + 1, text, speaker: speakerCol >= 0 ? cellText(cells[speakerCol]) : '' });
  }
  return utterances;
}

/**
 * Join runs of consecutive rows from the same speaker into one utterance,
 * e.g. a turn transcribed as several intonation units. Merged utterances keep
 * the first row number and gain rowEnd.
 */
export function mergeSpeakerRuns(utterances) {
  const out = [];
  for (const u of utterances) {
    const last = out[out.length - 1];
    if (last && u.speaker && u.speaker === last.speaker) {
      last.text = `${last.text} ${u.text}`;
      last.rowEnd = u.row;
    } else out.push({ ...u });
  }
  return out;
}

/** Row label for an utterance: "5" or "5–9" for merged rows. */
export const rowLabel = u => (u.rowEnd && u.rowEnd !== u.row ? `${u.row}–${u.rowEnd}` : `${u.row}`);

/** Convert raw rows (arrays of cells) to [{row, text, speaker}] using the detected mapping. */
export function rowsToUtterances(rows) {
  if (firstRowIndex(rows) < 0) throw new Error('The spreadsheet is empty.');
  const utterances = toUtterances(rows, detectMapping(rows));
  if (!utterances.length) throw new Error('No transcriptions found in the spreadsheet.');
  return utterances;
}

/** Split plain-text content into rows by file name (csv / tsv / txt). */
export function parseTextRows(name, content) {
  const ext = name.toLowerCase().split('.').pop();
  const text = content.replace(/^\uFEFF/, '');
  if (ext === 'csv') {
    const rows = parseDelimited(text, ',');
    // A one-column sheet (e.g. a "text" header) is often saved without quoting
    // commas inside sentences, so read it line by line instead
    const firstRow = rows.find(r => r.some(c => c.trim()));
    if (firstRow && firstRow.length === 1) return text.split(/\r?\n/).map(line => [line]);
    return rows;
  }
  if (ext === 'tsv' || (ext === 'txt' && text.includes('\t'))) return parseDelimited(text, '\t');
  return text.split(/\r?\n/).map(line => [line]);
}

/** Parse plain-text content by file name (csv / tsv / txt) into utterances. */
export function parseTextFile(name, content) {
  return rowsToUtterances(parseTextRows(name, content));
}

/**
 * Pick the sheet that looks most like a transcript: one with a recognised
 * text column, then the most utterances. Returns {index, name, utterances}.
 */
export function chooseSheet(sheets) {
  let best = null;
  sheets.forEach(({ name, rows }, index) => {
    let utterances;
    try { utterances = rowsToUtterances(rows); } catch { return; }
    const header = (rows.find(r => r.some(c => cellText(c))) || []).map(norm);
    const named = TEXT_HEADERS.some(h => header.includes(h));
    const score = (named ? 1e9 : 0) + utterances.length;
    if (!best || score > best.score) best = { index, name, utterances, score };
  });
  if (!best) throw new Error('No transcriptions found in any sheet.');
  return { index: best.index, name: best.name, utterances: best.utterances };
}

/** Browser entry point: read a File into sheets of raw rows: [{name, rows}]. */
export async function readSheets(file) {
  const ext = file.name.toLowerCase().split('.').pop();
  if (['xlsx', 'xls', 'ods'].includes(ext)) {
    const XLSX = await import('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm');
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    return wb.SheetNames.map(name => ({
      name, rows: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '' }),
    }));
  }
  return [{ name: file.name, rows: parseTextRows(file.name, await file.text()) }];
}
