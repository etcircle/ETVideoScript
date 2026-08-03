#!/usr/bin/env node
import { Command } from 'commander';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { Writable } from 'node:stream';
import { addOperation, analyzeChannelBalance, canonicalProviderId, applyChannelFix, captionsToSrtV3, captionsToVttV3, createWorkspace, doctor, extractAllClipAudio, extractAllClipWaveformPeaks, extractClipAudio, extractClipWaveformPeaks, importLegacyEnvProviders, importSource, loadManifestV3, loadProject, readProviderRegistry, removeProvider, safeProjectPath, settingsErrorEnvelope, setDefaultProvider, setProviderSecret, transcribeAllClips, transcribeClip, upsertProvider, validateManifestV3Document, saveManifestV3, buildRenderPlanV3, renderPlanV3, projectCaptionsV3, loadTranscript, assertInside, STUDIO_CLEANUP_STALE_WARNING, type ProviderKind, type ProviderRecord } from '@etvideoscript/core';

function workspaceOption(value?: string) { return resolve(value || process.cwd()); }
function print(value: unknown, json?: boolean) { console.log(json ? JSON.stringify(value, null, 2) : value); }
// ChannelFixOutcome carries the resulting manifest for internal callers (e.g. reading
// detachedClipIds without a redundant reload); it's not part of any CLI command's
// printed JSON contract.
function withoutManifest<T extends { manifest: unknown }>(outcome: T): Omit<T, 'manifest'> {
  const { manifest: _manifest, ...rest } = outcome;
  return rest;
}
type ExtractAudioCliOptions = { format: 'wav' | 'mp3'; sampleRate: string; clip?: string; yes?: boolean };
type PeaksCliOptions = { resolution: string; clip?: string; all?: boolean };
type FixChannelsCliOptions = { channel?: string; disable?: boolean; detectOnly?: boolean };
type RootCliOptions = { workspace?: string; json?: boolean };
export type CliHandlerDeps = {
  extractClipAudio: typeof extractClipAudio;
  extractAllClipAudio: typeof extractAllClipAudio;
  extractClipWaveformPeaks: typeof extractClipWaveformPeaks;
  extractAllClipWaveformPeaks: typeof extractAllClipWaveformPeaks;
  applyChannelFix: typeof applyChannelFix;
  analyzeChannelBalance: typeof analyzeChannelBalance;
  print: typeof print;
};
const defaultCliDeps: CliHandlerDeps = { extractClipAudio, extractAllClipAudio, extractClipWaveformPeaks, extractAllClipWaveformPeaks, applyChannelFix, analyzeChannelBalance, print };

