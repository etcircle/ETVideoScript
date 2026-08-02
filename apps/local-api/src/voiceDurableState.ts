import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { assertInside, atomicWriteJson } from '@etvideoscript/core';

// ── Durable state for the S1b voice flow ────────────────────────────────────────
// Three stores, all under the workspace's logs/ dir, all written atomically (tmp + fsync +
// rename) so a crash can never leave a half-written record:
//
//   1. CLONE RESERVATIONS      — the ⟨Q2⟩ state machine that makes a paid clone at-most-once
//                                and makes cancellation decidable.
//   2. COMMIT-PENDING MARKERS  — the ⟨Q1⟩ crash-consistent Phase-3 protocol.
//   3. ROOT TERMINALS          — the ⟨F4⟩ exactly-once route-level terminal, replayed
//                                byte-for-byte on a repeat requestId.
//
// Every mutation here runs under the caller's project manifest mutex — that mutex is what
// makes read-modify-write on these JSON files a CAS.
//
// FAIL CLOSED. These files gate PAID calls: a reservation says "a clone is already in flight,
// do not bill again"; a terminal says "this request already had an outcome, do not re-execute".
// Treating unreadable or malformed content as "no state" would convert a corrupt file into
// duplicate billing — precisely the failure the stores exist to prevent. So every read parses
// through a zod schema and throws DurableStateCorruptError on anything unexpected, which the
// routes surface as a sticky 500 an operator has to look at.

export class DurableStateCorruptError extends Error {
  readonly code = 'durable-state-corrupt';
  constructor(store: string, detail: string) {
    super(`durable-state-corrupt: ${store} is unreadable or malformed (${detail}). Refusing to treat it as empty — that would risk billing a paid call twice. Inspect the file under logs/ and repair or remove it deliberately.`);
    this.name = 'DurableStateCorruptError';
  }
}

function readJsonStore<T>(path: string, store: string, parse: (value: unknown) => T): T | null {
  if (!existsSync(path)) return null;
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); }
  catch (err) { throw new DurableStateCorruptError(store, err instanceof Error ? err.message : String(err)); }
  let json: unknown;
  try { json = JSON.parse(raw); }
  catch (err) { throw new DurableStateCorruptError(store, `invalid JSON: ${err instanceof Error ? err.message : String(err)}`); }
  try { return parse(json); }
  catch (err) { throw new DurableStateCorruptError(store, err instanceof Error ? err.message : String(err)); }
}

// ── 1. Clone reservations (⟨F2⟩ + ⟨Q2⟩) ─────────────────────────────────────────

/**
 * Durable clone states, in order. Cancellation is only legal in 'local-prep'; from
 * 'provider-in-flight' on, the money may already be committed and the job must run to its real
 * terminal (409 too-late-to-cancel).
 */
export const CloneReservationStateSchema = z.enum([
  'local-prep',          // decode + window selection; nothing paid yet
  'provider-in-flight',  // the paid clone call has been issued
  'provider-committed',  // the provider returned a voice id; local persist may still be pending
  'persisted',           // voices.json holds the record — the clone is fully usable
  'failed'               // terminal failure (errorCode carries which)
]);
export type CloneReservationState = z.infer<typeof CloneReservationStateSchema>;

export const CloneReservationSchema = z.object({
  key: z.string().regex(/^[0-9a-f]{64}$/),
  projectId: z.string().min(1),
  jobId: z.string().min(1),
  accountRef: z.string().min(1).max(200).optional(),
  cleanupIdentity: z.string().regex(/^[0-9a-f]{64}$/),
  clipId: z.string().min(1).max(128),
  sourceClass: z.enum(['raw', 'cleaned']),
  state: CloneReservationStateSchema,
  voiceId: z.string().min(1).max(128).optional(),
  errorCode: z.string().min(1).max(64).optional(),
  errorMessage: z.string().max(4096).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1)
}).superRefine((reservation, ctx) => {
  // {outcome XOR error}: a terminal reservation carries exactly one kind of outcome.
  if (reservation.state === 'failed' && !reservation.errorCode) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['errorCode'], message: 'a failed reservation must carry an errorCode' });
  if (reservation.state === 'persisted') {
    if (!reservation.voiceId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['voiceId'], message: 'a persisted reservation must carry its voiceId' });
    if (reservation.errorCode) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['errorCode'], message: 'a persisted reservation must not carry an errorCode' });
  }
});
export type CloneReservation = z.infer<typeof CloneReservationSchema>;

