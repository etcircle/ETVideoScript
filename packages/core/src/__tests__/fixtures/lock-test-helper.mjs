import { loadManifestV3 } from '../../index.ts';

const workspace = process.argv[2];
if (!workspace) {
  console.error('workspace path argument is required');
  process.exit(2);
}

try {
  const manifest = loadManifestV3(workspace);
  const version = manifest.manifestVersion;
  if (version !== 3) throw new Error(`expected v3 manifest, got ${version}`);
  process.stdout.write(JSON.stringify({ version }) + '\n');
} catch (err) {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
}
