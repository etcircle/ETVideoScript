import { ManifestSchemaV1, ManifestSchemaV2, ProjectSchema, ProjectSchemaV1, type ManifestV1, type ManifestV2, type ProjectV1, type ProjectV2 } from '../schemas';

const CLIP_ID = 'clip_001';
const DEFAULT_ASSET_PATH = 'input/source.mp4';

export function migrateManifestV1ToV2(v1Input: ManifestV1, projectInput: ProjectV1): { manifest: ManifestV2; project: ProjectV2 } {
  const v1 = ManifestSchemaV1.parse(v1Input);
  const project = ProjectSchemaV1.parse(projectInput);
  if (!project.source) throw new Error('Cannot migrate v1 workspace without project.source metadata');

  const clipSource = {
    clipId: CLIP_ID,
    path: project.source.path,
    originalFilename: project.source.originalFilename,
    sha256: project.source.sha256,
    durationSec: project.source.durationSec,
    width: project.source.width,
    height: project.source.height,
    fps: project.source.fps,
    audioSampleRate: project.source.audioSampleRate,
    videoCodec: '',
    audioCodec: '',
    pixelFormat: ''
  };

  const manifest = ManifestSchemaV2.parse({
    manifestVersion: 2,
    projectId: v1.projectId,
    tracks: [{
      trackId: 'track_video_001',
      kind: 'video',
      clips: [{
        clipId: CLIP_ID,
        assetPath: DEFAULT_ASSET_PATH,
        sourceStart: 0,
        sourceEnd: project.source.durationSec
      }]
    }],
    createdAt: v1.createdAt,
    updatedAt: v1.updatedAt,
    operations: v1.operations.map((op) => ({ ...op, clipId: CLIP_ID })),
    renderPresets: v1.renderPresets
  });

  const migratedProject = ProjectSchema.parse({
    schemaVersion: project.schemaVersion,
    manifestVersion: 2,
    projectId: project.projectId,
    title: project.title,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    workspacePath: project.workspacePath,
    clipSources: [clipSource],
    status: project.status
  });

  return { manifest, project: migratedProject };
}
