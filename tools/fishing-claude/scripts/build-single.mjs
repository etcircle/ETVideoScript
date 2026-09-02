// Bundles the app into one self-contained HTML file: CSS inlined, ES modules
// concatenated in dependency order (imports/exports stripped — the modules
// share one scope once merged, and their top-level names don't collide).
//
//   node scripts/build-single.mjs                  -> dist/fishing-claude.html
//   node scripts/build-single.mjs --preview        -> forces synthetic weather
//   node scripts/build-single.mjs --fragment       -> omits <!doctype>/<html>/<body>
//   node scripts/build-single.mjs --out path.html
//
// --preview exists for sandboxes that block outbound fetch (the Artifact
// viewer's CSP, for one): the page renders and is fully interactive, but on
// generated weather. A normal build is the real app and needs network.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const pub = join(root, 'public');

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const optionValue = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
};
const preview = has('--preview');
const fragment = has('--fragment');
const outPath = resolve(optionValue('--out') ?? join(root, 'dist', 'fishing-claude.html'));

// Dependency order: leaves first, app last (it calls main() at the end).
const MODULES = ['src/astro.js', 'src/timezone.js', 'src/engine.js', 'src/data.js', 'src/ea.js', 'app.js'];

/** Strip ESM syntax so the module body can be concatenated into one script. */
function flatten(source, name) {
  const out = [];
  for (const line of source.split('\n')) {
    if (/^import\s.*from\s+['"]\.\/.*['"];?\s*$/.test(line)) continue; // local import
    if (/^export\s*\{[^}]*\}\s*;?\s*$/.test(line)) continue; // re-export list
    if (/^import\s/.test(line) || /^export\s+(default|\*)/.test(line)) {
      throw new Error(`${name}: unsupported module syntax for bundling: ${line.trim()}`);
    }
    out.push(line.replace(/^export\s+(?=(const|let|var|function|async|class)\b)/, ''));
  }
  return out.join('\n');
}

const css = readFileSync(join(pub, 'styles.css'), 'utf8');
const html = readFileSync(join(pub, 'index.html'), 'utf8');

const bodyMatch = html.match(/<body>([\s\S]*?)<\/body>/);
if (!bodyMatch) throw new Error('index.html: <body> not found');
const body = bodyMatch[1]
  .replace(/\s*<script type="module"[^>]*><\/script>/, '') // the module tag is inlined below
  .trim();

const titleMatch = html.match(/<title>([^<]*)<\/title>/);
const title = titleMatch ? titleMatch[1] : 'Fishing Claude';

const bundle = MODULES.map((rel) => `// ---- ${rel} ${'-'.repeat(Math.max(0, 60 - rel.length))}\n${flatten(readFileSync(join(pub, rel), 'utf8'), rel)}`).join('\n\n');

const previewFlag = preview ? '<script>window.__FISHING_CLAUDE_PREVIEW__ = true;</script>\n' : '';
const head = `<title>${title}</title>\n<style>\n${css}</style>\n${previewFlag}`;
const script = `<script type="module">\n${bundle}\n</script>`;

let doc;
if (fragment) {
  doc = `${head}${body}\n\n${script}\n`;
} else {
  doc = `<!doctype html>
<html lang="en-GB">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="theme-color" content="#0f2a3a" />
${head
  .split('\n')
  .map((l) => (l ? `    ${l}` : l))
  .join('\n')}
  </head>
  <body>
${body}

${script}
  </body>
</html>
`;
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, doc);
console.log(`${outPath} — ${(doc.length / 1024).toFixed(0)} kB${preview ? ' (preview: synthetic weather)' : ''}${fragment ? ' (fragment)' : ''}`);
