import './globals.css';
import './editor.css';
import './realign.css';
import './editor-overrides.css';
import './app-chrome.css';
import './v4.css';
export const metadata = { title: 'ETVideoScript', description: 'Local transcript-based video editor' };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en" data-theme="light"><body>{children}</body></html>;
}
