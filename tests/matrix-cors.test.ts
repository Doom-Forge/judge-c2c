import { expect, it } from "vitest";
import {
	isMatrixOriginAllowed,
	matrixPreflight,
	withMatrixCors,
} from "../src/matrix-cors";
const origin = "https://doomforge-matrix.example";
const env = {
	CORS_ALLOWED_ORIGINS: "https://arena.example,http://localhost:5173",
};
const req = (remote?: string, init: RequestInit = {}) =>
	new Request(origin + "/api/matrix/overview", {
		...init,
		headers: { ...(remote ? { Origin: remote } : {}), ...init.headers },
	});
it("allows same-origin and server requests while denying lookalike and null origins", () => {
	expect(isMatrixOriginAllowed(req(), env)).toBe(true);
	expect(isMatrixOriginAllowed(req(origin), env)).toBe(true);
	expect(isMatrixOriginAllowed(req("https://arena.example"), env)).toBe(true);
	expect(isMatrixOriginAllowed(req("http://localhost:5173"), env)).toBe(true);
	for (
		const remote of [
			"null",
			"https://arena.example.evil.test",
			"https://arena.example/path",
			"https://evil.test",
		]
	) {
		expect(isMatrixOriginAllowed(req(remote), env)).toBe(false);
	}
});
it("does not treat wildcards or malformed config values as trusted origins", () => {
	expect(
		isMatrixOriginAllowed(req("https://evil.test"), {
			CORS_ALLOWED_ORIGINS: "* , https://arena.example/path",
		}),
	).toBe(false);
});
it("responds to allowed bearer preflight without authenticating it or allowing cookies", () => {
	const r = matrixPreflight(
		req("https://arena.example", {
			method: "OPTIONS",
			headers: {
				"Access-Control-Request-Method": "POST",
				"Access-Control-Request-Headers": "authorization, content-type",
			},
		}),
		env,
	)!;
	expect(r.status).toBe(204);
	expect(r.headers.get("access-control-allow-origin")).toBe(
		"https://arena.example",
	);
	expect(r.headers.get("access-control-allow-methods")).toContain("POST");
	expect(r.headers.get("access-control-allow-headers")).toContain(
		"Authorization",
	);
	expect(r.headers.has("access-control-allow-credentials")).toBe(false);
	expect(r.headers.get("vary")).toContain("Origin");
});
it("rejects untrusted origin and unsupported preflight operations", () => {
	expect(
		matrixPreflight(req("https://evil.test", { method: "OPTIONS" }), env)
			?.status,
	).toBe(403);
	expect(
		matrixPreflight(
			req("https://arena.example", {
				method: "OPTIONS",
				headers: { "Access-Control-Request-Method": "DELETE" },
			}),
			env,
		)?.status,
	).toBe(405);
	expect(
		matrixPreflight(
			req("https://arena.example", {
				method: "OPTIONS",
				headers: {
					"Access-Control-Request-Method": "POST",
					"Access-Control-Request-Headers": "x-unexpected",
				},
			}),
			env,
		)?.status,
	).toBe(400);
	expect(matrixPreflight(req(), env)).toBeNull();
});
it("adds CORS to errors as well as successes and preserves existing Vary values", () => {
	for (const status of [200, 401, 403, 503]) {
		const r = withMatrixCors(
			req("https://arena.example"),
			env,
			new Response("value", {
				status,
				headers: { Vary: "Accept-Encoding" },
			}),
		);
		expect(r.status).toBe(status);
		expect(r.headers.get("access-control-allow-origin")).toBe(
			"https://arena.example",
		);
		expect(r.headers.get("vary")).toContain("Accept-Encoding");
		expect(r.headers.get("vary")).toContain("Origin");
	}
	const denied = withMatrixCors(
		req("https://evil.test"),
		env,
		new Response("value"),
	);
	expect(denied.headers.has("access-control-allow-origin")).toBe(false);
});

