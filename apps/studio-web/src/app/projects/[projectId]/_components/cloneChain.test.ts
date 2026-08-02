import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../../lib/api';
import { cloneChainIntentKey, cloneChainRemedy, requestIdIsSpent } from './cloneChain';

const ID = 'vp-1111-2222';

describe('requestIdIsSpent — replay vs re-bill', () => {
  it('RETAINS the id for an untyped gateway failure (the proxy may have answered after the backend accepted)', () => {
    for (const status of [500, 502, 503, 504]) {
      expect(requestIdIsSpent(new ApiError('Bad gateway', status), ID)).toBe(false);
    }
  });

  it('RETAINS the id for a typed 502 paid-step failure — the terminal is the route\'s, not the proxy\'s, only when it says so', () => {
    // No providerRequestId echoed ⇒ we cannot prove a terminal exists ⇒ retry replays.
    expect(requestIdIsSpent(new ApiError('TTS failed', 502, 'tts-failed'), ID)).toBe(false);
  });

  it('releases the id when the body echoes this requestId (a real root terminal)', () => {
    const error = new ApiError('Seam bake failed', 502, 'seam-bake-failed', undefined, { providerRequestId: ID, operationId: 'op-1' });
    expect(requestIdIsSpent(error, ID)).toBe(true);
  });

  it('does not release the id when the body echoes a DIFFERENT requestId', () => {
    const error = new ApiError('Seam bake failed', 502, 'seam-bake-failed', undefined, { providerRequestId: 'vp-other' });
    expect(requestIdIsSpent(error, ID)).toBe(false);
  });

  it('releases the id for intake validation — nothing reached execution', () => {
    expect(requestIdIsSpent(new ApiError('bad range', 400, 'invalid-range'), ID)).toBe(true);
    expect(requestIdIsSpent(new ApiError('remove: provider', 400, 'field-not-allowed'), ID)).toBe(true);
  });

  it.each(['clone-not-ready', 'clone-stale', 'clone-unknown-outcome', 'clip-not-eligible', 'request-id-conflict'])(
    'releases the id for the pre-execution code %s',
    (code) => { expect(requestIdIsSpent(new ApiError('x', 409, code), ID)).toBe(true); }
  );

  it.each(['operation-conflict', 'snapshot-conflict', 'range-conflict'])(
    'releases the id for %s even with NO echoed providerRequestId — the resume preflight shape',
    (code) => {
      // Phase 1's resume path returns exactly this: a bare code, no terminal, no echo. Retaining
      // the id here retried the same stale precondition forever while the UI said "start a new
      // generation".
      expect(requestIdIsSpent(new ApiError('The operation has changed.', 409, code), ID)).toBe(true);
      // The Phase-3 variant echoes the id and must behave identically.
      expect(requestIdIsSpent(new ApiError('x', 409, code, undefined, { providerRequestId: ID }), ID)).toBe(true);
    }
  );

  it.each(['commit-marker-conflict', 'ledger-corruption'])(
    'RETAINS the id for %s — a fresh id would re-execute paid work',
    (code) => {
      // These DO echo providerRequestId, and for ledger-corruption a conflicting terminal
      // necessarily exists — but re-billing under a new id is the one thing that must not
      // happen, so the echo does not release the id here.
      const error = new ApiError('x', 409, code, undefined, { providerRequestId: ID });
      expect(requestIdIsSpent(error, ID)).toBe(false);
    }
  );
});

describe('cloneChainRemedy — what the UI offers', () => {
  it.each(['clone-not-ready', 'clone-stale', 'clone-unknown-outcome'])('offers prepare for %s', (errorCode) => {
    expect(cloneChainRemedy({ errorCode })).toBe('prepare-voice');
  });

  it.each(['ledger-corruption', 'commit-marker-conflict'])(
    'routes %s to the operator, never to "confirm again"',
    (errorCode) => {
      // The id is retained (retryReplays true) but re-Confirm is NOT the fix: a conflicting or
      // duplicate terminal already exists and a human has to look at the ledger.
      expect(cloneChainRemedy({ errorCode, retryReplays: true })).toBe('operator');
    }
  );

  it.each(['paid-step-unknown-outcome', 'step-artifact-corrupt', 'operation-conflict', 'snapshot-conflict', 'range-conflict'])(
    'requires a new generation for %s',
    (errorCode) => { expect(cloneChainRemedy({ errorCode })).toBe('new-generation'); }
  );

  it('offers a replaying retry only for an ambiguous failure with no code', () => {
    expect(cloneChainRemedy({ retryReplays: true })).toBe('retry-replays');
    expect(cloneChainRemedy({})).toBe('none');
  });
});

describe('cloneChainIntentKey', () => {
  it('separates identical coordinates on different clips and different projects', () => {
    const base = { projectId: 'p1', clipId: 'c1', start: 1, end: 2, text: 'hi' };
    expect(cloneChainIntentKey(base)).toBe(cloneChainIntentKey({ ...base }));
    expect(cloneChainIntentKey(base)).not.toBe(cloneChainIntentKey({ ...base, clipId: 'c2' }));
    expect(cloneChainIntentKey(base)).not.toBe(cloneChainIntentKey({ ...base, projectId: 'p2' }));
    expect(cloneChainIntentKey(base)).not.toBe(cloneChainIntentKey({ ...base, text: 'hi ' }));
  });
});

describe('operator-blocked failures are not user-retryable', () => {
  it.each(['ledger-corruption', 'commit-marker-conflict'])(
    'classifies %s as operator so the UI can disable Confirm',
    (errorCode) => {
      // The button guard and the handler guard both read this. Re-issuing the request would
      // re-hit the same conflicting ledger state, and the id is retained so nothing re-bills.
      expect(cloneChainRemedy({ errorCode, retryReplays: true })).toBe('operator');
      expect(requestIdIsSpent(new ApiError('x', 409, errorCode, undefined, { providerRequestId: ID }), ID)).toBe(false);
    }
  );

  it('leaves an ambiguous transport failure retryable', () => {
    expect(cloneChainRemedy({ retryReplays: true })).toBe('retry-replays');
  });
});

describe('cap refusal from the server preflight (round-5 P2-3)', () => {
  it('spends the id — nothing was created, so a retry is a new action', () => {
    expect(requestIdIsSpent(new ApiError('cap', 409, 'cap-would-refuse-sequence'), ID)).toBe(true);
  });

  it('gets its own remedy, not "resume" and not "start a new generation"', () => {
    // Resubmitting unchanged is refused identically, and there is nothing billed to resume.
    expect(cloneChainRemedy({ errorCode: 'cap-would-refuse-sequence' })).toBe('cap');
    expect(cloneChainRemedy({ errorCode: 'cap-would-refuse-sequence', retryReplays: true })).toBe('cap');
  });
});
