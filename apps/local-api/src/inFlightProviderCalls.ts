// In-flight provider-call dedup (P4-1c). Per-app Map<key, Promise<result>> keyed
// by `${projectId}:${requestId}`. Concurrent same-key callers join the same
// promise instead of firing parallel provider calls; different-key callers run
// independently. Lets HTTP routes release withProjectManifestMutex during the
// paid provider call (which could be 30s+ for xAI video) so unrelated edits on
// the project aren't blocked, while still preserving the "exactly one paid call
// per requestId" guarantee the existing concurrent tests assert.
//
// Why per-app, not module-scoped: tests create a fresh app per case
// (`createApp(config(root))`). A module-scoped map would leak in-flight entries
// across tests and races between worker threads in vitest. The factory binds
// the map to one app lifetime; app close = map gone.

export type InFlightProviderCalls = {
  withInFlightProviderCall<T>(key: string, work: () => Promise<T>): Promise<T>;
};

export function createInFlightProviderCalls(): InFlightProviderCalls {
  const inFlight = new Map<string, Promise<unknown>>();

  function withInFlightProviderCall<T>(key: string, work: () => Promise<T>): Promise<T> {
    const existing = inFlight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    let tracked!: Promise<T>;
    tracked = (async () => work())().finally(() => {
      if (inFlight.get(key) === tracked) inFlight.delete(key);
    });
    inFlight.set(key, tracked);
    return tracked;
  }

  return { withInFlightProviderCall };
}
