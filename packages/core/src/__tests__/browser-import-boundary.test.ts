import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// ⟨F14⟩ ADR-0001 guard, in the test suite rather than only in the studio-web prod build.
// `pnpm -r typecheck` cannot catch a violation (the types resolve fine either way) — only the
// Next.js bundle does, which means a regression is found minutes later and in another package.
// This walks the import graph from browser.ts and fails immediately on any node:* import.

const SRC = resolve(__dirname, '..');

function resolveImport(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, join(base, 'index.ts'), `${base}.tsx`]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function importSpecifiers(source: string): string[] {
  const out: string[] = [];
  // Every `from 'x'` plus bare `import 'x'`. Deliberately not a parser: a token-level scan is
  // enough to enumerate module specifiers and cannot be defeated by formatting.
  //
  // TYPE-ONLY specifiers are NOT edges: `export type { X } from './nodeThing'` is erased at
  // compile time, so it carries nothing into the bundle. browser.ts legitimately re-exports
  // types from Node-only modules this way (e.g. ProviderRequestCostSummary), and counting those
  // as violations would make this test assert something the ADR never required.
  for (const match of source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) {
    const statementStart = Math.max(source.lastIndexOf('import', match.index!), source.lastIndexOf('export', match.index!));
    const clause = statementStart >= 0 ? source.slice(statementStart, match.index!) : '';
    if (/^(?:import|export)\s+type\b/.test(clause)) continue;
    const braced = /\{([\s\S]*)\}/.exec(clause);
    if (braced) {
      const bindings = braced[1]!.split(',').map((binding) => binding.trim()).filter(Boolean);
      if (bindings.length > 0 && bindings.every((binding) => /^type\s/.test(binding))) continue;
    }
    out.push(match[1]!);
  }
  for (const match of source.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) out.push(match[1]!);
  return out;
}

describe('browser.ts import boundary (ADR-0001)', () => {
  it('reaches no node:* import from the browser-safe entrypoint', () => {
    const seen = new Set<string>();
    const violations: string[] = [];
    const walk = (file: string, trail: string[]) => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = readFileSync(file, 'utf8');
      for (const specifier of importSpecifiers(source)) {
        if (specifier.startsWith('node:')) {
          violations.push(`${[...trail, file].map((f) => f.slice(SRC.length + 1)).join(' -> ')} imports ${specifier}`);
          continue;
        }
        const resolved = resolveImport(file, specifier);
        if (resolved) walk(resolved, [...trail, file]);
      }
    };
    walk(join(SRC, 'browser.ts'), []);
    expect(violations).toEqual([]);
    // Sanity: the walk actually traversed the graph rather than silently resolving nothing.
    expect(seen.size).toBeGreaterThan(5);
  });

  it('does not reach the Node-only S1b modules', () => {
    const seen = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
        const resolved = resolveImport(file, specifier);
        if (resolved) walk(resolved);
      }
    };
    walk(join(SRC, 'browser.ts'));
    for (const nodeOnly of ['audioDecode.ts', 'generatePatch.ts', 'jobs.ts', 'voiceClone.ts', 'providerRequests.ts']) {
      expect(seen.has(join(SRC, nodeOnly))).toBe(false);
    }
    // ...while the browser-safe job view IS reachable (it is what the studio client types against).
    expect(seen.has(join(SRC, 'jobView.ts'))).toBe(true);
  });
});
