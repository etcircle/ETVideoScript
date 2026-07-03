import {
  addAssetV3,
  addClipV3,
  addTrackV3,
  detachAudioInWorkspaceV3,
  loadTranscript,
  moveClipV3,
  proposeOutputsV3,
  removeAssetV3,
  removeClipV3,
  removeTrackV3,
  renameTrackV3,
  reorderTracksV3,
  setBrandPackId,
  setTrackFlagsV3,
  trimClipV3,
  updateAssetV3
} from '@etvideoscript/core';
import type { LocalApiRouteContext } from './routeContext';

function touch(manifest: any) {
  return { ...manifest, updatedAt: new Date().toISOString() };
}

function response(ctx: LocalApiRouteContext, ws: string, result: Record<string, unknown>) {
  return { ...result, manifest: ctx.loadManifest(ws), validation: ctx.validateWorkspaceManifest(ws) };
}

async function mutate(ctx: LocalApiRouteContext, projectId: string, edit: (manifest: any, ws: string) => Record<string, unknown> | Promise<Record<string, unknown>>) {
  const ws = ctx.workspace(projectId);
  return ctx.withProjectManifestMutex(projectId, async () => {
    const result = await edit(ctx.loadManifest(ws), ws);
    return response(ctx, ws, result);
  });
}

function routeError(reply: any, err: unknown) {
  return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
}

function saveValidated(ctx: LocalApiRouteContext, ws: string, manifest: any) {
  const validation = ctx.validateManifestDocument(manifest);
  if (!validation.valid) throw new Error(`Manifest structure edit rejected:\n${validation.errors.join('\n')}`);
  ctx.saveManifest(ws, manifest, true);
}

