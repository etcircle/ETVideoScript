"use client";

import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  cloneVoice,
  deleteSecret,
  deleteVoice,
  getProjects,
  getProviderRequestSummary,
  getSettingsProviders,
  getVoices,
  getWorkspaceSettings,
  putWorkspaceSettings,
  removeProvider,
  saveProvider,
  renameVoice,
  setSecret,
  setProviderDefault,
  testProvider,
  type CostSummary,
  type ProjectSummary,
  type ProviderRecord,
  type SettingsSnapshot,
  type SettingsState,
  type VoiceRecord,
  type WorkspaceSettings
} from '../../lib/api';
import { READ_ALOUD_SCRIPT, VoiceSampleRecorder, secureContextHint } from './voice-sample-recorder';

const TABS = [
  { id: 'keys', label: 'Keys' },
  { id: 'defaults', label: 'Defaults' },
  { id: 'voices', label: 'Voices' },
  { id: 'usage', label: 'Usage' }
] as const;

type TabId = typeof TABS[number]['id'];

const PROVIDER_TEMPLATES = [
  // omitBaseUrl: xAI adapters treat provider.baseUrl as the full endpoint (e.g.
  // image-gen POSTs straight to baseUrl), so persisting the vendor root would
  // route real calls to https://api.x.ai/ and 404. The displayed baseUrl is
  // informational only.
  { name: 'xAI', secretRef: 'xai', baseUrl: 'https://api.x.ai', tier: 'paid' as const, kinds: ['image-gen', 'video-gen', 'tts'] as const, omitBaseUrl: true },
  { name: 'ElevenLabs', secretRef: 'elevenlabs', baseUrl: 'https://api.elevenlabs.io', tier: 'paid' as const, kinds: ['tts', 'music-gen', 'studio-sound', 'stt'] as const },
  { name: 'OpenAI', secretRef: 'openai', baseUrl: 'https://api.openai.com', tier: 'paid' as const, kinds: ['stt'] as const, providerIdSuffix: 'openai-whisper' },
  { name: 'Homelab Whisper', secretRef: undefined, baseUrl: 'http://127.0.0.1:8789/v1/audio/transcriptions', tier: 'local' as const, kinds: ['stt'] as const },
  { name: 'FFmpeg local', secretRef: undefined, baseUrl: undefined, tier: 'local' as const, kinds: ['studio-sound'] as const }
];

type ProviderTemplate = typeof PROVIDER_TEMPLATES[number] & { providerIdSuffix?: string; omitBaseUrl?: boolean };

const STATES = ['idle', 'loading', 'testing', 'ok', 'error', 'disabled', 'empty-first-run', 'malformed-config', 'secret-missing', 'provider-disabled-but-default', 'test-timed-out', 'LAN-denied', 'env-override-read-only'];
const CONTROLS = ['provider list', 'add/edit form', 'test connection', 'set default', 'secret controls', 'workspace defaults'];
const DEFAULT_TASKS = [
  ['stt', 'Speech-to-text'],
  ['tts', 'Text-to-speech'],
  ['image-gen', 'Image generation'],
  ['video-gen', 'Video generation'],
  ['music-gen', 'Music generation'],
  ['studio-sound', 'Studio sound']
] as const;
// Mirror of each adapter's `availableModels` array (see packages/core/src/providers/*).
// Kept here as a browser-safe const to avoid bundling Node-facing core modules into the web client.
// If you add/remove a model on an adapter, update this map too — the conformance test in
// packages/core/src/__tests__/mediaProviderFramework.test.ts locks the adapter side.
const AVAILABLE_MODELS: Partial<Record<ProviderRecord['id'], readonly string[]>> = {
  'tts.elevenlabs': ['eleven_multilingual_v2', 'eleven_turbo_v2_5', 'eleven_flash_v2_5'],
  'stt.openai-whisper': ['whisper-1'],
  'stt.elevenlabs': ['scribe_v2', 'scribe_v1'],
  'image-gen.xai': ['grok-imagine-image', 'grok-imagine-image-quality'],
  'video-gen.xai': ['grok-imagine-video'],
  'music-gen.elevenlabs': ['music_v1']
};

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function providerId(template: ProviderTemplate, kind: ProviderTemplate['kinds'][number]) {
  return `${kind}.${template.providerIdSuffix ?? slugify(template.name)}`;
}

function providerName(template: ProviderTemplate) {
  return template.providerIdSuffix ?? slugify(template.name);
}

function errorState(message: string) {
  if (/LAN|403|unavailable/i.test(message)) return 'LAN-denied';
  if (/Malformed|Invalid.*settings/i.test(message)) return 'malformed-config';
  if (/timed out/i.test(message)) return 'test-timed-out';
  return 'error';
}

