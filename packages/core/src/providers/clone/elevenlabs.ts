import { registerProvider } from '../registry';
import { cloneElevenLabsVoice, type VoiceCloneSample } from '../tts/elevenlabs';
import { ProviderExecutionError } from '../engine';
import type { HttpMediaProvider } from '../contract';
import type { ProviderKind } from '../../providerSettings';

// ── clone.elevenlabs (S1b ⟨Q5⟩/⟨R4⟩) ────────────────────────────────────────────
// The EL Instant Voice Clone as a first-class provider adapter, so the paid clone call runs
// through runProvider — spend caps, cap reservation, ledger 'started'/'succeeded'/'failed'
// events, structured provider-status errors — exactly like TTS and STS. There is deliberately
// NO parallel "equivalent choke point": D8's single paid boundary (guardedFetch, threaded in
// here as context.guardedFetch) holds for all three call types.
//
// 'clone' is a HIDDEN kind (see ProviderKindSchema): not user-selectable, not in defaults.

export interface CloneInput {
  name: string;
  samples: VoiceCloneSample[];
  description?: string;
  timeoutMs?: number;
}

export interface CloneOutput {
  voiceId: string;
}

/**
 * EL bills instant voice cloning by PLAN TIER, not per call or per sample second — there is no
 * honest per-call USD figure to report, so the estimate is null (the ledger records the call and
 * `whyCostUnknown: 'cost-missing'` explains it) unless the user pinned a costPerUnit amount.
 */
function cloneCost(provider: { costPerUnit?: { currency?: string; amount: number } }) {
  const amount = provider.costPerUnit?.amount;
  return { currency: provider.costPerUnit?.currency ?? 'USD', estimated: amount ?? null, actual: null };
}

export const cloneElevenlabsProvider: HttpMediaProvider<CloneInput, CloneOutput> = registerProvider({
  id: 'clone.elevenlabs',
  kind: 'clone' as ProviderKind,
  tier: 'paid',
  mode: 'http',
  displayName: 'ElevenLabs Instant Voice Clone',
  capabilities: { polling: false, cancel: false },
  estimateCost(_input, provider) {
    return cloneCost(provider);
  },
  actualCost(_output, _input, provider) {
    const cost = cloneCost(provider);
    return { ...cost, actual: cost.estimated };
  },
  // Never let sample AUDIO (or its byte payload) into the append-only ledger — record the
  // shape of the request only.
  ledgerInput(input) {
    return {
      name: input.name,
      sampleCount: input.samples.length,
      sampleBytes: input.samples.reduce((sum, sample) => sum + sample.audio.byteLength, 0)
    };
  },
  async run(input, context) {
    if (!context.secret) throw new ProviderExecutionError('Configure a secretRef/API key for ElevenLabs before cloning a voice.', { code: 'provider_auth_failed' });
    const result = await cloneElevenLabsVoice({
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      samples: input.samples,
      secret: context.secret,
      ...(context.provider.baseUrl ? { baseUrl: context.provider.baseUrl } : {}),
      signal: context.signal,
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      // The engine's guarded transport — keeps the clone inside the same D8 paid boundary.
      fetchImpl: context.guardedFetch
    });
    return { voiceId: result.voiceId };
  }
});
