import { afterEach, expect, it, vi } from "vitest";
import { MailIdempotency, fetch as sendMail } from "../src/spacemail-sender";
import { setSocketFactory } from "./fixtures/cloudflare-sockets";

type RecordValue = { requestHash: string; state: string; token: string; updatedAt: number };
class StorageFixture {
	values = new Map<string, unknown>();
	async get<T>(key: string) { return this.values.get(key) as T | undefined; }
	async put(key: string, value: unknown) { this.values.set(key, value); }
}
function senderEnv(replies: string[]) {
	const storage = new StorageFixture();
	const state = {
		storage,
		blockConcurrencyWhile: async <T>(callback: () => Promise<T>) => callback(),
	} as unknown as DurableObjectState;
	const object = new MailIdempotency(state, {} as never);
	let sends = 0;
	let written = "";
	setSocketFactory(() => {
		sends++;
		const readable = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(replies.join("\r\n") + "\r\n"));
				controller.close();
			},
		});
		const writable = new WritableStream<Uint8Array>({
			write(chunk) { written += new TextDecoder().decode(chunk); },
		});
		return { opened: Promise.resolve(undefined as never), readable, writable, close() {} };
	});
	const env = {
		SPACEMAIL_SMTP_PASSWORD: "test-secret-password",
		MAIL_IDEMPOTENCY: {
			idFromName: (name: string) => name,
			get: () => ({ fetch: (input: RequestInfo | URL, init?: RequestInit) => object.fetch(input instanceof Request ? input : new Request(input, init)) }),
		},
	} as never;
	return { env, storage, get sends() { return sends; }, get written() { return written; } };
}
const smtpReplies = [
	"220 mail ready",
	"250-mail ready", "250 AUTH LOGIN",
	"334 username", "334 password", "235 authenticated",
	"250 sender accepted", "251 recipient accepted", "354 send mail",
	"250 message accepted", "221 goodbye",
];
function request(idempotencyKey: string, payload = { to: "person@example.com", subject: "Your DOOMFORGE code", body: "Your code is 123456.\n.If this was not you, ignore." }) {
	return new Request("https://team-email-sender.internal/send", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ idempotencyKey, ...payload }),
	});
}
afterEach(() => { setSocketFactory(undefined); vi.restoreAllMocks(); });

it("sends privately through implicit TLS and returns a stable duplicate result", async () => {
	const fixture = senderEnv(smtpReplies);
	const first = await sendMail(request("daily:team-1"), fixture.env);
	expect(first.status).toBe(200);
	expect(await first.json()).toEqual({ accepted: true, duplicate: false });
	expect(fixture.sends).toBe(1);
	expect(fixture.written).toContain("MAIL FROM:<technical@180dcvitc.org>");
	expect(fixture.written).toContain("..If this was not you");
	expect(fixture.written).not.toContain("test-secret-password");
	const duplicate = await sendMail(request("daily:team-1"), fixture.env);
	expect(duplicate.status).toBe(200);
	expect(await duplicate.json()).toEqual({ accepted: true, duplicate: true });
	expect(fixture.sends).toBe(1);
	expect((await fixture.storage.get<RecordValue>("delivery"))?.state).toBe("SENT");
});

it("rejects key reuse with different content before contacting SMTP", async () => {
	const fixture = senderEnv(smtpReplies);
	await sendMail(request("same-key"), fixture.env);
	const response = await sendMail(request("same-key", { to: "other@example.com", subject: "Different", body: "different" }), fixture.env);
	expect(response.status).toBe(409);
	expect(await response.json()).toEqual({ error: "IDEMPOTENCY_CONFLICT" });
	expect(fixture.sends).toBe(1);
});

it("rejects header injection and malformed addresses before opening SMTP", async () => {
	const fixture = senderEnv(smtpReplies);
	const response = await sendMail(request("bad-key", { to: "person@example.com\r\nBcc: attacker@example.com", subject: "Hi", body: "hello" }), fixture.env);
	expect(response.status).toBe(400);
	expect(fixture.sends).toBe(0);
	const scalar = await sendMail(new Request("https://team-email-sender.internal/send", { method: "POST", body: "null" }), fixture.env);
	expect(scalar.status).toBe(400);
});

it("does not automatically retry an uncertain SMTP delivery", async () => {
	const fixture = senderEnv(["220 ready", "250 hello", "334 user", "334 pass", "235 ok", "250 sender", "250 recipient", "354 data"]);
	const response = await sendMail(request("uncertain"), fixture.env);
	expect(response.status).toBe(409);
	expect(await response.json()).toEqual({ error: "DELIVERY_STATE_UNKNOWN" });
	const retry = await sendMail(request("uncertain"), fixture.env);
	expect(retry.status).toBe(409);
	expect(await retry.json()).toEqual({ error: "DELIVERY_STATE_UNKNOWN" });
	expect(fixture.sends).toBe(1);
});

it("logs only the SMTP failure stage and numeric response, then blocks permanent auth retries", async () => {
	const fixture = senderEnv([
		"220 mail ready",
		"250-mail ready", "250 AUTH LOGIN",
		"334 username", "334 password", "535 authentication rejected",
	]);
	const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
	const response = await sendMail(request("private-key-otp-123", {
		to: "person@example.com",
		subject: "Your login code",
		body: "The private one-time code is 908172.",
	}), fixture.env);
	expect(response.status).toBe(409);
	expect(await response.json()).toEqual({ error: "SMTP_DELIVERY_FAILED_PERMANENT" });
	expect(log).toHaveBeenCalledTimes(1);
	const line = String(log.mock.calls[0]?.[0]);
	expect(JSON.parse(line)).toEqual({ event: "spacemail.smtp.failure", stage: "auth_password", smtpCode: 535 });
	for (const secret of ["test-secret-password", "person@example.com", "908172", "private-key-otp-123"]) {
		expect(line).not.toContain(secret);
	}
	const retry = await sendMail(request("private-key-otp-123", {
		to: "person@example.com",
		subject: "Your login code",
		body: "The private one-time code is 908172.",
	}), fixture.env);
	expect(retry.status).toBe(409);
	expect(fixture.sends).toBe(1);
});

it("sanitizes Durable Object failures without logging request or exception data", async () => {
	const fixture = senderEnv(smtpReplies);
	const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
	const env = {
		SPACEMAIL_SMTP_PASSWORD: "test-secret-password",
		MAIL_IDEMPOTENCY: {
			idFromName: () => ({}),
			get: () => ({ fetch: async () => { throw new Error("sensitive request data"); } }),
		},
	} as never;
	const response = await sendMail(request("private-idempotency-key"), env);
	expect(response.status).toBe(503);
	const line = String(log.mock.calls[0]?.[0]);
	expect(JSON.parse(line)).toEqual({ event: "spacemail.smtp.failure", stage: "idempotency_claim" });
	expect(line).not.toContain("sensitive request data");
	expect(line).not.toContain("private-idempotency-key");
	expect(fixture.sends).toBe(0);
});
