import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { assertInside } from './filesystem';
import './providers';
import { ProviderEnvelopeError, runProvider, type StudioSoundOutput } from './providers';
import { readProviderRegistry, readSecrets, setDefaultProvider, upsertProvider, type SettingsPathsInput } from './providerSettings';

export const AUDIO_ENHANCE_FILTER_CHAIN_VERSION = 0;
export const AUDIO_ENHANCE_PROFILES = ['clean_voice', 'podcast', 'meeting', 'tutorial'] as const;
export const AUDIO_ENHANCE_PROVIDERS = ['ffmpeg-local', 'adobe-enhance', 'elevenlabs-isolation'] as const;

export type AudioEnhanceProfile = typeof AUDIO_ENHANCE_PROFILES[number];
export type AudioEnhanceProvider = typeof AUDIO_ENHANCE_PROVIDERS[number];
export type AudioEnhanceOperationLike = {
  id?: string;
  status?: string;
  clipId?: string;
  createdBy?: string;
  createdAt?: string;
  type: 'audio_enhance';
  provider: AudioEnhanceProvider;
  profile: AudioEnhanceProfile;
  filterChainVersion: number;
  ffmpegVersion?: string;
  providerVersion?: string;
  intensity?: number;
  start?: number;
  end?: number;
  costEstimateUsd?: number;
};

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type CostDisclosureSink = (line: string) => void;

type BuildLocalEnhanceArgvInput = { inputPath: string; outputPath: string; profile: AudioEnhanceProfile; filterChainVersion: number };

