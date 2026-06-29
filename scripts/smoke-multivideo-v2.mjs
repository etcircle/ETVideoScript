#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspace = join(repoRoot, 'workspaces', 'smoke-v2-end-to-end');
const stagingWorkspace = join(repoRoot, 'workspaces', '.smoke-v2-clip2-import');
const source1 = join(repoRoot, 'temp', 'smoke-source.mp4');
const source2 = join(repoRoot, 'temp', 'IMG_1158.MOV');
const outputRel = 'renders/smoke-v2-draft.mp4';
const outputPath = join(workspace, outputRel);

function log(line = '') { console.log(line); }
function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function writeJson(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }
function fail(message) { throw new Error(message); }

function run(command, args, options = {}) {
  log(`$ ${[command, ...args].join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
    env: { ...process.env, ...options.env }
  });
  if (result.stdout?.trim()) log(result.stdout.trim());
  if (result.stderr?.trim()) log(result.stderr.trim());
  if (result.status !== 0) fail(`${command} exited ${result.status}`);
  return result.stdout;
}

function ets(args) {
  return run('pnpm', ['--filter', '@etvideoscript/cli', 'ets', ...args]);
}

function ffprobeDuration(file) {
  const stdout = run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file]);
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) fail(`ffprobe returned invalid duration for ${file}: ${stdout}`);
  return duration;
}

function canonicalizeFirstClip() {
  const projectPath = join(workspace, 'project.json');
  const manifestPath = join(workspace, 'edits', 'manifest.json');
  const project = readJson(projectPath);
  const manifest = readJson(manifestPath);
  const first = project.clipSources[0];
  if (!first) fail('clip_001 metadata missing after import');

  const assetRel = 'assets/video/clip_001/source.mp4';
  const assetPath = join(workspace, assetRel);
  mkdirSync(dirname(assetPath), { recursive: true });
  copyFileSync(join(workspace, 'input', 'source.mp4'), assetPath);

  project.clipSources = [{ ...first, clipId: 'clip_001', path: assetRel }];
  manifest.tracks = [{
    trackId: 'track_video_001',
    kind: 'video',
    clips: [{ clipId: 'clip_001', assetPath: assetRel, sourceStart: 0, sourceEnd: first.durationSec }]
  }];
  manifest.updatedAt = new Date().toISOString();
  project.updatedAt = manifest.updatedAt;
  writeJson(projectPath, project);
  writeJson(manifestPath, manifest);
}

function importSecondClipThroughCliAndMerge() {
  rmSync(stagingWorkspace, { recursive: true, force: true });
  ets(['--workspace', stagingWorkspace, 'init', '--project-id', 'smoke-v2-clip2-import', '--title', 'Smoke V2 Clip 2 Import']);
  ets(['--workspace', stagingWorkspace, 'import', source2, '--yes']);

  const stagedProject = readJson(join(stagingWorkspace, 'project.json'));
  const second = stagedProject.clipSources[0];
  if (!second) fail('clip_002 metadata missing after staging import');

  const assetRel = 'assets/video/clip_002/source.mp4';
  const assetPath = join(workspace, assetRel);
  mkdirSync(dirname(assetPath), { recursive: true });
  copyFileSync(join(stagingWorkspace, 'input', 'source.mp4'), assetPath);

  const projectPath = join(workspace, 'project.json');
  const manifestPath = join(workspace, 'edits', 'manifest.json');
  const project = readJson(projectPath);
  const manifest = readJson(manifestPath);
  project.clipSources = [
    project.clipSources.find((clip) => clip.clipId === 'clip_001'),
    { ...second, clipId: 'clip_002', path: assetRel }
  ].filter(Boolean);
  project.status.imported = true;
  project.updatedAt = new Date().toISOString();

  const first = project.clipSources.find((clip) => clip.clipId === 'clip_001');
  const secondMerged = project.clipSources.find((clip) => clip.clipId === 'clip_002');
  manifest.tracks = [{
    trackId: 'track_video_001',
    kind: 'video',
    clips: [
      { clipId: 'clip_001', assetPath: first.path, sourceStart: 0, sourceEnd: first.durationSec },
      { clipId: 'clip_002', assetPath: secondMerged.path, sourceStart: 0, sourceEnd: secondMerged.durationSec }
    ]
  }];
  manifest.operations = [];
  manifest.updatedAt = project.updatedAt;

  writeJson(projectPath, project);
  writeJson(manifestPath, manifest);
}

async function main() {
  log('ETVideoScript multi-video v2 smoke');
  if (!existsSync(source1)) fail(`Missing required source: ${source1}`);
  if (!existsSync(source2)) fail(`Missing required source: ${source2}`);

  rmSync(workspace, { recursive: true, force: true });
  rmSync(stagingWorkspace, { recursive: true, force: true });
  mkdirSync(dirname(workspace), { recursive: true });

  ets(['--workspace', workspace, 'init', '--project-id', 'smoke-v2-end-to-end', '--title', 'Smoke V2 End-to-End']);
  ets(['--workspace', workspace, 'import', source1, '--yes']);
  canonicalizeFirstClip();
  importSecondClipThroughCliAndMerge();

  ets(['--workspace', workspace, 'extract-audio', '--clip', 'clip_001', '--yes']);
  ets(['--workspace', workspace, 'extract-audio', '--clip', 'clip_002', '--yes']);

  ets(['--workspace', workspace, 'transcribe', '--provider', 'mock', '--clip', 'clip_001']);
  ets(['--workspace', workspace, 'transcribe', '--provider', 'mock', '--clip', 'clip_002']);
  ets(['--workspace', workspace, 'transcribe', '--provider', 'mock']);

  ets(['--workspace', workspace, 'validate-manifest']);
  ets(['--workspace', workspace, 'render', '--preset', 'draft', '--output', outputRel, '--yes']);

  if (!existsSync(outputPath)) fail(`Render output missing: ${outputPath}`);
  const size = statSync(outputPath).size;
  if (size <= 0) fail(`Render output is empty: ${outputPath}`);
  const durationSec = ffprobeDuration(outputPath);
  const project = readJson(join(workspace, 'project.json'));
  const manifest = readJson(join(workspace, 'edits', 'manifest.json'));
  const clips = manifest.tracks[0]?.clips ?? [];

  rmSync(stagingWorkspace, { recursive: true, force: true });
  log(`SMOKE PASSED clips=${clips.length} sources=${project.clipSources.length} output=${outputRel} durationSec=${durationSec.toFixed(3)} sizeBytes=${size}`);
}

main().catch((error) => {
  console.error('SMOKE FAILED');
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
