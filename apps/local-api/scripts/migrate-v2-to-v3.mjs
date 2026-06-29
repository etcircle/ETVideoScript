import { migrateV2WorkspaceToV3 } from '@etvideoscript/core';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

const projects = [
  'e2e-agent-test',
  'e2e-hermes-test',
  'induction-upskilling',
  'phase2-smoke-1778706039',
  'real-video-web-test',
  'smoke-v2-end-to-end'
];
const root = process.argv[2];

for (const id of projects) {
  const ws = resolve(root, id);
  const manifestPath = ws + '/edits/manifest.json';
  if (!existsSync(manifestPath)) { console.log(`SKIP ${id}: no manifest`); continue; }
  const before = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (before.manifestVersion >= 3) { console.log(`SKIP ${id}: already v${before.manifestVersion}`); continue; }
  try {
    const result = migrateV2WorkspaceToV3(ws);
    console.log(`OK   ${id}: converted=${result.converted} dropped=${result.droppedOperations.length} warnings=${result.warnings.length}`);
    if (result.droppedOperations.length) console.log(`  dropped:`, result.droppedOperations.map(d => `${d.type ?? '?'}:${d.reason}`).join('; '));
    if (result.warnings.length) result.warnings.forEach(w => console.log(`  warn: ${w}`));
  } catch (err) {
    console.log(`FAIL ${id}: ${err.message}`);
  }
}