function inferState(state: string, settings: SettingsState | null, provider?: ProviderRecord) {
  if (state !== 'idle') return state;
  if (!settings?.registry.providers.length) return 'empty-first-run';
  if (provider && provider.default && !provider.enabled) return 'provider-disabled-but-default';
  if (provider?.secretRef && !settings.secrets.keys.includes(provider.secretRef)) return 'secret-missing';
  if (provider && !provider.enabled) return 'disabled';
  if (process.env.NEXT_PUBLIC_ETVS_SETTINGS_MODE === 'env') return 'env-override-read-only';
  return 'idle';
}

function money(value: number | null, currency = 'USD') {
  if (value == null) return '—';
  return `${currency} ${value.toFixed(4)}`;
}

function durationLabel(duration: CostSummary['rows'][number]['duration']) {
  if (!duration) return '—';
  const parts = [];
  if (duration.requestedSec != null) parts.push(`${duration.requestedSec}s requested`);
  if (duration.generatedSec != null) parts.push(`${duration.generatedSec}s generated`);
  return parts.join(' / ') || '—';
}

function statusFor(template: ProviderTemplate, providers: ProviderRecord[], secrets: string[], failed: boolean) {
  if (failed) return { label: 'Test failed', className: 'error' };
  const enabled = providers.filter((provider) => provider.enabled !== false);
  if (!providers.length) return { label: 'Not configured', className: 'empty-first-run' };
  if (template.tier === 'paid' && template.secretRef && !secrets.includes(template.secretRef)) return { label: 'Missing key', className: 'secret-missing' };
  // "Configured" requires every expected provider kind to be enabled — a paid template that
  // half-failed mid-save (secret saved, second upsert errored) would otherwise be marked
  // Configured because *some* provider matched, masking the partial state from the user.
  if (enabled.length >= template.kinds.length) return { label: 'Configured', className: 'ok' };
  if (enabled.length > 0) return { label: 'Partially configured', className: 'secret-missing' };
  return { label: 'Not configured', className: 'disabled' };
}

function emptyWorkspace(): WorkspaceSettings {
  return { schemaVersion: 1, defaults: {}, paidCaps: {}, taskOptions: { tts: {} }, updatedAt: new Date().toISOString() };
}

function formatUsd(value: number | undefined) {
  return value == null ? '' : `$${value.toFixed(2)}`;
}

function capLabel(provider: ProviderRecord, workspace: { settings: WorkspaceSettings } | null) {
  const cap = workspace?.settings.paidCaps[provider.id];
  return cap == null ? 'no workspace cap set' : `workspace cap $${cap.toFixed(2)}`;
}

function isStaleError(err: unknown) {
  return (err instanceof Error ? err.message : String(err)).includes('settings_stale');
}

function parseUsd(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/^\$/, '');
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) throw new Error('Caps must use USD format like $0.50.');
  return Number(normalized);
}