export function registerStructureRoutes(ctx: LocalApiRouteContext) {
  const { app } = ctx;

  app.put<{ Params: { projectId: string }; Body: { brandPackId?: string | null } }>(
    '/api/projects/:projectId/brand-pack', async (req, reply) => {
      const body = req.body as { brandPackId?: string | null };
      try {
        return await mutate(ctx, req.params.projectId, (manifest, ws) => {
          const result = setBrandPackId(manifest, body?.brandPackId ?? null);
          ctx.saveManifest(ws, result.manifest, true);
          return { brandPackId: result.manifest.brandPackId ?? null };
        });
      } catch (err) { return routeError(reply, err); }
    });

  app.post<{ Params: { projectId: string }; Body: any }>('/api/projects/:projectId/tracks', async (req, reply) => {
    const body = req.body as any;
    try { return await mutate(ctx, req.params.projectId, (manifest, ws) => { const result = addTrackV3(manifest, body); ctx.saveManifest(ws, result.manifest, true); return { track: result.track }; }); }
    catch (err) { return routeError(reply, err); }
  });

  app.delete<{ Params: { projectId: string; trackId: string } }>('/api/projects/:projectId/tracks/:trackId', async (req, reply) => {
    try { return await mutate(ctx, req.params.projectId, (manifest, ws) => { const result = removeTrackV3(manifest, { trackId: req.params.trackId }); ctx.saveManifest(ws, result.manifest, true); return { track: result.track }; }); }
    catch (err) { return routeError(reply, err); }
  });

  app.patch<{ Params: { projectId: string; trackId: string }; Body: any }>('/api/projects/:projectId/tracks/:trackId', async (req, reply) => {
    const body = req.body as any;
    try {
      return await mutate(ctx, req.params.projectId, (manifest, ws) => {
        let current = manifest;
        let track: any;
        if (typeof body.name === 'string') { const result = renameTrackV3(current, { trackId: req.params.trackId, name: body.name }); current = result.manifest; track = result.track; }
        const flags = ['locked', 'muted', 'solo', 'hidden'].reduce((acc: any, key) => (body[key] == null ? acc : { ...acc, [key]: Boolean(body[key]) }), {});
        if (Object.keys(flags).length) { const result = setTrackFlagsV3(current, { trackId: req.params.trackId, ...flags }); current = result.manifest; track = result.track; }
        if (body.fx !== undefined) {
          let updated: any;
          current = touch({ ...current, tracks: current.tracks.map((candidate: any) => {
            if (candidate.trackId !== req.params.trackId) return candidate;
            updated = { ...candidate, fx: body.fx };
            return updated;
          }) });
          if (!updated) throw new Error(`Track not found: ${req.params.trackId}`);
          saveValidated(ctx, ws, current);
          return { track: updated };
        }
        if (!track) throw new Error('No track patch fields supplied');
        ctx.saveManifest(ws, current, true);
        return { track };
      });
    } catch (err) { return routeError(reply, err); }
  });

  app.post<{ Params: { projectId: string }; Body: { order: { trackId: string; order: number }[] } }>('/api/projects/:projectId/tracks/reorder', async (req, reply) => {
    try { return await mutate(ctx, req.params.projectId, (manifest, ws) => { const result = reorderTracksV3(manifest, req.body); ctx.saveManifest(ws, result.manifest, true); return { tracks: result.tracks }; }); }
    catch (err) { return routeError(reply, err); }
  });

  app.post<{ Params: { projectId: string }; Body: any }>('/api/projects/:projectId/clips', async (req, reply) => {
    const body = req.body as any;
    try { return await mutate(ctx, req.params.projectId, (manifest, ws) => { const result = addClipV3(manifest, body); ctx.saveManifest(ws, result.manifest, true); return { clip: result.clip }; }); }
    catch (err) { return routeError(reply, err); }
  });

  app.patch<{ Params: { projectId: string; clipId: string }; Body: any }>('/api/projects/:projectId/clips/:clipId', async (req, reply) => {
    const body = req.body as any;
    try {
      return await mutate(ctx, req.params.projectId, (manifest, ws) => {
        let current = manifest;
        let clip: any;
        if (body.timelineStart != null) { const result = moveClipV3(current, { clipId: req.params.clipId, timelineStart: Number(body.timelineStart) }); current = result.manifest; clip = result.clip; }
        if (body.sourceStart != null || body.sourceEnd != null) {
          const existing = current.tracks.flatMap((track: any) => track.clips).find((candidate: any) => candidate.clipId === req.params.clipId);
          if (!existing) throw new Error(`Clip not found: ${req.params.clipId}`);
          const result = trimClipV3(current, { clipId: req.params.clipId, sourceStart: Number(body.sourceStart ?? existing.sourceStart), sourceEnd: Number(body.sourceEnd ?? existing.sourceEnd) });
          current = result.manifest; clip = result.clip;
        }
        if (!clip) throw new Error('No clip patch fields supplied');
        ctx.saveManifest(ws, current, true);
        return { clip };
      });
    } catch (err) { return routeError(reply, err); }
  });

  app.delete<{ Params: { projectId: string; clipId: string } }>('/api/projects/:projectId/clips/:clipId', async (req, reply) => {
    try { return await mutate(ctx, req.params.projectId, (manifest, ws) => { const result = removeClipV3(manifest, { clipId: req.params.clipId }); ctx.saveManifest(ws, result.manifest, true); return { clip: result.clip }; }); }
    catch (err) { return routeError(reply, err); }
  });

  app.post<{ Params: { projectId: string; clipId: string }; Body: { detachedClipId?: string; refresh?: boolean } }>('/api/projects/:projectId/clips/:clipId/detach-audio', async (req, reply) => {
    try {
      const ws = ctx.workspace(req.params.projectId);
      return await ctx.withProjectManifestMutex(req.params.projectId, async () => {
        const result = detachAudioInWorkspaceV3(ws, { clipId: req.params.clipId, detachedClipId: req.body?.detachedClipId, refresh: req.body?.refresh });
        return response(ctx, ws, { videoClip: result.videoClip, audioClip: result.audioClip, audioTrack: result.audioTrack, asset: result.asset });
      });
    } catch (err) { return routeError(reply, err); }
  });

  app.post<{ Params: { projectId: string }; Body: any }>('/api/projects/:projectId/assets', async (req, reply) => {
    const body = req.body as any;
    try { return await mutate(ctx, req.params.projectId, (manifest, ws) => { const result = addAssetV3(manifest, body); ctx.saveManifest(ws, result.manifest, true); return { asset: result.asset }; }); }
    catch (err) { return routeError(reply, err); }
  });
  app.patch<{ Params: { projectId: string; assetId: string }; Body: any }>('/api/projects/:projectId/assets/:assetId', async (req, reply) => {
    const body = req.body as any;
    try { return await mutate(ctx, req.params.projectId, (manifest, ws) => { const result = updateAssetV3(manifest, { assetId: req.params.assetId, patch: body }); ctx.saveManifest(ws, result.manifest, true); return { asset: result.asset }; }); }
    catch (err) { return routeError(reply, err); }
  });
  app.delete<{ Params: { projectId: string; assetId: string } }>('/api/projects/:projectId/assets/:assetId', async (req, reply) => {
    try { return await mutate(ctx, req.params.projectId, (manifest, ws) => { const result = removeAssetV3(manifest, { assetId: req.params.assetId }); ctx.saveManifest(ws, result.manifest, true); return { asset: result.asset }; }); }
    catch (err) { return routeError(reply, err); }
  });

  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/outputs', async (req) => {
    const ws = ctx.workspace(req.params.projectId);
    const manifest = ctx.loadManifest(ws);
    return { outputs: manifest.outputs || [], manifest, validation: ctx.validateWorkspaceManifest(ws) };
  });
  app.post<{ Params: { projectId: string }; Body: any }>('/api/projects/:projectId/outputs', async (req, reply) => {
    const body = req.body as any;
    try { return await mutate(ctx, req.params.projectId, (manifest, ws) => { if (manifest.outputs?.some((output: any) => output.outputId === body.outputId)) throw new Error(`Output already exists: ${body.outputId}`); const next = touch({ ...manifest, outputs: [...(manifest.outputs || []), body] }); saveValidated(ctx, ws, next); return { output: body, outputs: next.outputs }; }); }
    catch (err) { return routeError(reply, err); }
  });
  app.patch<{ Params: { projectId: string; outputId: string }; Body: any }>('/api/projects/:projectId/outputs/:outputId', async (req, reply) => {
    const body = req.body as any;
    try { return await mutate(ctx, req.params.projectId, (manifest, ws) => { let output: any; const next = touch({ ...manifest, outputs: (manifest.outputs || []).map((candidate: any) => { if (candidate.outputId !== req.params.outputId) return candidate; output = { ...candidate, ...body, outputId: candidate.outputId }; return output; }) }); if (!output) throw new Error(`Output not found: ${req.params.outputId}`); saveValidated(ctx, ws, next); return { output, outputs: next.outputs }; }); }
    catch (err) { return routeError(reply, err); }
  });
  app.delete<{ Params: { projectId: string; outputId: string } }>('/api/projects/:projectId/outputs/:outputId', async (req, reply) => {
    try { return await mutate(ctx, req.params.projectId, (manifest, ws) => { const output = (manifest.outputs || []).find((candidate: any) => candidate.outputId === req.params.outputId); if (!output) throw new Error(`Output not found: ${req.params.outputId}`); const next = touch({ ...manifest, outputs: manifest.outputs.filter((candidate: any) => candidate.outputId !== req.params.outputId) }); saveValidated(ctx, ws, next); return { output, outputs: next.outputs }; }); }
    catch (err) { return routeError(reply, err); }
  });
  app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/outputs/propose', async (req) => {
    const ws = ctx.workspace(req.params.projectId);
    const manifest = ctx.loadManifest(ws);
    const transcript = loadTranscript(ws);
    if (!transcript) return { outputs: [], manifest, validation: ctx.validateWorkspaceManifest(ws) };
    return { outputs: proposeOutputsV3(manifest, transcript), manifest, validation: ctx.validateWorkspaceManifest(ws) };
  });
}
