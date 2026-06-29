"use client";
import { useEffect, useMemo, useRef, useState } from 'react';

export const READ_ALOUD_SCRIPT = `Hey — this is my voice for ETVideo Studio. I'm cloning the way I actually talk so the edits in my videos sound like me, not a robot reading lines.

I'll read for about a minute, with normal pacing, the occasional pause, and a question or two thrown in. How does this sound? Pretty close to how I'd actually speak, I hope.

A few practice lines for variety: pack my box with five dozen liquor jugs. The quick brown fox jumps over the lazy dog. Bright moons rise behind the wide gray fjord.

That's it — recording done. Thanks.`;

type Mode = 'idle' | 'requesting' | 'recording' | 'stopped' | 'error';

function pickMime() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  return candidates.find((mime) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime)) || '';
}

function formatElapsed(sec: number) {
  const minutes = Math.floor(sec / 60).toString().padStart(2, '0');
  const seconds = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

// getUserMedia requires a secure context. localhost / 127.0.0.1 are exempt,
// but a plain-HTTP LAN origin (e.g. http://<lan-ip>:4318) is not — surface
// that as a friendly hint rather than the browser's generic permission error.
export function secureContextHint(): string | null {
  if (typeof window === 'undefined') return null;
  if (window.isSecureContext) return null;
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return null;
  return `Microphone requires a secure context. Open this page via http://127.0.0.1:${location.port || '4318'}/settings (or use HTTPS) to record. Upload file works on this origin.`;
}

export function VoiceSampleRecorder({
  blob,
  onBlob,
  disabled
}: {
  blob: Blob | null;
  onBlob: (blob: Blob | null, durationSec: number) => void;
  disabled?: boolean;
}) {
  const [mode, setMode] = useState<Mode>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [lastDuration, setLastDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  // mountedRef closes the getUserMedia permission-prompt race: if the dialog
  // closes (or the user navigates away) while the browser is still showing the
  // permission prompt, the await resolves into an unmounted component. Without
  // this guard, start() would happily create a MediaRecorder and capture
  // audio with no UI controlling it.
  const mountedRef = useRef(true);

  const previewUrl = useMemo(() => (blob ? URL.createObjectURL(blob) : ''), [blob]);
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  useEffect(() => {
    if (mode !== 'recording') return;
    const timer = window.setInterval(() => setElapsed((Date.now() - startedAtRef.current) / 1000), 250);
    return () => window.clearInterval(timer);
  }, [mode]);

  useEffect(() => () => {
    mountedRef.current = false;
    const recorder = recorderRef.current;
    if (recorder) {
      // Detach handlers so any in-flight events fired after unmount become no-ops.
      recorder.ondataavailable = null;
      recorder.onstop = null;
      if (recorder.state === 'recording') recorder.stop();
    }
    recorderRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    chunksRef.current = [];
  }, []);

  function fail(message: string) {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setError(message);
    setMode('error');
  }

  async function start() {
    setElapsed(0);
    setError(null);
    chunksRef.current = [];
    setMode('requesting');
    try {
      const hint = secureContextHint();
      if (hint) { fail(hint); return; }
      if (typeof navigator === 'undefined' || !navigator.mediaDevices || typeof MediaRecorder === 'undefined') {
        fail('Microphone recording is not supported in this browser.');
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const mimeType = pickMime();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onstop = () => {
        const recordedType = mimeType || chunksRef.current[0]?.type || 'audio/webm';
        const durationSec = Math.max(0.1, (Date.now() - startedAtRef.current) / 1000);
        const recorded = new Blob(chunksRef.current, { type: recordedType });
        chunksRef.current = [];
        recorderRef.current = null;
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        if (!mountedRef.current) return;
        if (recorded.size === 0) {
          onBlob(null, 0);
          setLastDuration(0);
          setMode('idle');
          return;
        }
        setLastDuration(durationSec);
        onBlob(recorded, durationSec);
        setMode('stopped');
      };
      recorderRef.current = recorder;
      startedAtRef.current = Date.now();
      recorder.start(250);
      setMode('recording');
    } catch (err) {
      if (!mountedRef.current) return;
      fail(err instanceof Error ? err.message : 'Could not start microphone. Check browser permissions.');
    }
  }

  function stop() {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
  }

  function retake() {
    onBlob(null, 0);
    setLastDuration(0);
    setError(null);
    setMode('idle');
    setElapsed(0);
  }

  return <div className="voice-recorder">
    {mode === 'recording' || mode === 'requesting' ? <>
      <div className="voice-recorder-status">
        <span className="recording-dot live" aria-hidden="true" />
        <strong>{formatElapsed(elapsed)}</strong>
        <span className="muted">{mode === 'requesting' ? 'Waiting for microphone permission…' : 'Recording — read the script below'}</span>
      </div>
      <button type="button" onClick={stop} disabled={mode !== 'recording'}>Stop</button>
    </> : blob ? <>
      <audio className="voice-recorder-preview" controls src={previewUrl} preload="metadata" />
      <div className="voice-recorder-status">
        <span className="muted">{formatElapsed(lastDuration)} captured · listen back before cloning</span>
        <button type="button" onClick={retake} disabled={disabled}>Re-record</button>
      </div>
    </> : <>
      <button type="button" onClick={start} disabled={disabled}>Start recording</button>
      <span className="muted">~30-60 seconds of natural speech gives the best clone.</span>
    </>}
    {error && <p className="voice-recorder-error" role="alert">{error}</p>}
  </div>;
}
