"use client";
import { useMemo, useState } from 'react';
import type { AssetV3, ClipV3, TrackV3 } from '@etvideoscript/core/browser';
import type { GenerationKind } from '../../../../../lib/api';
import { useEditorStore } from '../../../../../store/editorStore';
import { decidePanelState } from '../../../../../store/selectors';
import { RecordingDialog } from '../RecordingDialog';
import { GenerationDialog } from '../GenerationDialog';
import { PanelState } from '../state/PanelState';

// ── Media kind label → design class ──────────────────────────────────────────
const KIND_CLASS: Record<string, string> = {
  video:   'source',
  audio:   'voice',
  image:   'b-roll',
  caption: 'caption',
  other:   'b-roll',
};

function kindClass(kind: string): string {
  return KIND_CLASS[kind] ?? kind;
}

// ── Generator tile definitions (mirrors design's generators array) ────────────
const GENERATORS: Array<{
  id: string;
  label: string;
  sub: string;
  kind?: GenerationKind;
  disabled?: boolean;
}> = [
  { id: 'image',     label: 'Image',     sub: 'AI still',        kind: 'image-gen'   },
  { id: 'video',     label: 'Video',     sub: 'AI motion clip',  kind: 'video-gen'   },
  { id: 'voiceover', label: 'Voiceover', sub: 'Text-to-speech',  disabled: true      },
  { id: 'broll',     label: 'B-roll',    sub: 'Stock library',   kind: 'video-gen'   },
  { id: 'music',     label: 'Music',     sub: 'AI track',        kind: 'music-gen'   },
  { id: 'caption',   label: 'Captions',  sub: 'Auto from script',disabled: true      },
];

// ── Generator tile icons ──────────────────────────────────────────────────────
function GenIcon({ id }: { id: string }) {
  if (id === 'image') return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="14" rx="1"/><circle cx="9" cy="11" r="1.6"/><path d="M3 17l5-5 4 4 3-3 6 6"/>
    </svg>
  );
  if (id === 'video') return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="6" width="13" height="12" rx="1"/><path d="M16 10l5-3v10l-5-3z"/>
    </svg>
  );
  if (id === 'voiceover') return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8"/>
    </svg>
  );
  if (id === 'broll') return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="4" width="14" height="14" rx="1"/><rect x="8" y="8" width="12" height="12" rx="1"/>
    </svg>
  );
  if (id === 'music') return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18V6l11-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>
    </svg>
  );
  if (id === 'caption') return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="14" rx="1"/><path d="M7 12h4M13 12h4M7 15h7"/>
    </svg>
  );
  return null;
}

// ── Import tile icons ─────────────────────────────────────────────────────────
function UploadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 16V4M6 10l6-6 6 6"/><rect x="4" y="16" width="16" height="4" rx="1"/>
    </svg>
  );
}
function VoiceIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8"/>
    </svg>
  );
}
function ScreenIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="13" rx="1"/><path d="M3 12h18M8 21h8M12 17v4"/><circle cx="18" cy="7" r="1.4" fill="currentColor"/>
    </svg>
  );
}
function CamIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="6" width="13" height="12" rx="1"/><path d="M16 10l5-3v10l-5-3z"/><circle cx="9.5" cy="12" r="2.5"/>
    </svg>
  );
}
function PasteIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="6" y="4" width="12" height="16" rx="1"/><path d="M9 4h6v3H9z"/>
    </svg>
  );
}
function DeviceIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="7" y="3" width="10" height="18" rx="2"/><circle cx="12" cy="18" r="0.8" fill="currentColor"/>
    </svg>
  );
}

function endOfTrack(track: TrackV3) {
  return Math.max(0, ...track.clips.map((clip) => clip.timelineStart + (clip.sourceEnd - clip.sourceStart)));
}

function clipFromAsset(asset: AssetV3, track: TrackV3): ClipV3 {
  return {
    clipId: `clip_${Date.now()}`,
    assetId: asset.assetId,
    sourceStart: 0,
    sourceEnd: asset.durationSec || 0.1,
    timelineStart: endOfTrack(track),
  };
}

