// Shared Cartesia constants used by every Cartesia adapter (tts, stt, and the future
// infill / clone paths). Single source of truth for the API base and the dated API
// version header so a version bump is one edit, not three.

export const CARTESIA_BASE = 'https://api.cartesia.ai';

// Cartesia requires a dated API-version header on EVERY request (a missing or stale
// value is a hard 4xx). Pinned deliberately; bump intentionally when adopting new
// response shapes. Verified against live Cartesia docs 2026-05-28.
export const CARTESIA_VERSION = '2026-03-01';

export function cartesiaBaseUrl(url?: string): string {
  return (url ?? CARTESIA_BASE).replace(/\/+$/, '');
}