const ReservationFileSchema = z.record(z.string(), CloneReservationSchema);
type ReservationFile = z.infer<typeof ReservationFileSchema>;

function reservationsPath(ws: string): string {
  return assertInside(ws, 'logs/voice-clone-reservations.json');
}

/**
 * Structural reservation key (⟨F2⟩). Known SYNCHRONOUSLY in the POST handler — before the 202,
 * before setImmediate — which is the whole point: the racy `runningByProjectAndType` set cannot
 * stop two simultaneous POSTs from both reaching the paid call, a durable key can.
 *
 * The chosen windows are deliberately NOT part of the key: they are only known after the decode
 * + selection phase, i.e. after the moment the duplicate must already have been rejected. The
 * key is the coarser structural identity (account, cleanup generation, source class, clip),
 * which is exactly "the clone this project needs right now" — window-exactness is still
 * enforced downstream by cloneCleanClip's own cache identity.
 */
export function cloneReservationKey(input: { accountRef?: string; cleanupIdentity: string; sourceClass: 'raw' | 'cleaned'; clipId: string }): string {
  // JSON-tuple, not delimiter-join: any of these values may contain the delimiter, and a
  // non-injective key is a cache collision AFTER a paid call has already succeeded.
  const tuple = JSON.stringify([input.accountRef ?? null, input.cleanupIdentity, input.sourceClass, input.clipId]);
  return createHash('sha256').update(tuple).digest('hex');
}

export function readCloneReservations(ws: string): ReservationFile {
  return readJsonStore(reservationsPath(ws), 'logs/voice-clone-reservations.json', (value) => ReservationFileSchema.parse(value)) ?? {};
}

export function readCloneReservation(ws: string, key: string): CloneReservation | null {
  return readCloneReservations(ws)[key] ?? null;
}

export function writeCloneReservation(ws: string, reservation: CloneReservation): CloneReservation {
  const parsed = CloneReservationSchema.parse(reservation);
  const all = readCloneReservations(ws);
  all[parsed.key] = parsed;
  atomicWriteJson(reservationsPath(ws), all);
  return parsed;
}

/**
 * Compare-and-set on the reservation state. `from` lists the states the transition is legal
 * from; a reservation in any other state is left untouched and `null` is returned, so a racing
 * cancel and a racing commit can never both win.
 *
 * CALLERS MUST HOLD THE PROJECT MUTEX. Read-modify-write on a JSON file is only atomic with
 * respect to writers that serialize on the same lock; without it the cancel path and the
 * pre-payment transition can both observe 'local-prep' and both proceed.
 */
export function casCloneReservation(
  ws: string,
  key: string,
  from: CloneReservationState[],
  patch: Partial<Omit<CloneReservation, 'key' | 'createdAt'>> & { state: CloneReservationState }
): CloneReservation | null {
  const all = readCloneReservations(ws);
  const current = all[key];
  if (!current || !from.includes(current.state)) return null;
  const next = CloneReservationSchema.parse({ ...current, ...patch, key: current.key, createdAt: current.createdAt, updatedAt: new Date().toISOString() });
  all[key] = next;
  atomicWriteJson(reservationsPath(ws), all);
  return next;
}

export function deleteCloneReservation(ws: string, key: string): void {
  const all = readCloneReservations(ws);
  if (!(key in all)) return;
  delete all[key];
  atomicWriteJson(reservationsPath(ws), all);
}

// ── 2. Commit-pending markers (⟨Q1⟩/⟨R3⟩) ───────────────────────────────────────

/**
 * Immutable record of WHAT executed (D5). Clone identity is mutable server state and therefore
 * must NOT be part of bodyHash — instead it is snapshotted at Phase 1 and re-verified at Phase 3,
 * so a clone or cleanup that changed mid-flight is a detectable conflict rather than a silently
 * mismatched patch.
 */
export const VoicePatchExecutionSnapshotSchema = z.object({
  voiceId: z.string().min(1).max(128),
  accountRef: z.string().min(1).max(200).optional(),
  cleanupIdentity: z.string().regex(/^[0-9a-f]{64}$/),
  ttsModel: z.string().min(1).max(128),
  stsModel: z.string().min(1).max(128),
  recipeVersion: z.string().min(1).max(64)
});
export type VoicePatchExecutionSnapshot = z.infer<typeof VoicePatchExecutionSnapshotSchema>;

/**
 * The operation's identity as Phase 1 wrote it, and as Phase 3 expects to find it. Recovery
 * compares the CURRENT op against BOTH images: status alone is not identity — an op the user
 * edited mid-flight can share a status with the one we generated for while carrying different
 * text, a different target, or a different asset.
 */
