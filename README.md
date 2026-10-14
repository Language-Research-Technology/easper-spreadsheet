# Easper Transcript Aligner (prototype)

Finds timecodes for a manually transcribed spreadsheet, using Whisper as a guide.
It mirrors a subset of the [Easper](https://easper.au) transcriber, with a view to
merging it into Easper later.

1. **Open audio**: decoded in the browser to 16 kHz mono.
2. **Auto Segmentation**: Silero VAD v5 plus Easper's segment clean-up (ported from easper.au).
   Set **Number of speakers** to 2–5 for speaker diarization, as in Easper. Sliding windows (2 s by default; Easper uses 1 s) get CAM++
   speaker embeddings, which are clustered (average linkage) and merged into speaker turns.
   Aligned rows then show the diarized speaker they overlap most (`diarized_speaker` in the CSV).
   Drag the **Portion to segment** slider to segment and transcribe only part of the recording, as in Easper. It's handy for testing and demos.
   Re-running on a range replaces only the segments inside it.
3. **Speech Recognition**: Whisper via transformers.js 3.8.1 (`onnx-community/whisper-*_timestamped`, q8),
   run on each segment with word-level timestamps. Whisper's repetition loops ("que lo que me hace es que lo que…")
   are collapsed before alignment.
4. **Manual Transcript**: upload `.xlsx` / `.csv` / `.tsv` / `.txt`, with one utterance per row in spoken order.
   A header with a `text`, `transcription` or `IU` column and an optional `speaker` or `Name` column is recognised;
   otherwise the first column is used. In a workbook, the sheet that looks like a transcript is used, e.g. skipping a pivot table.
   Transcription conventions that aren't speech are ignored when matching: `((comments))`, `(1.5)` pauses,
   `<tags>`, and `X`/`XX` unintelligible syllables. The text you see and export is unchanged.
5. **Align**: the manual words are aligned to Whisper's timed words (fuzzy, so misspellings and
   mis-hearings still match). Matched words take Whisper's times. Unmatched words are spread over
   detected speech between their neighbours. Utterance edges snap to nearby VAD edges.
   If only part of the audio was processed (see Range), the transcript can still be the full one: Whisper's words
   line up with the matching stretch, and rows outside the processed audio are left untimed (status `outside`).
   **The manual text is never changed.** Each row gets a confidence score: `matched`, `partial`, or `estimated`.
6. **Export**: CSV (the rows plus `start`, `end`, `confidence` and `status`) or ELAN `.eaf`
   (manual tiers per speaker, plus Whisper tiers per diarized speaker).

Everything runs locally in the browser. Models are downloaded from Hugging Face and cached.

## Run

Live: https://language-research-technology.github.io/easper-spreadsheet/

Locally, any static file server works, e.g.

```bash
python3 -m http.server 5180
```

then open http://localhost:5180. `samples/` has a 31 s test recording with a manual transcript (CSV and XLSX).

## Deploy

Pushing to `main` runs `.github/workflows/pages.yml`, which runs the tests and publishes to GitHub Pages.
`scripts/stamp-version.mjs` adds `?v=<commit>` to every local CSS/JS URL in the published copy, so after an
update browsers never mix new files with stale cached ones.

## Test

```bash
node --test tests/*.test.mjs
```

## Code

| File | Purpose |
| --- | --- |
| `js/align.js` | Alignment of manual utterances to Whisper words (pure, unit-tested) |
| `js/segments.js` | Silero VAD loop and `segmentsCleanup`, ported from Easper web |
| `js/range.js` | Working range: merging range results into existing segments |
| `js/range-slider.js` | Two-handle "Portion to segment" slider |
| `js/diarize.js` | Fbank features, CAM++ embeddings, clustering and turn merging, ported from Easper web |
| `js/worker.js` | Web Worker that runs VAD and Whisper |
| `js/waveform.js` | Vertical waveform canvas, styled after Easper's transcriber |
| `js/spreadsheet.js` | Spreadsheet / CSV reading |
| `js/export.js` | CSV and EAF export |
| `js/app.js` | UI wiring |

Not yet included: editing boundaries by hand, and saving projects.
