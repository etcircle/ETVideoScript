import { describe, expect, it } from 'vitest';
import { selectCleanWindows, InsufficientCleanWindowsError } from '../voiceClone';
import { YIN_SAMPLE_RATE } from '../pitch';
import type { TranscriptWords } from '../schemas';

// selectCleanWindows is PURE: it takes the eligible clip's 16k mono PCM (asset axis) + the
// clip's words and returns the usable ~10s windows. We drive it with SYNTHETIC PCM — pure
// tones (voiced) and silence (unvoiced) — so voicing/register are deterministic and no ffmpeg
// is needed. Word timing lines up with the PCM so a window's [start,end) slices the tone/silence
// we placed there.

const SR = YIN_SAMPLE_RATE;

function sine(freqHz: number, startSec: number, endSec: number, buf: Float32Array, amp = 0.6): void {
  const from = Math.round(startSec * SR);
  const to = Math.min(buf.length, Math.round(endSec * SR));
  for (let i = from; i < to; i++) buf[i] = amp * Math.sin((2 * Math.PI * freqHz * i) / SR);
}

// Build an asset-axis PCM buffer of `durationSec`, then paint tones into it via `paint`.
function pcmOf(durationSec: number, paint: (buf: Float32Array) => void): Float32Array {
  const buf = new Float32Array(Math.round(durationSec * SR));
  paint(buf);
  return buf;
}

let _seq = 0;
function word(start: number, end: number, confidence = 0.95, clipId = 'clip_001'): TranscriptWords['words'][number] {
  const id = `w_${_seq++}`;
  return { id, text: 'w', normalized: 'w', start, end, speaker: 'speaker_1', confidence, segmentId: `seg_${id}`, clipId };
}

// One word per second [i, i+0.9) covering [startSec, startSec+count) so a run stays contiguous
// (0.1s gaps < the 0.35s split threshold).
function wordsCovering(startSec: number, count: number, confidence = 0.95, clipId = 'clip_001'): TranscriptWords['words'] {
  const out: TranscriptWords['words'] = [];
  for (let i = 0; i < count; i++) out.push(word(startSec + i, startSec + i + 0.9, confidence, clipId));
  return out;
}

function transcript(words: TranscriptWords['words'], timing: 'exact' | 'mock' = 'exact'): TranscriptWords {
  const dur = words.reduce((m, w) => Math.max(m, w.end), 0);
  return { schemaVersion: 1, source: 'test', provider: { name: 'whisper', model: 'base', requestId: null, timing }, language: 'en', durationSec: dur, words, segments: [] };
}

describe('selectCleanWindows — timing guard', () => {
  it('throws when transcript timing is not exact', () => {
    const words = wordsCovering(0, 5);
    const pcm = pcmOf(5, (b) => sine(150, 0, 5, b));
    expect(() => selectCleanWindows({ words: transcript(words, 'mock'), clipId: 'clip_001', pcm16k: pcm }))
      .toThrow('transcript-timing-not-exact');
  });
});

describe('selectCleanWindows — basic tiling + usability', () => {
  it('tiles ~40s of continuous clean 150 Hz speech into ~10s windows, all usable, ascending order', () => {
    const words = wordsCovering(0, 40); // 40s continuous
    const pcm = pcmOf(40, (b) => sine(150, 0, 40, b));
    const res = selectCleanWindows({ words: transcript(words), clipId: 'clip_001', pcm16k: pcm });
    expect(res.windows.length).toBeGreaterThanOrEqual(4);
    // canonical ascending order
    for (let i = 1; i < res.windows.length; i++) {
      expect(res.windows[i]!.start).toBeGreaterThanOrEqual(res.windows[i - 1]!.start);
    }
    // every returned window is usable, ~150 Hz register, high voiced coverage
    for (const w of res.windows) {
      expect(w.usable).toBe(true);
      expect(w.voicedCoverage).toBeGreaterThan(0.9);
      expect(Math.abs(w.registerHz! - 150) / 150).toBeLessThan(0.02);
      expect(w.spanSec).toBeLessThanOrEqual(10.001);
    }
    // target register was measured near 150 Hz
    expect(Math.abs(res.targetRegisterHz! - 150) / 150).toBeLessThan(0.02);
    expect(res.totalSec).toBeGreaterThanOrEqual(30);
  });

  it('is deterministic — same input twice yields identical windows', () => {
    // Small buffer (YIN over long PCM is slow); a 20s floor keeps this under ~22s of material.
    const words = wordsCovering(0, 22);
    const pcm = pcmOf(22, (b) => sine(150, 0, 22, b));
    const opts = { words: transcript(words), clipId: 'clip_001', pcm16k: pcm, minUsableAggregateSec: 20 };
    const a = selectCleanWindows(opts);
    const b = selectCleanWindows(opts);
    expect(a).toEqual(b);
  });

  it('caps aggregate at ≈maxTotalSec even with abundant clean material', () => {
    // Use a small cap so we don't have to synthesize 90s+ of PCM (YIN over long buffers is slow).
    const words = wordsCovering(0, 60); // 60s available
    const pcm = pcmOf(60, (b) => sine(150, 0, 60, b));
    const res = selectCleanWindows({
      words: transcript(words), clipId: 'clip_001', pcm16k: pcm,
      minUsableAggregateSec: 20, maxTotalSec: 30
    });
    expect(res.totalSec).toBeGreaterThanOrEqual(20);
    // cap 30s: allow one window's worth of overshoot on the last take
    expect(res.totalSec).toBeLessThanOrEqual(40);
  });
});