export const VoicePatchOpImageSchema = z.object({
  status: z.string().min(1),
  providerRequestId: z.string().min(1),
  text: z.string(),
  // The target's IDENTITY, not just its bounds: an op moved to a different clip or track keeps
  // its start/end while pointing at completely different audio.
  targetClipId: z.string().optional(),
  targetTrackId: z.string().optional(),
  targetStart: z.number(),
  targetEnd: z.number(),
  assetRel: z.string().optional(),
  durationGeneratedSec: z.number().optional(),
  durationRequestedSec: z.number().optional(),
  seamBaked: z.boolean().optional()
});
export type VoicePatchOpImage = z.infer<typeof VoicePatchOpImageSchema>;

/**
 * Written durably BEFORE the Phase-3 manifest mutation and cleared only after the root terminal
 * is appended AND fsynced. It carries the FINALIZED terminal, so recovery never has to re-derive
 * anything: whatever the crash window, the terminal is reconstructable from this marker alone.
 *
 * `intendedOutcome: 'preserve'` is a first-class outcome: the request HAS a terminal, but the
 * operation must NOT be touched — the user edited or removed it while the paid call was in
 * flight, and overwriting their state with our stale rejection would be a second bug stacked on
 * the failure.
 */
export const VoicePatchCommitMarkerSchema = z.object({
  requestId: z.string().min(1).max(128),
  projectId: z.string().min(1),
  operationId: z.string().min(1),
  assetRel: z.string(),
  intendedOutcome: z.enum(['approve', 'reject', 'preserve']),
  /** The exact HTTP status + serialized body the client would have received. */
  httpStatus: z.number().int().min(100).max(599),
  serializedBody: z.string().min(2),
  bodyHash: z.string().min(1),
  executionSnapshot: VoicePatchExecutionSnapshotSchema,
  /** The op as Phase 1 left it — recovery only mutates an op that still matches this. */
  expectedOpPreimage: VoicePatchOpImageSchema,
  /** The op Phase 3 intends to leave behind — a match here means the mutation already landed. */
  expectedOpPostimage: VoicePatchOpImageSchema,
  createdAt: z.string().min(1)
}).superRefine((marker, ctx) => {
  // {response XOR error}: a 200 terminal carries a result body, a non-200 carries an error.
  let body: unknown;
  try { body = JSON.parse(marker.serializedBody); }
  catch { ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['serializedBody'], message: 'serializedBody must be valid JSON' }); return; }
  const hasError = !!(body && typeof body === 'object' && 'error' in (body as Record<string, unknown>));
  if (marker.httpStatus === 200 && hasError) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['serializedBody'], message: 'a 200 terminal must not carry an error' });
  if (marker.httpStatus !== 200 && !hasError) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['serializedBody'], message: 'a non-200 terminal must carry an error' });
  if (marker.intendedOutcome === 'preserve' && marker.httpStatus === 200) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['intendedOutcome'], message: 'a preserved operation cannot also be a successful approval' });
});
export type VoicePatchCommitMarker = z.infer<typeof VoicePatchCommitMarkerSchema>;

const MarkerFileSchema = z.record(z.string(), VoicePatchCommitMarkerSchema);

function markersPath(ws: string): string {
  return assertInside(ws, 'logs/voice-patch-commit-markers.json');
}

export function readCommitMarkers(ws: string): Record<string, VoicePatchCommitMarker> {
  return readJsonStore(markersPath(ws), 'logs/voice-patch-commit-markers.json', (value) => MarkerFileSchema.parse(value)) ?? {};
}

export function readCommitMarker(ws: string, requestId: string): VoicePatchCommitMarker | null {
  return readCommitMarkers(ws)[requestId] ?? null;
}

export function writeCommitMarker(ws: string, marker: VoicePatchCommitMarker): void {
  const parsed = VoicePatchCommitMarkerSchema.parse(marker);
  const all = readCommitMarkers(ws);
  all[parsed.requestId] = parsed;
  atomicWriteJson(markersPath(ws), all);
}

export function clearCommitMarker(ws: string, requestId: string): void {
  const all = readCommitMarkers(ws);
  if (!(requestId in all)) return;
  delete all[requestId];
  atomicWriteJson(markersPath(ws), all);
}

// ── 3. Root terminals (⟨F4⟩/⟨Q1⟩) ───────────────────────────────────────────────

