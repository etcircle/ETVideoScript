"use client";
import type { ReactNode } from 'react';
import type { ActivePanel } from '../../../../store/editorStore';
import { useEditorStore } from '../../../../store/editorStore';
import { approvedOperations, proposedOperations } from '../../../../store/selectors';

type RailItem = {
  key: NonNullable<ActivePanel>;
  label: string;
  icon: ReactNode;
};

function LineIcon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

const icons = {
  sparkle: (
    <LineIcon>
      <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3z" />
      <path d="M18 14l.8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8L18 14z" />
    </LineIcon>
  ),
  inbox: (
    <LineIcon>
      <path d="M4 13h4l2 3h4l2-3h4" />
      <path d="M4 13V5h16v8" />
      <path d="M4 13v6h16v-6" />
    </LineIcon>
  ),
  list: (
    <LineIcon>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <circle cx="4" cy="6" r="1" />
      <circle cx="4" cy="12" r="1" />
      <circle cx="4" cy="18" r="1" />
    </LineIcon>
  ),
  shorts: (
    <LineIcon>
      <rect x="7" y="3" width="10" height="18" rx="1.5" />
      <path d="M11 9v6l4-3z" fill="currentColor" stroke="none" />
    </LineIcon>
  ),
  inspect: (
    <LineIcon>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l5 5" />
      <path d="M11 8v6M8 11h6" />
    </LineIcon>
  ),
  shapes: (
    <LineIcon>
      <rect x="3" y="3" width="8" height="8" />
      <circle cx="17" cy="7" r="4" />
      <path d="M7 13l4 7H3z" />
    </LineIcon>
  ),
  film: (
    <LineIcon>
      <rect x="3" y="4" width="18" height="16" rx="1" />
      <path d="M7 4v16M17 4v16M3 8h4M17 8h4M3 16h4M17 16h4M3 12h18" />
    </LineIcon>
  ),
  gear: (
    <LineIcon>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
    </LineIcon>
  ),
};

const ITEMS: RailItem[] = [
  { key: 'ai',          label: 'AI',       icon: icons.sparkle },
  { key: 'suggestions', label: 'Suggest',  icon: icons.inbox   },
  { key: 'manifest',    label: 'Changes',  icon: icons.list    },
  { key: 'clips',       label: 'Clips',    icon: icons.shorts  },
  { key: 'inspect',     label: 'Inspect',  icon: icons.inspect },
  { key: 'elements',    label: 'Elements', icon: icons.shapes  },
  { key: 'media',       label: 'Media',    icon: icons.film    },
];

export function SidebarRail() {
  const activePanel      = useEditorStore((s) => s.activePanel);
  const setPanel         = useEditorStore((s) => s.setPanel);
  const manifest         = useEditorStore((s) => s.manifest);
  const studioSoundStatus = useEditorStore((s) => s.studioSoundStatus);

  const proposedCount = proposedOperations(manifest).length;
  const approvedCount = approvedOperations(manifest).length;
  const runningSkill  = studioSoundStatus === 'running';

  function badge(key: NonNullable<ActivePanel>): number | string | null {
    if (key === 'ai') return runningSkill ? '•' : null;
    if (key === 'suggestions') return proposedCount > 0 ? proposedCount : null;
    if (key === 'manifest')    return approvedCount > 0 ? approvedCount : null;
    return null;
  }

  function isAccent(key: NonNullable<ActivePanel>) {
    return (key === 'suggestions' && proposedCount > 0) || (key === 'ai' && runningSkill);
  }

  return (
    <nav className="rail" aria-label="Side panels">
      <div className="rail-items">
        {ITEMS.map((item) => {
          const b = badge(item.key);
          return (
            <button
              key={item.key}
              type="button"
              className={`rail-btn${activePanel === item.key ? ' active' : ''}`}
              onClick={() => setPanel(item.key)}
              aria-pressed={activePanel === item.key}
              title={item.label}
            >
              <span className="rail-icon">{item.icon}</span>
              <span className="rail-label">{item.label}</span>
              {b != null && (
                <span className={`rail-badge${isAccent(item.key) ? ' accent' : ''}`}>{b}</span>
              )}
            </button>
          );
        })}
      </div>
      <div className="rail-footer">
        <button type="button" className="rail-btn" disabled title="Settings">
          <span className="rail-icon">{icons.gear}</span>
          <span className="rail-label">Settings</span>
        </button>
      </div>
    </nav>
  );
}
