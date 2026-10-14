// Read a manual transcription spreadsheet into utterances.
// Expected: one utterance per row, in spoken order. A header row is optional;
// when present, a text/transcription column and an optional speaker column are
// picked up by name. Without a header, the first column is the text.

const TEXT_HEADERS = ['text', 'transcription', 'transcript', 'utterance', 'sentence', 'annotation', 'value', 'manual', 'manual transcription'];
const SPEAKER_HEADERS = ['speaker', 'tier', 'participant', 'speaker id', 'spk'];

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

/** Convert raw rows (arrays of cells) to [{row, text, speaker}]. */
export function rowsToUtterances(rows) {
  const numbered = rows
    .map((r, i) => ({ line: i + 1, cells: r.map(c => String(c ?? '').trim()) }))
    .filter(r => r.cells.some(Boolean));
  if (!numbered.length) throw new Error('The spreadsheet is empty.');

  const header = numbered[0].cells.map(norm);
  let textCol = header.findIndex(h => TEXT_HEADERS.includes(h));
  let speakerCol = header.findIndex(h => SPEAKER_HEADERS.includes(h));
  let data = numbered;
  if (textCol >= 0 || speakerCol >= 0) {
    data = numbered.slice(1);
    if (textCol < 0) {
      // Header names a speaker column but no text column: take the first other column
      textCol = header.findIndex((_, i) => i !== speakerCol);
    }
  } else {
    textCol = 0;
    speakerCol = -1;
  }

  const utterances = [];
  for (const { line, cells } of data) {
    const text = (cells[textCol] ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    utterances.push({ row: line, text, speaker: speakerCol >= 0 ? cells[speakerCol] ?? '' : '' });
  }
  if (!utterances.length) throw new Error('No transcriptions found in the spreadsheet.');
  return utterances;
}

/** Parse plain-text content by file name (csv / tsv / txt). */
export function parseTextFile(name, content) {
  const ext = name.toLowerCase().split('.').pop();
  const text = content.replace(/^﻿/, '');
  if (ext === 'csv') {
    const rows = parseDelimited(text, ',');
    // A one-column sheet (e.g. a "text" header) is often saved without quoting
    // commas inside sentences, so read it line by line instead
    const firstRow = rows.find(r => r.some(c => c.trim()));
    if (firstRow && firstRow.length === 1) return rowsToUtterances(text.split(/\r?\n/).map(line => [line]));
    return rowsToUtterances(rows);
  }
  if (ext === 'tsv' || (ext === 'txt' && text.includes('\t'))) return rowsToUtterances(parseDelimited(text, '\t'));
  return rowsToUtterances(text.split(/\r?\n/).map(line => [line]));
}

/** Browser entry point: read a File into utterances. */
export async function readSpreadsheetFile(file) {
  const ext = file.name.toLowerCase().split('.').pop();
  if (['xlsx', 'xls', 'ods'].includes(ext)) {
    const XLSX = await import('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm');
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
    return rowsToUtterances(rows);
  }
  return parseTextFile(file.name, await file.text());
}