describe('selectCleanWindows — usability floor + honest failure', () => {
  it('throws InsufficientCleanWindowsError when clean material is under 30s', () => {
    const words = wordsCovering(0, 12); // only ~12s
    const pcm = pcmOf(12, (b) => sine(150, 0, 12, b));
    let err: unknown;
    try {
      selectCleanWindows({ words: transcript(words), clipId: 'clip_001', pcm16k: pcm });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(InsufficientCleanWindowsError);
    const e = err as InsufficientCleanWindowsError;
    expect(e.code).toBe('insufficient-clean-windows');
    expect(e.requiredSec).toBe(30);
    expect(e.usableSec).toBeGreaterThan(0);
    expect(e.message).toMatch(/insufficient-clean-windows/);
  });

  it('never returns a silent (sub-floor voiced coverage) window as usable', () => {
    // 40s of words but the PCM is SILENT everywhere → no voiced frames → no usable windows.
    const words = wordsCovering(0, 40);
    const pcm = pcmOf(40, () => { /* silence */ });
    expect(() => selectCleanWindows({ words: transcript(words), clipId: 'clip_001', pcm16k: pcm }))
      .toThrow(InsufficientCleanWindowsError);
  });

  it('low-confidence windows fail the cleanliness floor and are excluded', () => {
    // 40s of perfectly voiced tone but confidence 0.2 (< 0.6 floor) → nothing usable.
    const words = wordsCovering(0, 40, 0.2);
    const pcm = pcmOf(40, (b) => sine(150, 0, 40, b));
    expect(() => selectCleanWindows({ words: transcript(words), clipId: 'clip_001', pcm16k: pcm }))
      .toThrow(InsufficientCleanWindowsError);
  });
});

describe('selectCleanWindows — register band demotes (does not exclude)', () => {
  it('out-of-band windows are USABLE (demoted, not excluded) and rank below in-band', () => {
    // 30s at 150 Hz (in-band vs the ~150 Hz target — 150 is the clear majority so the target
    // median lands there) then 15s at 250 Hz (out of the ±3% band). All are voiced+clean → all
    // USABLE (the point of "demote, not exclude"). A 20s cap fills with in-band 150 Hz windows
    // FIRST; the out-of-band ones are excluded by the cap.
    const words = [...wordsCovering(0, 30), ...wordsCovering(31, 15)];
    const pcm = pcmOf(46, (b) => { sine(150, 0, 30, b); sine(250, 31, 46, b); });
    // Sanity: with a generous cap ALL four windows come back and the 250 Hz ones are usable+demoted.
    const all = selectCleanWindows({
      words: transcript(words), clipId: 'clip_001', pcm16k: pcm, minUsableAggregateSec: 20, maxTotalSec: 100
    });
    expect(all.windows.some((w) => !w.inBand && w.usable)).toBe(true); // out-of-band IS usable
    expect(all.windows.some((w) => w.inBand && w.usable)).toBe(true);

    // With the tight 20s cap, only the in-band 150 Hz windows are kept.
    const res = selectCleanWindows({
      words: transcript(words), clipId: 'clip_001', pcm16k: pcm, minUsableAggregateSec: 20, maxTotalSec: 20
    });
    expect(Math.abs(res.targetRegisterHz! - 150) / 150).toBeLessThan(0.05);
    expect(res.windows.every((w) => w.usable && w.inBand)).toBe(true);
  });

  it('classifies an out-of-band window as usable when it is the ONLY material', () => {
    // Force the target high so a 150 Hz window is out-of-band, and confirm it is still returned
    // (usable) rather than dropped — the ≥30s aggregate is met by demoted material.
    const words = wordsCovering(0, 40);
    const pcm = pcmOf(40, (b) => sine(150, 0, 40, b));
    const res = selectCleanWindows({ words: transcript(words), clipId: 'clip_001', pcm16k: pcm, targetRegisterHz: 250 });
    expect(res.windows.length).toBeGreaterThan(0);
    expect(res.windows.every((w) => w.usable && !w.inBand)).toBe(true);
  });
});

describe('selectCleanWindows — respects a supplied target register', () => {
  it('honors an explicit targetRegisterHz for band classification', () => {
    const words = wordsCovering(0, 40);
    const pcm = pcmOf(40, (b) => sine(150, 0, 40, b));
    // Force the target to 250 Hz: every ~150 Hz window is now out-of-band but still usable.
    const res = selectCleanWindows({ words: transcript(words), clipId: 'clip_001', pcm16k: pcm, targetRegisterHz: 250 });
    expect(res.targetRegisterHz).toBe(250);
    expect(res.windows.every((w) => w.usable)).toBe(true);
    expect(res.windows.every((w) => !w.inBand)).toBe(true); // 150 vs 250 is far out of ±3%
  });
});
