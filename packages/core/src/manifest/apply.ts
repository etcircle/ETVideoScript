import { getOperationKind, type Operation } from '../operations/registry';
import { validateManifestV3Document } from './validate';
import type { ManifestV3 } from './schema';

export type OperationInput = Record<string, unknown> & { type: string };
export type OperationPatch = Record<string, unknown>;

export function addOperation(manifest: ManifestV3, input: OperationInput): { manifest: ManifestV3; operation: Operation } {
  const kind = getOperationKind(input.type);
  const operation = kind.schema.parse(input) as Operation;
  const next = { ...manifest, operations: [...manifest.operations, operation], updatedAt: new Date().toISOString() };
  const result = validateManifestV3Document(next);
  if (!result.valid) throw new Error(`Manifest edit rejected:\n${result.errors.join('\n')}`);
  return { manifest: next, operation };
}

export function updateOperation(manifest: ManifestV3, operationId: string, patch: OperationPatch): { manifest: ManifestV3; operation: Operation } {
  const index = manifest.operations.findIndex((op) => op.id === operationId);
  if (index === -1) throw new Error(`Manifest operation not found: ${operationId}`);
  const current = manifest.operations[index]!;
  const kind = getOperationKind(String(current.type));
  const operation = kind.schema.parse({ ...current, ...patch, id: current.id, type: current.type, createdAt: current.createdAt, createdBy: current.createdBy }) as Operation;
  const operations = manifest.operations.map((op, i) => (i === index ? operation : op));
  const next = { ...manifest, operations, updatedAt: new Date().toISOString() };
  const result = validateManifestV3Document(next);
  if (!result.valid) throw new Error(`Manifest edit rejected:\n${result.errors.join('\n')}`);
  return { manifest: next, operation };
}
