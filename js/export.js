// Export aligned utterances as CSV and as an ELAN (.eaf) file.

export function formatTime(sec, withMs = true) {
  const s = Math.max(0, sec || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  const ss = withMs ? rest.toFixed(3).padStart(6, '0') : String(Math.floor(rest)).padStart(2, '0');
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${ss}`;
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(aligned, withDiarization = false) {
  const header = ['row', 'speaker', ...(withDiarization ? ['diarized_speaker'] : []), 'start', 'end', 'start_time', 'end_time', 'confidence', 'status', 'text'];
  const lines = [header.join(',')];
  for (const r of aligned) {
    const diar = withDiarization ? [r.diarizedSpeaker ? `S${r.diarizedSpeaker}` : ''] : [];
    const timed = r.start !== null;
    const times = timed ? [r.start.toFixed(3), r.end.toFixed(3), formatTime(r.start), formatTime(r.end)] : ['', '', '', ''];
    lines.push([r.row, r.speaker, ...diar, ...times, r.confidence.toFixed(2), r.status, r.text].map(csvCell).join(','));
  }
  return lines.join('\n') + '\n';
}

function xml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * @param tiers  Array<{ id: string, annotations: Array<{start, end, text}> }>
 */
export function toEaf(mediaName, tiers) {
  const slots = [];
  const slotId = ms => { slots.push(ms); return `ts${slots.length}`; };
  let annId = 0;
  const tierXml = tiers.map(t => {
    const anns = t.annotations
      .filter(a => a.end > a.start)
      .map(a => {
        const s = slotId(Math.round(a.start * 1000));
        const e = slotId(Math.round(a.end * 1000));
        return `        <ANNOTATION>\n            <ALIGNABLE_ANNOTATION ANNOTATION_ID="a${++annId}" TIME_SLOT_REF1="${s}" TIME_SLOT_REF2="${e}">\n                <ANNOTATION_VALUE>${xml(a.text)}</ANNOTATION_VALUE>\n            </ALIGNABLE_ANNOTATION>\n        </ANNOTATION>`;
      })
      .join('\n');
    return `    <TIER LINGUISTIC_TYPE_REF="default-lt" TIER_ID="${xml(t.id)}">\n${anns}\n    </TIER>`;
  }).join('\n');
  const slotXml = slots.map((ms, i) => `        <TIME_SLOT TIME_SLOT_ID="ts${i + 1}" TIME_VALUE="${ms}"/>`).join('\n');
  const mime = /\.wav$/i.test(mediaName) ? 'audio/x-wav' : /\.mp4$/i.test(mediaName) ? 'video/mp4' : 'audio/*';
  return `<?xml version="1.0" encoding="UTF-8"?>
<ANNOTATION_DOCUMENT AUTHOR="" DATE="${new Date().toISOString()}" FORMAT="3.0" VERSION="3.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.mpi.nl/tools/elan/EAFv3.0.xsd">
    <HEADER MEDIA_FILE="" TIME_UNITS="milliseconds">
        <MEDIA_DESCRIPTOR MEDIA_URL="file:///${xml(mediaName)}" MIME_TYPE="${mime}" RELATIVE_MEDIA_URL="./${xml(mediaName)}"/>
        <PROPERTY NAME="lastUsedAnnotationId">${annId}</PROPERTY>
    </HEADER>
    <TIME_ORDER>
${slotXml}
    </TIME_ORDER>
${tierXml}
    <LINGUISTIC_TYPE GRAPHIC_REFERENCES="false" LINGUISTIC_TYPE_ID="default-lt" TIME_ALIGNABLE="true"/>
</ANNOTATION_DOCUMENT>
`;
}

export function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
