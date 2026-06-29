import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { assertInside, nowIso } from './filesystem';
import { probeRecordingMedia } from './media';
import './providers';
import { runProvider, type GeneratedMediaOutput, type ImageGenInput, type MusicGenInput, type VideoGenInput } from './providers';

export type GenerateMediaKind = 'image-gen' | 'video-gen' | 'music-gen';

export interface GenerateMediaInput {
  kind: GenerateMediaKind;
  prompt: string;
  provider?: string;
  requestId?: string;
  projectId?: string;
  count?: number;
  aspectRatio?: string;
  resolution?: string;
  durationSec?: number;
  durationMs?: number;
  model?: string;
  env?: Record<string, string | undefined>;
  homeDir?: string;
  etvsDir?: string;
}

export interface GenerateMediaResult {
  asset: string;
  assetKind: 'image' | 'video' | 'audio';
  provider: string;
  providerRequestId: string;
  durationSec: number;
  mimeType: string;
  video?: { width: number; height: number; fps: number; codec?: string; pixelFormat?: string };
  audio?: { sampleRate?: number; channels?: number; codec?: string };
  estimatedCostUsd: number | null;
  actualCostUsd: number | null;
}

function normalizeProviderId(kind: GenerateMediaKind, provider?: string): string | undefined {
  if (!provider) return undefined;
  return provider.includes('.') ? provider : `${kind}.${provider}`;
}

function assertKind(kind: string): asserts kind is GenerateMediaKind {
  if (!['image-gen', 'video-gen', 'music-gen'].includes(kind)) throw new Error(`Unsupported generation kind: ${kind}`);
}

function inputForKind(input: GenerateMediaInput): ImageGenInput | VideoGenInput | MusicGenInput {
  if (input.kind === 'image-gen') return { prompt: input.prompt.trim(), count: input.count ?? 1, aspectRatio: input.aspectRatio, model: input.model };
  if (input.kind === 'video-gen') return { prompt: input.prompt.trim(), durationSec: input.durationSec, aspectRatio: input.aspectRatio, resolution: input.resolution, model: input.model };
  return { prompt: input.prompt.trim(), durationMs: input.durationMs, model: input.model };
}

function assetKindFor(kind: GenerateMediaKind): 'image' | 'video' | 'audio' {
  return kind === 'image-gen' ? 'image' : kind === 'video-gen' ? 'video' : 'audio';
}

function extensionForMime(mimeType: string): string {
  if (/jpeg|jpg/i.test(mimeType)) return 'jpg';
  if (/png/i.test(mimeType)) return 'png';
  if (/mp4/i.test(mimeType)) return 'mp4';
  if (/mpeg|mp3/i.test(mimeType)) return 'mp3';
  if (/wav/i.test(mimeType)) return 'wav';
  return 'bin';
}

function timeoutFor(kind: GenerateMediaKind): number {
  return kind === 'video-gen' ? 600000 : kind === 'music-gen' ? 180000 : 120000;
}

function nextAssetPath(workspacePath: string, kind: GenerateMediaKind, mimeType: string): { abs: string; rel: string } {
  const stamp = nowIso().replace(/[-:.TZ]/g, '').slice(0, 14);
  const rel = `assets/generated/${kind}/gen-${stamp}-${Math.random().toString(36).slice(2, 8)}.${extensionForMime(mimeType)}`;
  return { abs: assertInside(workspacePath, rel), rel };
}

export async function generateMedia(workspacePath: string, input: GenerateMediaInput): Promise<GenerateMediaResult> {
  const workspace = resolve(workspacePath);
  assertKind(input.kind);
  if (typeof input.prompt !== 'string') throw new Error('Generation prompt is required');
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error('Generation prompt is required');
  if (prompt.length > 8000) throw new Error('Generation prompt exceeds 8,000 character limit');
  const providerId = normalizeProviderId(input.kind, input.provider);
  const providerInput = inputForKind({ ...input, prompt });
  const envelope = await runProvider<typeof providerInput, GeneratedMediaOutput>({
    workspacePath: workspace,
    kind: input.kind,
    providerId,
    requestId: input.requestId,
    requestType: input.kind,
    projectId: input.projectId,
    input: providerInput,
    timeoutMs: timeoutFor(input.kind),
    env: input.env,
    homeDir: input.homeDir,
    etvsDir: input.etvsDir
  });
  if (envelope.ok === false) throw new Error(`${envelope.error.problem} ${envelope.error.cause} ${envelope.error.fix}`);
  const { abs } = nextAssetPath(workspace, input.kind, envelope.output.mimeType);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, envelope.output.media);
  const rel = relative(workspace, abs).split('\\').join('/');
  const assetKind = assetKindFor(input.kind);
  let durationSec = assetKind === 'image' ? 0 : envelope.output.durationSec ?? 0;
  let video: GenerateMediaResult['video'];
  let audio: GenerateMediaResult['audio'];
  if (assetKind !== 'image') {
    const probe = probeRecordingMedia(abs);
    durationSec = probe.durationSec > 0 ? probe.durationSec : (envelope.output.durationSec ?? 0);
    video = probe.video;
    audio = probe.audio;
  }
  return {
    asset: rel,
    assetKind,
    provider: envelope.providerId,
    providerRequestId: envelope.requestId,
    durationSec,
    mimeType: envelope.output.mimeType,
    video,
    audio,
    estimatedCostUsd: envelope.cost.currency === 'USD' ? envelope.cost.estimated ?? null : null,
    actualCostUsd: envelope.cost.currency === 'USD' ? envelope.cost.actual ?? null : null
  };
}
