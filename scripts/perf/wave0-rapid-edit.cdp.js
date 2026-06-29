import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PROJECT_ID = process.env.ETVS_PERF_PROJECT_ID || 'qa-perf-1779641445';
const TARGET_URL = process.env.ETVS_PERF_URL || `https://127.0.0.1:4443/projects/${PROJECT_ID}`;
const API_BASE = process.env.ETVS_PERF_API_BASE || 'http://127.0.0.1:4317';
const WORKSPACE_ROOT = resolve(process.env.ETVS_PERF_WORKSPACE_ROOT || process.env.ETVS_WORKSPACE_ROOT || 'workspaces');
const MANIFEST_PATH = join(WORKSPACE_ROOT, PROJECT_ID, 'edits/manifest.json');
const CHROME = process.env.ETVS_PERF_CHROME || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium'
].find((path) => existsSync(path));

function readEnvToken() {
  const fromProcess = process.env.ETVS_TERMINAL_TOKEN || process.env.ETVIDEO_TERMINAL_TOKEN || process.env.NEXT_PUBLIC_ETVS_TERMINAL_TOKEN || process.env.NEXT_PUBLIC_ETVIDEO_TERMINAL_TOKEN;
  if (fromProcess) return fromProcess;
  const candidates = [
    '.env.local',
    'apps/studio-web/.env.local',
    'apps/local-api/.env.local',
    '.env'
  ];
  for (const candidate of candidates) {
    try {
      const raw = readFileSync(resolve(candidate), 'utf8');
      for (const line of raw.split(/\r?\n/)) {
        const match = /^\s*(NEXT_PUBLIC_)?ETV(S|IDEO)_TERMINAL_TOKEN\s*=\s*(.*)\s*$/.exec(line);
        if (!match) continue;
        return match[3].replace(/^['"]|['"]$/g, '');
      }
    } catch {}
  }
  return '';
}

async function manifestOpsCount(token) {
  const res = await fetch(`${API_BASE}/api/projects/${PROJECT_ID}/manifest`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    cache: 'no-store'
  });
  if (!res.ok) throw new Error(`manifest fetch failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  return Array.isArray(body.manifest?.operations) ? body.manifest.operations.length : 0;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

async function delay(ms) {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitFor(fn, timeoutMs, label) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}${last instanceof Error ? `: ${last.message}` : ''}`);
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.ws = null;
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data.toString());
      if (!msg.id) return;
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(`${msg.error.message || 'CDP error'} ${JSON.stringify(msg.error.data || '')}`));
      else pending.resolve(msg.result);
    });
    await new Promise((resolveOpen, rejectOpen) => {
      this.ws.addEventListener('open', resolveOpen, { once: true });
      this.ws.addEventListener('error', rejectOpen, { once: true });
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolveSend, rejectSend) => {
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend });
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        rejectSend(new Error(`CDP timeout: ${method}`));
      }, 30000).unref?.();
    });
  }

  close() {
    this.ws?.close();
  }
}

