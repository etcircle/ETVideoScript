"use client";

import { FormEvent, useState } from 'react';
import Link from 'next/link';
import { api } from '../../lib/api';

type Project = { projectId: string; title: string; status: { imported: boolean; transcribed: boolean } };

export default function ProjectsClient({ initialProjects }: { initialProjects: Project[] }) {
  const [projects, setProjects] = useState<Project[]>(initialProjects);
  const [projectId, setProjectId] = useState('');
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function createProject(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const created = await api<{ project: Project }>('/api/projects', { method: 'POST', body: JSON.stringify({ projectId, title: title || projectId }) });
      setProjects((current) => [created.project, ...current.filter((p) => p.projectId !== created.project.projectId)]);
      setProjectId('');
      setTitle('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return <main className="page project-list">
    <h1>Projects</h1>
    <p className="muted">Create/import from the local API, then edit via transcript + manifest.</p>
    <form className="form" onSubmit={createProject}>
      <input value={projectId} onChange={(e) => setProjectId(e.target.value)} placeholder="episode-001" pattern="[a-zA-Z0-9._\-]+" required />
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Project title" />
      <button>Create project</button>
    </form>
    {error && <pre className="error-box">{error}</pre>}
    <div className="cards">{projects.map((project) => <Link className="card" key={project.projectId} href={`/projects/${project.projectId}`}><h2>{project.title}</h2><p className="muted">{project.projectId}</p><p>Imported: {project.status.imported ? 'yes' : 'no'} · Transcribed: {project.status.transcribed ? 'yes' : 'no'}</p></Link>)}</div>
  </main>;
}
