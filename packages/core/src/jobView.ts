// BROWSER-SAFE (ADR-0001): types only — no node:*, no zod, no fs. Exported from browser.ts so
// the Studio client can type job payloads without pulling jobs.ts (appendFileSync) into the
// Next.js bundle. Kept structurally identical to JobRecordSchema's output; the round-trip test
// (jobs.errorcode.test.ts) asserts a parsed JobRecord is assignable to JobView, so a schema
// change that this file misses fails typecheck rather than drifting silently.

export type JobStatus = 'queued' | 'waiting_for_approval' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface JobStageView {
  name: string;
  status: JobStatus;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  clipId?: string;
  phase?: string;
  percent?: number;
}

export interface JobView {
  jobId: string;
  projectId?: string;
  type: string;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  command?: string;
  args?: string[];
  input?: Record<string, unknown>;
  stages?: JobStageView[];
  outputs?: string[];
  error?: string;
  log?: string;
  warning?: string;
  /**
   * S1b ⟨R5⟩: machine-readable failure discriminator. The status enum stays as-is — an
   * interrupted job is `status:'failed'` + `errorCode:'interrupted'`, so existing status
   * switches in the UI keep working and only the copy layer needs to learn the new codes.
   */
  errorCode?: string;
  errorDetails?: Record<string, unknown>;
}

/** True for the terminal states a poller should stop on. */
export function isTerminalJobStatus(status: JobStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}
