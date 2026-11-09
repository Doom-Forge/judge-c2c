import { useState, type FormEvent } from 'react';
import { AlertCircle, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { Session } from '@/types/session';

export function SessionNotice({
  session,
  onSignIn,
  onParticipantVerify,
  signInError,
}: {
  readonly session: Exclude<Session, { kind: 'live' }>;
  readonly onSignIn: (token: string) => Promise<boolean>;
  readonly onParticipantVerify: (email: string, code: string) => Promise<boolean>;
  readonly signInError: string | null;
}) {
  const [token, setToken] = useState('');
  const [participantMode, setParticipantMode] = useState(false);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [signingIn, setSigningIn] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSigningIn(true);
    try {
      if (await onSignIn(token)) setToken('');
    } finally {
      setSigningIn(false);
    }
  }

  async function submitParticipant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSigningIn(true);
    try {
      if (await onParticipantVerify(email, code)) {
        setEmail('');
        setCode('');
      }
    } finally {
      setSigningIn(false);
    }
  }

  if (session.kind === 'unconfigured') {
    return (
      <main className="session-page" role="status">
        <TriangleAlert aria-hidden="true" />
        <h1>Organization workspace unavailable</h1>
        <p>The Worker returned ORGANIZATION_NOT_CONFIGURED. Live records are not available until the organization service is configured.</p>
      </main>
    );
  }

  return (
    <main className="session-page">
      <section className="session-login-card">
        <AlertCircle aria-hidden="true" />
        <h1>Sign in to Doomforge</h1>
        <p>{session.kind === 'signed-out' ? 'Use your organization access code to open the workspace authorized for your role.' : session.kind === 'unavailable' ? `The organization session could not be checked. ${session.message}` : 'The organization session is unavailable.'}</p>
        {participantMode ? <form className="session-login" onSubmit={(event) => void submitParticipant(event)}>
          <label htmlFor="participant-email">Team email</label>
          <input autoComplete="email" id="participant-email" onChange={(event) => setEmail(event.currentTarget.value)} required type="email" value={email} />
          <label htmlFor="participant-code">Email verification code</label>
          <input autoComplete="one-time-code" id="participant-code" onChange={(event) => setCode(event.currentTarget.value)} required type="text" value={code} />
          {signInError && <p role="alert">{signInError}</p>}
          <Button disabled={signingIn} size="sm" type="submit" variant="primary">{signingIn ? 'Verifying…' : 'Verify email'}</Button>
          <p className="text-xs text-[var(--muted)]">Email verification activates this team member’s account and opens an eight-hour session.</p>
          <a className="session-mode-toggle" href="/api/auth/github" onClick={() => sessionStorage.setItem('doomforge.participant-github-login', 'pending')}>Returning participant? Continue with GitHub</a>
          <button className="session-mode-toggle" onClick={() => setParticipantMode(false)} type="button">Organization sign in</button>
        </form> : <form className="session-login" onSubmit={(event) => void submit(event)}>
          <label htmlFor="organization-access-code">Organization access code</label>
          <input autoComplete="current-password" id="organization-access-code" onChange={(event) => setToken(event.currentTarget.value)} required type="password" value={token} />
          {(signInError || session.kind === 'unavailable') && <p role="alert">{signInError ?? (session.kind === 'unavailable' ? session.message : '')}</p>}
          <Button disabled={signingIn} size="sm" type="submit" variant="primary">{signingIn ? 'Signing in…' : 'Sign in'}</Button>
          <button className="session-mode-toggle" onClick={() => setParticipantMode(true)} type="button">Participant sign in</button>
        </form>
        }
      </section>
    </main>
  );
}
