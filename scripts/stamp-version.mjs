// Cache-busting for the GitHub Pages deploy: copies the site to an output
// folder and adds ?v=<version> to every local CSS/JS reference (HTML tags,
// static and dynamic imports, new URL(...) for the worker), so a new deploy
// never mixes freshly loaded files with stale cached ones.
//
//   node scripts/stamp-version.mjs <outDir> <version>

import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SKIP = new Set(['.git', '.github', '.claude', 'node_modules', 'scripts', 'tests', '_site']);

/** Stamp local .js/.css references in HTML attributes. */
export function stampHtml(html, version) {
  return html.replace(/\b(src|href)="(?![a-z]+:|\/\/|#)([^"?#]+\.(?:js|mjs|css))"/gi, `$1="$2?v=${version}"`);
}

/** Stamp relative module specifiers (./x.js, ../x.js) in JavaScript. */
export function stampJs(js, version) {
  return js.replace(/(['"])(\.{1,2}\/[^'"?#\s]+\.(?:js|mjs))\1/g, `$1$2?v=${version}$1`);
}

function walk(dir, root = dir) {
  return readdirSync(dir).flatMap(name => {
    if (SKIP.has(name)) return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path, root) : [relative(root, path)];
  });
}

export function buildSite(srcDir, outDir, version) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const file of walk(srcDir)) {
    const from = join(srcDir, file), to = join(outDir, file);
    mkdirSync(join(to, '..'), { recursive: true });
    if (/\.html?$/i.test(file)) writeFileSync(to, stampHtml(readFileSync(from, 'utf8'), version));
    else if (/\.m?js$/i.test(file)) writeFileSync(to, stampJs(readFileSync(from, 'utf8'), version));
    else cpSync(from, to);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [outDir, version] = process.argv.slice(2);
  if (!outDir || !version) {
    console.error('Usage: node scripts/stamp-version.mjs <outDir> <version>');
    process.exit(1);
  }
  buildSite(process.cwd(), outDir, version);
  console.log(`Built ${outDir} with asset version ${version}`);
}
