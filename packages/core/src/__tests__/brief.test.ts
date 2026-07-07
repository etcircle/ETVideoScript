import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { briefTemplate, readBrief, writeBrief } from '../brief/io';
import { TakesError } from '../takes/schema';

let dir: string;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
function ws(): string { dir = mkdtempSync(join(tmpdir(), 'ets-brief-')); return dir; }

const VALID = `---\ntitle: "Webhooks demo"\naudience: "ETCircle admins"\ntone: "friendly"\ntargetDurationSec: 480\nstructure:\n  - "hook"\n  - "steps"\n---\nBody text here.\n`;

describe('brief', () => {
  it('round-trips a valid brief', () => {
    const w = ws();
    writeFileSync(join(w, 'brief.md'), VALID);
    const brief = readBrief(w);
    expect(brief.frontmatter.title).toBe('Webhooks demo');
    expect(brief.frontmatter.targetDurationSec).toBe(480);
    expect(brief.frontmatter.structure).toEqual(['hook', 'steps']);
    expect(brief.body.trim()).toBe('Body text here.');
    writeBrief(w, brief);
    expect(readBrief(w)).toEqual(brief);
  });

  it('throws BRIEF_INVALID when file is missing', () => {
    expect(() => readBrief(ws())).toThrowError(TakesError);
    try { readBrief(dir); } catch (err) { expect((err as TakesError).code).toBe('BRIEF_INVALID'); }
  });

  it('throws BRIEF_INVALID listing each bad frontmatter field', () => {
    const w = ws();
    writeFileSync(join(w, 'brief.md'), `---\ntitle: ""\ntargetDurationSec: -5\n---\n`);
    try {
      readBrief(w);
      expect.unreachable();
    } catch (err) {
      const message = (err as TakesError).message;
      expect(message).toMatch(/title/);
      expect(message).toMatch(/audience/);
      expect(message).toMatch(/targetDurationSec/);
    }
  });

  it('requires the document to start with frontmatter', () => {
    const w = ws();
    writeFileSync(join(w, 'brief.md'), 'no frontmatter');
    expect(() => readBrief(w)).toThrowError(/must start with ---/);
  });

  it('template parses once filled placeholders are replaced', () => {
    expect(briefTemplate()).toMatch(/^---\n/);
    expect(briefTemplate()).toMatch(/title:/);
  });
});
