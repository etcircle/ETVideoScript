import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertInside, atomicWriteJson } from '../filesystem';
import { AlignmentArtifactSchema, CompositionFileSchema, TakesError, type AlignmentArtifact, type CompositionFile } from './schema';

export function readAlignment(workspaceDir: string): AlignmentArtifact {
  const path = assertInside(resolve(workspaceDir), 'takes/alignment.json');
  if (!existsSync(path)) throw new TakesError('ALIGNMENT_STALE', 'takes/alignment.json not found. Run `ets takes align` first.');
  return AlignmentArtifactSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function writeAlignment(workspaceDir: string, artifact: AlignmentArtifact): void {
  atomicWriteJson(assertInside(resolve(workspaceDir), 'takes/alignment.json'), AlignmentArtifactSchema.parse(artifact));
}

export function readComposition(workspaceDir: string, relPath = 'takes/composition.json'): CompositionFile {
  const path = assertInside(resolve(workspaceDir), relPath);
  if (!existsSync(path)) throw new TakesError('COMPOSE_VALIDATION', `Composition file not found: ${relPath}`);
  return CompositionFileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function writeComposition(workspaceDir: string, file: CompositionFile, relPath = 'takes/composition.json'): void {
  atomicWriteJson(assertInside(resolve(workspaceDir), relPath), CompositionFileSchema.parse(file));
}

/** Hash of the CANONICAL composition (parsed then re-serialized) so formatting never changes the hash. */
export function compositionHash(file: CompositionFile): string {
  return createHash('sha256').update(JSON.stringify(CompositionFileSchema.parse(file))).digest('hex');
}
