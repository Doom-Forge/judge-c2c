import { connect } from "cloudflare:sockets";
import { DurableObject } from "cloudflare:workers";

const SENDER = "technical@180dcvitc.org";
const SMTP_HOST = "mail.spacemail.com";
const SMTP_PORT = 465;
const MAX_REQUEST_BYTES = 20_000;
const MAX_BODY_LENGTH = 12_000;
const RESPONSE_TIMEOUT_MS = 8_000;
const DELIVERY_TIMEOUT_MS = 30_000;
const IN_FLIGHT_TTL_MS = 15 * 60_000;

interface Env {
	SPACEMAIL_SMTP_PASSWORD?: string;
	MAIL_IDEMPOTENCY: DurableObjectNamespace<MailIdempotency>;
}

type StoredDelivery = {
	requestHash: string;
	state: "SENDING" | "SENT" | "FAILED_RETRYABLE" | "FAILED_PERMANENT" | "UNKNOWN";
	token: string;
	updatedAt: number;
};
type FailureStage = "connect" | "greeting" | "ehlo" | "auth_login" | "auth_username" | "auth_password" | "mail_from" | "rcpt_to" | "data_command" | "data_write" | "data_reply" | "quit" | "idempotency_claim" | "idempotency_finish";
function reportFailure(stage: FailureStage, smtpCode?: number) {
	console.error(JSON.stringify({
		event: "spacemail.smtp.failure",
		stage,
		...(Number.isInteger(smtpCode) && smtpCode! >= 100 && smtpCode! <= 599 ? { smtpCode } : {}),
	}));
}

const json = (data: unknown, status = 200) => Response.json(data, {
	status,
	headers: { "cache-control": "no-store" },
});
const hex = (value: ArrayBuffer) => Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
async function hash(value: string) {
	return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}
function validAddress(value: string) {
	return value.length <= 254 && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(value);
}
function validHeader(value: string, maximum: number) {
	return value.length > 0 && value.length <= maximum && !/[\r\n\x00-\x1f\x7f]/.test(value);
}
function validBody(value: string) {
	return value.length > 0 && value.length <= MAX_BODY_LENGTH && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
}

