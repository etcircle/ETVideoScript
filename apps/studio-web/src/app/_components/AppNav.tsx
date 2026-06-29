import Link from 'next/link';

export function AppNav() {
  return <nav className="app-nav" aria-label="App navigation">
    <Link className="logo" href="/projects">ETVideoScript</Link>
    <div className="navlinks">
      <Link href="/projects">Projects</Link>
      <Link href="/settings">Settings</Link>
    </div>
  </nav>;
}