function assertKnownProfile(profile: string): asserts profile is AudioEnhanceProfile {
  if (!(AUDIO_ENHANCE_PROFILES as readonly string[]).includes(profile)) throw new Error(`Unknown audio enhance profile: ${profile}`);
}
function assertKnownProvider(provider: string): asserts provider is AudioEnhanceProvider {
  if (!(AUDIO_ENHANCE_PROVIDERS as readonly string[]).includes(provider)) throw new Error(`Unknown audio enhance provider: ${provider}`);
}
export function normalizeAudioEnhanceProvider(provider?: string): AudioEnhanceProvider {
  const normalized = provider?.startsWith('studio-sound.') ? provider.slice('studio-sound.'.length) : provider === 'adobe' ? 'adobe-enhance' : provider === 'elevenlabs' ? 'elevenlabs-isolation' : provider ?? 'ffmpeg-local';
  assertKnownProvider(normalized);
  return normalized;
}
export function isPaidAudioEnhanceProvider(provider: AudioEnhanceProvider): boolean { return provider !== 'ffmpeg-local'; }
export function providerDisplayName(provider: AudioEnhanceProvider): string {
  switch (provider) {
    case 'ffmpeg-local': return 'FFmpeg Local';
    case 'adobe-enhance': return 'Adobe Enhance';
    case 'elevenlabs-isolation': return 'ElevenLabs Isolation';
  }
}
function localFilterChain(profile: AudioEnhanceProfile): string {
  assertKnownProfile(profile);
  const filters = ['afftdn=nr=12:nf=-25', 'loudnorm=I=-16:TP=-1.5:LRA=11'];
  if (profile === 'clean_voice' || profile === 'podcast') filters.push('deesser');
  if (profile !== 'tutorial') filters.push('highpass=f=80');
  return filters.join(',');
}
export function buildLocalEnhanceArgv(input: BuildLocalEnhanceArgvInput): string[] {
  // Keep the public helper stable for existing filter-chain snapshots.
  if (input.filterChainVersion !== AUDIO_ENHANCE_FILTER_CHAIN_VERSION) throw new Error(`Unsupported local enhance filterChainVersion: ${input.filterChainVersion}`);
  return ['ffmpeg', '-y', '-i', input.inputPath, '-af', localFilterChain(input.profile), '-acodec', 'pcm_s16le', input.outputPath];
}
export function cacheKeyFor(op: AudioEnhanceOperationLike, clipSourceSha256: string): string {
  const payload = { clipSourceSha256, provider: op.provider, profile: op.profile, filterChainVersion: op.filterChainVersion, ffmpegVersion: op.ffmpegVersion ?? '', providerVersion: op.providerVersion ?? '', intensity: op.intensity ?? 0.6 };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
export function estimateAudioEnhanceCostUsd(provider: AudioEnhanceProvider, durationSec: number): number {
  if (!isPaidAudioEnhanceProvider(provider)) return 0;
  const minutes = Math.max(durationSec, 0) / 60;
  const perMinute = provider === 'adobe-enhance' ? 0.08 : 0.10;
  return Number((minutes * perMinute).toFixed(4));
}
export function costDisclosureLine(provider: AudioEnhanceProvider, durationSec: number): string {
  return `${providerDisplayName(provider)} — ~$${estimateAudioEnhanceCostUsd(provider, durationSec).toFixed(2)} for ${Math.round(durationSec)}s of audio`;
}
function paidCredential(provider: AudioEnhanceProvider, env: NodeJS.ProcessEnv | Record<string, string | undefined>, settingsPaths: SettingsPathsInput = {}): string | undefined {
  const providerId = `studio-sound.${provider}`;
  const record = readProviderRegistry(settingsPaths).value.providers.find((candidate) => candidate.id === providerId && candidate.kind === 'studio-sound');
  if (record?.secretRef) {
    const stored = readSecrets(settingsPaths).secrets[record.secretRef];
    if (stored) return stored;
  }
  return provider === 'adobe-enhance' ? env.ADOBE_ENHANCE_API_KEY : env.ELEVENLABS_API_KEY;
}

export type EnhanceAudioInput = SettingsPathsInput & {
  inputPath: string;
  op: AudioEnhanceOperationLike;
  clipSourceSha256: string;
  durationSec: number;
  projectId?: string;
  operationId?: string;
  onCostDisclosure?: CostDisclosureSink;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  fetchImpl?: FetchLike;
};

function fullProviderId(provider: AudioEnhanceProvider): string { return `studio-sound.${provider}`; }
function enhancedAssetPath(workspace: string, cacheKey: string): { abs: string; rel: string } {
  const rel = `assets/enhanced/${cacheKey}.wav`;
  return { rel, abs: assertInside(workspace, rel) };
}

export async function enhanceAudio(workspacePath: string, input: EnhanceAudioInput): Promise<{ outputPath: string; asset: string; cacheKey: string; costEstimateUsd?: number }> {
  const workspace = resolve(workspacePath);
  const bareProvider = normalizeAudioEnhanceProvider(input.op.provider);
  const op = { ...input.op, provider: bareProvider };
  const cacheKey = cacheKeyFor(op, input.clipSourceSha256);
  const asset = enhancedAssetPath(workspace, cacheKey);
  if (existsSync(asset.abs)) return { outputPath: asset.abs, asset: asset.rel, cacheKey, costEstimateUsd: op.costEstimateUsd };
  mkdirSync(dirname(asset.abs), { recursive: true });

  const env = input.env ?? process.env;
  const costEstimateUsd = estimateAudioEnhanceCostUsd(bareProvider, input.durationSec);
  const providerId = fullProviderId(bareProvider);
  let credential: string | undefined;
  if (isPaidAudioEnhanceProvider(bareProvider)) {
    const line = costDisclosureLine(bareProvider, input.durationSec);
    process.stderr.write(`[paid] ${line}\n`);
    input.onCostDisclosure?.(line);
    credential = paidCredential(bareProvider, env, { homeDir: input.homeDir, etvsDir: input.etvsDir });
  }

  const originalFetch = globalThis.fetch;
  if (input.fetchImpl) {
    const injected = ((url: string | URL | Request, init?: RequestInit) => input.fetchImpl!(url, init)) as typeof fetch & { mock?: boolean };
    injected.mock = true;
    (globalThis as any).fetch = injected;
  }
  try {
    const envelope = await runProvider<any, StudioSoundOutput>({
      workspacePath: workspace,
      kind: 'studio-sound',
      providerId,
      requestType: 'audio_enhance',
      projectId: input.projectId,
      operationId: input.operationId ?? input.op.id ?? cacheKey,
      input: { inputPath: input.inputPath, profile: input.op.profile, filterChainVersion: input.op.filterChainVersion, durationSec: input.durationSec, credential, envTestMode: env.ETVS_PAID_PROVIDER_TEST_MODE === '1' },
      env,
      homeDir: input.homeDir,
      etvsDir: input.etvsDir,
      timeoutMs: 15 * 60 * 1000
    });
    if (envelope.ok === false) throw new ProviderEnvelopeError(envelope.error);
    writeFileSync(asset.abs, envelope.output.audio);
    return { outputPath: asset.abs, asset: asset.rel, cacheKey, costEstimateUsd };
  } finally {
    if (input.fetchImpl) (globalThis as any).fetch = originalFetch;
  }
}

export async function materializeAudioEnhance(input: {
  inputPath: string;
  outputPath: string;
  op: AudioEnhanceOperationLike;
  clipSourceSha256: string;
  durationSec: number;
  workspacePath?: string;
  projectId?: string;
  operationId?: string;
  onCostDisclosure?: CostDisclosureSink;
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  homeDir?: string;
  etvsDir?: string;
}): Promise<{ outputPath: string; cacheKey: string; costEstimateUsd?: number }> {
  const workspace = resolve(input.workspacePath ?? dirname(input.outputPath));
  const checkedOutput = assertInside(workspace, relative(workspace, resolve(input.outputPath)));
  const result = await enhanceAudio(workspace, input);
  if (resolve(checkedOutput) !== resolve(result.outputPath) && !existsSync(checkedOutput)) {
    mkdirSync(dirname(checkedOutput), { recursive: true });
    writeFileSync(checkedOutput, readFileSync(result.outputPath));
  }
  return { outputPath: checkedOutput, cacheKey: result.cacheKey, costEstimateUsd: result.costEstimateUsd };
}

export function studioSoundDefaultConfigPath(home = process.env.HOME || process.env.USERPROFILE || '.'): string { return join(home, '.etvs', 'studio-sound-default.json'); }

function legacyDefaultPath(input: { configPath?: string; homeDir?: string } = {}) { return input.configPath ?? studioSoundDefaultConfigPath(input.homeDir); }

export function readStudioSoundDefaultProvider(input: { configPath?: string; homeDir?: string; etvsDir?: string } = {}): AudioEnhanceProvider {
  const registry = readProviderRegistry(input);
  const configured = registry.value.providers.find((provider) => provider.kind === 'studio-sound' && provider.default && provider.enabled);
  if (configured) return normalizeAudioEnhanceProvider(configured.id);
  const path = legacyDefaultPath(input);
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { defaultProvider?: string };
      const provider = normalizeAudioEnhanceProvider(parsed.defaultProvider);
      upsertProvider({ ...input, provider: { id: fullProviderId(provider), kind: 'studio-sound', name: provider, tier: provider === 'ffmpeg-local' ? 'local' : 'paid', default: true, enabled: true } });
      return provider;
    } catch {
      return 'ffmpeg-local';
    }
  }
  return 'ffmpeg-local';
}

export async function setStudioSoundDefaultProvider(providerInput: string, options: { configPath?: string; confirm?: (message: string) => boolean | Promise<boolean>; now?: string; homeDir?: string; etvsDir?: string; acknowledgePaid?: boolean } = {}): Promise<AudioEnhanceProvider> {
  const provider = normalizeAudioEnhanceProvider(providerInput);
  readStudioSoundDefaultProvider(options);
  let acknowledged = options.acknowledgePaid === true;
  if (isPaidAudioEnhanceProvider(provider) && !acknowledged) {
    acknowledged = await options.confirm?.(`${providerDisplayName(provider)} will be charged on your account for every Studio Sound op. Continue? [y/N]`) === true;
    if (!acknowledged) throw new Error(`Default provider switch refused for ${providerDisplayName(provider)}`);
  }
  upsertProvider({ ...options, provider: { id: fullProviderId(provider), kind: 'studio-sound', name: provider, tier: provider === 'ffmpeg-local' ? 'local' : 'paid', enabled: true } });
  setDefaultProvider({ ...options, kind: 'studio-sound', id: fullProviderId(provider), acknowledgePaid: acknowledged });
  return provider;
}
