import {
  Activity,
  Archive,
  BookOpenCheck,
  ClipboardList,
  Clock3,
  FileCheck2,
  FolderGit2,
  Gauge,
  LayoutDashboard,
  MessageSquareText,
  Users,
  ClipboardCheck,
  X,
} from 'lucide-react';
import { NavLink } from 'react-router-dom';
import type { Role } from '@/types/session';
import { Brand } from './brand';

type SidebarProps = {
  readonly role: Role;
  readonly open: boolean;
  readonly onClose: () => void;
};

const groups = {
  organizer: [
    { label: 'Command center', to: '/', icon: LayoutDashboard },
    { label: 'Teams', to: '/teams', icon: Users },
    { label: 'Assignments', to: '/assignments', icon: BookOpenCheck },
    { label: 'Repositories', to: '/repositories', icon: FolderGit2 },
    { label: 'Rubrics', to: '/rubrics', icon: ClipboardCheck },
    { label: 'Deadlines', to: '/deadlines', icon: Clock3 },
    { label: 'Communications', to: '/communications', icon: MessageSquareText },
    { label: 'Results', to: '/results', icon: FileCheck2 },
  ],
  judge: [
    { label: 'Assigned overview', to: '/', icon: LayoutDashboard },
    { label: 'My queue', to: '/queue', icon: ClipboardList },
    { label: 'Review workspace', to: '/workspace', icon: Gauge },
    { label: 'Review history', to: '/history', icon: Archive },
  ],
  participant: [
    { label: 'Overview', to: '/', icon: LayoutDashboard },
    { label: 'My submission', to: '/submission', icon: ClipboardList },
    { label: 'Evaluation', to: '/evaluation', icon: Activity },
  ],
} as const;
const roleLabel = {
  organizer: 'Organizer',
  judge: 'Judge',
  participant: 'Participant',
} as const;

export function Sidebar({ role, open, onClose }: SidebarProps) {
  return (
    <>
      <button
        aria-label="Close navigation"
        className={`sidebar-scrim ${open ? 'is-open' : ''}`}
        onClick={onClose}
        type="button"
      />
      <aside
        aria-label={`${roleLabel[role]} workspace navigation`}
        className={`sidebar ${open ? 'is-open' : ''}`}
      >
        <div className="sidebar-top">
          <Brand />
          <button
            aria-label="Close navigation"
            className="icon-button sidebar-close"
            onClick={onClose}
            type="button"
          >
            <X />
          </button>
        </div>
        <div className="workspace-context">
          <strong>Private arena</strong>
          <small>{roleLabel[role]} workspace</small>
        </div>
        <div className="nav-section-label">Workspace</div>
        <nav aria-label="Primary navigation" className="side-nav">
          <span className="sr-only" data-role-navigation-label>
            {roleLabel[role]} workspace navigation
          </span>
          {groups[role].map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                className={({ isActive }) =>
                  `nav-link ${isActive ? 'is-active' : ''}`
                }
                end={item.to === '/'}
                key={item.to}
                onClick={onClose}
                to={item.to}
              >
                <Icon aria-hidden="true" />
                <span>{item.label}</span>
              </NavLink>
            );
          })}
        </nav>
        <div className="sidebar-spacer" />
        <div className="sidebar-footer">
          <ShieldMark />
          <span>Private evaluation workspace</span>
        </div>
      </aside>
    </>
  );
}

function ShieldMark() {
  return <span aria-hidden="true" className="sidebar-footer-mark" />;
}
