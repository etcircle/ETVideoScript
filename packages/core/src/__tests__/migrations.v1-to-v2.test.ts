import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ManifestSchemaV2, ProjectSchemaV1, ManifestSchemaV1 } from '../index';
import { migrateManifestV1ToV2 } from '../migrations/v1-to-v2';

const fixtures = join(process.cwd(), 'packages/core/src/__tests__/fixtures/v1-workspaces');

function readJson(path: string) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('v1 to v2 migration', () => {
  it('migrates all 6 operation types with clipId and identical clip-local ranges', () => {
    const v1 = ManifestSchemaV1.parse(readJson(join(fixtures, 'with-ops/edits/manifest.json')));
    const project = ProjectSchemaV1.parse(readJson(join(fixtures, 'with-ops/project.json')));

    const { manifest } = migrateManifestV1ToV2(v1, project);

    expect(manifest.operations).toHaveLength(6);
    for (let i = 0; i < v1.operations.length; i++) {
      expect(manifest.operations[i]).toMatchObject({
        id: v1.operations[i]!.id,
        type: v1.operations[i]!.type,
        clipId: 'clip_001',
        start: v1.operations[i]!.start,
        end: v1.operations[i]!.end
      });
    }
    expect(new Set(manifest.operations.map((op) => op.type))).toEqual(new Set(['cut', 'mute', 'keep', 'voice_patch', 'lipsync_patch', 'caption_override']));
  });

  it('migrates and reparses as v2 with operations roundtripping identically', () => {
    const v1 = ManifestSchemaV1.parse(readJson(join(fixtures, 'with-ops/edits/manifest.json')));
    const project = ProjectSchemaV1.parse(readJson(join(fixtures, 'with-ops/project.json')));

    const { manifest } = migrateManifestV1ToV2(v1, project);
    const reparsed = ManifestSchemaV2.parse(JSON.parse(JSON.stringify(manifest)));

    expect(reparsed.operations).toEqual(manifest.operations);
  });

  it('moves project.source to project.clipSources[0] and sets manifestVersion 2', () => {
    const v1 = ManifestSchemaV1.parse(readJson(join(fixtures, 'with-ops/edits/manifest.json')));
    const project = ProjectSchemaV1.parse(readJson(join(fixtures, 'with-ops/project.json')));

    const migrated = migrateManifestV1ToV2(v1, project);

    expect(migrated.project.manifestVersion).toBe(2);
    expect(migrated.project.clipSources[0]).toMatchObject({ ...project.source, clipId: 'clip_001', videoCodec: '', audioCodec: '', pixelFormat: '' });
    expect(migrated.manifest.manifestVersion).toBe(2);
  });

});
