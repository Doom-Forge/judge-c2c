import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { ApiError, getOrganizationStatus, loginOrganization, logoutOrganization, requestParticipantCode, verifyParticipant } from "@/lib/api";
import { SessionNotice } from "@/app/session-notice";
import type { Role, Session } from "@/types/session";

const JudgeOverview = lazy(() => import("@/features/overview/judge-overview").then(({ JudgeOverview }) => ({ default: JudgeOverview })));
const ParticipantDashboard = lazy(() => import("@/features/participant/participant-dashboard").then(({ ParticipantDashboard }) => ({ default: ParticipantDashboard })));
const OrganizerCommandCenter = lazy(() => import("@/features/organizer/command-center").then(({ OrganizerCommandCenter }) => ({ default: OrganizerCommandCenter })));
const OrganizerResults = lazy(() => import("@/features/organizer/results/results").then(({ OrganizerResults }) => ({ default: OrganizerResults })));
const JudgeWorkspace = lazy(() => import("@/features/judge/judge-workspace").then(({ JudgeWorkspace }) => ({ default: JudgeWorkspace })));
const OrganizerTeamInspector = lazy(() => import("@/features/organizer/team-inspector").then(({ OrganizerTeamInspector }) => ({ default: OrganizerTeamInspector })));

function AccessState({ role, required }: { role: Role; required: Role }) {
	return (
		<main className="page-content">
			<h1>Access required</h1>
			<p role="status">This page is available to {required}s. Your current session is for a {role}.</p>
		</main>
	);
}

function Workspace() {
	const [session, setSession] = useState<Session>({ kind: "signed-out", organization: null });
	const [sessionReady, setSessionReady] = useState(false);
	const [sidebarOpen, setSidebarOpen] = useState(false);
	const [authError, setAuthError] = useState<string | null>(null);

	const refreshSession = useCallback(async () => {
		try {
			let status = await getOrganizationStatus();
			setSession(status.authenticated
				? { kind: "live", status }
				: { kind: "signed-out", organization: status.organization ?? null });
		} catch (error) {
			setSession(error instanceof ApiError && error.code === "ORGANIZATION_NOT_CONFIGURED"
				? { kind: "unconfigured" }
				: { kind: "unavailable", message: error instanceof Error ? error.message : "The status service returned an unknown error." });
		} finally {
			setSessionReady(true);
		}
	}, []);

	useEffect(() => { void refreshSession(); }, [refreshSession]);

	const signIn = useCallback(async (token: string): Promise<boolean> => {
		setAuthError(null);
		try {
			await loginOrganization(token);
			await refreshSession();
			return true;
		} catch (error) {
			setAuthError(error instanceof Error ? error.message : "Sign-in failed.");
			return false;
		}
	}, [refreshSession]);

	const participantVerify = useCallback(async (email: string, code: string, teamKey?: string): Promise<boolean> => {
		setAuthError(null);
		try {
			await verifyParticipant(email, code, teamKey);
			await refreshSession();
			return true;
		} catch (error) {
			setAuthError(error instanceof Error ? error.message : "Participant verification failed.");
			return false;
		}
	}, [refreshSession]);

	const participantCodeRequest = useCallback(async (email: string, teamKey?: string): Promise<boolean> => {
		setAuthError(null);
		try {
			await requestParticipantCode(email, teamKey);
			return true;
		} catch (error) {
			setAuthError(error instanceof ApiError && error.code === "PARTICIPANT_EMAIL_UNAVAILABLE"
				? "Email sign-in is temporarily unavailable. Contact the organizers to activate participant email delivery."
				: error instanceof ApiError && error.code === "VERIFICATION_RATE_LIMIT"
					? "Too many sign-in attempts. Wait a few minutes before requesting another code."
					: error instanceof Error ? error.message : "A sign-in code could not be sent.");
			return false;
		}
	}, []);

	const logout = useCallback(async () => {
		setAuthError(null);
		try {
			await logoutOrganization();
			await refreshSession();
		} catch (error) {
			setAuthError(error instanceof Error ? error.message : "Sign-out failed.");
		}
	}, [refreshSession]);

	const clearAuthError = useCallback(() => setAuthError(null), []);

	if (!sessionReady) {
		return <main className="session-page"><p role="status">Checking organization session…</p></main>;
	}
	if (session.kind !== "live") {
		return <SessionNotice onClearError={clearAuthError} onParticipantCodeRequest={participantCodeRequest} onParticipantVerify={participantVerify} onSignIn={signIn} session={session} signInError={authError} />;
	}

	const role = session.status.role;
	const denied = (required: Role) => <AccessState required={required} role={role} />;
	const org = (focus?: string) => role === "organizer"
		? <OrganizerCommandCenter focus={focus} session={session} />
		: denied("organizer");
	const queue = role === "judge" ? <JudgeOverview role="judge" /> : denied("judge");
	const participant = (view: "overview" | "submission" | "evaluation" = "overview") => role === "participant" ? <ParticipantDashboard view={view} /> : denied("participant");
	const workspace = role === "judge" ? <JudgeWorkspaceRoute /> : denied("judge");

	return (
		<div className="app-shell">
			<Sidebar onClose={() => setSidebarOpen(false)} open={sidebarOpen} role={role} />
			<div className="main-column">
				<Topbar onLogout={() => void logout()} onOpenMenu={() => setSidebarOpen(true)} role={role} session={session} />
				{authError && <div className="session-error" role="alert">{authError}</div>}
				<Suspense fallback={<div className="loading-indicator" role="status">Loading workspace…</div>}>
					<Routes>
						<Route element={role === "organizer" ? org() : role === "judge" ? queue : participant()} path="/" />
						<Route element={org("teams")} path="/teams" />
						<Route element={org("assignments")} path="/assignments" />
						<Route element={org("deadlines")} path="/deadlines" />
						<Route element={org("communications")} path="/communications" />
						<Route element={role === "organizer" ? <OrganizerResults /> : denied("organizer")} path="/results" />
						<Route element={org("rubrics")} path="/rubrics" />
						<Route element={role === "organizer" ? org("teams") : role === "judge" ? queue : denied("organizer")} path="/submissions" />
						<Route element={role === "organizer" ? org("assignments") : role === "judge" ? workspace : denied("organizer")} path="/reviews" />
						<Route element={queue} path="/queue" />
						<Route element={workspace} path="/workspace" />
						<Route element={workspace} path="/history" />
						<Route element={participant("submission")} path="/submission" />
						<Route element={participant("evaluation")} path="/evaluation" />
						<Route element={org("github")} path="/repositories" />
						<Route element={<Navigate replace to="/" />} path="*" />
						<Route element={role === "organizer" ? <OrganizerTeamInspector /> : denied("organizer")} path="/inspect/team/:teamId" />
						<Route element={role === "organizer" ? <JudgeWorkspaceRoute readOnly /> : denied("organizer")} path="/inspect/judge" />
					</Routes>
				</Suspense>
			</div>
		</div>
	);
}

function JudgeWorkspaceRoute({ readOnly = false }: { readOnly?: boolean }) {
	const location = useLocation();
	const initialTeamId = new URLSearchParams(location.search).get("teamId") ?? "";
	const reviewerIdentityId = new URLSearchParams(location.search).get("judgeIdentityId") ?? "";
	return <JudgeWorkspace initialTeamId={initialTeamId} reviewerIdentityId={reviewerIdentityId} readOnly={readOnly} />;
}

export function App() {
	return <BrowserRouter><Workspace /></BrowserRouter>;
}
