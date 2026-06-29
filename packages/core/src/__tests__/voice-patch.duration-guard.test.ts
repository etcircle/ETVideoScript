import { describe, expect, it } from 'vitest';
import { validateManifestV3Document } from '../index';

const now = '2026-05-26T00:00:00.000Z';
const presets = { draft: { resolution: '1280x720', videoBitrate: '2500k', audioBitrate: '128k' }, youtube: { resolution: 'source', videoBitrate: 'source-or-auto', audioBitrate: '192k' } };

// Defense-in-depth fixture: an approved voice_patch with an asset that exists in
// the manifest, a clip that contains its range, and varying durationGeneratedSec
// shapes. The validation layer should reject the implausible ones even though the
// API-level guard already rejects them at synthesis time — the goal is that no
// manifest in this shape can ever reach renderContribution.
function manifest(durationGeneratedSec: unknown) {
  const op: Record<string, unknown> = {
    id: 'op_voice_0001',
    type: 'voice_patch',
    status: 'approved',
    target: { kind: 'clip-span', trackId: 'track_video_001', clipId: 'clip_001', start: 1, end: 2 },
    text: 'replacement',
    assetId: 'asset_voice_001',
    proposedBy: 'user',
    createdBy: 'user',
    createdAt: now
  };
  if (durationGeneratedSec !== undefined) op.durationGeneratedSec = durationGeneratedSec;
  return {
    manifestVersion: 3,
    projectId: 'voice-patch-duration-guard',
    createdAt: now,
    updatedAt: now,
    assets: [
      { assetId: 'asset_video_001', kind: 'video', path: 'assets/video/source.mp4', durationSec: 10, provenance: 'imported', video: { width: 1280, height: 720, fps: 30 }, audio: { sampleRate: 48000 } },
      { assetId: 'asset_voice_001', kind: 'audio', path: 'assets/voice/patch.wav', durationSec: 1, provenance: 'generated', audio: { sampleRate: 48000 } }
    ],
    tracks: [{ trackId: 'track_video_001', kind: 'video', name: 'Video 1', order: 0, clips: [{ clipId: 'clip_001', assetId: 'asset_video_001', sourceStart: 0, sourceEnd: 10, timelineStart: 0 }] }],
    operations: [op],
    outputs: [{ outputId: 'output_full_001', kind: 'full', aspects: ['16:9'], status: 'manual' }],
    renderPresets: presets
  };
}

describe('voice_patch validateLocal — durationGeneratedSec guard', () => {
  it('accepts an approved voice_patch with a normal generated duration', () => {
    const result = validateManifestV3Document(manifest(0.4));
    expect(result.valid).toBe(true);
  });

  it('accepts an approved voice_patch missing durationGeneratedSec (legacy/migrated back-compat)', () => {
    // Older approved ops predate the persisted field, and projectTimeMap treats a
    // missing duration as delta=0 (the slot is preserved and the asset plays inside
    // it), so this state is safe and must NOT retroactively invalidate the manifest.
    // Only a PRESENT sub-floor value is the degraded-payload artifact we reject.
    const result = validateManifestV3Document(manifest(undefined));
    expect(result.valid).toBe(true);
  });

  it('rejects an approved voice_patch with a 50 ms asset (the ElevenLabs degraded-mode artifact)', () => {
    const result = validateManifestV3Document(manifest(0.050375));
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('implausibly short audio');
    expect(result.errors.join('\n')).toContain('50 ms');
  });

  it('rejects an approved voice_patch with durationGeneratedSec of exactly 0', () => {
    const result = validateManifestV3Document(manifest(0));
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('implausibly short audio');
  });

  it('accepts a proposed voice_patch with no durationGeneratedSec (pre-synthesis state)', () => {
    const m = manifest(undefined);
    (m.operations[0] as Record<string, unknown>).status = 'proposed';
    const result = validateManifestV3Document(m);
    expect(result.valid).toBe(true);
  });

  it('accepts a disabled voice_patch with a tiny generated duration (kept for history)', () => {
    const m = manifest(0.05);
    (m.operations[0] as Record<string, unknown>).status = 'disabled';
    const result = validateManifestV3Document(m);
    expect(result.valid).toBe(true);
  });

  // W5 seam-bake: seamBaked is a render-only flag; it must not bypass any validation rule.

  it('accepts an approved voice_patch with seamBaked:true and normal generated duration', () => {
    // seamBaked is purely a pipeline hint — it does not relax any validation rule.
    const m = manifest(0.4);
    (m.operations[0] as Record<string, unknown>).seamBaked = true;
    const result = validateManifestV3Document(m);
    expect(result.valid).toBe(true);
  });

  it('rejects an approved voice_patch with seamBaked:true but implausibly short audio (floor still applies)', () => {
    // seamBaked does NOT bypass the 100 ms degraded-payload guard.
    const m = manifest(0.050375);
    (m.operations[0] as Record<string, unknown>).seamBaked = true;
    const result = validateManifestV3Document(m);
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('implausibly short audio');
  });

  it('rejects an approved seamBaked voice_patch with NO durationGeneratedSec', () => {
    // seamBaked disables the pipeline fade (crossfadeSec:0), which is only safe when the
    // play length is known — so an approved seamBaked op must carry durationGeneratedSec.
    const m = manifest(undefined);
    (m.operations[0] as Record<string, unknown>).seamBaked = true;
    const result = validateManifestV3Document(m);
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('seamBaked voice patch requires durationGeneratedSec');
  });
});
