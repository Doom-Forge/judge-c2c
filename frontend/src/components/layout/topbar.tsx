import { LogOut, Menu } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import type { Role, Session } from '@/types/session';

type TopbarProps = {
  readonly role: Role;
  readonly session: Extract<Session, { kind: 'live' }>;
  readonly onOpenMenu: () => void;
  readonly onLogout: () => void;
};
const titles: Readonly<Record<string, string>> = {
  '/': 'Overview',
  '/teams': 'Teams',
  '/assignments': 'Assignments',
  '/deadlines': 'Deadlines',
  '/communications': 'Communications',
  '/results': 'Results',
  '/repositories': 'Repositories',
  '/rubrics': 'Rubrics',
  '/queue': 'My queue',
  '/workspace': 'Review workspace',
  '/history': 'Review history',
  '/submission': 'My submission',
  '/evaluation': 'Evaluation',
};
const roleNames: Readonly<Record<Role, string>> = {
  organizer: 'Organizer',
  judge: 'Judge',
  participant: 'Participant',
};

export function Topbar({ role, session, onOpenMenu, onLogout }: TopbarProps) {
  const location = useLocation();
  const pageTitle = titles[location.pathname] ?? 'Overview';
  const personName = session.status.identity.name || 'Organization workspace';
  const initials = personName.split(' ').filter(Boolean).map((part) => part[0]).join('').slice(0, 2).toUpperCase();

  return (
    <header className="topbar">
      <div className="topbar-start">
        <Button aria-label="Open navigation" className="mobile-menu" onClick={onOpenMenu} variant="ghost">
          <Menu data-icon="inline-start" />
        </Button>
        <div className="breadcrumbs" aria-label="Breadcrumb">
          <Link to="/">Workspace</Link>
          <span aria-hidden="true">/</span>
          <strong>{pageTitle}</strong>
        </div>
      </div>
      <div className="topbar-actions">
        <span className="live-session-label"><span aria-hidden="true" /> Live session</span>
        <Button aria-label="Sign out" className="logout-button" onClick={onLogout} title="Sign out" variant="ghost">
          <LogOut data-icon="inline-start" />
          <span>Sign out</span>
        </Button>
        <div className="account-identity" aria-label={`${personName}, ${roleNames[role]}`}>
          <span aria-hidden="true" className="account-avatar">{initials}</span>
          <span className="account-copy"><strong>{personName}</strong><small>{roleNames[role]}</small></span>
        </div>
      </div>
    </header>
  );
}
