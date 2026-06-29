import { apiFetch } from '../../../lib/api';
import EditorShell from './EditorShell';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ projectId: string }> };

export default async function ProjectPage({ params }: Props) {
  const { projectId } = await params;
  try {
    const res = await apiFetch(`/api/projects/${projectId}`);
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    return <EditorShell initial={data} projectId={projectId} />;
  } catch (err) {
    return <main className="page"><h1>Project load failed</h1><pre>{err instanceof Error ? err.message : String(err)}</pre></main>;
  }
}
