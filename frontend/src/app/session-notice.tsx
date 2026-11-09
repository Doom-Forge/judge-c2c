import { useState, type FormEvent } from 'react';
import { TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { Session } from '@/types/session';

export function SessionNotice({
  session,
  onSignIn,
  onParticipantVerify,
  onParticipantCodeRequest,
  onClearError,
  signInError,
}: {
  readonly session: Exclude<Session, { kind: 'live' }>;
  readonly onSignIn: (token: string) => Promise<boolean>;
  readonly onParticipantVerify: (email: string, code: string, teamKey?: string) => Promise<boolean>;
  readonly onParticipantCodeRequest: (email: string, teamKey?: string) => Promise<boolean>;
  readonly onClearError: () => void;
  readonly signInError: string | null;
}) {
  const [token, setToken] = useState('');
  const [participantMode, setParticipantMode] = useState(false);
  const [email, setEmail] = useState('');
  const [teamKey, setTeamKey] = useState('');
  const [code, setCode] = useState('');
  const [codeRequested, setCodeRequested] = useState(false);
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
      if (!codeRequested) {
        if (await onParticipantCodeRequest(email, teamKey.trim() || undefined)) setCodeRequested(true);
      } else if (await onParticipantVerify(email, code, teamKey.trim() || undefined)) {
        setEmail(''); setTeamKey(''); setCode(''); setCodeRequested(false);
      }
    } finally {
      setSigningIn(false);
    }
  }

  async function resendParticipantCode() {
    setSigningIn(true);
    try {
      await onParticipantCodeRequest(email, teamKey.trim() || undefined);
    } finally {
      setSigningIn(false);
    }
  }

  if (session.kind === 'unconfigured') {
    return (
      <main className="session-page session-unconfigured" role="status">
        <TriangleAlert aria-hidden="true" />
        <h1>Organization workspace unavailable</h1>
        <p>The Worker returned ORGANIZATION_NOT_CONFIGURED. Live records are not available until the organization service is configured.</p>
      </main>
    );
  }

  return (
    <main className="session-page">
      <section className="session-login-card" aria-labelledby="session-title" aria-describedby="session-intro">
        <div className="session-wordmark" aria-label="Doomforge">DOOMFORGE</div>
        <p className="session-kicker">Central judging platform</p>
        <h1 id="session-title">Sign in to Doomforge</h1>
        <p id="session-intro" className="session-intro">{participantMode ? 'Use your roster email. Team members also need the key shared by their lead.' : session.kind === 'signed-out' ? 'Use your organization access code to open the workspace authorized for your role.' : session.kind === 'unavailable' ? `The organization session could not be checked. ${session.message}` : 'The organization session is unavailable.'}</p>
        {participantMode ? <form className="session-login" onSubmit={(event) => void submitParticipant(event)}>
          <fieldset className="participant-signin-step" disabled={signingIn || codeRequested}>
            <legend>1 · Identify your team</legend>
            <label htmlFor="participant-email">Email on the team roster</label>
            <input autoComplete="email" id="participant-email" onChange={(event) => { setEmail(event.currentTarget.value); setCodeRequested(false); setCode(''); onClearError(); }} required type="email" value={email} />
            <label htmlFor="participant-team-key">Team key <span>(members only)</span></label>
            <input autoComplete="off" id="participant-team-key" onChange={(event) => setTeamKey(event.currentTarget.value.trim())} placeholder="Leave blank if you are the team lead" type="password" value={teamKey} />
          </fieldset>
          {codeRequested && <><label htmlFor="participant-code">Email verification code</label>
          <fieldset className="participant-signin-step"><legend>2 · Verify your email</legend><input autoComplete="one-time-code" id="participant-code" onChange={(event) => setCode(event.currentTarget.value.toUpperCase())} required type="text" value={code} /></fieldset></>}
          {signInError && <p role="alert">{signInError}</p>}
          <Button className="session-submit" disabled={signingIn} size="sm" type="submit" variant="primary">{signingIn ? (codeRequested ? 'Verifying…' : 'Sending…') : (codeRequested ? 'Verify and sign in' : 'Email me a sign-in code')}</Button>
          {codeRequested ? <><p className="text-xs text-[var(--muted)]">If the email and team key match your roster, a code is on its way. It expires after 10 minutes.</p><button className="session-mode-toggle" disabled={signingIn} onClick={() => void resendParticipantCode()} type="button">Resend code</button></> : <button className="session-mode-toggle" onClick={() => setCodeRequested(true)} type="button">I already have a code</button>}
          <button className="session-mode-toggle" onClick={() => { setParticipantMode(false); setCodeRequested(false); setCode(''); onClearError(); }} type="button">Organization sign in</button>
        </form> : <form className="session-login" onSubmit={(event) => void submit(event)}>
          <label htmlFor="organization-access-code">Organization access code</label>
          <input autoComplete="current-password" id="organization-access-code" onChange={(event) => setToken(event.currentTarget.value)} required type="password" value={token} />
          {(signInError || session.kind === 'unavailable') && <p role="alert">{signInError ?? (session.kind === 'unavailable' ? session.message : '')}</p>}
          <Button className="session-submit" disabled={signingIn} size="sm" type="submit" variant="primary">{signingIn ? 'Signing in…' : 'Sign in'}</Button>
          <button className="session-mode-toggle" onClick={() => { setParticipantMode(true); onClearError(); }} type="button">Participant sign in</button>
        </form>
        }
      </section>
    </main>
  );
}
