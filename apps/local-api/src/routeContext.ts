import type { FastifyInstance } from 'fastify';
import type { ApiConfig } from './config';

type JobType = 'extract-audio' | 'peaks' | 'transcribe' | 'validate-manifest' | 'render-draft' | 'export-captions';

type UploadStage = { name: string; status: 'queued' | 'waiting_for_approval' | 'running' | 'succeeded' | 'failed' | 'cancelled'; startedAt?: string; completedAt?: string; error?: string; clipId?: string; phase?: string; percent?: number };

export type LocalApiRouteContext = {
  app: FastifyInstance;
  config: ApiConfig;
  workspace(projectId: string): string;
  maxUploadBytes: number;
  withProjectManifestMutex<T>(projectId: string, task: () => Promise<T>): Promise<T>;
  withInFlightProviderCall<T>(key: string, work: () => Promise<T>): Promise<T>;
  updateStage(stages: UploadStage[], name: string, patch: Partial<UploadStage>): UploadStage[];
  queueJob(projectId: string, type: JobType, body?: any): any;
  addManifestOperation(ws: string, input: any): any;
  addVoicePatchOperation(ws: string, input: any): any;
  updateManifestOperation(ws: string, operationId: string, patch: any): any;

  loadManifest(ws: string): any;
  saveManifest(ws: string, manifest: any, revision?: boolean): void;
  validateWorkspaceManifest(ws: string): any;
  validateManifestDocument(manifest: any): any;
  clipTarget(manifest: any, clipId?: string, start?: number, end?: number): any;
  fileInfo(workspacePath: string, rel: string): any;
  parseRange(rangeHeader: string | undefined, size: number): { start: number; end: number } | null;
  contentType(path: string): string;
  draftRenderFreshness(ws: string, manifestUpdatedAt: string, draft: any, recentJobs: any): any;
  peaksFreshness(files: { audio: any; peaks: any }): any;
  baseProviderEvent(input: any): any;
  providerBodyHash(input: { text: string; start: number; end: number; provider: string; voice: string; language: string; model?: string; granularity?: string; cloneScope?: string; referenceRange?: { clipId: string; start: number; end: number } }): string;
  providerExecutionShape(event: unknown): any;
  voicePatchDurationWarning(generated: number, requested: number): any;
  errorMessage(err: unknown): string;
};
