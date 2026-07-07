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
import { addOperation, analyzeChannelBalance, applyChannelFix, captionsToSrtV3, captionsToVttV3, createWorkspace, doctor, extractAllClipAudio, extractAllClipWaveformPeaks, extractClipAudio, extractClipWaveformPeaks, importLegacyEnvProviders, importSource, importTake, computeAlignment, readAlignment, writeAlignment, loadManifestV3, loadProject, readProviderRegistry, removeProvider, safeProjectPath, settingsErrorEnvelope, setDefaultProvider, setProviderSecret, transcribeAllClips, transcribeClip, upsertProvider, validateManifestV3Document, saveManifestV3, buildRenderPlanV3, renderPlanV3, projectCaptionsV3, loadTranscript, assertInside, nowIso, STUDIO_CLEANUP_STALE_WARNING, readBrief, briefTemplate, TakesError, TranscriptWordsSchema, validateComposition, materializeComposition, deriveChapters, readComposition, compositionHash, type ProviderKind, type ProviderRecord, type TranscriptWord } from '@etvideoscript/core';

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
    const provider = setDefaultProvider({ homeDir: cliHomeDir(), kind: providerKind(kind), id: id.includes('.') ? id : `${kind}.${id}`, acknowledgePaid: Boolean(opts.yes) });
    writeProviderSuccess({ kind, defaultProvider: provider.id });
  }));

