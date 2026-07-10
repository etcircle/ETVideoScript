import { describe, expect, it } from 'vitest';
import {
  estimateFrameF0,
  trackPitch,
  int16ToFloat32,
  YIN_SAMPLE_RATE,
  YIN_FRAME_SAMPLES,
  YIN_HOP_SAMPLES
} from '../pitch';

// Synthetic PCM builders — pure sine tones at a known Hz, and silence. The YIN
// port must recover the tone's F0 within 1% (the plan's acceptance) and report
// no voicing on silence.

function sine(freqHz: number, durationSec: number, sampleRate = YIN_SAMPLE_RATE, amp = 0.6): Float32Array {
  const n = Math.round(durationSec * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  return out;
}

function silence(durationSec: number, sampleRate = YIN_SAMPLE_RATE): Float32Array {
  return new Float32Array(Math.round(durationSec * sampleRate));
}

// Concatenate PCM buffers.
function concat(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

describe('YIN pitch — single frame', () => {
  it.each([90, 110, 147, 220, 300])('recovers a %d Hz pure tone within 1%%', (hz) => {
    const frame = sine(hz, YIN_FRAME_SAMPLES / YIN_SAMPLE_RATE).subarray(0, YIN_FRAME_SAMPLES);
    const { f0Hz, voiced } = estimateFrameF0(frame);
    expect(voiced).toBe(true);
    expect(f0Hz).not.toBeNull();
    expect(Math.abs(f0Hz! - hz) / hz).toBeLessThan(0.01);
  });

  it('reports a silent frame as unvoiced with null F0', () => {
    const frame = silence(YIN_FRAME_SAMPLES / YIN_SAMPLE_RATE).subarray(0, YIN_FRAME_SAMPLES);
    const { f0Hz, voiced } = estimateFrameF0(frame);
    expect(voiced).toBe(false);
    expect(f0Hz).toBeNull();
  });
});

describe('YIN pitch — track over a buffer', () => {
  it('a 1 s pure 150 Hz tone is (near) fully voiced with register ≈ 150 Hz', () => {
    const track = trackPitch(sine(150, 1.0));
    expect(track.voicedCoverage).toBeGreaterThan(0.95);
    expect(track.voicedMedianF0Hz).not.toBeNull();
    expect(Math.abs(track.voicedMedianF0Hz! - 150) / 150).toBeLessThan(0.01);
  });

  it('1 s of silence has zero voiced coverage and a null register', () => {
    const track = trackPitch(silence(1.0));
    expect(track.frames.length).toBeGreaterThan(0);
    expect(track.voicedCoverage).toBe(0);
    expect(track.voicedMedianF0Hz).toBeNull();
  });

  it('half tone + half silence → coverage fraction ≈ 0.5', () => {
    // 1 s tone then 1 s silence. With hop 10 ms and frame 25 ms, the coverage is
    // the voiced-frame fraction; the ~1.5-frame straddle at the seam keeps this
    // near — but not exactly — 0.5, so assert a tight band around it.
    const track = trackPitch(concat(sine(140, 1.0), silence(1.0)));
    expect(track.voicedCoverage).toBeGreaterThan(0.45);
    expect(track.voicedCoverage).toBeLessThan(0.55);
    // Register is measured over the voiced (tone) frames only.
    expect(Math.abs(track.voicedMedianF0Hz! - 140) / 140).toBeLessThan(0.01);
  });

  it('an all-silence buffer shorter than a frame yields an empty track (no throw)', () => {
    const track = trackPitch(silence((YIN_FRAME_SAMPLES - 1) / YIN_SAMPLE_RATE));
    expect(track.frames).toHaveLength(0);
    expect(track.voicedCoverage).toBe(0);
    expect(track.voicedMedianF0Hz).toBeNull();
  });

  it('frame count matches ⌊(N - frame)/hop⌋ + 1', () => {
    const pcm = sine(150, 0.5); // 8000 samples
    const expected = Math.floor((pcm.length - YIN_FRAME_SAMPLES) / YIN_HOP_SAMPLES) + 1;
    expect(trackPitch(pcm).frames).toHaveLength(expected);
  });
});

describe('int16ToFloat32', () => {
  it('scales Int16 into [-1, 1] by 1/32768 and round-trips a tone register', () => {
    const f = sine(200, 0.5);
    const i16 = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) i16[i] = Math.round(f[i]! * 32768);
    const back = int16ToFloat32(i16);
    expect(back[10]!).toBeCloseTo(f[10]!, 3);
    const track = trackPitch(back);
    expect(Math.abs(track.voicedMedianF0Hz! - 200) / 200).toBeLessThan(0.01);
  });
});