export async function handleExtractAudioCommand(opts: ExtractAudioCliOptions, rootOpts: RootCliOptions = {}, deps: CliHandlerDeps = defaultCliDeps) {
  const workspace = workspaceOption(rootOpts.workspace);
  // Auto-detect single-channel-mic recordings before extraction so the pan applies to
  // this run. Never blocks extraction: detection failure is a warning, and an existing
  // audioChannelFix (approved or disabled) is always preserved by applyChannelFix.
  let channelFix: ReturnType<typeof applyChannelFix> | undefined;
  try {
    channelFix = deps.applyChannelFix(workspace);
    if (channelFix.action === 'applied') {
      const { detection } = channelFix.fix;
      console.warn(`Detected single-channel recording (L ${detection.leftRmsDb.toFixed(1)} dB / R ${detection.rightRmsDb.toFixed(1)} dB); using ${channelFix.fix.sourceChannel} channel. Revert with: ets fix-channels --disable`);
    }
  } catch (err) {
    console.warn(`Channel-balance detection skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
  const common = { format: opts.format, sampleRate: Number(opts.sampleRate), overwrite: Boolean(opts.yes) };
  const outputs = opts.clip ? [await deps.extractClipAudio(workspace, opts.clip, common)] : await deps.extractAllClipAudio(workspace, common);
  deps.print(rootOpts.json ? { outputs, ...(channelFix && channelFix.action !== 'unchanged' ? { channelFix: withoutManifest(channelFix) } : {}) } : `Audio ready: ${outputs.join(', ')}`, rootOpts.json);
  return outputs;
}

export function handlePeaksCommand(opts: PeaksCliOptions, rootOpts: RootCliOptions = {}, deps: CliHandlerDeps = defaultCliDeps) {
  const workspace = workspaceOption(rootOpts.workspace);
  const resolutionHz = Number(opts.resolution);
  if (opts.clip) {
    const peaks = deps.extractClipWaveformPeaks(workspace, opts.clip, { resolutionHz });
    deps.print(rootOpts.json ? peaks : `Peaks ready: media/${opts.clip}/peaks.json (${peaks.peaks.length} buckets @ ${peaks.resolutionHz}Hz)`, rootOpts.json);
    return [{ clipId: opts.clip, peaks: peaks.peaks.length }];
  }
  if (opts.all) {
    const results = deps.extractAllClipWaveformPeaks(workspace, { resolutionHz });
    deps.print(rootOpts.json ? results : `Peaks ready: ${results.map((r) => `media/${r.clipId}/peaks.json`).join(', ')}`, rootOpts.json);
    return results;
  }
  const results = deps.extractAllClipWaveformPeaks(workspace, { resolutionHz });
  deps.print(rootOpts.json ? results : `Peaks ready: ${results.map((r) => `media/${r.clipId}/peaks.json`).join(', ')}`, rootOpts.json);
  return results;
}

function hasPerClipAudio(workspace: string, manifest: ReturnType<typeof loadManifestV3>, project: ReturnType<typeof loadProject>): boolean {
  const clips = manifest.tracks.flatMap((track) => track.clips);
  if (clips.length === 0) return project.status.audioExtracted;
  return clips.every((clip) => existsSync(resolve(workspace, `media/${clip.clipId}/extracted-audio.wav`)));
}

async function confirmCli(message: string): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(message + ' ');
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
function repoRoot() {
  const fromSource = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  return existsSync(resolve(fromSource, 'skills')) ? fromSource : process.cwd();
}
function skillScript(name: string) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error('skill name must be lowercase letters, numbers, and hyphens');
  const script = resolve(repoRoot(), 'skills', name, 'index.ts');
  if (!existsSync(script)) throw new Error(`Unknown skill: ${name}`);
  return script;
}

const program = new Command();
program.name('ets').description('ETVideoScript deterministic local video-editing CLI').version('0.1.0');
program.option('--workspace <path>', 'workspace path');
program.option('--json', 'print JSON');

program.command('doctor').description('Check local media/tooling prerequisites').action(() => {
  const result = doctor();
  const rootJson = program.opts().json;
  if (rootJson) print(result, true); else console.log(`ffmpeg: ${result.ffmpeg ? 'ok' : 'missing'}\nffprobe: ${result.ffprobe ? 'ok' : 'missing'}\nnode: ${result.node}`);
  if (!result.ffmpeg || !result.ffprobe) process.exitCode = 1;
});

program.command('init').description('Create or preserve an ETVideo project workspace')
  .requiredOption('--project-id <id>', 'project id')
  .requiredOption('--title <title>', 'project title')
  .action(async (opts) => {
    const workspace = workspaceOption(program.opts().workspace);
    const project = await createWorkspace({ workspacePath: workspace, projectId: opts.projectId, title: opts.title });
    print(program.opts().json ? project : `Workspace ready: ${project.workspacePath}`, program.opts().json);
  });

program.command('new').description('Create a workspace under a workspace root')
  .requiredOption('--workspace-root <path>', 'workspace root')
  .requiredOption('--project-id <id>', 'project id')
  .requiredOption('--title <title>', 'project title')
  .action(async (opts) => {
    const workspace = safeProjectPath(resolve(opts.workspaceRoot), opts.projectId);
    const project = await createWorkspace({ workspacePath: workspace, projectId: opts.projectId, title: opts.title });
    print(program.opts().json ? project : `Workspace ready: ${project.workspacePath}`, program.opts().json);
  });

program.command('import').description('Import source video into input/source.mp4')
  .argument('<file>', 'source video file')
  .option('--copy <copy>', 'copy source into workspace', 'true')
  .option('--yes', 'replace existing input/source.mp4 if it differs from the requested source')
  .action(async (file, opts) => {
    const project = await importSource(workspaceOption(program.opts().workspace), resolve(file), { copy: opts.copy !== 'false', replace: Boolean(opts.yes) });
    const source = project.clipSources[0];
    print(program.opts().json ? project : `Imported ${source?.originalFilename ?? source?.path ?? 'source'} (${source?.durationSec.toFixed(1) ?? '0.0'}s)`, program.opts().json);
  });

program.command('inspect').description('Print workspace and media state').action(() => {
  const workspace = workspaceOption(program.opts().workspace);
  const project = loadProject(workspace);
  const manifest = loadManifestV3(workspace);
  const validation = validateManifestV3Document(manifest);
  const state = { project, manifest: { operations: manifest.operations.length, valid: validation.valid, errors: validation.errors }, files: { source: existsSync(resolve(workspace, 'input/source.mp4')), audio: hasPerClipAudio(workspace, manifest, project), transcript: existsSync(resolve(workspace, 'transcript/words.json')) }, doctor: doctor() };
  if (program.opts().json) print(state, true); else console.log(`${project.title}\nsource: ${state.files.source ? 'yes' : 'missing'}\naudio: ${state.files.audio ? 'yes' : 'missing'}\ntranscript: ${state.files.transcript ? 'yes' : 'missing'}\nmanifest: ${validation.valid ? 'valid' : `invalid (${validation.errors.length})`}\nops: ${manifest.operations.length}`);
});

program.command('extract-audio').description('Extract mono transcription audio from source')
  .option('--format <format>', 'wav or mp3', 'wav')
  .option('--sample-rate <hz>', 'sample rate', '16000')
  .option('--clip <clipId>', 'extract only one clip')
  .option('--yes', 'overwrite output if it exists')
  .action(async (opts) => {
    await handleExtractAudioCommand(opts, program.opts());
  });

program.command('peaks').description('Regenerate waveform peaks')
  .option('--resolution <hz>', 'peak buckets per second', '100')
  .option('--clip <clipId>', 'generate peaks for one clip')
  .option('--all', 'generate per-clip peaks for all clips')
  .action((opts) => {
    handlePeaksCommand(opts, program.opts());
  });

export function handleFixChannelsCommand(opts: FixChannelsCliOptions, rootOpts: RootCliOptions = {}, deps: CliHandlerDeps = defaultCliDeps) {
  const workspace = workspaceOption(rootOpts.workspace);
  if (opts.channel && !['left', 'right'].includes(opts.channel)) throw new Error('--channel must be left or right');
  if (opts.detectOnly) {
    const balance = deps.analyzeChannelBalance(resolve(workspace, 'input/source.mp4'));
    deps.print(rootOpts.json ? balance : `channels: ${balance.channels}\nleft RMS: ${balance.leftRmsDb?.toFixed(1) ?? 'n/a'} dB\nright RMS: ${balance.rightRmsDb?.toFixed(1) ?? 'n/a'} dB\nrecommendation: ${balance.recommendation ?? 'none (balanced or non-stereo)'}`, rootOpts.json);
    return balance;
  }
  const outcome = deps.applyChannelFix(workspace, { channel: opts.channel as 'left' | 'right' | undefined, disable: Boolean(opts.disable) });
  const summary = outcome.action === 'applied'
    ? `Channel fix applied: ${outcome.fix.sourceChannel} (auto: ${outcome.fix.detection.auto}). Re-run "ets extract-audio --yes" and "ets transcribe" to refresh derived audio.`
    : outcome.action === 'disabled' ? 'Channel fix disabled (record kept). Re-run "ets extract-audio --yes" to restore averaged extraction.'
    : outcome.action === 'unchanged' ? `No change: ${outcome.reason}`
    : `No fix needed: ${outcome.reason}`;
  // Already-detached clips don't refresh through extract-audio/transcribe — the
  // detached WAV is a separate derivative (assets/audio/<assetId>.wav) that only
  // detach-audio (with refresh:true) revisits (issue #4).
  const detachedClipIds = (outcome.action === 'applied' || outcome.action === 'disabled')
    ? outcome.manifest.tracks.flatMap((track) => track.clips).filter((clip) => clip.audioDetached).map((clip) => clip.clipId)
    : [];
  const refreshNote = detachedClipIds.length
    ? ` Clips with detached audio need a refresh: POST .../clips/<clipId>/detach-audio with {"refresh":true} for: ${detachedClipIds.join(', ')}.`
    : '';
  deps.print(rootOpts.json
    ? { ...withoutManifest(outcome), ...(detachedClipIds.length ? { detachedClipsNeedingRefresh: detachedClipIds } : {}) }
    : summary + refreshNote, rootOpts.json);
  return outcome;
}

program.command('fix-channels').description('Detect/repair single-channel mic recordings (fill both channels from the live one)')
  .option('--channel <side>', 'force left or right as the live channel')
  .option('--disable', 'disable an existing channel fix (record is kept)')
  .option('--detect-only', 'analyze and print channel balance without writing the manifest')
  .action((opts) => {
    handleFixChannelsCommand(opts, program.opts());
  });

program.command('transcribe').description('Transcribe audio into transcript/words.json and transcript.md')
  .option('--provider <provider>', 'mock or homelab-whisper', 'mock')
  .option('--clip <clipId>', 'transcribe only one clip')
  .action(async (opts) => {
    const workspace = workspaceOption(program.opts().workspace);
    const doc = opts.clip
      ? await transcribeClip(workspace, opts.clip, { provider: opts.provider })
      : await transcribeAllClips(workspace, { provider: opts.provider });
    print(program.opts().json ? { words: doc.words.length, segments: doc.segments.length, provider: doc.provider } : `Transcript ready: ${doc.words.length} words via ${doc.provider.name}`, program.opts().json);
  });

program.command('validate-manifest').description('Validate edits/manifest.json')
  .action(() => {
    const manifest = loadManifestV3(workspaceOption(program.opts().workspace));
    const result = validateManifestV3Document(manifest);
    const legacyOps = manifest.operations.filter((op) => op.disabledReason === 'legacy_model_requires_recreate').map((op) => ({ id: op.id, type: op.type }));
    if (program.opts().json) print({ ...result, legacyOps }, true);
    else {
      console.log(result.valid ? 'Manifest valid' : `Manifest invalid:\n${result.errors.join('\n')}`);
      if (legacyOps.length) console.warn(`Legacy ops (recreate required): ${legacyOps.map((op) => op.id).join(', ')}`);
    }
    if (!result.valid) process.exitCode = 1;
  });

program.command('migrate-manifest').description('Migrate manifest operations for backward compatibility')
  .option('--voice-patch-ripple', 'disable approved voice_patch ops that predate durationGeneratedSec (ripple semantics)')
  .option('--dry-run', 'print what would change without writing')
  .action((opts) => {
    if (!opts.voicePatchRipple) { console.error('Specify a migration flag (e.g. --voice-patch-ripple)'); process.exitCode = 1; return; }
    const workspace = workspaceOption(program.opts().workspace);
    const manifest = loadManifestV3(workspace);
    const targets = manifest.operations.filter((op) => op.type === 'voice_patch' && op.status === 'approved' && op.durationGeneratedSec === undefined);
    if (!targets.length) {
      print(program.opts().json ? { migrated: [], total: 0 } : 'Nothing to migrate.', program.opts().json);
      return;
    }
    const migrated = targets.map((op) => ({ id: op.id, text: (op as Record<string, unknown>).text as string | undefined }));
    if (!opts.dryRun) {
      const next = { ...manifest, operations: manifest.operations.map((op) => targets.some((t) => t.id === op.id) ? { ...op, status: 'disabled' as const, disabledReason: 'legacy_model_requires_recreate' } : op) };
      saveManifestV3(workspace, next);
    }
    print(program.opts().json ? { migrated, total: migrated.length, dryRun: Boolean(opts.dryRun) } : `${opts.dryRun ? '[dry-run] Would migrate' : 'Migrated'} ${migrated.length} op(s): ${migrated.map((op) => op.id).join(', ')}`, program.opts().json);
  });

program.command('apply-edit').description('Add a source-time manifest edit')
  .argument('<type>', 'cut or mute')
  .requiredOption('--clip <clipId>', 'target clip id')
  .option('--track <trackId>', 'target track id; defaults to clip owner')
  .requiredOption('--start <seconds>', 'source start seconds')
  .requiredOption('--end <seconds>', 'source end seconds')
  .option('--reason <reason>', 'edit reason')
  .action((type, opts) => {
    if (!['cut', 'mute'].includes(type)) throw new Error('type must be cut or mute');
    const workspace = workspaceOption(program.opts().workspace);
    const manifest = loadManifestV3(workspace);
    const trackId = opts.track ?? manifest.tracks.find((track) => track.clips.some((clip) => clip.clipId === opts.clip))?.trackId;
    if (!trackId) throw new Error(`Unknown clipId: ${opts.clip}`);
    const { manifest: next, operation: op } = addOperation(manifest, { id: `op_${type}_${Date.now()}`, type, status: 'approved', target: { kind: 'clip-span', trackId, clipId: opts.clip, start: Number(opts.start), end: Number(opts.end) }, reason: opts.reason, proposedBy: 'user', createdBy: 'user', createdAt: new Date().toISOString() });
    saveManifestV3(workspace, next);
    print(program.opts().json ? op : `Added ${op.type}: ${op.id}`, program.opts().json);
  });

function cliHomeDir(): string | undefined {
  return process.env.ETVS_HOME;
}

const PROVIDER_KINDS = ['stt', 'tts', 'studio-sound', 'image-gen', 'video-gen', 'music-gen'] as const;
function providerKind(value: string): ProviderKind {
  if (!(PROVIDER_KINDS as readonly string[]).includes(value)) throw new Error(`kind must be ${PROVIDER_KINDS.join(', ')}`);
  return value as ProviderKind;
}

function providerToPlain(provider: ProviderRecord) {
  return provider;
}

function writeProviderSuccess(payload: unknown) {
  print(program.opts().json ? { ok: true, ...payload as object } : payload, program.opts().json);
}

function writeProviderError(error: unknown) {
  const envelope = settingsErrorEnvelope(error);
  if (program.opts().json) console.log(JSON.stringify({ ok: false, ...envelope }, null, 2));
  else console.error((envelope.error.message));
  process.exitCode = envelope.error.code === 'settings_stale' ? 11 : envelope.error.code === 'provider_not_found' ? 4 : envelope.error.code === 'paid_default_requires_ack' ? 12 : 1;
}

async function readStdinSecret(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

async function providerAction(fn: () => unknown | Promise<unknown>) {
  try { await fn(); } catch (err) { writeProviderError(err); }
}

const providersCommand = program.command('providers').description('Configure provider registry');

providersCommand.command('add')
  .requiredOption('--id <id>', 'provider id, e.g. stt.homelab-whisper')
  .requiredOption('--kind <kind>', 'stt, tts, studio-sound, image-gen, video-gen, or music-gen')
  .requiredOption('--name <name>', 'stable provider slug')
  .requiredOption('--tier <tier>', 'local or paid')
  .option('--base-url <url>', 'provider base URL')
  .option('--secret-ref <ref>', 'secret reference key')
  .option('--default', 'mark as default for kind')
  .option('--disabled', 'create disabled')
  .action((opts) => providerAction(() => {
    const provider = upsertProvider({ homeDir: cliHomeDir(), provider: { id: opts.id, kind: providerKind(opts.kind), name: opts.name, tier: opts.tier, baseUrl: opts.baseUrl, secretRef: opts.secretRef, default: Boolean(opts.default), enabled: !opts.disabled } });
    writeProviderSuccess({ provider: providerToPlain(provider) });
  }));

providersCommand.command('list').action(() => providerAction(() => {
  const snapshot = readProviderRegistry({ homeDir: cliHomeDir() });
  writeProviderSuccess({ providers: snapshot.value.providers });
}));

providersCommand.command('get').argument('<id>').action((id) => providerAction(() => {
  const provider = readProviderRegistry({ homeDir: cliHomeDir() }).value.providers.find((candidate) => candidate.id === id);
  if (!provider) throw new Error(`Provider not found: ${id}`);
  writeProviderSuccess({ provider });
}));

providersCommand.command('remove').argument('<id>').action((id) => providerAction(() => {
  const provider = removeProvider({ homeDir: cliHomeDir(), id });
  writeProviderSuccess({ removed: provider.id });
}));

providersCommand.command('set-secret')
  .argument('<secretRef>')
  .option('--stdin', 'read secret from stdin')
  .action((secretRef, opts) => providerAction(async () => {
    if (!opts.stdin) throw new Error('set-secret requires --stdin; secrets are never accepted via argv');
    setProviderSecret({ homeDir: cliHomeDir(), secretRef, value: await readStdinSecret() });
    writeProviderSuccess({ secretRef });
  }));

providersCommand.command('set-default')
  .argument('<kind>')
  .argument('<id>')
  .option('--yes', 'acknowledge paid provider default cost')
  .action((kind, id, opts) => providerAction(() => {
    // Shared primitive (core canonicalProviderId): shorthand → `<kind>.<name>`, and a typed
    // error for anything that is not a provider id — writeProviderError renders it as usual.
    const canonicalId = canonicalProviderId(kind, id);
    if (!canonicalId) throw new Error('Provider id is required');
    const provider = setDefaultProvider({ homeDir: cliHomeDir(), kind: providerKind(kind), id: canonicalId, acknowledgePaid: Boolean(opts.yes) });
    writeProviderSuccess({ kind, defaultProvider: provider.id });
  }));

providersCommand.command('default')
  .argument('<kind>', 'legacy alias for set-default')
  .argument('<provider>')
  .option('--yes', 'acknowledge paid provider default cost')
  .action((kind, provider, opts) => providerAction(() => {
    const id = canonicalProviderId(kind, provider);
    if (!id) throw new Error('Provider id is required');
    const normalizedKind = providerKind(kind);
    const existing = readProviderRegistry({ homeDir: cliHomeDir() }).value.providers.find((candidate) => candidate.id === id);
    if (!existing) {
      const name = id.split('.')[1]!;
      upsertProvider({ homeDir: cliHomeDir(), provider: { id, kind: normalizedKind, name, tier: name === 'ffmpeg-local' || name.includes('local') ? 'local' : 'paid' } });
    }
    const selected = setDefaultProvider({ homeDir: cliHomeDir(), kind: normalizedKind, id, acknowledgePaid: Boolean(opts.yes) });
    writeProviderSuccess({ kind, defaultProvider: selected.id });
  }));

providersCommand.command('import-env').action(() => providerAction(() => {
  const imported = importLegacyEnvProviders({ homeDir: cliHomeDir(), env: process.env as Record<string, string | undefined> });
  writeProviderSuccess({ imported: imported.map((provider) => provider.id) });
}));

function testProviderConnection(provider: ProviderRecord) {
  if (!provider.enabled) throw new Error(`Provider disabled: ${provider.id}`);
  if (provider.baseUrl) {
    try { new URL(provider.baseUrl); } catch { throw new Error(`Invalid provider base URL: ${provider.baseUrl}`); }
  }
  return { provider: provider.id, reachable: true };
}

providersCommand.command('test').argument('<id>').action((id) => providerAction(async () => {
  const provider = readProviderRegistry({ homeDir: cliHomeDir() }).value.providers.find((candidate) => candidate.id === id);
  if (!provider) throw new Error(`Provider not found: ${id}`);
  writeProviderSuccess(testProviderConnection(provider));
}));

async function runQuickstartWizard() {
  if (program.opts().json) throw new Error('quickstart is interactive and cannot run with --json; use ets providers add/test/set-default for scripted setup.');
  let scriptedAnswers: string[] | null = null;
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    scriptedAnswers = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
  }
  const mutedOutput = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const ask = async (question: string) => {
    if (scriptedAnswers) {
      output.write(question);
      return (scriptedAnswers.shift() ?? '').trim();
    }
    const questionRl = createInterface({ input, output });
    try {
      return (await questionRl.question(question)).trim();
    } finally {
      questionRl.close();
    }
  };
  const askSecret = async (question: string) => {
    if (scriptedAnswers) {
      output.write(question);
      return (scriptedAnswers.shift() ?? '').trim();
    }
    output.write(question);
    const secretRl = createInterface({ input, output: mutedOutput, terminal: true });
    try {
      const answer = (await secretRl.question('')).trim();
      output.write('\n');
      return answer;
    } finally {
      secretRl.close();
    }
  };
  const kind = providerKind(await ask(`Provider kind (${PROVIDER_KINDS.join('/')}): `));
  const slug = (await ask('Provider slug (stable name, e.g. homelab-whisper): ')).toLowerCase().replace(/_/g, '-');
  const tierInput = await ask('Tier (local/paid): ');
  if (!['local', 'paid'].includes(tierInput)) throw new Error('tier must be local or paid');
  const tier = tierInput as 'local' | 'paid';
  const baseUrl = await ask('Base URL (optional): ');
  const secret = await askSecret('Secret/API key (optional, stored in ~/.etvs/secrets.json; input hidden): ');
  const id = `${kind}.${slug}`;
  const secretRef = secret ? `${id}.api-key` : undefined;
  if (secretRef) setProviderSecret({ homeDir: cliHomeDir(), secretRef, value: secret });
  const provider = upsertProvider({ homeDir: cliHomeDir(), provider: { id, kind, name: slug, tier, baseUrl: baseUrl || undefined, secretRef, enabled: true } });
  console.log(`Provider added: ${provider.id}`);
  try {
    testProviderConnection(provider);
    console.log('Connection test: ok');
  } catch (err) {
    console.log(`Connection test: failed — ${err instanceof Error ? err.message : String(err)}`);
  }
  const setAsDefault = /^y(es)?$/i.test(await ask(`Set ${provider.id} as default for ${kind}? (y/N): `));
  if (!setAsDefault) {
    console.log('Default not changed.');
    return;
  }
  if (provider.tier === 'paid') {
    const ack = /^y(es)?$/i.test(await ask(`Paid default confirmation: calls through ${provider.id} may cost money and will run with cost disclosure. Continue? (y/N): `));
    if (!ack) {
      console.log('Paid default not set.');
      return;
    }
  }
  const selected = setDefaultProvider({ homeDir: cliHomeDir(), kind, id: provider.id, acknowledgePaid: provider.tier === 'paid' });
  console.log(`Default set: ${selected.id}`);
}

program.command('quickstart').description('Interactive first-run provider setup wizard').action(async () => {
  try { await runQuickstartWizard(); }
  catch (err) { console.error(err instanceof Error ? err.message : String(err)); process.exitCode = 1; }
});

program.command('render').description('Render edited MP4 from manifest')
  .option('--preset <preset>', 'draft or youtube', 'draft')
  .option('--output <path>', 'workspace-relative output path')
  .option('--yes', 'allow final overwrite')
  .action(async (opts) => {
    const workspace = workspaceOption(program.opts().workspace);
    const manifest = loadManifestV3(workspace);
    const skipped = manifest.operations.filter(
      (op) => op.type === 'voice_patch' && op.status === 'disabled' && op.disabledReason === 'legacy_model_requires_recreate'
    );
    if (skipped.length) {
      console.warn(`Skipping ${skipped.length} legacy voice_patch op(s) (re-create to apply ripple): ${skipped.map((o) => o.id).join(', ')}`);
    }
    const plan = buildRenderPlanV3(manifest, loadTranscript(workspace) ?? undefined);
    if (plan.studioCleanupStale) {
      console.warn(STUDIO_CLEANUP_STALE_WARNING);
    }
    const output = await renderPlanV3(workspace, plan, { output: opts.output ?? (opts.preset === 'youtube' ? 'renders/final.mp4' : 'renders/draft.mp4'), overwrite: Boolean(opts.yes) });
    print(program.opts().json ? { output, skipped: skipped.map((o) => o.id), ...(plan.studioCleanupStale ? { studioCleanupStale: true } : {}) } : `Rendered: ${output}`, program.opts().json);
  });

program.command('export-captions').description('Export edited captions from manifest')
  .option('--format <format>', 'srt or vtt', 'srt')
  .option('--output <path>', 'workspace-relative output path under captions/')
  .action((opts) => {
    if (!['srt', 'vtt'].includes(opts.format)) throw new Error('format must be srt or vtt');
    const workspace = workspaceOption(program.opts().workspace);
    const manifest = loadManifestV3(workspace);
    const transcript = loadTranscript(workspace);
    if (!transcript) throw new Error('transcript/words.json not found; run ets transcribe first');
    const cues = projectCaptionsV3(manifest, transcript, buildRenderPlanV3(manifest).timeMap);
    const outputRel = opts.output ?? `captions/edited.${opts.format}`;
    const outputPath = assertInside(workspace, outputRel);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, opts.format === 'vtt' ? captionsToVttV3(cues) : captionsToSrtV3(cues));
    const output = outputRel;
    print(program.opts().json ? { output } : `Captions ready: ${output}`, program.opts().json);
  });

program.command('skill')
  .description('Run a reference agent skill against an agent WebSocket')
  .argument('<name>', 'skill name under skills/')
  .requiredOption('--ws-url <url>', 'agent websocket URL without token')
  .requiredOption('--token <token>', 'local admin token')
  .requiredOption('--project-id <id>', 'project id')
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .action((name, opts, command) => {
    const rawArgs = process.argv.slice(process.argv.indexOf('skill') + 2);
    const extraArgs = rawArgs.filter((value, index) => {
      if (value === name) return false;
      const previous = rawArgs[index - 1];
      return !['--ws-url', '--token', '--workspace', '--project-id'].includes(value) && !['--ws-url', '--token', '--workspace', '--project-id'].includes(previous || '');
    });
    const child = spawnSync(process.execPath, ['--import', 'tsx', skillScript(name), '--ws-url', opts.wsUrl, '--token', opts.token, '--workspace', workspaceOption(program.opts().workspace), '--project-id', opts.projectId, ...extraArgs], { stdio: 'inherit', cwd: repoRoot(), env: process.env });
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 1;
  });

if (process.argv[1] && (resolve(process.argv[1]) === fileURLToPath(import.meta.url) || basename(process.argv[1]) === 'ets')) {
  program.parseAsync(process.argv).catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
}