providersCommand.command('default')
  .argument('<kind>', 'legacy alias for set-default')
  .argument('<provider>')
  .option('--yes', 'acknowledge paid provider default cost')
  .action((kind, provider, opts) => providerAction(() => {
    const id = provider.includes('.') ? provider : `${kind}.${provider}`;
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

function takesCliAction(json: boolean | undefined, fn: () => void) {
  try { fn(); } catch (err) {
    if (err instanceof TakesError) {
      if (json) print({ error: { code: err.code, message: err.message, details: err.details ?? null } }, true);
      else console.error(`${err.code}: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

const briefCommand = program.command('brief').description('Manage the project brief that educates edit decisions');
briefCommand.command('init').description('Write a brief.md template to fill in')
  .action(() => takesCliAction(program.opts().json, () => {
    const workspace = workspaceOption(program.opts().workspace);
    const target = assertInside(workspace, 'brief.md');
    if (existsSync(target)) throw new TakesError('BRIEF_INVALID', 'brief.md already exists; edit it directly or use `ets brief set --file --force`');
    writeFileSync(target, briefTemplate());
    print(program.opts().json ? { path: target } : `Brief template written: ${target}`, program.opts().json);
  }));
briefCommand.command('set').description('Validate and install a brief file as brief.md')
  .requiredOption('--file <path>', 'markdown file with YAML frontmatter')
  .option('--force', 'overwrite an existing brief.md')
  .action((opts) => takesCliAction(program.opts().json, () => {
    const workspace = workspaceOption(program.opts().workspace);
    const target = assertInside(workspace, 'brief.md');
    if (existsSync(target) && !opts.force) throw new TakesError('BRIEF_INVALID', 'brief.md already exists; pass --force to replace it');
    const raw = readFileSync(resolve(opts.file), 'utf8');
    writeFileSync(target, raw);
    const brief = readBrief(workspace); // validates; throws (and leaves file for inspection) if invalid
    print(program.opts().json ? { frontmatter: brief.frontmatter } : `Brief set: ${brief.frontmatter.title}`, program.opts().json);
  }));
briefCommand.command('show').description('Print the parsed brief')
  .action(() => takesCliAction(program.opts().json, () => {
    const brief = readBrief(workspaceOption(program.opts().workspace));
    print(program.opts().json ? brief : `# ${brief.frontmatter.title}\naudience: ${brief.frontmatter.audience}\ntone: ${brief.frontmatter.tone ?? '-'}\ntarget: ${brief.frontmatter.targetDurationSec ?? '-'}s\n\n${brief.body}`, program.opts().json);
  }));

function loadClipTranscript(workspace: string, clipId: string) {
  const path = assertInside(workspace, `transcript/${clipId}/words.json`);
  if (!existsSync(path)) return null;
  return TranscriptWordsSchema.parse(JSON.parse(readFileSync(path, 'utf8'))).words;
}

const takesCommand = program.command('takes').description('Multi-take import, alignment, and inspection');

takesCommand.command('add').description('Import one or more takes into the staging track')
  .argument('<files...>', 'take video files')
  .option('--group <id>', 'take group id', 'main')
  .option('--label <label>', 'label (single file only)')
  .action((files: string[], opts) => takesCliAction(program.opts().json, () => {
    if (opts.label && files.length > 1) throw new TakesError('COMPOSE_VALIDATION', '--label is only valid with a single file');
    const workspace = workspaceOption(program.opts().workspace);
    const results = files.map((file) => importTake(workspace, resolve(file), { groupId: opts.group, label: opts.label }));
    print(program.opts().json ? results : results.map((r) => `${r.clipId} <- ${r.path} (${r.durationSec.toFixed(1)}s)`).join('\n'), program.opts().json);
  }));

takesCommand.command('list').description('List take groups and their takes')
  .action(() => takesCliAction(program.opts().json, () => {
    const workspace = workspaceOption(program.opts().workspace);
    const manifest = loadManifestV3(workspace);
    const rows = manifest.takeGroups.flatMap((g) => g.clipIds.map((clipId) => {
      const words = loadClipTranscript(workspace, clipId);
      return { groupId: g.groupId, clipId, transcribed: words !== null, wordCount: words?.length ?? 0 };
    }));
    print(program.opts().json ? { groups: manifest.takeGroups, takes: rows } : rows.map((r) => `${r.groupId}/${r.clipId} ${r.transcribed ? `${r.wordCount}w` : 'not transcribed'}`).join('\n') || '(no takes)', program.opts().json);
  }));

takesCommand.command('align').description('Align takes against a reference script into takes/alignment.json')
  .option('--group <id>', 'take group id', 'main')
  .option('--reference <clipId>', 'use a specific take as reference')
  .option('--script <file>', 'use a plain-text script file as reference')
  .action((opts) => takesCliAction(program.opts().json, () => {
    const workspace = workspaceOption(program.opts().workspace);
    let manifest = loadManifestV3(workspace);
    const group = manifest.takeGroups.find((g) => g.groupId === opts.group);
    if (!group) throw new TakesError('TAKES_UNKNOWN_GROUP', `Unknown take group: ${opts.group}. Known: ${manifest.takeGroups.map((g) => g.groupId).join(', ') || '(none)'}`);
    let scriptText: string | undefined;
    if (opts.script) {
      scriptText = readFileSync(resolve(opts.script), 'utf8');
      mkdirSync(assertInside(workspace, 'takes'), { recursive: true });
      writeFileSync(assertInside(workspace, 'takes/script.txt'), scriptText);
      group.reference = { kind: 'file', path: 'takes/script.txt' };
      saveManifestV3(workspace, manifest, { revision: true });
    } else if (opts.reference) {
      group.reference = { kind: 'take', clipId: opts.reference };
      saveManifestV3(workspace, manifest, { revision: true });
      manifest = loadManifestV3(workspace);
    }
    const transcripts = new Map<string, ReturnType<typeof loadClipTranscript>>();
    const missing: string[] = [];
    for (const clipId of group.clipIds) {
      const words = loadClipTranscript(workspace, clipId);
      if (!words) missing.push(clipId);
      else transcripts.set(clipId, words);
    }
    if (missing.length) throw new TakesError('TAKES_MISSING_TRANSCRIPTS', `Transcribe these first:\n${missing.map((c) => `  ets transcribe --clip ${c}`).join('\n')}`, { missing });
    const artifact = computeAlignment({ manifest, groupId: opts.group, transcripts: transcripts as Map<string, NonNullable<ReturnType<typeof loadClipTranscript>>>, scriptText, generatedAt: nowIso() });
    mkdirSync(assertInside(workspace, 'takes'), { recursive: true });
    writeAlignment(workspace, artifact);
    print(program.opts().json ? artifact : `Aligned ${artifact.takes.length} takes, ${artifact.spans.length} spans, ${artifact.orphans.length} orphans${artifact.takes.some((t) => t.lowConfidence) ? ' (low-confidence takes present)' : ''}`, program.opts().json);
  }));

takesCommand.command('spans').description('Show the span x take decision table')
  .option('--group <id>', 'take group id', 'main')
  .option('--contested', 'only spans where the top two candidates are close')
  .option('--gaps', 'only spans with zero candidates')
  .action((opts) => takesCliAction(program.opts().json, () => {
    const workspace = workspaceOption(program.opts().workspace);
    const artifact = readAlignment(workspace);
    const byspan = new Map<string, typeof artifact.candidates>();
    for (const c of artifact.candidates) { const list = byspan.get(c.spanId) ?? []; list.push(c); byspan.set(c.spanId, list); }
    const composite = (c: (typeof artifact.candidates)[number]) => c.matchQuality - 0.05 * c.metrics.fillerCount - 0.05 * c.metrics.falseStartCount;
    let spans = artifact.spans;
    if (opts.gaps) spans = spans.filter((s) => !byspan.has(s.spanId));
    if (opts.contested) spans = spans.filter((s) => {
      const list = (byspan.get(s.spanId) ?? []).slice().sort((a, b) => composite(b) - composite(a));
      return list.length >= 2 && (composite(list[0]) - composite(list[1])) < 0.15;
    });
    const rows = spans.map((s) => ({ spanId: s.spanId, ordinal: s.ordinal, text: s.text.split(/\s+/).slice(0, 8).join(' '), words: s.text.split(/\s+/).length, candidates: (byspan.get(s.spanId) ?? []).map((c) => ({ clipId: c.clipId, coverage: c.coverage, matchQuality: c.matchQuality, fillerCount: c.metrics.fillerCount, durationSec: c.metrics.durationSec })) }));
    print(program.opts().json ? { spans: rows } : rows.map((r) => `${r.spanId} (${r.ordinal}) "${r.text}..." ${r.candidates.map((c) => `${c.clipId}:cov${c.coverage}/mq${c.matchQuality}/f${c.fillerCount}`).join('  ')}`).join('\n') || '(no spans match filter)', program.opts().json);
  }));

takesCommand.command('span').description('Full detail for one span or orphan')
  .argument('<spanId>', 'span id (s001) or orphan id (o001)')
  .option('--take <clipId>', 'limit to one take')
  .option('--words', 'include word-by-word timings')
  .action((spanId: string, opts) => takesCliAction(program.opts().json, () => {
    const workspace = workspaceOption(program.opts().workspace);
    const artifact = readAlignment(workspace);
    if (spanId.startsWith('o')) {
      const orphan = artifact.orphans.find((o) => o.orphanId === spanId);
      if (!orphan) throw new TakesError('ALIGNMENT_STALE', `No orphan ${spanId} in alignment`);
      print(program.opts().json ? orphan : `${orphan.orphanId} [${orphan.clipId}] ${orphan.tStart.toFixed(2)}-${orphan.tEnd.toFixed(2)}s: ${orphan.text}`, program.opts().json);
      return;
    }
    const span = artifact.spans.find((s) => s.spanId === spanId);
    if (!span) throw new TakesError('ALIGNMENT_STALE', `No span ${spanId} in alignment`);
    let candidates = artifact.candidates.filter((c) => c.spanId === spanId);
    if (opts.take) candidates = candidates.filter((c) => c.clipId === opts.take);
    const detail = {
      span,
      candidates: candidates.map((c) => ({ ...c, words: opts.words ? (loadClipTranscript(workspace, c.clipId) ?? []).slice(c.takeWordStart, c.takeWordEnd + 1).map((w) => ({ text: w.text, start: w.start, end: w.end })) : undefined }))
    };
    print(program.opts().json ? detail : `${span.spanId}: ${span.text}\n${candidates.map((c) => `  ${c.clipId} cov${c.coverage} mq${c.matchQuality} fill${c.metrics.fillerCount} head${c.metrics.headBoundaryScore} tail${c.metrics.tailBoundaryScore}`).join('\n')}`, program.opts().json);
  }));

program.command('compose').description('Materialize a take composition into the timeline')
  .command('apply').description('Validate and apply takes/composition.json')
  .option('--file <path>', 'composition file', 'takes/composition.json')
  .option('--dry-run', 'validate and print the plan without writing')
  .action((opts) => takesCliAction(program.opts().json, () => {
    const workspace = workspaceOption(program.opts().workspace);
    const manifest = loadManifestV3(workspace);
    const alignment = readAlignment(workspace);
    const composition = readComposition(workspace, opts.file);
    // Load per-clip take transcripts so validateComposition can pad-clamp to neighbour words
    // and apply trim per-word (spec §10). Reuse loadClipTranscript from the takes verbs.
    const group = manifest.takeGroups.find((g) => g.groupId === composition.groupId);
    const takeTranscripts = new Map<string, TranscriptWord[]>();
    for (const clipId of group?.clipIds ?? []) {
      const words = loadClipTranscript(workspace, clipId);
      if (words) takeTranscripts.set(clipId, words);
    }
    const validation = validateComposition(manifest, alignment, composition, takeTranscripts);
    if (validation.errors.length) throw new TakesError('COMPOSE_VALIDATION', validation.errors.map((e) => `[${e.rule}] ${e.message}${e.spanId ? ` (${e.spanId})` : ''}${e.clipId ? ` (${e.clipId})` : ''}`).join('\n'), validation.errors);
    if (opts.dryRun) {
      const total = validation.plan.reduce((s, p) => s + p.durationSec, 0);
      print(program.opts().json ? { plan: validation.plan, warnings: validation.warnings, totalSec: total, rationales: composition.selections.map((s) => ({ order: s.order, rationale: s.rationale })) } : `PLAN (${validation.plan.length} clips, ${total.toFixed(1)}s)\n${validation.plan.map((p) => `  ${p.clipId} ${p.assetId} ${p.sourceStart.toFixed(2)}-${p.sourceEnd.toFixed(2)}s`).join('\n')}\n${validation.warnings.map((w) => `  WARN [${w.rule}] ${w.message}`).join('\n')}`, program.opts().json);
      return;
    }
    let next = materializeComposition(manifest, validation.plan);
    next = { ...next, composeState: { appliedAt: nowIso(), compositionHash: compositionHash(composition) } };
    saveManifestV3(workspace, next, { revision: true });
    print(program.opts().json ? { applied: validation.plan.length, warnings: validation.warnings } : `Applied ${validation.plan.length} clips${validation.warnings.length ? ` (${validation.warnings.length} warnings)` : ''}`, program.opts().json);
  }));

program.command('export-chapters').description('Export chapter markers from the applied composition')
  .option('--format <format>', 'json or youtube', 'json')
  .action((opts) => takesCliAction(program.opts().json, () => {
    const workspace = workspaceOption(program.opts().workspace);
    const manifest = loadManifestV3(workspace);
    const composition = readComposition(workspace);
    if (!manifest.composeState || manifest.composeState.compositionHash !== compositionHash(composition)) {
      throw new TakesError('CHAPTERS_STALE', 'Composition has not been applied (or changed since). Run `ets compose apply` first.');
    }
    const alignment = readAlignment(workspace);
    const plan = validateComposition(manifest, alignment, composition).plan;
    const chapters = deriveChapters(composition, alignment, plan);
    if (opts.format === 'youtube') {
      const lines = chapters.map((c) => { const m = Math.floor(c.startSec / 60); const s = Math.floor(c.startSec % 60); return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} ${c.title}`; });
      print(program.opts().json ? { chapters, youtube: lines } : lines.join('\n') || '(no chapters set)', program.opts().json);
    } else {
      print(program.opts().json ? { chapters } : chapters.map((c) => `${c.startSec.toFixed(1)}s ${c.title}`).join('\n') || '(no chapters set)', program.opts().json);
    }
  }));

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
