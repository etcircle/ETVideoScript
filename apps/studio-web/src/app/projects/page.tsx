import { apiFetch } from '../../lib/api';
import { AppNav } from '../_components/AppNav';
import ProjectsClient from './projects-client';

async function getProjects() {
  try { const res = await apiFetch('/api/projects'); return await res.json(); } catch { return { projects: [] }; }
}

export default async function ProjectsPage() {
  const { projects } = await getProjects();
  return <>
    <AppNav />
    <div className="topbar"><div className="logo">ETVideoScript</div><div className="muted">local-first transcript editor</div></div>
    <ProjectsClient initialProjects={projects} />
  </>;
}
