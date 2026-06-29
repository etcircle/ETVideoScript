import { z, type ZodTypeAny } from 'zod';
import { cutOperationKind } from './cut';
import { muteOperationKind } from './mute';
import { overlayOperationKind } from './overlay';
import { speedOperationKind } from './speed';
import { transitionOperationKind } from './transition';
import { voicePatchOperationKind } from './voice-patch';
import { captionStyleOperationKind } from './caption-style';
import { transcriptAmendOperationKind } from './transcript-amend';
import type { OperationKind } from './base';

const operationKinds = [cutOperationKind, muteOperationKind, voicePatchOperationKind, speedOperationKind, overlayOperationKind, transitionOperationKind, captionStyleOperationKind, transcriptAmendOperationKind] as const;

export const registeredOperationKinds = operationKinds;
export type RegisteredOperationKind = (typeof operationKinds)[number];
export type RegisteredOperationType = RegisteredOperationKind['type'];

export const operationKindByType: ReadonlyMap<string, OperationKind> = new Map(operationKinds.map((kind) => [kind.type, kind]));

export function getOperationKind(type: string): OperationKind {
  const kind = operationKindByType.get(type);
  if (!kind) throw new Error(`Unknown operation type: ${type}`);
  return kind;
}

export function hasOperationKind(type: string): type is RegisteredOperationType {
  return operationKindByType.has(type);
}

const operationSchemas = operationKinds.map((kind) => kind.schema) as unknown as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]];

export const OperationSchema = z.union(operationSchemas);
export type Operation = z.infer<typeof OperationSchema>;

export const OPERATION_PRECEDENCE = Object.freeze(Object.fromEntries(operationKinds.map((kind) => [kind.type, kind.precedence])) as Record<RegisteredOperationType, number>);
