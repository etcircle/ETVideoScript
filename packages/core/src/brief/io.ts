import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { assertInside } from '../filesystem';
import { TakesError } from '../takes/schema';
import { BriefFrontmatterSchema, BriefSchema, type Brief } from './schema';

export function readBrief(workspaceDir: string): Brief {
  const path = assertInside(resolve(workspaceDir), 'brief.md');
  if (!existsSync(path)) {
    throw new TakesError('BRIEF_INVALID', 'brief.md not found. Run `ets brief init` and fill it in, or `ets brief set --file <path>`.');
  }
  const raw = readFileSync(path, 'utf8');
  if (!raw.startsWith('---\n')) throw new TakesError('BRIEF_INVALID', 'brief.md must start with --- frontmatter on line 1');
  const closing = raw.indexOf('\n---', 4);
  if (closing === -1) throw new TakesError('BRIEF_INVALID', 'brief.md frontmatter is missing its closing ---');
  let data: unknown;
  try {
    data = parseYaml(raw.slice(4, closing));
  } catch (err) {
    throw new TakesError('BRIEF_INVALID', `brief.md frontmatter is not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = BriefFrontmatterSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
    throw new TakesError('BRIEF_INVALID', `brief.md frontmatter invalid:\n${issues.join('\n')}`, issues);
  }
  const bodyStart = raw.indexOf('\n', closing + 1);
  return { frontmatter: parsed.data, body: bodyStart === -1 ? '' : raw.slice(bodyStart + 1) };
}

export function writeBrief(workspaceDir: string, brief: Brief): void {
  const validated = BriefSchema.parse(brief);
  const path = assertInside(resolve(workspaceDir), 'brief.md');
  writeFileSync(path, `---\n${stringifyYaml(validated.frontmatter)}---\n${validated.body}`);
}

export function briefTemplate(): string {
  return [
    '---',
    'title: "What this video is called"',
    'audience: "Who watches it and what they already know"',
    'tone: "e.g. friendly, concise"',
    '# targetDurationSec: 480',
    '# structure:',
    '#   - "hook: ..."',
    '#   - "main steps"',
    '---',
    'Explain here, in as much detail as you like: what the video is about, why the',
    'audience should care, what must stay in, what can be dropped. The editing agent',
    'grounds every cut decision in this document.',
    ''
  ].join('\n');
}