async function launchCdp() {
  if (!CHROME) throw new Error('No Chrome/Chromium executable found. Set ETVS_PERF_CHROME to the browser path.');
  const port = 49000 + Math.floor(Math.random() * 1000);
  const profile = mkdtempSync(join(tmpdir(), 'etvs-wave0-chrome-'));
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--ignore-certificate-errors',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    'about:blank'
  ], { stdio: 'ignore' });

  const cleanup = () => {
    chrome.kill('SIGKILL');
    setTimeout(() => rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }), 250).unref?.();
  };

  try {
    const pageTarget = await waitFor(async () => {
      const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).catch(() => null);
      return res?.ok ? res.json() : null;
    }, 10000, 'Chrome CDP page target');

    const client = new CdpClient(pageTarget.webSocketDebuggerUrl);
    await client.connect();
    return { client, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

async function runWithPlaywright() {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    return null;
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1100 } });
  try {
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.transcript-body', { timeout: 30000 });
    await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button')];
      const preview = buttons.find((button) => button.textContent?.trim() === 'Preview');
      if (preview && !preview.classList.contains('active')) preview.click();
    });
    await page.evaluate(() => {
      window.__wave0Frames = [];
      window.__wave0FrameActive = true;
      let last = performance.now();
      const tick = (now) => {
        if (!window.__wave0FrameActive) return;
        const delta = now - last;
        if (delta > 16) window.__wave0Frames.push(delta);
        last = now;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const wallStart = Date.now();
    for (let i = 0; i < 10; i++) {
      const loc = page.locator('.transcript-body .tx-word').nth(4 + i * 3);
      const box = await loc.boundingBox().catch(() => null) || await page.locator('.transcript-body .tx-word').nth(1).boundingBox();
      if (!box) throw new Error('No transcript words found for edit');
      await page.mouse.click(box.x + Math.max(2, box.width - 2), box.y + box.height / 2);
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(50);
    }
    const wallTimeMs = Date.now() - wallStart;
    const frames = await page.evaluate(() => { window.__wave0FrameActive = false; return window.__wave0Frames || []; });
    return { frames, wallTimeMs, close: () => browser.close() };
  } catch (err) {
    await browser.close();
    throw err;
  }
}

async function runWithCdp() {
  const { client, cleanup } = await launchCdp();
  try {
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
    await client.send('Page.navigate', { url: TARGET_URL });
    await waitFor(async () => {
      const result = await client.send('Runtime.evaluate', { expression: "!!document.querySelector('.transcript-body')", returnByValue: true });
      return result.result.value;
    }, 30000, '.transcript-body');

    await client.send('Runtime.evaluate', { expression: `(() => {
      const preview = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Preview');
      if (preview && !preview.classList.contains('active')) preview.click();
    })()` });

    await client.send('Runtime.evaluate', { expression: `(() => {
      window.__wave0Frames = [];
      window.__wave0FrameActive = true;
      let last = performance.now();
      const tick = (now) => {
        if (!window.__wave0FrameActive) return;
        const delta = now - last;
        if (delta > 16) window.__wave0Frames.push(delta);
        last = now;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    })()` });

    const wallStart = Date.now();
    for (let i = 0; i < 10; i++) {
      const clicked = await client.send('Runtime.evaluate', { expression: `(() => {
        const words = [...document.querySelectorAll('.transcript-body .tx-word')];
        const word = words[Math.min(words.length - 1, ${4 + i * 3})] || words[1] || words[0];
        if (!word) return false;
        const rect = word.getBoundingClientRect();
        const x = Math.max(rect.left + 2, rect.right - 2);
        const y = rect.top + rect.height / 2;
        for (const type of ['mousedown', 'mouseup', 'click']) word.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === 'mousedown' ? 1 : 0, clientX: x, clientY: y }));
        document.querySelector('.transcript-body')?.focus();
        return true;
      })()`, returnByValue: true });
      if (!clicked.result.value) throw new Error('No transcript words found for edit');
      await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
      await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
      await delay(50);
    }
    const wallTimeMs = Date.now() - wallStart;
    const framesResult = await client.send('Runtime.evaluate', { expression: "(() => { window.__wave0FrameActive = false; return window.__wave0Frames || []; })()", returnByValue: true });
    return { frames: framesResult.result.value || [], wallTimeMs, close: async () => { client.close(); cleanup(); } };
  } catch (err) {
    client.close();
    cleanup();
    throw err;
  }
}

async function main() {
  const token = readEnvToken();
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(`Perf fixture manifest not found at ${MANIFEST_PATH}. Create project ${PROJECT_ID} or set ETVS_PERF_PROJECT_ID and ETVS_WORKSPACE_ROOT to an existing perf workspace.`);
  }
  const originalManifest = readFileSync(MANIFEST_PATH, 'utf8');
  let runnerResult;
  try {
    const beforeOps = await manifestOpsCount(token);
    runnerResult = await runWithPlaywright() || await runWithCdp();
    const afterOps = await waitFor(async () => {
      const count = await manifestOpsCount(token);
      return count >= beforeOps + 10 ? count : 0;
    }, 30000, '10 committed manifest ops');
    const frames = runnerResult.frames.filter((n) => typeof n === 'number' && Number.isFinite(n) && n > 16);
    console.log(JSON.stringify({
      p95LongFrameMs: Number(percentile(frames, 95).toFixed(2)),
      maxLongFrameMs: Number((frames.length ? Math.max(...frames) : 0).toFixed(2)),
      editsCommitted: Math.max(0, afterOps - beforeOps),
      wallTimeMs: runnerResult.wallTimeMs
    }, null, 2));
  } finally {
    writeFileSync(MANIFEST_PATH, originalManifest);
    if (runnerResult) await runnerResult.close();
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err.message }, null, 2));
  process.exit(1);
});
