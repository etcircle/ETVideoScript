import { appendJobStatus, jobEvents, latestJob, latestJobs } from '@etvideoscript/core';
import { cancelPrepareVoice, PREPARE_VOICE_JOB_TYPE } from './voiceRoutes';
import type { LocalApiRouteContext } from './routeContext';

type JobType = 'extract-audio' | 'peaks' | 'transcribe' | 'validate-manifest' | 'render-draft' | 'export-captions';

export function registerJobRoutes(ctx: LocalApiRouteContext, cancelledJobs: Set<string>) {
  const { app, workspace, queueJob } = ctx;

  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/jobs', async (req) => ({ jobs: latestJobs(workspace(req.params.projectId)).slice(0, 50) }));

  app.get<{ Params: { projectId: string; jobId: string } }>('/api/projects/:projectId/jobs/:jobId', async (req, reply) => {
    const ws = workspace(req.params.projectId);
    const job = latestJob(ws, req.params.jobId);
    if (!job) return reply.code(404).send({ error: 'job not found' });
    return { job, events: jobEvents(ws, req.params.jobId) };
  });

  app.post<{ Params: { projectId: string; jobId: string } }>('/api/projects/:projectId/jobs/:jobId/cancel', async (req, reply) => {
    const ws = workspace(req.params.projectId);
    const job = latestJob(ws, req.params.jobId);
    if (!job) return reply.code(404).send({ error: 'job not found' });
    // ⟨Q2⟩: prepare-voice cancellation is only legal before the paid clone call is issued.
    // After that the generic "write a cancelled terminal" behaviour would claim the call never
    // happened, so the route refuses instead and lets the job reach its real terminal.
    if (job.type === PREPARE_VOICE_JOB_TYPE) {
      const dispatch = await cancelPrepareVoice(ctx, req.params.projectId, ws, req.params.jobId, cancelledJobs);
      if (!dispatch.ok) return reply.code(dispatch.code).send(dispatch.body);
      return { job: latestJob(ws, req.params.jobId) };
    }
    cancelledJobs.add(req.params.jobId);
    appendJobStatus(ws, { jobId: req.params.jobId, projectId: req.params.projectId, type: job.type, status: 'cancelled', createdAt: job.createdAt, completedAt: new Date().toISOString(), stages: job.stages?.map((stage) => ['queued', 'running', 'waiting_for_approval'].includes(stage.status) ? { ...stage, status: 'cancelled' as const, completedAt: new Date().toISOString() } : stage) });
    return { job: latestJob(ws, req.params.jobId) };
  });

  app.post<{ Params: { projectId: string }; Body: { type: JobType; provider?: string; format?: string; overwrite?: boolean; resolutionHz?: number } }>('/api/projects/:projectId/jobs', async (req, reply) => {
    const supported: JobType[] = ['extract-audio', 'peaks', 'transcribe', 'validate-manifest', 'render-draft', 'export-captions'];
    if (!supported.includes(req.body.type)) return reply.code(400).send({ error: `Unsupported job type: ${req.body.type}` });
    const job = queueJob(req.params.projectId, req.body.type, req.body);
    return reply.code(202).send({ job });
  });
}
