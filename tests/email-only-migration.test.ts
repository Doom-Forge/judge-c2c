import { afterEach, describe, expect, it } from "vitest";
import { Miniflare } from "./miniflare";
import { migrate, migrationFiles } from "./database";

describe("email-only team member migration", () => {
	it("preserves member links, assignments, and review history while allowing unlinked roster rows", async () => {
		const mf = new Miniflare({
			modules: true,
			script: 'export default{fetch(){return new Response("ok")}}',
			d1Databases: ["ORG_DB"],
			compatibilityDate: "2026-08-01",
		});
		try {
			const db = (await mf.getD1Database("ORG_DB")) as unknown as D1Database;
			const beforeEmailOnly = migrationFiles.slice(
				0,
				migrationFiles.indexOf("0044_email_only_team_members.sql"),
			);
			await migrate(db, beforeEmailOnly);
			await db.prepare("UPDATE hackathons SET status='ACTIVE' WHERE id='initial'").run();
			await db.prepare("INSERT INTO teams(id,name) VALUES('legacy-team','Legacy team')").run();
			await db.prepare(
				"INSERT INTO team_members(id,team_id,hackathon_id,github_id,github_login,display_name,email) VALUES('legacy-member','legacy-team','initial',1234,'legacy-gh','Legacy member','legacy@example.test')",
			).run();
			await db.prepare(
				"INSERT INTO console_identities(id,name,role,team_id,team_member_id,credential_hash) VALUES('legacy-participant','Legacy member','participant','legacy-team','legacy-member',?)",
			).bind("a".repeat(64)).run();
			await db.prepare(
				"INSERT INTO console_identities(id,name,role,credential_hash) VALUES('legacy-judge','Legacy judge','judge',?)",
			).bind("b".repeat(64)).run();
			await db.prepare(
				"INSERT INTO round_two_judge_assignments(id,judge_identity_id,team_id,assigned_by) VALUES('legacy-assignment','legacy-judge','legacy-team','organizer:test')",
			).run();
			await db.prepare(
				"INSERT INTO round_two_review_submissions(id,team_id,judge_identity_id,stage,revision,score,payload,document_id,reason) VALUES('legacy-review','legacy-team','legacy-judge','ANALYSIS',1,80,'{}',NULL,'Review before roster migration')",
			).run();

			await migrate(db, ["0044_email_only_team_members.sql"]);
			const linked = await db.prepare(
				"SELECT i.team_member_id,m.github_id,m.github_login,m.email FROM console_identities i JOIN team_members m ON m.id=i.team_member_id WHERE i.id='legacy-participant'",
			).first();
			const history = await db.prepare(
				"SELECT r.id,a.id AS assignment_id FROM round_two_review_submissions r JOIN round_two_judge_assignments a ON a.id='legacy-assignment' WHERE r.id='legacy-review'",
			).first();
			expect(linked).toEqual({
				team_member_id: "legacy-member",
				github_id: 1234,
				github_login: "legacy-gh",
				email: "legacy@example.test",
			});
			expect(history).toEqual({ id: "legacy-review", assignment_id: "legacy-assignment" });
			await db.prepare(
				"INSERT INTO team_roster_members(id,team_id,hackathon_id,display_name,email) VALUES('email-only-member','legacy-team','initial','Email only','new@example.test')",
			).run();
			expect(
				await db.prepare("PRAGMA foreign_key_check").all(),
			).toMatchObject({ results: [] });
		} finally {
			await mf.dispose();
		}
	});
});
