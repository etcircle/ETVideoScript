import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, copyFileSync, readdirSync, statSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, relative, basename } from 'node:path';
import { Project, ProjectSchema, ProjectSchemaV1 } from './schemas';
import { ManifestV3Schema, type ManifestV3 } from './manifest/schema';

export const WORKSPACE_FOLDERS = ['input', 'media/thumbnails', 'transcript', 'edits/revisions', 'edits/proposals', 'assets/voice', 'assets/lipsync', 'assets/broll', 'renders/render-logs', 'captions', 'logs'];

export function nowIso(): string { return new Date().toISOString(); }

export function defaultRenderPresets() {
  return {
    draft: { resolution: '1280x720', videoBitrate: '2500k', audioBitrate: '128k' },
    youtube: { resolution: 'source', videoBitrate: 'source-or-auto', audioBitrate: '192k' }
  };
}

export function defaultProject(workspacePath: string, projectId: string, title: string): Project {
  const now = nowIso();
  return ProjectSchema.parse({ schemaVersion: 1, manifestVersion: 3, projectId, title, createdAt: now, updatedAt: now, workspacePath: resolve(workspacePath), clipSources: [], status: { imported: false, audioExtracted: false, transcribed: false, manifestValid: true, lastRender: null } });
}

export function defaultManifest(projectId: string): ManifestV3 {
  const now = nowIso();
  return ManifestV3Schema.parse({
    manifestVersion: 3,
    projectId,
    createdAt: now,
    updatedAt: now,
    assets: [],
    tracks: [{ trackId: 'track_video_001', kind: 'video', name: 'Video 1', order: 0, locked: false, muted: false, solo: false, hidden: false, clips: [] }],
    operations: [],
    outputs: [{ outputId: 'output_full_001', kind: 'full', aspects: ['16:9'], status: 'manual' }],
    renderPresets: defaultRenderPresets()
  });
}

export function assertInside(workspacePath: string, targetPath: string): string {
  const workspace = resolve(workspacePath);
  const resolved = isAbsolute(targetPath) ? resolve(targetPath) : resolve(workspace, targetPath);
  const rel = relative(workspace, resolved);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return resolved;
  throw new Error(`Path escapes outside workspace: ${targetPath}`);
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, stableJsonValue(nested)]));
  }
  return value;
}

export function atomicWriteFile(path: string, content: string | Buffer, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  let fd: number | undefined;
  try {
    fd = mode === undefined ? openSync(tmp, 'wx') : openSync(tmp, 'wx', mode);
    if (typeof content === 'string') writeSync(fd, content);
    else writeSync(fd, content, 0, content.length, 0);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
    try {
      const dirFd = openSync(dirname(path), 'r');
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    } catch {}
  } catch (err) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
}

export function atomicWriteJson(path: string, value: unknown, mode?: number): void {
  atomicWriteFile(path, `${JSON.stringify(stableJsonValue(value), null, 2)}\n`, mode);
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export async function createWorkspace(input: { workspacePath: string; projectId: string; title: string }): Promise<Project> {
  const workspace = resolve(input.workspacePath);
  mkdirSync(workspace, { recursive: true });
  for (const folder of WORKSPACE_FOLDERS) mkdirSync(join(workspace, folder), { recursive: true });
  const projectPath = join(workspace, 'project.json');
  const manifestPath = join(workspace, 'edits/manifest.json');
  if (!existsSync(projectPath)) atomicWriteJson(projectPath, defaultProject(workspace, input.projectId, input.title));
  if (!existsSync(manifestPath)) atomicWriteJson(manifestPath, defaultManifest(input.projectId));
  const agentPath = join(workspace, 'AGENTS.md');
  const claudePath = join(workspace, 'CLAUDE.md');
  const instruction = `# ${input.projectId} workspace\n\nProject state lives in files. Preserve source media. Use edits/manifest.json as timeline edit truth. Run etvideo validate-manifest before rendering.\n`;
  if (!existsSync(agentPath)) atomicWriteFile(agentPath, instruction);
  if (!existsSync(claudePath)) atomicWriteFile(claudePath, instruction);
  return loadProject(workspace);
}

export function loadProject(workspacePath: string): Project {
  const raw = readJson<unknown>(join(resolve(workspacePath), 'project.json'));
  // V1 detection must happen BEFORE v2 parse. v2 ProjectSchema strips unknown
  // `source` and defaults `clipSources: []`, silently discarding v1 metadata.
  // Check for the v1 `source` field on the raw object first.
  const looksLikeV1 = raw && typeof raw === 'object' && 'source' in raw && (raw as { source?: unknown }).source != null;
  if (looksLikeV1) {
    const legacy = ProjectSchemaV1.safeParse(raw);
    if (legacy.success && legacy.data.source) {
      return ProjectSchema.parse({
        schemaVersion: 1,
        manifestVersion: 3,
        projectId: legacy.data.projectId,
        title: legacy.data.title,
        createdAt: legacy.data.createdAt,
        updatedAt: legacy.data.updatedAt,
        workspacePath: legacy.data.workspacePath,
        clipSources: [{ ...legacy.data.source, clipId: 'clip_001', videoCodec: '', audioCodec: '', pixelFormat: '' }],
        status: legacy.data.status
      });
    }
  }
  return ProjectSchema.parse(raw);
}

export function saveProject(project: Project): void {
  atomicWriteJson(join(project.workspacePath, 'project.json'), ProjectSchema.parse({ ...project, updatedAt: nowIso() }));
}

export async function writeManifestRevision(workspacePath: string): Promise<string> { return writeManifestRevisionSync(workspacePath); }
export function writeManifestRevisionSync(workspacePath: string): string {
  const src = join(resolve(workspacePath), 'edits/manifest.json');
  if (!existsSync(src)) throw new Error('No manifest exists to revise');
  const revisions = join(resolve(workspacePath), 'edits/revisions');
  mkdirSync(revisions, { recursive: true });
  const existing = readdirSync(revisions).filter((name) => /^manifest-\d{4}\.json$/.test(name)).sort();
  const next = `manifest-${String(existing.length + 1).padStart(4, '0')}.json`;
  const dst = join(revisions, next);
  copyFileSync(src, dst);
  return relative(resolve(workspacePath), dst).split('\\').join('/');
}

export function sha256File(path: string): string {
  const hash = createHash('sha256');
  hash.update(readFileSync(path));
  return hash.digest('hex');
}

export function listProjects(workspaceRoot: string): Project[] {
  const root = resolve(workspaceRoot);
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((name) => {
    const projectPath = join(root, name, 'project.json');
    try { return statSync(join(root, name)).isDirectory() && existsSync(projectPath) ? [loadProject(join(root, name))] : []; }
    catch { return []; }
  });
}

export function safeProjectPath(workspaceRoot: string, projectId: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(projectId)) throw new Error(`Invalid project id: ${projectId}`);
  return assertInside(workspaceRoot, projectId);
}

export function relativeToWorkspace(workspacePath: string, filePath: string): string {
  return relative(resolve(workspacePath), resolve(filePath)).split('\\').join('/');
}

export function originalName(path: string): string { return basename(path); }
