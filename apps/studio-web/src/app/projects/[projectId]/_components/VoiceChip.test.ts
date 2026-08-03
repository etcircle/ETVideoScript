import { describe, expect, it } from 'vitest';
import { PREPARE_PRICE_LINE, voiceChipView } from './VoiceChip';

describe('VoiceChip state → copy mapping', () => {
  it("shows the PRICE LINE on 'none', not an error code", () => {
    // The regression this locks: `errorCopy ?? price` meant any errorCode carried on a 'none'
    // status replaced the D7 cost disclosure on the button that makes the paid call.
    expect(voiceChipView({ state: 'none' })).toMatchObject({ title: 'Prepare your voice', sub: PREPARE_PRICE_LINE, cta: 'prepare', banner: null });
    expect(voiceChipView({ state: 'none', errorCode: 'transcript-not-word-accurate' }).sub).toBe(PREPARE_PRICE_LINE);
    expect(voiceChipView({ state: 'none', errorCode: 'clone-failed', message: 'ElevenLabs returned 429' }).sub).toBe(PREPARE_PRICE_LINE);
  });

  it('NEVER renders a raw error code as copy', () => {
    // 'some-unmapped-code' has no PREPARE_ERROR_COPY entry; it used to fall through verbatim
    // into the sub-line.
    const view = voiceChipView({ state: 'none', errorCode: 'some-unmapped-code' });
    expect(view.sub).toBe(PREPARE_PRICE_LINE);
    expect(view.banner).toBeNull();
    expect(voiceChipView({ state: 'unknown-outcome', errorCode: 'some-unmapped-code' }).sub).toBe('the last attempt ended with an unknown outcome');
  });

  it("moves a 'none' failure reason into the banner, CURATED COPY FIRST", () => {
    // The error is not dropped — it is relocated to where 'stale' already explains itself.
    expect(voiceChipView({ state: 'none', errorCode: 'transcript-not-word-accurate' }).banner).toBe('needs a word-accurate transcript');
    // Our copy WINS over the provider's raw text. Preferring `message` made the actionable line
    // unreachable on exactly the failure that has an action: voice-slot-limit ships a raw
    // ElevenLabs envelope as its message.
    expect(voiceChipView({ state: 'none', errorCode: 'voice-slot-limit', message: '{"detail":{"status":"voice_limit_reached","message":"You have reached your voice limit."}}' }).banner)
      .toBe('ElevenLabs voice slots are full — free one in Settings → Voices');
    // The provider message is the FALLBACK, for codes we have no copy for.
    expect(voiceChipView({ state: 'none', errorCode: 'some-unmapped-code', message: 'ElevenLabs returned 429' }).banner).toBe('ElevenLabs returned 429');
  });

  it('truncates a long provider message before it reaches the one-line banner', () => {
    const long = `HTTP 500 from provider: ${'x'.repeat(400)}`;
    const banner = voiceChipView({ state: 'none', message: long }).banner!;
    expect(banner.length).toBeLessThanOrEqual(140);
    expect(banner.endsWith('…')).toBe(true);
    expect(voiceChipView({ state: 'stale', message: long }).banner!.length).toBeLessThanOrEqual(140);
    // A message that fits is passed through untouched.
    expect(voiceChipView({ state: 'none', message: 'short enough' }).banner).toBe('short enough');
  });

  it('keeps the typed error on the states that are ABOUT an error', () => {
    expect(voiceChipView({ state: 'unknown-outcome', errorCode: 'unknown-outcome' })).toMatchObject({
      title: 'Your voice needs attention',
      sub: 'a clone call may or may not have been billed — re-prepare to be sure',
      cta: 're-prepare'
    });
    expect(voiceChipView({ state: 'stale', message: 'Studio Sound was re-run.' })).toMatchObject({
      title: 'Your voice is out of date',
      sub: 'Studio Sound changed since the clone was made',
      cta: 're-prepare',
      banner: 'Studio Sound was re-run.'
    });
  });

  it('keeps the preparing and ready lines unchanged', () => {
    expect(voiceChipView({ state: 'preparing', runningStage: 'cloning' }).sub).toBe('creating the voice');
    expect(voiceChipView({ state: 'preparing', disclosure: '~$1.00' }).sub).toBe('~$1.00');
    expect(voiceChipView({ state: 'preparing' }).sub).toBe('working…');
    expect(voiceChipView({ state: 'ready', voiceId: 'QhQLqXTdMGEha3x0pgwY' })).toMatchObject({
      title: 'Your voice is ready',
      sub: 'cloned from the cleaned recording · QhQLqXTd',
      cta: 're-prepare',
      banner: null
    });
  });
});
