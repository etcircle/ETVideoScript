import type { LocalProviderRunContext } from './contract';
import { ProviderExecutionError } from './engine';

export type RunLocalCommandOptions = {
  cwd?: string;
  input?: Buffer | string;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  timeoutMs?: number;
};

function appendCapped(chunks: Buffer[], chunk: Buffer, maxBytes: number): void {
  const current = chunks.reduce((sum, part) => sum + part.byteLength, 0);
  if (current >= maxBytes) return;
  chunks.push(chunk.subarray(0, Math.max(0, maxBytes - current)));
}

export function runLocalCommand(ctx: LocalProviderRunContext, command: string, args: string[], opts: RunLocalCommandOptions = {}): Promise<{ stdout: Buffer; stderr: Buffer }> {
  return new Promise((resolve, reject) => {
    const child = ctx.spawn(command, args, { cwd: opts.cwd ?? ctx.workspacePath, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const maxStdout = opts.maxStdoutBytes ?? 1024 * 1024;
    const maxStderr = opts.maxStderrBytes ?? 1024 * 1024;
    let settled = false;
    const killTree = () => {
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        try { child.kill('SIGKILL'); } catch {}
      }
    };
    const finish = (err?: Error, value?: { stdout: Buffer; stderr: Buffer }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ctx.signal.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve(value!);
    };
    const onAbort = () => {
      killTree();
      finish(new ProviderExecutionError(`${command} aborted or timed out.`, { code: 'provider_timeout' }));
    };
    const timeout = setTimeout(onAbort, opts.timeoutMs ?? 60000);
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk) => appendCapped(stdoutChunks, Buffer.from(chunk), maxStdout));
    child.stderr?.on('data', (chunk) => appendCapped(stderrChunks, Buffer.from(chunk), maxStderr));
    child.on('error', (err) => finish(new ProviderExecutionError(`${command} failed to start: ${err.message}`, { code: 'provider_unavailable' })));
    child.on('close', (code, signal) => {
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks);
      if (code !== 0) {
        finish(new ProviderExecutionError(`${command} exited with ${code ?? signal}: ${stderr.toString('utf8') || stdout.toString('utf8')}`, { code: 'provider_unavailable', details: { stderr: stderr.toString('utf8'), stdout: stdout.toString('utf8'), code, signal } }));
        return;
      }
      finish(undefined, { stdout, stderr });
    });
    if (opts.input != null) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
}
