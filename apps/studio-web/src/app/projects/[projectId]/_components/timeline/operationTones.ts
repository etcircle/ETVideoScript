import type { OperationV3, OverlayView } from '@etvideoscript/core/browser';

export type TimelineOperationView = { op: OperationV3; view: OverlayView; range: { start: number; end: number } };
export type WaveBarTone = 'cut' | 'mute' | 'voice_patch' | null;

/**
 * Pick the tone class for a waveform bar covering [start, end].
 *
 * Invariant assumed: a `voice_patch` op replaces the audio inside its span, so
 * if an active cut/mute overlaps a voice_patch on the same range, we surface
 * the replacement (green) rather than the destruction (orange/blue). Manifest
 * validation today prevents this overlap, but if that invariant ever changes
 * we'll want a distinct "conflict" tone — re-visit this function then.
 */
export function operationToneAt(operations: TimelineOperationView[], start: number, end: number): WaveBarTone {
  const isActive = (item: TimelineOperationView) => item.op.status !== 'rejected' && item.op.status !== 'disabled' && item.range.start < end && item.range.end > start;
  if (operations.some((item) => item.op.type === 'voice_patch' && isActive(item))) return 'voice_patch';
  const cut = operations.find((item) => (item.op.type === 'cut' || item.op.type === 'mute') && isActive(item));
  return cut ? (cut.op.type as 'cut' | 'mute') : null;
}
