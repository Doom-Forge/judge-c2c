import { z } from "zod";
import { boundedBody } from "./security";
import type { ConsoleSession } from "./console-identities";
import type { Env } from "./env";

const announcementInput = z
	.object({
		title: z.string().trim().min(1).max(120),
		body: z.string().trim().min(1).max(5000),
	})
	.strict();
const json = (value: unknown, status = 200) =>
	Response.json(value, {
		status,
		headers: { "cache-control": "no-store" },
	});

export async function roundTwoAnnouncements(
	request: Request,
	env: Env,
	session: ConsoleSession,
) {
	const db = env.ORG_DB;
	if (!db) return json({ error: "ORGANIZATION_NOT_CONFIGURED" }, 503);
	const url = new URL(request.url);
	if (request.method === "GET" && url.pathname === "/api/organization/announcements") {
		if (!["organizer", "judge", "participant"].includes(session.role)) {
			return json({ error: "ANNOUNCEMENT_ACCESS_REQUIRED" }, 403);
		}
		if (session.role === "participant") {
			const team = session.team_id
				? await db
					.prepare("SELECT id FROM teams WHERE id=? AND status='ACTIVE' AND hackathon_id='initial'")
					.bind(session.team_id)
					.first()
				: null;
			if (!team) return json({ error: "PARTICIPANT_REQUIRED" }, 403);
		}
		const rows = await db
			.prepare("SELECT id,title,body,created_by,created_at FROM round_two_announcements ORDER BY created_at DESC,id DESC LIMIT 100")
			.all<{
				id: string;
				title: string;
				body: string;
				created_by: string;
				created_at: string;
			}>();
		return json({
			announcements: rows.results.map((row) => ({
				id: row.id,
				title: row.title,
				body: row.body,
				createdAt: row.created_at,
			})),
		});
	}
	if (request.method === "POST" && url.pathname === "/api/organization/announcements") {
		if (session.role !== "organizer") {
			return json({ error: "ORGANIZER_REQUIRED" }, 403);
		}
		let raw: unknown;
		try {
			raw = JSON.parse(new TextDecoder().decode(await boundedBody(request, 6000)));
		} catch {
			return json({ error: "INVALID_INPUT" }, 400);
		}
		const parsed = announcementInput.safeParse(raw);
		if (!parsed.success) return json({ error: "INVALID_INPUT" }, 400);
		const id = crypto.randomUUID();
		const actor = "organizer:" + (session.identity_id ?? session.hash);
		const created = await db.batch([
			db.prepare("INSERT INTO round_two_announcements(id,title,body,created_by) VALUES(?,?,?,?)")
				.bind(id, parsed.data.title, parsed.data.body, actor),
			db.prepare("INSERT INTO audit(action,entity,actor,changes) VALUES('round_two.announcement.created',?,?,?)")
				.bind(id, actor, JSON.stringify({ title: parsed.data.title })),
		]);
		if (!created[0]?.meta.changes) return json({ error: "ANNOUNCEMENT_UNAVAILABLE" }, 503);
		return json({
			announcement: {
				id,
				title: parsed.data.title,
				body: parsed.data.body,
				createdAt: new Date().toISOString(),
			},
		}, 201);
	}
	return json({ error: "NOT_FOUND" }, 404);
}
