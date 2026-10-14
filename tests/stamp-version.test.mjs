import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stampHtml, stampJs } from '../scripts/stamp-version.mjs';

test('stampHtml versions local scripts and styles only', () => {
  const html = `<link rel="stylesheet" href="css/app.css">
<script type="module" src="js/app.js"></script>
<script src="https://cdn.example.com/lib.js"></script>
<a href="#top">top</a><a href="samples/a.csv">csv</a>`;
  assert.equal(stampHtml(html, 'abc123'), `<link rel="stylesheet" href="css/app.css?v=abc123">
<script type="module" src="js/app.js?v=abc123"></script>
<script src="https://cdn.example.com/lib.js"></script>
<a href="#top">top</a><a href="samples/a.csv">csv</a>`);
});

test('stampJs versions relative imports, dynamic imports and the worker URL', () => {
  const js = `import { a } from './align.js';
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.wasm.min.mjs';
import x from "../lib/x.mjs";
const m = await import('./range.js');
const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
fetch('samples/fisherman.wav');`;
  assert.equal(stampJs(js, 'v1'), `import { a } from './align.js?v=v1';
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.wasm.min.mjs';
import x from "../lib/x.mjs?v=v1";
const m = await import('./range.js?v=v1');
const w = new Worker(new URL('./worker.js?v=v1', import.meta.url), { type: 'module' });
fetch('samples/fisherman.wav');`);
});