export function MediaPanel() {
  const state = useEditorStore();
  const [dragging, setDragging] = useState(false);
  const [recordingMode, setRecordingMode] = useState<'screen' | 'cam' | 'voice' | null>(null);
  const [genKind, setGenKind] = useState<GenerationKind | null>(null);

  const assets = state.manifest?.assets ?? [];
  const tracks = state.manifest?.tracks ?? [];
  const jobs = state.jobs.filter((job) =>
    ['upload-video', 'record-clip', 'generate-media', 'transcribe', 'extract-audio', 'peaks'].includes(job.type)
  );

  const targetTracks = useMemo(() => tracks.filter((track) => track.kind === 'video' || track.kind === 'audio'), [tracks]);
  const panelState = decidePanelState({
    loading: state.loading,
    panel: 'media',
    project: state.project,
    diagnostics: state.diagnostics,
    transcript: state.transcript,
    jobs: state.jobs,
    providerRequests: state.providerRequests,
  });
  if (panelState === 'loading') return <PanelState state="loading" />;

  async function uploadFiles(files: FileList | File[]) {
    const file = Array.from(files).find(Boolean);
    if (file) await state.uploadVideoAsset(file);
  }

  return (
    <div
      className={`view-media ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); void uploadFiles(e.dataTransfer.files); }}
    >
      {dragging && <div className="drop-banner">Drop video to import</div>}

      {/* ── Generate ──────────────────────────────────────────── */}
      <section className="view-section">
        <header className="view-section-head">
          <h4>Generate</h4>
          <span className="muted">AI &middot; mocked</span>
        </header>
        <div className="gen-grid">
          {GENERATORS.map((g) => (
            <button
              key={g.id}
              type="button"
              className="gen-tile"
              disabled={g.disabled}
              onClick={() => g.kind && setGenKind(g.kind)}
              title={g.sub}
            >
              <span className="gen-icon"><GenIcon id={g.id} /></span>
              <span className="gen-label">{g.label}</span>
              <span className="gen-sub">{g.sub}</span>
            </button>
          ))}
        </div>
      </section>

      {/* ── Project clips ─────────────────────────────────────── */}
      <section className="view-section">
        <header className="view-section-head">
          <h4>Project clips</h4>
          <span className="muted">{assets.length} files</span>
        </header>
        {panelState === 'cold-start' ? (
          <PanelState state="cold-start" title="Import a video to begin" hint="Use the Upload tile above or drag a video file onto the editor." />
        ) : assets.length > 0 ? (
          <div className="media-list">
            {assets.map((asset) => {
              const inUse = tracks.some((track) => track.clips.some((clip) => clip.assetId === asset.assetId));
              const compatible = targetTracks.filter((track) =>
                asset.kind === 'video' ? track.kind === 'video' : track.kind === 'audio'
              );
              const filename = asset.path.split('/').pop() ?? asset.assetId;
              return (
                <div className={`media-row`} key={asset.assetId}>
                  <span className={`media-kind ${kindClass(asset.kind)}`}>{asset.kind}</span>
                  <span className="media-name">{filename}</span>
                  <span className="media-meta">
                    {asset.durationSec != null ? `${asset.durationSec.toFixed(1)}s` : '—'}
                    {asset.provenance ? ` · ${asset.provenance}` : ''}
                  </span>
                  <div className="media-row-actions">
                    <select
                      aria-label="Target track"
                      defaultValue={compatible[0]?.trackId ?? ''}
                      onChange={(e) => { e.currentTarget.dataset.trackId = e.target.value; }}
                    >
                      {compatible.map((track) => (
                        <option key={track.trackId} value={track.trackId}>{track.name}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="skill-chip"
                      disabled={!compatible.length}
                      onClick={(e) => {
                        const sel = e.currentTarget.parentElement?.querySelector('select') as HTMLSelectElement | null;
                        const track = compatible.find((c) => c.trackId === (sel?.value ?? compatible[0]?.trackId));
                        if (track) void state.addClip(track.trackId, clipFromAsset(asset, track));
                      }}
                    >
                      add
                    </button>
                    <button
                      type="button"
                      className="skill-chip"
                      disabled={inUse}
                      title={inUse ? 'Asset is used by a timeline clip' : 'Remove asset'}
                      onClick={() => state.removeAsset(asset.assetId)}
                    >
                      remove
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <PanelState state="empty" title="No media assets" hint="Upload a file or drag one into this panel." />
        )}

        {/* Pending jobs ─────────────────────────────────────── */}
        {jobs.length > 0 && (
          <div className="job-list" style={{ marginTop: 8 }}>
            {jobs.slice(0, 3).map((job) => (
              <div key={job.jobId} className="media-row">
                <span className={`media-kind ${job.status === 'succeeded' ? 'source' : job.status === 'failed' ? 'b-roll' : 'voice'}`}>
                  {job.status}
                </span>
                <span className="media-name">{job.type}</span>
                <span className="media-meta">{job.stages?.[0]?.phase ?? job.error ?? job.jobId}</span>
                {job.status === 'running' && <span className="media-tag">running</span>}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── Import ────────────────────────────────────────────── */}
      <section className="view-section">
        <header className="view-section-head"><h4>Import</h4></header>
        <div className="import-grid">
          <label className="import-tile" title="Upload local file">
            <input type="file" accept="video/*" hidden onChange={(e) => e.target.files && void uploadFiles(e.target.files)} />
            <span className="import-icon"><UploadIcon /></span>
            <span className="import-label">Upload</span>
            <span className="import-hint">file &middot; drag-drop</span>
          </label>
          <button type="button" className="import-tile" title="Record voiceover" onClick={() => setRecordingMode('voice')}>
            <span className="import-icon"><VoiceIcon /></span>
            <span className="import-label">Voice</span>
            <span className="import-hint">mic &middot; monitor</span>
          </button>
          <button type="button" className="import-tile featured" title="Record screen" onClick={() => setRecordingMode('screen')}>
            <span className="import-icon"><ScreenIcon /></span>
            <span className="import-label">Screen</span>
            <span className="import-hint">window &middot; monitor &middot; area</span>
          </button>
          <button type="button" className="import-tile featured" title="Record camera" onClick={() => setRecordingMode('cam')}>
            <span className="import-icon"><CamIcon /></span>
            <span className="import-label">Cam</span>
            <span className="import-hint">facecam &middot; PiP</span>
          </button>
          <button type="button" className="import-tile" title="Paste from clipboard" disabled>
            <span className="import-icon"><PasteIcon /></span>
            <span className="import-label">Paste</span>
            <span className="import-hint">clipboard &middot; url</span>
          </button>
          <button type="button" className="import-tile" title="Pull from device" disabled>
            <span className="import-icon"><DeviceIcon /></span>
            <span className="import-label">Device</span>
            <span className="import-hint">iPhone &middot; iPad</span>
          </button>
        </div>
      </section>

      <RecordingDialog mode={recordingMode} onClose={() => setRecordingMode(null)} />
      <GenerationDialog kind={genKind} onClose={() => setGenKind(null)} />
    </div>
  );
}
