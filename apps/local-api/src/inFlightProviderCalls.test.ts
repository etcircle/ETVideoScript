import { describe, expect, it } from 'vitest';
import { createInFlightProviderCalls } from './inFlightProviderCalls';

// P4-1c: the dedup utility is what lets paid-provider HTTP routes release the project
// manifest mutex during the paid call without breaking the "exactly one provider call per
// requestId" guarantee that the existing concurrent tests assert.

describe('createInFlightProviderCalls', () => {
  it('dedups concurrent same-key callers onto one work() invocation', async () => {
    const calls = createInFlightProviderCalls();
    let invocations = 0;
    let release!: () => void;
    const work = async () => {
      invocations += 1;
      await new Promise<void>((resolve) => { release = resolve; });
      return 'done';
    };
    const a = calls.withInFlightProviderCall('episode-001:req-1', work);
    const b = calls.withInFlightProviderCall('episode-001:req-1', work);
    expect(invocations).toBe(1);
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toBe('done');
    expect(rb).toBe('done');
    expect(invocations).toBe(1);
  });

  it('returns the same promise reference for same-key concurrent callers', async () => {
    const calls = createInFlightProviderCalls();
    let release!: () => void;
    const a = calls.withInFlightProviderCall('p:r', () => new Promise<number>((resolve) => { release = () => resolve(7); }));
    const b = calls.withInFlightProviderCall('p:r', async () => 999);
    expect(a).toBe(b);
    release();
    expect(await a).toBe(7);
  });

  it('lets different keys run independently and in parallel', async () => {
    const calls = createInFlightProviderCalls();
    let inFlight = 0;
    let peakInFlight = 0;
    const releases: Array<() => void> = [];
    const work = async () => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise<void>((resolve) => { releases.push(resolve); });
      inFlight -= 1;
      return inFlight;
    };
    const a = calls.withInFlightProviderCall('p:req-A', work);
    const b = calls.withInFlightProviderCall('p:req-B', work);
    const c = calls.withInFlightProviderCall('p:req-C', work);
    // Without dedup, three independent work() invocations run in parallel.
    expect(peakInFlight).toBe(3);
    releases.forEach((release) => release());
    await Promise.all([a, b, c]);
    expect(inFlight).toBe(0);
  });

  it('clears the slot after settle so a subsequent call re-invokes work()', async () => {
    const calls = createInFlightProviderCalls();
    let invocations = 0;
    const work = async () => { invocations += 1; return invocations; };
    expect(await calls.withInFlightProviderCall('p:r', work)).toBe(1);
    expect(await calls.withInFlightProviderCall('p:r', work)).toBe(2);
    expect(invocations).toBe(2);
  });

  it('clears the slot when work() rejects so the next call can retry', async () => {
    const calls = createInFlightProviderCalls();
    let invocations = 0;
    const work = async (): Promise<string> => { invocations += 1; throw new Error(`fail ${invocations}`); };
    await expect(calls.withInFlightProviderCall('p:r', work)).rejects.toThrow('fail 1');
    await expect(calls.withInFlightProviderCall('p:r', work)).rejects.toThrow('fail 2');
    expect(invocations).toBe(2);
  });

  it('joins concurrent same-key callers on a rejected promise too (all see the same error)', async () => {
    const calls = createInFlightProviderCalls();
    let triggerReject!: (err: Error) => void;
    const work = () => new Promise<string>((_, reject) => { triggerReject = reject; });
    const a = calls.withInFlightProviderCall('p:r', work);
    const b = calls.withInFlightProviderCall('p:r', work);
    triggerReject(new Error('boom'));
    await expect(a).rejects.toThrow('boom');
    await expect(b).rejects.toThrow('boom');
  });

  it('handles synchronous throws inside work() as rejected promises', async () => {
    const calls = createInFlightProviderCalls();
    const work = () => { throw new Error('sync-throw'); };
    await expect(calls.withInFlightProviderCall('p:r', work as any)).rejects.toThrow('sync-throw');
    // and the slot must be cleaned up so a subsequent call works normally
    expect(await calls.withInFlightProviderCall('p:r', async () => 'ok')).toBe('ok');
  });
});
