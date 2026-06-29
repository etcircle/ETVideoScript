import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWorkspace, ManifestV3Schema } from '../index';

const helper = join(process.cwd(), 'packages/core/src/__tests__/fixtures/lock-test-helper.mjs');

function runHelper(workspace: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', helper, workspace], {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`helper exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });
}

describe('cross-process manifest v3 locking', () => {
  it('serializes two child-process loadManifestV3 readers without corrupting the manifest', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvs-lock-xproc-'));
    const workspace = join(root, 'p');
    try {
      await createWorkspace({ workspacePath: workspace, projectId: 'p', title: 'P' });
      const [a, b] = await Promise.all([runHelper(workspace), runHelper(workspace)]);
      expect(JSON.parse(a.stdout.trim())).toEqual({ version: 3 });
      expect(JSON.parse(b.stdout.trim())).toEqual({ version: 3 });
      expect(ManifestV3Schema.parse(JSON.parse(readFileSync(join(workspace, 'edits/manifest.json'), 'utf8'))).manifestVersion).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