export class MailIdempotency extends DurableObject<Env> {
	async fetch(request: Request) {
		const url = new URL(request.url);
		if (request.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
		let input: Record<string, unknown>;
		try { input = await request.json() as Record<string, unknown>; } catch { return json({ error: "INVALID_REQUEST" }, 400); }
		if (url.pathname === "/claim") {
			if (typeof input.requestHash !== "string" || !/^[a-f0-9]{64}$/.test(input.requestHash) || typeof input.token !== "string") return json({ error: "INVALID_REQUEST" }, 400);
			const requestHash = input.requestHash as string;
			const token = input.token as string;
			return this.ctx.blockConcurrencyWhile(async () => {
				const current = await this.ctx.storage.get<StoredDelivery>("delivery");
				if (current && current.requestHash !== requestHash) return json({ error: "IDEMPOTENCY_CONFLICT" }, 409);
				if (current?.state === "SENT") return json({ state: "SENT" });
				if (current?.state === "FAILED_PERMANENT") return json({ error: "DELIVERY_FAILED_PERMANENT" }, 409);
				if (current?.state === "UNKNOWN") return json({ error: "DELIVERY_STATE_UNKNOWN" }, 409);
				if (current?.state === "SENDING") {
					const state = Date.now() - current.updatedAt > IN_FLIGHT_TTL_MS ? "UNKNOWN" : "SENDING";
					if (state === "UNKNOWN") await this.ctx.storage.put("delivery", { ...current, state, token: "", updatedAt: Date.now() } satisfies StoredDelivery);
					return json({ error: state === "UNKNOWN" ? "DELIVERY_STATE_UNKNOWN" : "DELIVERY_IN_PROGRESS" }, 409);
				}
				await this.ctx.storage.put("delivery", {
					requestHash,
					state: "SENDING",
					token,
					updatedAt: Date.now(),
				} satisfies StoredDelivery);
				return json({ state: "CLAIMED" });
			});
		}
		if (url.pathname === "/finish") {
			if (!/^[a-f0-9]{64}$/.test(String(input.requestHash ?? "")) || typeof input.token !== "string" || !["SENT", "FAILED_RETRYABLE", "FAILED_PERMANENT", "UNKNOWN"].includes(String(input.state))) return json({ error: "INVALID_REQUEST" }, 400);
			return this.ctx.blockConcurrencyWhile(async () => {
				const current = await this.ctx.storage.get<StoredDelivery>("delivery");
				if (!current || current.requestHash !== input.requestHash || current.token !== input.token || current.state !== "SENDING") return json({ error: "DELIVERY_CLAIM_LOST" }, 409);
				await this.ctx.storage.put("delivery", { ...current, state: input.state as StoredDelivery["state"], token: "", updatedAt: Date.now() } satisfies StoredDelivery);
				return json({ state: input.state });
			});
		}
		return json({ error: "NOT_FOUND" }, 404);
	}
}

class SmtpError extends Error {
	constructor(readonly retryable: boolean, readonly stage: FailureStage, readonly smtpCode?: number) { super("SMTP delivery failed"); }
}
function timeout<T>(operation: Promise<T>, milliseconds: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		operation,
		new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); }),
	]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
}
function base64(value: string) {
	const bytes = new TextEncoder().encode(value);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

async function sendSmtp(env: Env, to: string, subject: string, body: string) {
	const password = env.SPACEMAIL_SMTP_PASSWORD;
	if (!password || password.length > 1024) throw new SmtpError(false, "auth_password");
	let socket: ReturnType<typeof connect> | undefined;
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
	let buffered = "";
	let bodyMayHaveBeenAccepted = false;
	let stage: FailureStage = "connect";
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	const deadline = Date.now() + DELIVERY_TIMEOUT_MS;
	const remaining = () => Math.max(1, Math.min(RESPONSE_TIMEOUT_MS, deadline - Date.now()));
	try {
		socket = connect({ hostname: SMTP_HOST, port: SMTP_PORT }, { secureTransport: "on", allowHalfOpen: false });
		await timeout(socket.opened, remaining(), "SMTP timeout");
		reader = socket.readable.getReader();
		writer = socket.writable.getWriter();
		const readReply = async () => {
			let replyCode = 0;
			const lines: string[] = [];
			while (true) {
				const end = buffered.indexOf("\n");
				if (end < 0) {
					const part = await timeout(reader!.read(), remaining(), "SMTP timeout");
					if (part.done) throw new Error("SMTP disconnected");
					buffered += decoder.decode(part.value, { stream: true });
					if (buffered.length > 16_384) throw new Error("SMTP reply too large");
					continue;
				}
				const line = buffered.slice(0, end).replace(/\r$/, "");
				buffered = buffered.slice(end + 1);
				const match = /^(\d{3})([ -])/.exec(line);
				if (!match) throw new Error("Invalid SMTP reply");
				const code = Number(match[1]);
				if (replyCode && code !== replyCode) throw new Error("Inconsistent SMTP reply");
				replyCode = code;
				lines.push(line);
				if (lines.length > 20) throw new Error("SMTP reply has too many lines");
				if (match[2] === " ") return replyCode;
			}
		};
		const command = async (commandStage: FailureStage, value: string, accepted: number[]) => {
			stage = commandStage;
			await timeout(writer!.write(encoder.encode(value + "\r\n")), remaining(), "SMTP timeout");
			const code = await readReply();
			if (!accepted.includes(code)) throw new SmtpError(code >= 400 && code < 500, commandStage, code);
		};
		stage = "greeting";
		const greeting = await readReply();
		if (greeting !== 220) throw new SmtpError(greeting >= 400 && greeting < 500, "greeting", greeting);
		await command("ehlo", "EHLO doombot.180dcvitc.org", [250]);
		await command("auth_login", "AUTH LOGIN", [334]);
		await command("auth_username", base64(SENDER), [334]);
		await command("auth_password", base64(password), [235]);
		await command("mail_from", `MAIL FROM:<${SENDER}>`, [250]);
		await command("rcpt_to", `RCPT TO:<${to}>`, [250, 251]);
		await command("data_command", "DATA", [354]);
		const safeBody = body.replace(/^\./gm, "..");
		const encodedSubject = /^[\x20-\x7e]+$/.test(subject)
			? subject
			: `=?UTF-8?B?${base64(subject)}?=`;
		const message = [
			`From: DOOMFORGE <${SENDER}>`,
			`To: <${to}>`,
			`Subject: ${encodedSubject}`,
			"MIME-Version: 1.0",
			"Content-Type: text/plain; charset=UTF-8",
			"Content-Transfer-Encoding: 8bit",
			"",
			safeBody,
			".",
		].join("\r\n");
		bodyMayHaveBeenAccepted = true;
		stage = "data_write";
		await timeout(writer.write(encoder.encode(message + "\r\n")), remaining(), "SMTP timeout");
		stage = "data_reply";
		const accepted = await readReply();
		if (accepted !== 250) {
			bodyMayHaveBeenAccepted = false;
			throw new SmtpError(accepted >= 400 && accepted < 500, "data_reply", accepted);
		}
		bodyMayHaveBeenAccepted = false;
		try { await command("quit", "QUIT", [221]); } catch { /* The server already accepted the message. */ }
	} catch (error) {
		const failure = error instanceof SmtpError
			? error
			: new SmtpError(!bodyMayHaveBeenAccepted, stage);
		reportFailure(failure.stage, failure.smtpCode);
		throw failure;
	} finally {
		try { await reader?.cancel(); } catch { /* Close is best effort. */ }
		try { await writer?.close(); } catch { /* Close is best effort. */ }
		try { socket?.close(); } catch { /* Close is best effort. */ }
	}
}

export async function fetch(request: Request, env: Env) {
	if (request.method !== "POST" || new URL(request.url).pathname !== "/send") return json({ error: "NOT_FOUND" }, 404);
	const contentLength = Number(request.headers.get("content-length") ?? 0);
	if (contentLength > MAX_REQUEST_BYTES) return json({ error: "REQUEST_TOO_LARGE" }, 413);
	let bodyText: string;
	try {
		const reader = request.body?.getReader();
		if (!reader) return json({ error: "INVALID_REQUEST" }, 400);
		const chunks: Uint8Array[] = [];
		let size = 0;
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			size += chunk.value.byteLength;
			if (size > MAX_REQUEST_BYTES) { await reader.cancel(); return json({ error: "REQUEST_TOO_LARGE" }, 413); }
			chunks.push(chunk.value);
		}
		const all = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
		bodyText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(all);
	} catch { return json({ error: "INVALID_REQUEST" }, 400); }
	let parsedPayload: unknown;
	try { parsedPayload = JSON.parse(bodyText); } catch { return json({ error: "INVALID_REQUEST" }, 400); }
	if (!parsedPayload || typeof parsedPayload !== "object" || Array.isArray(parsedPayload)) return json({ error: "INVALID_REQUEST" }, 400);
	const payload = parsedPayload as Record<string, unknown>;
	const key = payload.idempotencyKey;
	const to = payload.to;
	const subject = payload.subject;
	const message = payload.body;
	if (typeof key !== "string" || !/^[A-Za-z0-9:_.-]{1,200}$/.test(key) || typeof to !== "string" || !validAddress(to) || typeof subject !== "string" || !validHeader(subject, 200) || typeof message !== "string" || !validBody(message)) return json({ error: "INVALID_EMAIL" }, 400);
	if (!env.SPACEMAIL_SMTP_PASSWORD) return json({ error: "SENDER_NOT_CONFIGURED" }, 503);
	const requestHash = await hash(JSON.stringify([to.toLowerCase(), subject, message]));
	const id = env.MAIL_IDEMPOTENCY.idFromName(await hash(key));
	const stub = env.MAIL_IDEMPOTENCY.get(id);
	const token = crypto.randomUUID();
	let claim: Response;
	try {
		claim = await stub.fetch("https://mail-idempotency.internal/claim", {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestHash, token }),
		});
	} catch {
		reportFailure("idempotency_claim");
		return json({ error: "IDEMPOTENCY_UNAVAILABLE" }, 503);
	}
	if (claim.status === 409) return json(await claim.json(), 409);
	if (!claim.ok) return json({ error: "IDEMPOTENCY_UNAVAILABLE" }, 503);
	const claimed = await claim.json() as { state?: string };
	if (claimed.state === "SENT") return json({ accepted: true, duplicate: true });
	if (claimed.state !== "CLAIMED") return json({ error: "IDEMPOTENCY_UNAVAILABLE" }, 503);
	let state: StoredDelivery["state"] = "SENT";
	try {
		await sendSmtp(env, to, subject, message);
	} catch (error) {
		state = error instanceof SmtpError
			? error.retryable ? "FAILED_RETRYABLE" : error.smtpCode ? "FAILED_PERMANENT" : "UNKNOWN"
			: "UNKNOWN";
	}
	let finish: Response;
	try {
		finish = await stub.fetch("https://mail-idempotency.internal/finish", {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestHash, token, state }),
		});
	} catch {
		reportFailure("idempotency_finish");
		return json({ error: "IDEMPOTENCY_UNAVAILABLE" }, 503);
	}
	if (!finish.ok) {
		reportFailure("idempotency_finish");
		return json({ error: "IDEMPOTENCY_UNAVAILABLE" }, 503);
	}
	if (state === "SENT") return json({ accepted: true, duplicate: false });
	return json({ error: state === "UNKNOWN" ? "DELIVERY_STATE_UNKNOWN" : state === "FAILED_PERMANENT" ? "SMTP_DELIVERY_FAILED_PERMANENT" : "SMTP_DELIVERY_FAILED" }, state === "UNKNOWN" || state === "FAILED_PERMANENT" ? 409 : 502);
}

export default { fetch };