it("serves preflight before auth and applies CORS to unauthenticated API errors at the Worker boundary", async () => {
	const worker = (await import("../src/index")).default;
	const bindings = {
		...env,
		MATRIX_MODE: "true",
		ADMIN_TOKEN: "s".repeat(40),
	} as unknown as import("../src/env").Env;
	const context = { waitUntil() {} } as unknown as ExecutionContext;
	const preflight = await worker.fetch(
		req("https://arena.example", {
			method: "OPTIONS",
			headers: {
				"Access-Control-Request-Method": "GET",
				"Access-Control-Request-Headers": "authorization",
			},
		}),
		bindings,
		context,
	);
	expect(preflight.status).toBe(204);
	const unauthorized = await worker.fetch(
		req("https://arena.example"),
		bindings,
		context,
	);
	expect(unauthorized.status).toBe(401);
	expect(unauthorized.headers.get("access-control-allow-origin")).toBe(
		"https://arena.example",
	);
	const denied = await worker.fetch(
		req("https://evil.test", { method: "POST" }),
		bindings,
		context,
	);
	expect(denied.status).toBe(403);
	expect(denied.headers.has("access-control-allow-origin")).toBe(false);
});

it("preserves actionable matrix budget and capacity errors with cross-origin headers", async () => {
	const worker = (await import("../src/index")).default;
	for (
		const [code, status] of [
			["MATRIX_BUDGET_LIMIT", 429],
			["MATRIX_BUSY", 429],
			["MATRIX_INVALID_BUDGET_CONFIG", 503],
		] as const
	) {
		const bindings = {
			...env,
			MATRIX_MODE: "true",
			ADMIN_TOKEN: "s".repeat(40),
			DB: {
				prepare() {
					throw new Error(code);
				},
			},
		} as unknown as import("../src/env").Env;
		const request = new Request(origin + "/api/matrix/budget", {
			headers: {
				Origin: "https://arena.example",
				Authorization: "Bearer " + "s".repeat(40),
			},
		});
		const response = await worker.fetch(request, bindings, {
			waitUntil() {},
		} as unknown as ExecutionContext);
		expect(response.status).toBe(status);
		expect(((await response.json()) as { error: string }).error).toBe(code);
		expect(response.headers.get("access-control-allow-origin")).toBe(
			"https://arena.example",
		);
	}
});

it("routes organizer endpoints through Matrix mode and protects team management", async () => {
	const worker = (await import("../src/index")).default;
	const { migrate } = await import("./database");
	const { Miniflare } = await import("./miniflare");
	const mf = new Miniflare({
		modules: true,
		script: "export default{}",
		d1Databases: ["ORG_DB"],
		compatibilityDate: "2026-08-01",
	});
	try {
		const orgDb = await mf.getD1Database("ORG_DB");
		await migrate(orgDb as unknown as D1Database);
		const organizerToken = "organizer-route-token-" + "a".repeat(40);
		const bindings = {
			...env,
			MATRIX_MODE: "true",
			ORG_DB: orgDb,
			ORG_ADMIN_TOKEN: organizerToken,
			ORG_VAULT_KEY: "12".repeat(32),
			ORG_NAME: "Fixture",
			ORG_PUBLIC_ORIGIN: origin,
		} as unknown as import("../src/env").Env;
		const context = { waitUntil() {} } as unknown as ExecutionContext;
		const login = await worker.fetch(
			new Request(origin + "/api/organization/login", {
				method: "POST",
				headers: { origin, "content-type": "application/json" },
				body: JSON.stringify({ token: organizerToken }),
			}),
			bindings,
			context,
		);
		const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
		const setting = await worker.fetch(
			new Request(origin + "/api/organization/manage/team-email", {
				headers: { cookie },
			}),
			bindings,
			context,
		);
		expect(setting.status).toBe(200);
		const teams = await worker.fetch(
			new Request(origin + "/api/organization/manage/teams", {
				headers: { origin, cookie },
			}),
			bindings,
			context,
		);
		expect(teams.status).toBe(200);
		expect(teams.headers.get("access-control-allow-origin")).toBeNull();
		const judgeLogin = await worker.fetch(
			new Request(origin + "/api/organization/login", {
				method: "POST",
				headers: { origin, "content-type": "application/json" },
				body: JSON.stringify({
					token: "judge-route-token-" + "b".repeat(40),
				}),
			}),
			bindings,
			context,
		);
		expect(judgeLogin.status).toBe(401);
		const blocked = await worker.fetch(
			new Request(origin + "/api/organization/manage/teams"),
			bindings,
			context,
		);
		expect(blocked.status).toBe(401);
		expect(
			await worker.fetch(
				new Request(origin + "/api/runner/actions/status"),
				bindings,
				context,
			),
		).toHaveProperty("status", 404);
	} finally {
		await mf.dispose();
	}
});
