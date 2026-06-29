"use client";

import { useCallback, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { selectEnrollmentSentences } from '@etvideoscript/core/browser';
import { enrollVoice } from '../../../lib/api';
import { VoiceSampleRecorder, secureContextHint } from '../voice-sample-recorder';

const SENTENCES_PER_SESSION = 10;

function getSeed(): string {
  if (typeof window === 'undefined') return 'default';
  return (localStorage.getItem('etvs-enrollment-seed') || (() => {
    const s = crypto.randomUUID();
    localStorage.setItem('etvs-enrollment-seed', s);
    return s;
  })());
}

type SentenceStatus = 'pending' | 'recording' | 'done';

interface RecordedSentence {
  sentenceId: string;
  blob: Blob;
  durationSec: number;
}

function recordedFileName(blob: Blob, index: number): string {
  const ext = blob.type.includes('webm') ? 'webm' : blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') || blob.type.includes('m4a') ? 'm4a' : 'wav';
  return `enrollment-${String(index + 1).padStart(2, '0')}.${ext}`;
}

export function EnrollmentClient() {
  const [step, setStep] = useState<'setup' | 'record' | 'submit' | 'done'>('setup');
  const [voiceName, setVoiceName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [recordings, setRecordings] = useState<Map<string, RecordedSentence>>(new Map());
  const [activeBlob, setActiveBlob] = useState<Blob | null>(null);
  const [submitBusy, setSubmitBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [doneVoiceName, setDoneVoiceName] = useState('');
  const seedRef = useRef<string | null>(null);

  const sentences = useMemo(() => {
    if (typeof window === 'undefined') return [];
    if (!seedRef.current) seedRef.current = getSeed();
    return selectEnrollmentSentences(seedRef.current, SENTENCES_PER_SESSION);
  }, []);

  const currentSentence = sentences[currentIndex];
  const allRecorded = sentences.length > 0 && sentences.every((s) => recordings.has(s.id));

  const statuses = useMemo<SentenceStatus[]>(() =>
    sentences.map((s, i) => recordings.has(s.id) ? 'done' : i === currentIndex ? 'recording' : 'pending'),
    [sentences, recordings, currentIndex]
  );

  function handleNameSubmit() {
    const name = voiceName.trim();
    if (!name) { setNameError('Voice name is required.'); return; }
    if (name.length > 200) { setNameError('Voice name must be 200 characters or fewer.'); return; }
    const hint = secureContextHint();
    if (hint) { setNameError(hint); return; }
    setNameError(null);
    setStep('record');
  }

  const handleBlob = useCallback((blob: Blob | null, durationSec: number) => {
    setActiveBlob(blob);
    if (!blob || !currentSentence) return;
    setRecordings((prev) => {
      const next = new Map(prev);
      next.set(currentSentence.id, { sentenceId: currentSentence.id, blob, durationSec });
      return next;
    });
  }, [currentSentence]);

  function goToNext() {
    setActiveBlob(null);
    if (currentIndex < sentences.length - 1) {
      setCurrentIndex((i) => i + 1);
    }
  }

  function goToPrev() {
    setActiveBlob(null);
    if (currentIndex > 0) setCurrentIndex((i) => i - 1);
  }

  async function submitEnrollment() {
    if (!allRecorded) return;
    setSubmitBusy(true);
    setSubmitError(null);
    try {
      const fd = new FormData();
      fd.set('name', voiceName.trim());
      let idx = 0;
      for (const s of sentences) {
        const rec = recordings.get(s.id);
        if (!rec) continue;
        fd.append('recordings', rec.blob, recordedFileName(rec.blob, idx));
        idx++;
      }
      const result = await enrollVoice(fd);
      setDoneVoiceName(result.voice.name);
      setStep('done');
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitBusy(false);
    }
  }

  if (step === 'setup') {
    return (
      <main className="settings-page">
        <div className="settings-header">
          <h1>Voice Enrollment</h1>
          <Link href="/settings?tab=voices" className="link-button">← Back to Voices</Link>
        </div>
        <p className="muted">
          Read {SENTENCES_PER_SESSION} short sentences aloud, one at a time. ETVideo Studio clones your
          voice from the recordings using ElevenLabs Instant Voice Cloning (billed by your plan tier).
        </p>
        <div className="settings-field">
          <label htmlFor="enrollment-name">Voice name</label>
          <input
            id="enrollment-name"
            type="text"
            value={voiceName}
            onChange={(e) => setVoiceName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleNameSubmit(); }}
            placeholder="e.g. My Voice"
            maxLength={200}
            autoFocus
          />
          {nameError && <p className="voice-recorder-error" role="alert">{nameError}</p>}
        </div>
        <button type="button" onClick={handleNameSubmit} disabled={!voiceName.trim()}>
          Start recording
        </button>
      </main>
    );
  }

  if (step === 'done') {
    return (
      <main className="settings-page">
        <div className="settings-header">
          <h1>Voice Enrolled</h1>
        </div>
        <p>"{doneVoiceName}" has been added to your Voices library.</p>
        <Link href="/settings?tab=voices" className="button">Go to Voices →</Link>
      </main>
    );
  }

  if (!currentSentence) return null;

  return (
    <main className="settings-page">
      <div className="settings-header">
        <h1>Voice Enrollment — {voiceName}</h1>
        <Link href="/settings?tab=voices" className="link-button">Cancel</Link>
      </div>

      <div className="enrollment-progress">
        {sentences.map((s, i) => (
          <button
            key={s.id}
            type="button"
            className={`enrollment-dot${statuses[i] === 'done' ? ' done' : statuses[i] === 'recording' ? ' active' : ''}`}
            onClick={() => { setActiveBlob(recordings.get(s.id)?.blob ?? null); setCurrentIndex(i); }}
            aria-label={`Sentence ${i + 1}: ${statuses[i]}`}
          />
        ))}
      </div>

      <div className="enrollment-sentence">
        <p className="muted" style={{ fontSize: '0.8em', marginBottom: '0.5rem' }}>
          {currentIndex + 1} of {sentences.length} · {currentSentence.category}
        </p>
        <blockquote className="enrollment-prompt">{currentSentence.text}</blockquote>
      </div>

      <VoiceSampleRecorder blob={activeBlob} onBlob={handleBlob} disabled={submitBusy} />

      <div className="enrollment-nav">
        <button type="button" onClick={goToPrev} disabled={currentIndex === 0}>← Prev</button>
        {currentIndex < sentences.length - 1
          ? <button type="button" onClick={goToNext} disabled={!recordings.has(currentSentence.id)}>Next →</button>
          : null
        }
      </div>

      {allRecorded && (
        <div className="enrollment-submit">
          <p className="muted">All {sentences.length} sentences recorded. ElevenLabs IVC call is billed by your plan.</p>
          <button type="button" onClick={submitEnrollment} disabled={submitBusy}>
            {submitBusy ? 'Enrolling…' : `Enroll voice — ${voiceName}`}
          </button>
          {submitError && <p className="voice-recorder-error" role="alert">{submitError}</p>}
        </div>
      )}
    </main>
  );
}
