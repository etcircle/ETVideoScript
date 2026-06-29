import { latestJobs, listProjects, loadProject, loadTranscript, createWorkspace, importSource, doctor, readProviderRequests } from '@etvideoscript/core';
import { resolve } from 'node:path';
import type { LocalApiRouteContext } from './routeContext';

export function registerProjectRoutes(ctx: LocalApiRouteContext) {
  const { app, config, workspace, fileInfo, draftRenderFreshness, peaksFreshness, validateWorkspaceManifest, loadManifest, errorMessage } = ctx;

  app.get('/health', async () => ({ ok: true, doctor: doctor(), workspaceRoot: config.workspaceRoot, terminalEnabled: config.enableTerminal, agentEnabled: config.enableAgent }));

  app.get('/api/projects', async () => ({ projects: listProjects(config.workspaceRoot) }));

  app.post<{ Body: { projectId: string; title: string } }>('/api/projects', async (req) => {
    const project = await createWorkspace({ workspacePath: workspace(req.body.projectId), projectId: req.body.projectId, title: req.body.title || req.body.projectId });
    return { project };
  });

  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/diagnostics', async (req) => {
    const ws = workspace(req.params.projectId);
    const project = loadProject(ws);
    const manifest = loadManifest(ws);
    const validation = validateWorkspaceManifest(ws);
    const errors: Record<string, string> = {};
    let transcript: ReturnType<typeof loadTranscript> | null = null;
    try { transcript = loadTranscript(ws); } catch (err) { errors.transcript = errorMessage(err); }
    let recent: ReturnType<typeof latestJobs> = [];
    try { recent = latestJobs(ws).slice(0, 10); } catch (err) { errors.jobs = errorMessage(err); }
    const firstClipId = manifest.tracks.flatMap((track: any) => track.clips).at(0)?.clipId ?? project.clipSources[0]?.clipId;
    const clipMediaFile = (clipRel: string, legacyRel: string) => {
      if (!firstClipId) return fileInfo(ws, legacyRel);
      const v2 = fileInfo(ws, `media/${firstClipId}/${clipRel}`);
      if (v2.exists) return v2;
      const legacy = fileInfo(ws, legacyRel);
      return legacy.exists ? legacy : v2;
    };
    const files = {
      source: fileInfo(ws, 'input/source.mp4'),
      proxy: fileInfo(ws, 'media/proxy-video.mp4'),
      audio: clipMediaFile('extracted-audio.wav', 'media/extracted-audio.wav'),
      transcriptWords: fileInfo(ws, 'transcript/words.json'),
      transcriptMarkdown: fileInfo(ws, 'transcript/transcript.md'),
      manifest: fileInfo(ws, 'edits/manifest.json'),
      draft: fileInfo(ws, 'renders/draft.mp4'),
      final: fileInfo(ws, 'renders/final.mp4'),
      peaks: clipMediaFile('peaks.json', 'media/peaks.json')
    };
    let providerRequests: ReturnType<typeof readProviderRequests> | null = null;
    try { providerRequests = readProviderRequests(ws, { throwIfAllInvalid: true }); } catch (err) { errors.providerRequests = errorMessage(err); }
    return { diagnostics: { projectId: project.projectId, title: project.title, workspacePath: project.workspacePath, doctor: doctor(), validation, files, renderFreshness: { draft: draftRenderFreshness(ws, manifest.updatedAt, files.draft, recent) }, peaksFreshness: peaksFreshness(files), status: project.status, transcript: transcript ? { words: transcript.words.length, segments: transcript.segments.length, timing: transcript.provider.timing, provider: transcript.provider.name } : null, manifest: { operations: manifest.operations.length }, providerRequests, jobs: errors.jobs ? null : { recent }, liveOverdubDisabled: config.disableLiveOverdub, errors } };
  });

  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId', async (req) => {
    const ws = workspace(req.params.projectId);
    return { project: loadProject(ws), manifest: loadManifest(ws), validation: validateWorkspaceManifest(ws), transcript: loadTranscript(ws), jobs: latestJobs(ws).slice(0, 20) };
  });

  app.post<{ Params: { projectId: string }; Body: { filePath: string; replace?: boolean } }>('/api/projects/:projectId/import', async (req) => ({ project: await importSource(workspace(req.params.projectId), resolve(req.body.filePath), { copy: true, replace: Boolean(req.body.replace) }) }));
}