/**
 * The route-level terminal: the exact HTTP status and response body one user action produced.
 * Consulted BEFORE clone resolution or any freshness check, and replayed byte-for-byte — a
 * retry of a request that already failed (TTS failure, STS failure, degraded output, Phase-3
 * conflict) must reproduce that failure, not re-execute it.
 *
 * Append-only JSONL with no uniqueness enforcement, exactly like the provider ledger: reads
 * therefore have to DETECT duplicate-but-conflicting terminals rather than take the first one —
 * two different outcomes for one requestId means something wrote a terminal we cannot reconcile,
 * and silently picking one would publish a lie.
 */
export const VoicePatchRootTerminalSchema = z.object({
  requestId: z.string().min(1).max(128),
  projectId: z.string().min(1),
  httpStatus: z.number().int().min(100).max(599),
  serializedBody: z.string().min(2),
  bodyHash: z.string().min(1),
  executionSnapshot: VoicePatchExecutionSnapshotSchema.optional(),
  createdAt: z.string().min(1)
}).superRefine((terminal, ctx) => {
  let body: unknown;
  try { body = JSON.parse(terminal.serializedBody); }
  catch { ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['serializedBody'], message: 'serializedBody must be valid JSON' }); return; }
  const hasError = !!(body && typeof body === 'object' && 'error' in (body as Record<string, unknown>));
  if (terminal.httpStatus === 200 && hasError) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['serializedBody'], message: 'a 200 terminal must not carry an error' });
  if (terminal.httpStatus !== 200 && !hasError) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['serializedBody'], message: 'a non-200 terminal must carry an error' });
});
export type VoicePatchRootTerminal = z.infer<typeof VoicePatchRootTerminalSchema>;

function terminalsPath(ws: string): string {
  return assertInside(ws, 'logs/voice-patch-terminals.jsonl');
}

export function readRootTerminals(ws: string): VoicePatchRootTerminal[] {
  const path = terminalsPath(ws);
  if (!existsSync(path)) return [];
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); }
  catch (err) { throw new DurableStateCorruptError('logs/voice-patch-terminals.jsonl', err instanceof Error ? err.message : String(err)); }
  return raw.split('\n').filter(Boolean).map((line, index) => {
    let json: unknown;
    // A malformed line is NOT skipped: this log records what the user was already told, and
    // quietly dropping an entry re-opens a completed request for re-execution.
    try { json = JSON.parse(line); }
    catch { throw new DurableStateCorruptError('logs/voice-patch-terminals.jsonl', `line ${index + 1} is not valid JSON`); }
    const parsed = VoicePatchRootTerminalSchema.safeParse(json);
    if (!parsed.success) throw new DurableStateCorruptError('logs/voice-patch-terminals.jsonl', `line ${index + 1}: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
    return parsed.data;
  });
}

/**
 * The terminal for one request. Throws on duplicate-but-conflicting terminals so ORDINARY
 * replay — not just marker recovery — surfaces ledger corruption.
 */
export function readRootTerminal(ws: string, requestId: string): VoicePatchRootTerminal | null {
  const matches = readRootTerminals(ws).filter((terminal) => terminal.requestId === requestId);
  if (matches.length === 0) return null;
  const first = matches[0]!;
  const conflicting = matches.find((terminal) => !sameRootTerminal(first, terminal));
  if (conflicting) {
    throw new DurableStateCorruptError('logs/voice-patch-terminals.jsonl', `requestId ${requestId} has two different terminals (HTTP ${first.httpStatus} and HTTP ${conflicting.httpStatus})`);
  }
  return first;
}

export function appendRootTerminal(ws: string, terminal: VoicePatchRootTerminal): VoicePatchRootTerminal {
  const parsed = VoicePatchRootTerminalSchema.parse(terminal);
  const path = terminalsPath(ws);
  mkdirSync(dirname(path), { recursive: true });
  // fsync BEFORE the caller clears the marker: the marker is the only way to reconstruct this
  // terminal, so it must not be removed while the terminal is still sitting in the page cache.
  const fd = openSync(path, 'a');
  try {
    writeSync(fd, `${JSON.stringify(parsed)}\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try {
    const dirFd = openSync(dirname(path), 'r');
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch { /* directory fsync is unsupported on some filesystems; the file fsync already landed */ }
  return parsed;
}

/** True when two terminals describe the same outcome — the ⟨Q1⟩ idempotent-recovery case. */
export function sameRootTerminal(a: VoicePatchRootTerminal, b: VoicePatchRootTerminal): boolean {
  return a.requestId === b.requestId
    && a.httpStatus === b.httpStatus
    && a.serializedBody === b.serializedBody
    && a.bodyHash === b.bodyHash;
}
