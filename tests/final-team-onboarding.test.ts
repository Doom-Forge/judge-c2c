import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "./miniflare";
import { migrate } from "./database";
import { importTeams } from "../src/competition-teams";
import { dispatchTeamInvitations, requestParticipantLoginCode, teamAccessKey, verifyParticipant } from "../src/team-invitations";
import { participantConsole } from "../src/console-identities";
import type { CompetitionServices } from "../src/competition-store";
import type { Env } from "../src/env";

let mf: Miniflare;
let env: Env;
let db: D1Database;
const messages: Array<{ to: string; body: string }> = [];
const services = { client: async () => { throw new Error("Email-only imports must not call GitHub."); } } as unknown as CompetitionServices;

beforeEach(async () => {
  messages.length = 0;
  mf = new Miniflare({ modules: true, script: "export default{}", d1Databases: ["ORG_DB"], compatibilityDate: "2026-08-01" });
  db = (await mf.getD1Database("ORG_DB")) as unknown as D1Database;
  await migrate(db);
  env = { ORG_DB: db, ORG_VAULT_KEY: "12".repeat(32), ORG_NAME: "Doomforge", ORG_PUBLIC_ORIGIN: "https://judge.test", TEAM_EMAIL_SENDER: { fetch: async (request: RequestInfo | URL) => { const payload = await new Request(request).json() as { to: string; body: string }; messages.push(payload); return Response.json({ accepted: true }); } } as Fetcher } as Env;
  await importTeams(env, services, "organizer:test", { csv: "team_name,participant_name,email,team_lead_email,team_status\nAlpha,Alice,alice@example.test,lead@example.test,ACTIVE\nAlpha,Bob,bob@example.test,lead@example.test,ACTIVE", commit: true });
  await db.prepare("INSERT INTO github_repositories(id,full_name,private,default_branch) VALUES(11,'Doom-Forge/mazhai-cover',0,'main'),(12,'Doom-Forge/pricingpulse',0,'main'),(13,'Doom-Forge/veera-footwear',0,'main'),(14,'Doom-Forge/janus',0,'main')").run();
});
afterEach(async () => mf.dispose());

const otp = () => messages.at(-1)?.body.match(/[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}/)?.[0] ?? "";

it("requires a finalized team key for each member OTP and login, while the lead uses email OTP", async () => {
  const team = await db.prepare("SELECT id FROM teams WHERE name='Alpha'").first<{ id: string }>();
  expect(team).toBeTruthy();
  const originalSender = env.TEAM_EMAIL_SENDER;
  const initialDispatch: Array<{ to: string; body: string }> = [];
  env.TEAM_EMAIL_SENDER = { fetch: async (request: RequestInfo | URL) => { initialDispatch.push(await new Request(request).json() as { to: string; body: string }); return Response.json({ accepted: true }); } } as Fetcher;
  await dispatchTeamInvitations(env);
  expect(initialDispatch[0]?.body).not.toMatch(/[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}/);
  env.TEAM_EMAIL_SENDER = originalSender;

  const leadRequest = await requestParticipantLoginCode(env, "lead@example.test", Date.now(), "lead-ip");
  expect(leadRequest.status).toBe(202);
  const leadLogin = await verifyParticipant(env, "lead@example.test", otp(), new Date().toISOString(), "lead-ip");
  expect(leadLogin).toMatchObject({ status: 200, participant: { isTeamLead: true, trackSelected: false } });
  const leadSession = { hash: "", role: "participant" as const, identity_id: leadLogin.identityId!, name: "Team Lead", team_id: team!.id };
  const leadKeyBeforeTrack = await participantConsole(new Request("https://judge.test/api/organization/participant/team-key"), env, leadSession);
  expect(leadKeyBeforeTrack.status).toBe(403);
  const leadDashboardBeforeTrack = await participantConsole(new Request("https://judge.test/api/organization/participant"), env, leadSession);
  expect(leadDashboardBeforeTrack.status).toBe(428);
  const choose = (repositoryId: number) => participantConsole(new Request("https://judge.test/api/organization/participant/track", { method: "POST", body: JSON.stringify({ repositoryId }) }), env, leadSession);
  expect([ (await choose(11)).status, await db.prepare("SELECT track_finalized FROM teams WHERE id=?").bind(team!.id).first() ]).toEqual([200, { track_finalized: 1 }]);
  expect((await choose(12)).status).toBe(409);

  const memberWithoutKey = await requestParticipantLoginCode(env, "alice@example.test", Date.now(), "member-ip");
  expect(memberWithoutKey).toEqual({ status: 202 });
  expect(messages).toHaveLength(1);

  const key = await teamAccessKey(env, team!.id);
  expect(key).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}$/);
  expect(await requestParticipantLoginCode(env, "alice@example.test", Date.now(), "member-ip", "WRONGKEY0000")).toEqual({ status: 202 });
  expect(messages).toHaveLength(1);
  await requestParticipantLoginCode(env, "alice@example.test", Date.now(), "member-ip", key!);
  const memberCode = otp();
  expect(await verifyParticipant(env, "alice@example.test", memberCode, new Date().toISOString(), "member-ip", "WRONGKEY0000")).toMatchObject({ status: 401 });
  const memberLogin = await verifyParticipant(env, "alice@example.test", memberCode, new Date().toISOString(), "member-ip", key!);
  expect(memberLogin).toMatchObject({ status: 200, participant: { isTeamLead: false, trackSelected: true } });
  const memberSession = { hash: "", role: "participant" as const, identity_id: memberLogin.identityId!, name: "Alice", team_id: team!.id };
  const memberDashboardBeforeGithub = await participantConsole(new Request("https://judge.test/api/organization/participant"), env, memberSession);
  expect(memberDashboardBeforeGithub.status).toBe(428);
  const memberTrackAttempt = await participantConsole(new Request("https://judge.test/api/organization/participant/track", { method: "POST", body: JSON.stringify({ repositoryId: 12 }) }), env, memberSession);
  expect(memberTrackAttempt.status).toBe(403);

  const repeatWindow = Date.now() + 900_001;
  await requestParticipantLoginCode(env, "alice@example.test", repeatWindow, "member-ip", key!);
  const repeatCode = otp();
  const repeatTime = new Date(repeatWindow + 1_000).toISOString();
  const missingKeyLogin = await verifyParticipant(env, "alice@example.test", repeatCode, repeatTime, "member-ip");
  expect(missingKeyLogin).toMatchObject({ status: 401 });
  expect(await db.prepare("SELECT used_at FROM participant_email_login_codes WHERE email=?").bind("alice@example.test").first()).toEqual({ used_at: null });
  expect(await verifyParticipant(env, "alice@example.test", repeatCode, repeatTime, "member-ip", key!)).toMatchObject({ status: 200 });

  await expect(db.prepare("UPDATE team_repositories SET active=0 WHERE team_id=?").bind(team!.id).run()).rejects.toThrow(/TEAM_TRACK_FINALIZED/);
});
