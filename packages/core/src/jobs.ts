import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { JobRecord, JobRecordSchema } from './schemas';
import { nowIso } from './filesystem';

export function makeJobId(type: string): string {
  const safeType = type.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'job';
  return `job_${safeType}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function appendJobRecord(workspacePath: string, record: JobRecord): JobRecord {
  const parsed = JobRecordSchema.parse(record);
  const logsDir = join(resolve(workspacePath), 'logs');
  mkdirSync(logsDir, { recursive: true });
  appendFileSync(join(logsDir, 'jobs.jsonl'), `${JSON.stringify(parsed)}\n`);
  return parsed;
}

export function appendJobStatus(workspacePath: string, input: Omit<JobRecord, 'createdAt'> & { createdAt?: string }): JobRecord {
  return appendJobRecord(workspacePath, { ...input, createdAt: input.createdAt || nowIso() });
}

export function readJobEvents(workspacePath: string): JobRecord[] {
  const path = join(resolve(workspacePath), 'logs/jobs.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try { return [JobRecordSchema.parse(JSON.parse(line))]; }
      catch { return []; }
    });
}

export function latestJobs(workspacePath: string): JobRecord[] {
  const latest = new Map<string, JobRecord>();
  for (const event of readJobEvents(workspacePath)) latest.set(event.jobId, { ...latest.get(event.jobId), ...event });
  return Array.from(latest.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function latestJob(workspacePath: string, jobId: string): JobRecord | null {
  return latestJobs(workspacePath).find((job) => job.jobId === jobId) || null;
}

export function jobEvents(workspacePath: string, jobId: string): JobRecord[] {
  return readJobEvents(workspacePath).filter((job) => job.jobId === jobId);
}