export default function SettingsClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const requestedTab = searchParams.get('tab');
  const activeTab: TabId = TABS.some((tab) => tab.id === requestedTab) ? requestedTab as TabId : 'keys';

  const [settings, setSettings] = useState<SettingsState | null>(null);
  const [status, setStatus] = useState('loading');
  const [message, setMessage] = useState<string | null>(null);
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({});
  const [baseUrlInputs, setBaseUrlInputs] = useState<Record<string, string>>({});
  const [testFailures, setTestFailures] = useState<Record<string, boolean>>({});
  const [projectId, setProjectId] = useState('');
  const [workspace, setWorkspace] = useState<{ settings: WorkspaceSettings; snapshot: SettingsSnapshot } | null>(null);
  const [workspaceCost, setWorkspaceCost] = useState<CostSummary | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [costProjectId, setCostProjectId] = useState('');
  const [costSummary, setCostSummary] = useState<CostSummary | null>(null);
  const [costStatus, setCostStatus] = useState('idle');
  const [voices, setVoices] = useState<VoiceRecord[]>([]);
  const [defaultsNotice, setDefaultsNotice] = useState<string | null>(null);
  const [voicesNotice, setVoicesNotice] = useState<string | null>(null);
  const [cloneBusy, setCloneBusy] = useState(false);
  const [editingVoiceId, setEditingVoiceId] = useState<string | null>(null);
  const [editingVoiceName, setEditingVoiceName] = useState('');
  const [voiceSource, setVoiceSource] = useState<'record' | 'upload'>('record');
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [secureNotice, setSecureNotice] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  useEffect(() => { setSecureNotice(secureContextHint()); }, []);
  // Mirror dialogOpen → native <dialog> open state so a Cancel click, Escape
  // press, or close-from-code all funnel through the same unmount path. The
  // form (and its embedded recorder) only renders when dialogOpen is true, so
  // closing the dialog tears down the MediaRecorder and the mic stream via
  // the recorder's unmount cleanup. Without this gate, a closed-but-mounted
  // dialog can leave the mic capturing audio behind the modal.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (dialogOpen && !dialog.open) dialog.showModal();
    else if (!dialogOpen && dialog.open) dialog.close();
  }, [dialogOpen]);

  const providers = settings?.registry.providers || [];
  const secrets = settings?.secrets.keys || [];
  const elevenLabsConfigured = secrets.includes('elevenlabs');

  function setTab(tab: TabId) {
    const next = new URLSearchParams(searchParams.toString());
    next.set('tab', tab);
    router.replace(`/settings?${next.toString()}`, { scroll: false });
  }

  async function load() {
    setStatus('loading');
    setMessage(null);
    try {
      const next = await getSettingsProviders();
      setSettings(next);
      setStatus(next.registry.providers.length ? 'ok' : 'empty-first-run');
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      setMessage(text);
      setStatus(errorState(text));
    }
  }

  async function loadWorkspace(project: string) {
    if (!project) return;
    try {
      setWorkspace(await getWorkspaceSettings(project));
      try { setWorkspaceCost((await getProviderRequestSummary(project)).costSummary); }
      catch { setWorkspaceCost(null); }
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      setWorkspace(null);
      setWorkspaceCost(null);
      setStatus(errorState(text));
      setMessage(text);
    }
  }

  async function loadCost(project: string) {
    if (!project) return;
    setCostStatus('loading');
    try {
      const result = await getProviderRequestSummary(project);
      setCostSummary(result.costSummary);
      setCostStatus('ok');
    } catch (err) {
      setCostSummary(null);
      setCostStatus('error');
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }

  async function loadVoices() {
    const result = await getVoices();
    setVoices(result.voices);
  }

  useEffect(() => {
    void load();
    loadVoices().catch((err) => setMessage(err instanceof Error ? err.message : String(err)));
    getProjects().then(({ projects: nextProjects }) => {
      setProjects(nextProjects);
      const firstProject = nextProjects[0]?.projectId || '';
      if (firstProject) {
        setProjectId(firstProject);
        setCostProjectId(firstProject);
        void loadWorkspace(firstProject);
        void loadCost(firstProject);
      }
    }).catch((err) => setMessage(err instanceof Error ? err.message : String(err)));
  }, []);

  const templateProviders = useMemo(() => {
    return Object.fromEntries(PROVIDER_TEMPLATES.map((template) => {
      const ids = new Set(template.kinds.map((kind) => providerId(template, kind)));
      return [template.name, providers.filter((provider) => ids.has(provider.id))];
    })) as Record<string, ProviderRecord[]>;
  }, [providers]);

  async function saveTemplate(template: ProviderTemplate) {
    setStatus('loading');
    setMessage(null);
    // Save/upsert calls are intrinsically non-atomic against the API. Run them all (best-effort
    // via allSettled), then reload so the UI reflects whichever pieces actually landed. The
    // tightened statusFor will downgrade to "Partially configured" if only some succeeded.
    const failures: string[] = [];
    try {
      if (template.tier === 'paid') {
        if (!template.secretRef) throw new Error(`Missing secret ref for ${template.name}.`);
        const key = keyInputs[template.secretRef]?.trim();
        if (key) {
          try { await setSecret(template.secretRef, key); }
          catch (err) { failures.push(`secret: ${err instanceof Error ? err.message : String(err)}`); }
        } else if (!secrets.includes(template.secretRef)) {
          throw new Error(`Paste an API key for ${template.name} before saving.`);
        }
        const results = await Promise.allSettled(template.kinds.map((kind) => {
          const id = providerId(template, kind);
          const existing = providers.find((provider) => provider.id === id);
          return saveProvider({
            ...existing,
            id,
            kind,
            name: providerName(template),
            tier: 'paid',
            // null here is the explicit-clear signal — JSON.stringify keeps the
            // null, the server interprets it as "drop baseUrl on the record",
            // and the existing.baseUrl on the prior record gets overridden.
            // undefined would be dropped by JSON.stringify and the stale
            // existing.baseUrl would survive upsertProvider's merge.
            baseUrl: (template.omitBaseUrl ? null : template.baseUrl) as ProviderRecord['baseUrl'],
            secretRef: template.secretRef,
            enabled: true,
            default: existing?.default ?? false
          } as ProviderRecord);
        }));
        results.forEach((result, index) => {
          if (result.status === 'rejected') {
            failures.push(`${providerId(template, template.kinds[index]!)}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
          }
        });
        setKeyInputs((current) => ({ ...current, [template.secretRef!]: '' }));
      } else {
        const kind = template.kinds[0]!;
        const id = providerId(template, kind);
        const existing = providers.find((provider) => provider.id === id);
        const baseUrl = (baseUrlInputs[template.name] ?? existing?.baseUrl ?? template.baseUrl ?? '').trim();
        try {
          await saveProvider({
            ...existing,
            id,
            kind,
            name: providerName(template),
            tier: 'local',
            // null when the user intentionally cleared the URL field — same
            // explicit-clear protocol as the paid path above.
            baseUrl: (baseUrl || null) as ProviderRecord['baseUrl'],
            secretRef: undefined,
            enabled: true,
            default: existing?.default ?? false
          } as ProviderRecord);
        } catch (err) {
          failures.push(`${id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err));
    }
    // Always reload — the UI must match server reality whether we succeeded fully, partially,
    // or completely failed. statusFor reads from the reloaded settings.
    await load();
    if (failures.length === 0) {
      setStatus('ok');
      setMessage(`${template.name} saved.`);
    } else {
      setStatus('error');
      setMessage(`${template.name} save partially failed:\n${failures.join('\n')}`);
    }
  }

  async function removeTemplate(template: ProviderTemplate) {
    setStatus('loading');
    setMessage(null);
    const matches = templateProviders[template.name] || [];
    // Same posture as save — best-effort across all deletes via allSettled, then reload so the
    // UI shows whichever providers / secret actually survived.
    const results = await Promise.allSettled(matches.map((provider) => removeProvider(provider.id)));
    const failures: string[] = [];
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        failures.push(`${matches[index]!.id}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      }
    });
    if (template.tier === 'paid' && template.secretRef) {
      try { await deleteSecret(template.secretRef); }
      catch (err) { failures.push(`secret ${template.secretRef}: ${err instanceof Error ? err.message : String(err)}`); }
    }
    await load();
    if (failures.length === 0) {
      setStatus('ok');
      setMessage(`${template.name} removed.`);
    } else {
      setStatus('error');
      setMessage(`${template.name} remove partially failed:\n${failures.join('\n')}`);
    }
  }

  async function runTest(template: ProviderTemplate) {
    const provider = templateProviders[template.name]?.[0];
    if (!provider) return;
    setStatus('testing');
    setMessage(null);
    try {
      const result = await testProvider(provider.id);
      const failed = result.result.status < 200 || result.result.status >= 300;
      setTestFailures((current) => ({ ...current, [template.name]: failed }));
      setStatus(failed ? 'error' : 'ok');
      setMessage(`${provider.id} ${failed ? 'failed' : 'OK'} (${result.result.status})`);
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      setTestFailures((current) => ({ ...current, [template.name]: true }));
      setStatus(errorState(text));
      setMessage(text);
    }
  }

  async function saveCap(providerIdValue: string, raw: string) {
    const current = workspace?.settings ?? emptyWorkspace();
    let parsed: number | null;
    try { parsed = parseUsd(raw); }
    catch (err) {
      setStatus('error');
      setMessage(err instanceof Error ? err.message : String(err));
      return;
    }
    const paidCaps = { ...current.paidCaps };
    if (parsed == null) delete paidCaps[providerIdValue];
    else paidCaps[providerIdValue] = parsed;
    const next = { ...current, paidCaps, updatedAt: new Date().toISOString() };
    setStatus('loading');
    setMessage(null);
    try {
      const saved = await putWorkspaceSettings(projectId, next as WorkspaceSettings, workspace?.snapshot);
      setWorkspace(saved);
      try { setWorkspaceCost((await getProviderRequestSummary(projectId)).costSummary); }
      catch { setWorkspaceCost(null); }
      setStatus('ok');
      setMessage(`Spend cap for ${providerIdValue} saved.`);
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      setStatus(errorState(text));
      setMessage(text);
    }
  }

  function handleStale(err: unknown) {
    if (!isStaleError(err)) return false;
    setDefaultsNotice('Settings changed elsewhere. Reloading…');
    setStatus('loading');
    void Promise.all([load(), projectId ? loadWorkspace(projectId) : Promise.resolve()]).then(() => setDefaultsNotice(null));
    return true;
  }

  function handleVoicesStale(err: unknown) {
    if (!isStaleError(err)) return false;
    setVoicesNotice('Voices changed elsewhere. Reloading…');
    setStatus('loading');
    void Promise.all([load(), loadVoices()]).then(() => setVoicesNotice(null));
    return true;
  }

  function openAddVoice() {
    setVoiceSource(secureNotice ? 'upload' : 'record');
    setRecordedBlob(null);
    setVoicesNotice(null);
    setDialogError(null);
    setDialogOpen(true);
  }

  function closeAddVoice() {
    setDialogOpen(false);
  }

  function handleDialogClose() {
    // Fires on Escape and on explicit close() calls — single source of truth
    // for tearing down state when the dialog goes away.
    setDialogOpen(false);
    setRecordedBlob(null);
    setDialogError(null);
  }

  function recordedFileName(blob: Blob): string {
    const ext = blob.type.includes('webm') ? 'webm' : blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') || blob.type.includes('m4a') ? 'm4a' : 'wav';
    return `recorded-sample.${ext}`;
  }

  async function submitClone(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fd = new FormData(form);
    const name = String(fd.get('name') ?? '').trim();
    if (!name) { setDialogError('Voice name is required.'); return; }
    const description = String(fd.get('description') ?? '').trim();

    const payload = new FormData();
    payload.set('name', name);
    if (description) payload.set('description', description);

    if (voiceSource === 'record') {
      if (!recordedBlob) { setDialogError('Record a voice sample before cloning.'); return; }
      payload.set('sample', recordedBlob, recordedFileName(recordedBlob));
    } else {
      const file = fd.get('sample');
      if (!(file instanceof File) || file.size === 0) { setDialogError('Choose an audio file to upload.'); return; }
      payload.set('sample', file);
    }

    setCloneBusy(true);
    setDialogError(null);
    setVoicesNotice(null);
    setMessage('ElevenLabs Voice Cloning — included with active ElevenLabs subscriptions; check your tier voice slots.');
    try {
      await cloneVoice(payload);
      await loadVoices();
      setDialogOpen(false);
      setStatus('ok');
      setMessage('Voice cloned.');
    } catch (err) {
      if (isStaleError(err)) {
        // Keep the dialog open and surface the stale notice inside it so the
        // user can retry once the registry reloads. Other callers of
        // handleVoicesStale still use voicesNotice for page-level UX.
        setDialogError('Voices changed elsewhere. Reloading — try again.');
        setStatus('loading');
        void Promise.all([load(), loadVoices()]).catch(() => {});
        return;
      }
      setDialogError(err instanceof Error ? err.message : String(err));
    } finally {
      setCloneBusy(false);
    }
  }

  async function commitRename(id: string) {
    const name = editingVoiceName.trim();
    if (!name) { setVoicesNotice('Voice name is required.'); return; }
    setVoicesNotice(null);
    setStatus('loading');
    try {
      await renameVoice(id, name);
      await loadVoices();
      setEditingVoiceId(null);
      setStatus('ok');
      setMessage('Voice renamed.');
    } catch (err) {
      if (handleVoicesStale(err)) return;
      setStatus('error');
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }

  async function removeVoiceRecord(voice: VoiceRecord) {
    if (!window.confirm(`Delete voice "${voice.name}"? This cannot be undone.`)) return;
    setVoicesNotice(null);
    setStatus('loading');
    try {
      await deleteVoice(voice.id);
      await loadVoices();
      setStatus('ok');
      setMessage('Voice deleted.');
    } catch (err) {
      if (handleVoicesStale(err)) return;
      setStatus('error');
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }

  async function chooseDefaultProvider(provider: ProviderRecord) {
    setDefaultsNotice(null);
    setStatus('loading');
    setMessage(null);
    try {
      await setProviderDefault(provider, false);
      await load();
      setStatus('ok');
      setMessage(`${provider.id} is now the ${provider.kind} default.`);
    } catch (err) {
      if (handleStale(err)) return;
      if (provider.tier !== 'paid') {
        setStatus('error');
        setMessage(err instanceof Error ? err.message : String(err));
        return;
      }
      const ok = window.confirm(`Set paid provider ${provider.name} as the default for ${provider.kind}?\n\nThis may spend your own provider credits. Current ${capLabel(provider, workspace)}.`);
      if (!ok) {
        setStatus('idle');
        setMessage('Default change cancelled.');
        return;
      }
      try {
        await setProviderDefault(provider, true);
        await load();
        setStatus('ok');
        setMessage(`${provider.id} is now the ${provider.kind} default.`);
      } catch (retryErr) {
        if (handleStale(retryErr)) return;
        setStatus('error');
        setMessage(retryErr instanceof Error ? retryErr.message : String(retryErr));
      }
    }
  }

  async function saveProviderModel(provider: ProviderRecord, model: string) {
    setDefaultsNotice(null);
    setStatus('loading');
    setMessage(null);
    try {
      await saveProvider({ ...provider, model });
      await load();
      setStatus('ok');
      setMessage(`${provider.id} model saved.`);
    } catch (err) {
      if (handleStale(err)) return;
      setStatus('error');
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }

  async function saveDefaultVoice(provider: ProviderRecord, voiceId: string) {
    if (!projectId || !workspace) return;
    setDefaultsNotice(null);
    setStatus('loading');
    setMessage(null);
    const next: WorkspaceSettings = {
      ...workspace.settings,
      taskOptions: {
        ...workspace.settings.taskOptions,
        tts: { ...workspace.settings.taskOptions.tts, defaultVoice: { providerId: provider.id, voiceId } }
      },
      updatedAt: new Date().toISOString()
    };
    try {
      const saved = await putWorkspaceSettings(projectId, next, workspace.snapshot);
      setWorkspace(saved);
      setStatus('ok');
      setMessage('Default voice saved.');
    } catch (err) {
      if (handleStale(err)) return;
      setStatus('error');
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }

  function renderDefaults() {
    return <section className="settings-section defaults-section">
      <h2>Defaults per task</h2>
      {defaultsNotice && <div className="notice-box error">{defaultsNotice}</div>}
      <div className="defaults-grid">
        {DEFAULT_TASKS.map(([kind, label]) => {
          const matches = providers.filter((provider) => provider.kind === kind && provider.enabled !== false);
          const selected = matches.find((provider) => provider.default) ?? null;
          const models = selected ? AVAILABLE_MODELS[selected.id] || [] : [];
          const providerVoices = selected ? voices.filter((voice) => voice.provider === selected.name) : [];
          const defaultVoice = workspace?.settings.taskOptions.tts.defaultVoice;
          const selectedVoice = defaultVoice && selected && defaultVoice.providerId === selected.id ? defaultVoice.voiceId : '';
          return <div className="defaults-row" key={kind}>
            <div>
              <strong>{label}</strong>
              {selected && <span className={`status-badge ${selected.tier === 'paid' ? 'error' : 'disabled'}`}>{selected.tier}</span>}
            </div>
            <label>Provider
              <select value={selected?.id || ''} disabled={!matches.length} onChange={(event) => {
                const provider = matches.find((candidate) => candidate.id === event.target.value);
                if (provider) void chooseDefaultProvider(provider);
              }}>
                <option value="">{matches.length ? 'Select provider…' : 'No provider configured'}</option>
                {matches.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
              </select>
            </label>
            {!matches.length && <button type="button" className="link-button" onClick={() => setTab('keys')}>Configure a provider in Keys →</button>}
            {selected && models.length > 0 && <label>Model
              <select value={selected.model ?? ''} onChange={(event) => { if (event.target.value) void saveProviderModel(selected, event.target.value); }}>
                <option value="" disabled>Adapter default ({models[0]})</option>
                {models.map((model) => <option key={model} value={model}>{model}</option>)}
              </select>
            </label>}
            {kind === 'tts' && selected && <>
              <label>Default voice
                <select value={selectedVoice} disabled={!projectId || !workspace || !providerVoices.length} onChange={(event) => { if (event.target.value) void saveDefaultVoice(selected, event.target.value); }}>
                  <option value="" disabled>{providerVoices.length ? 'Select voice…' : 'No voices available'}</option>
                  {providerVoices.map((voice) => <option key={voice.id} value={voice.voiceId}>{voice.name}</option>)}
                </select>
              </label>
              {!projectId && <p className="muted">Pick a workspace first.</p>}
              {projectId && !providerVoices.length && <button type="button" className="link-button" onClick={() => setTab('voices')}>Add voices in the Voices tab →</button>}
            </>}
          </div>;
        })}
      </div>
    </section>;
  }

  function renderVoices() {
    return <section className="settings-section voices-section">
      <header className="settings-hero">
        <h2>Voices</h2>
        <button type="button" onClick={openAddVoice} disabled={!elevenLabsConfigured}>Add voice</button>
      </header>
      {voicesNotice && <div className="notice-box error">{voicesNotice}</div>}
      {!elevenLabsConfigured && <div className="empty-first-run">
        <p>Configure ElevenLabs in Keys to start cloning voices →</p>
        <button type="button" onClick={() => setTab('keys')}>Configure ElevenLabs in Keys</button>
      </div>}
      {elevenLabsConfigured && !voices.length && <p className="muted">No voices cloned yet. Use Add voice to clone your first.</p>}
      {elevenLabsConfigured && Boolean(voices.length) && <div className="voices-grid">
        {voices.map((voice) => {
          const editing = editingVoiceId === voice.id;
          return <article className="voice-card" key={voice.id}>
            <div className="voice-card-title">
              {editing ? <input
                aria-label={`Rename ${voice.name}`}
                value={editingVoiceName}
                onChange={(event) => setEditingVoiceName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void commitRename(voice.id);
                  if (event.key === 'Escape') setEditingVoiceId(null);
                }}
              /> : <strong>{voice.name}</strong>}
            </div>
            <p>Provider: {voice.provider}</p>
            <p>Origin: {voice.originProjectId || 'global'}</p>
            <p>Provider voice id: <code>{voice.voiceId}</code></p>
            <div className="voice-card-actions">
              {editing ? <>
                <button type="button" onClick={() => void commitRename(voice.id)}>Save</button>
                <button type="button" onClick={() => setEditingVoiceId(null)}>Cancel</button>
              </> : <button type="button" onClick={() => { setEditingVoiceId(voice.id); setEditingVoiceName(voice.name); }}>Rename</button>}
              <button type="button" className="danger" onClick={() => void removeVoiceRecord(voice)}>Delete</button>
            </div>
          </article>;
        })}
      </div>}
      <dialog ref={dialogRef} className="voice-dialog" onClose={handleDialogClose}>
        {dialogOpen && <form className="dialog-form" onSubmit={submitClone}>
          <h3>Add voice</h3>
          <p><strong>This audio will be uploaded to ElevenLabs to clone the voice.</strong></p>
          <p className="muted">Voice cloning is included in active ElevenLabs subscriptions; check your tier's voice slots. The sample stays on your device after clone.</p>
          {secureNotice && <p className="notice-box error" role="alert">{secureNotice}</p>}
          {dialogError && <p className="notice-box error" role="alert">{dialogError}</p>}
          <div className="voice-source-toggle" role="tablist" aria-label="Voice sample source">
            <button type="button" role="tab" aria-selected={voiceSource === 'record'} className={voiceSource === 'record' ? 'active' : ''} onClick={() => setVoiceSource('record')} disabled={cloneBusy}>Record</button>
            <button type="button" role="tab" aria-selected={voiceSource === 'upload'} className={voiceSource === 'upload' ? 'active' : ''} onClick={() => setVoiceSource('upload')} disabled={cloneBusy}>Upload file</button>
          </div>
          {voiceSource === 'record' ? <>
            <VoiceSampleRecorder
              blob={recordedBlob}
              onBlob={(blob) => setRecordedBlob(blob)}
              disabled={cloneBusy || Boolean(secureNotice)}
            />
            <details className="voice-recorder-script" open>
              <summary>Suggested script (~45s read)</summary>
              <p className="voice-recorder-script-body">{READ_ALOUD_SCRIPT}</p>
            </details>
          </> : <label>Sample audio<input name="sample" type="file" accept="audio/*" required /></label>}
          <label>Name<input name="name" required maxLength={200} /></label>
          <label>Description<input name="description" /></label>
          <div className="provider-actions">
            <button type="submit" disabled={cloneBusy || (voiceSource === 'record' && !recordedBlob)}>{cloneBusy ? 'Cloning…' : 'Clone voice'}</button>
            <button type="button" onClick={closeAddVoice}>Cancel</button>
          </div>
        </form>}
      </dialog>
    </section>;
  }

  function renderKeys() {
    return <>
      <section className="settings-section plaintext-warning">
        <h2>API keys</h2>
        <p className="muted"><strong>Severe warning:</strong> secrets are stored as chmod 600 plaintext JSON. No keyring in v1. Never paste keys into provider URLs or logs.</p>
        <p className="muted">Location: <code>{settings?.secrets.displayPath || '~/.etvs/secrets.json'}</code> · chmod: <code>{settings?.secrets.chmod || 'missing'}</code></p>
        <div className="form">
          <select value={projectId} onChange={(event) => { setProjectId(event.target.value); void loadWorkspace(event.target.value); }}>
            <option value="">Select workspace for caps…</option>
            {projects.map((project) => <option key={project.projectId} value={project.projectId}>{project.title || project.projectId}</option>)}
          </select>
          <button type="button" disabled={!projectId} onClick={() => void loadWorkspace(projectId)}>Reload caps</button>
        </div>
      </section>

      <section className="settings-grid">
        {PROVIDER_TEMPLATES.map((template) => {
          const matches = templateProviders[template.name] || [];
          const badge = statusFor(template, matches, secrets, Boolean(testFailures[template.name]));
          return <article className="settings-section provider-card" key={template.name}>
            <div className="provider-card-head">
              <div>
                <h2>{template.name}</h2>
                <p className="muted">Powers: {template.kinds.join(' · ')}</p>
              </div>
              <span className={`status-badge ${badge.className}`}>{badge.label}</span>
            </div>
            {template.tier === 'paid' ? <>
              <p className="muted">Base URL: <code>{template.baseUrl}</code></p>
              <input
                aria-label={`${template.name} API key`}
                type="password"
                value={template.secretRef ? keyInputs[template.secretRef] || '' : ''}
                onChange={(event) => template.secretRef && setKeyInputs((current) => ({ ...current, [template.secretRef!]: event.target.value }))}
                placeholder={template.secretRef && secrets.includes(template.secretRef) ? 'Key saved; paste to replace' : 'Paste API key'}
              />
            </> : <input
              aria-label={`${template.name} base URL`}
              value={baseUrlInputs[template.name] ?? matches[0]?.baseUrl ?? template.baseUrl ?? ''}
              onChange={(event) => setBaseUrlInputs((current) => ({ ...current, [template.name]: event.target.value }))}
              placeholder="Base URL"
            />}
            {template.tier === 'paid' && matches.length > 0 && <div className="cap-list">
              {matches.map((provider) => {
                const spent = workspaceCost?.totalsByProvider.find((total) => total.provider === provider.id)?.estimatedTotal ?? 0;
                const cap = workspace?.settings.paidCaps[provider.id];
                return <label key={`cap-${projectId}-${provider.id}`}>{provider.kind}
                  <input type="text" defaultValue={formatUsd(cap)} placeholder="$0.50" onBlur={(event) => void saveCap(provider.id, event.target.value)} disabled={!projectId || !workspace} />
                  <span className="muted">spent ${spent.toFixed(4)}{cap != null ? ` of $${cap.toFixed(2)}` : ' of no cap'}</span>
                </label>;
              })}
            </div>}
            <div className="provider-actions">
              <button type="button" onClick={() => void saveTemplate(template)}>Save</button>
              <button type="button" onClick={() => void runTest(template)} disabled={!matches.length}>Test</button>
              <button type="button" className="danger" onClick={() => void removeTemplate(template)} disabled={!matches.length && !(template.secretRef && secrets.includes(template.secretRef))}>Remove</button>
            </div>
          </article>;
        })}
      </section>
    </>;
  }

  function renderUsage() {
    return <>
      <section className="settings-section cost-console">
        <h2>Usage & cost</h2>
        <p className="muted">Read-only per-workspace paid-call ledger. Paid-call disclosure is always shown; ETVS_HIDE_COST does not hide this section.</p>
        <div className="form">
          <select value={costProjectId} onChange={(e) => { setCostProjectId(e.target.value); void loadCost(e.target.value); }}>
            <option value="">Select project…</option>
            {projects.map((project) => <option key={project.projectId} value={project.projectId}>{project.title || project.projectId}</option>)}
          </select>
          <button type="button" disabled={!costProjectId || costStatus === 'loading'} onClick={() => void loadCost(costProjectId)}>Refresh</button>
        </div>
        {!projects.length && <div className="provider-row empty-first-run">No projects found.</div>}
        {costStatus === 'loading' && <div className="provider-row">Loading cost ledger…</div>}
        {costSummary && !costSummary.rows.length && <div className="provider-row empty-first-run">No paid calls yet</div>}
        {costSummary && Boolean(costSummary.totalsByProvider.length) && <table className="state-matrix cost-table"><thead><tr><th>Provider</th><th>Requests</th><th>Estimated</th><th>Actual</th></tr></thead><tbody>{costSummary.totalsByProvider.map((total, index) => <tr key={`${total.provider}-${total.currency}-${index}`}><th>{total.provider}</th><td>{total.count}</td><td>{money(total.estimatedTotal, total.currency)}</td><td>{money(total.actualTotal, total.currency)}</td></tr>)}</tbody></table>}
        {costSummary && Boolean(costSummary.rows.length) && <table className="state-matrix cost-table"><thead><tr><th>Timestamp</th><th>Provider</th><th>Type</th><th>Status</th><th>Estimated</th><th>Actual</th><th>Divergence</th><th>Duration</th><th>Source</th><th>HTTP</th><th>Why cost unknown</th></tr></thead><tbody>{costSummary.rows.map((row, index) => <tr key={`${row.requestId}-${row.status}-${row.timestamp}-${index}`}><td>{row.timestamp}</td><td>{row.provider}</td><td>{row.requestType}</td><td>{row.status}</td><td>{money(row.estimatedCost, row.currency)}</td><td>{money(row.actualCost, row.currency)}</td><td className={row.costDiverged ? 'error-text' : ''}>{row.costDiverged ? 'yes' : 'no'}</td><td>{durationLabel(row.duration)}</td><td>{row.sourceAction}</td><td>{row.providerStatus ?? '—'}</td><td>{row.whyCostUnknown ?? '—'}</td></tr>)}</tbody></table>}
      </section>

      <section className="settings-section">
        <details>
          <summary>State matrix (debugging)</summary>
          <table className="state-matrix"><thead><tr><th>Control</th>{STATES.map((s) => <th key={s}>{s}</th>)}</tr></thead><tbody>{CONTROLS.map((control) => <tr key={control}><th>{control}</th>{STATES.map((s) => <td key={s} className={s === inferState(status, settings) ? 'active-state' : ''}>handled</td>)}</tr>)}</tbody></table>
        </details>
      </section>
    </>;
  }

  return <main className="page settings-page">
    <header className="settings-hero">
      <div>
        <h1>Settings</h1>
        <p className="muted">Flat-file provider registry for transcription, speech, media generation, Studio Sound, and workspace overrides.</p>
      </div>
      <button onClick={load}>Reload</button>
    </header>

    <nav className="settings-tabs" aria-label="Settings sections">
      {TABS.map((tab) => <button key={tab.id} type="button" className={activeTab === tab.id ? 'active' : ''} onClick={() => setTab(tab.id)}>{tab.label}</button>)}
    </nav>

    {message && <pre className={status === 'ok' ? 'notice-box' : 'error-box'}>{message}</pre>}

    {activeTab === 'keys' && renderKeys()}
    {activeTab === 'defaults' && renderDefaults()}
    {activeTab === 'voices' && renderVoices()}
    {activeTab === 'usage' && renderUsage()}
  </main>;
}
