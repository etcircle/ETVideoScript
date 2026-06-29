"use client";
import { useEffect, useRef, useState } from 'react';
import { useEditorStore } from '../../../../store/editorStore';

type RecordingMode = 'screen' | 'cam' | 'voice';
type DialogState = 'requesting' | 'ready' | 'recording' | 'uploading' | 'done' | 'error';

type Props = { mode: RecordingMode | null; onClose: () => void };

function pickMime(mode: RecordingMode) {
  const candidates =
    mode === 'voice'
      ? ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
      : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
  return (
    candidates.find(
      (mime) =>
        typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime)
    ) || ''
  );
}

function formatElapsed(sec: number) {
  const minutes = Math.floor(sec / 60).toString().padStart(2, '0');
  const seconds = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

const KICKERS: Record<RecordingMode, string> = {
  screen: 'CAPTURE · SCREEN',
  cam: 'CAPTURE · CAMERA',
  voice: 'CAPTURE · VOICE',
};

const TITLES: Record<RecordingMode, string> = {
  screen: 'Record screen',
  cam: 'Record camera',
  voice: 'Record voice',
};

const STATE_HINT: Record<DialogState, string> = {
  requesting: 'Waiting for browser permission…',
  ready: 'Ready — press Record to start.',
  recording: 'Recording in progress.',
  uploading: 'Saving recording…',
  done: 'Done.',
  error: 'An error occurred.',
};

export function RecordingDialog({ mode, onClose }: Props) {
  const uploadRecording = useEditorStore((s) => s.uploadRecording);
  const [dialogState, setDialogState] = useState<DialogState>('requesting');
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const uploadRecorderRef = useRef<MediaRecorder | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  function stopStream() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  function close() {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
    stopStream();
    onClose();
  }

  useEffect(() => {
    if (!mode) return;
    let cancelled = false;
    setDialogState('requesting');
    setError(null);
    setElapsed(0);

    async function requestStream() {
      try {
        if (!navigator.mediaDevices || typeof MediaRecorder === 'undefined')
          throw new Error('Recording is not supported in this browser.');
        const stream =
          mode === 'screen'
            ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
            : await navigator.mediaDevices.getUserMedia(
                mode === 'voice' ? { audio: true } : { video: true, audio: true }
              );
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        setDialogState('ready');
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof Error
            ? err.message
            : 'Could not start recording. Check browser permissions and secure-context access.'
        );
        setDialogState('error');
        stopStream();
      }
    }

    void requestStream();
    return () => {
      cancelled = true;
      if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
      stopStream();
    };
  }, [mode]);

  useEffect(() => {
    if (videoRef.current && streamRef.current)
      videoRef.current.srcObject = streamRef.current;
  }, [dialogState]);

  useEffect(() => {
    if (dialogState !== 'recording') return;
    const timer = window.setInterval(
      () => setElapsed((Date.now() - startedAtRef.current) / 1000),
      250
    );
    return () => window.clearInterval(timer);
  }, [dialogState]);

  if (!mode) return null;

  const activeMode: RecordingMode = mode;

  function start() {
    const stream = streamRef.current;
    if (!stream) return;
    try {
      chunksRef.current = [];
      const mimeType = pickMime(activeMode);
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const shouldUpload = uploadRecorderRef.current === recorder;
        if (uploadRecorderRef.current === recorder) uploadRecorderRef.current = null;
        recorderRef.current = null;
        if (shouldUpload)
          void finishUpload(
            mimeType ||
              chunksRef.current[0]?.type ||
              (activeMode === 'voice' ? 'audio/webm' : 'video/webm')
          );
        else {
          chunksRef.current = [];
          stopStream();
        }
      };
      startedAtRef.current = Date.now();
      recorder.start(250);
      setDialogState('recording');
    } catch (err) {
      recorderRef.current = null;
      stopStream();
      setError(err instanceof Error ? err.message : 'Could not start MediaRecorder.');
      setDialogState('error');
    }
  }

  async function stop() {
    if (recorderRef.current?.state === 'recording') {
      uploadRecorderRef.current = recorderRef.current;
      recorderRef.current.stop();
    }
  }

  async function finishUpload(type: string) {
    const seconds = Math.max(0.1, (Date.now() - startedAtRef.current) / 1000);
    const blob = new Blob(chunksRef.current, { type });
    setElapsed(seconds);
    setDialogState('uploading');
    stopStream();
    try {
      await uploadRecording(blob, activeMode, seconds);
      setDialogState('done');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDialogState('error');
    }
  }

  const isRecording = dialogState === 'recording';
  const canStart = dialogState === 'ready';

  return (
    <div className="rd-overlay" role="dialog" aria-modal="true" onClick={close}>
      <div className="rd-sheet" onClick={(e) => e.stopPropagation()}>

        {/* ── Header ── */}
        <header className="rd-head">
          <div className="rd-titles">
            <div className="rd-kicker">{KICKERS[activeMode]}</div>
            <h3>{TITLES[activeMode]}</h3>
          </div>
          <button className="rd-close" onClick={close} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>

        {/* ── Preview / status ── */}
        <section className="rd-section">
          {mode !== 'voice' ? (
            <video
              ref={videoRef}
              className="recording-preview"
              autoPlay
              playsInline
              muted
            />
          ) : (
            <div className="recording-voice">
              <span className={`recording-dot${isRecording ? ' live' : ''}`} />
              Microphone ready
            </div>
          )}

          <div className="media-row" style={{ marginTop: 10 }}>
            <span className="stamp">{dialogState}</span>
            <strong>{formatElapsed(elapsed)}</strong>
            <small>{STATE_HINT[dialogState]}</small>
          </div>

          {error ? <p className="panel-error">{error}</p> : null}
        </section>

        {/* ── Footer ── */}
        <footer className="rd-foot">
          <div className="rd-summary">
            <div className="rd-summary-l">
              <span className="rd-summary-k">Source</span>
              <span className="rd-summary-v" style={{ fontSize: '0.95rem' }}>
                {TITLES[activeMode]}
              </span>
            </div>
            <div className="rd-summary-r">
              {mode === 'screen'
                ? 'Screen audio depends on share settings.'
                : 'Mock STT will transcribe after saving.'}
            </div>
          </div>
          <div className="rd-actions">
            <button className="rd-btn" onClick={close}>
              cancel
            </button>
            {isRecording ? (
              <button className="rd-btn primary" onClick={stop}>
                stop ↵
              </button>
            ) : (
              <button className="rd-btn primary" disabled={!canStart} onClick={start}>
                record ↵
              </button>
            )}
          </div>
        </footer>

      </div>
    </div>
  );
}
