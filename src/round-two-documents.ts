import type { ConsoleSession } from "./console-identities";
import type { Env } from "./env";
import { boundedBody } from "./security";

export const MAX_ANALYSIS_DOCUMENT_BYTES = 2 * 1024 * 1024;
export const DOCX_CONTENT_TYPE =
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PDF_CONTENT_TYPE = "application/pdf";

function isDocx(bytes: Uint8Array) {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
		decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }),
		minimumEndOffset = Math.max(0, bytes.byteLength - 65_557);
	let endOffset = -1;
	for (
		let offset = bytes.byteLength - 22;
		offset >= minimumEndOffset;
		offset--
	) {
		if (view.getUint32(offset, true) === 0x06054b50) {
			endOffset = offset;
			break;
		}
	}
	if (endOffset < 0) return false;
	const disk = view.getUint16(endOffset + 4, true),
		centralDisk = view.getUint16(endOffset + 6, true),
		diskEntries = view.getUint16(endOffset + 8, true),
		entryCount = view.getUint16(endOffset + 10, true),
		centralSize = view.getUint32(endOffset + 12, true),
		centralOffset = view.getUint32(endOffset + 16, true),
		commentLength = view.getUint16(endOffset + 20, true);
	if (
		disk !== 0 ||
		centralDisk !== 0 ||
		diskEntries !== entryCount ||
		entryCount === 0xffff ||
		centralSize === 0xffffffff ||
		centralOffset === 0xffffffff ||
		endOffset + 22 + commentLength !== bytes.byteLength ||
		centralOffset + centralSize !== endOffset
	) {
		return false;
	}
	let offset = centralOffset;
	const names = new Set<string>();
	for (let entry = 0; entry < entryCount; entry++) {
		if (
			offset + 46 > endOffset ||
			view.getUint32(offset, true) !== 0x02014b50
		) {
			return false;
		}
		const flags = view.getUint16(offset + 8, true),
			compression = view.getUint16(offset + 10, true),
			compressedBytes = view.getUint32(offset + 20, true),
			uncompressedBytes = view.getUint32(offset + 24, true),
			nameLength = view.getUint16(offset + 28, true),
			extraLength = view.getUint16(offset + 30, true),
			entryCommentLength = view.getUint16(offset + 32, true),
			localOffset = view.getUint32(offset + 42, true),
			recordLength = 46 + nameLength + extraLength + entryCommentLength;
		const localFlags = view.getUint16(localOffset + 6, true),
			localCompression = view.getUint16(localOffset + 8, true);
		if (
			flags & 1 ||
			(compression !== 0 && compression !== 8) ||
			compressedBytes === 0xffffffff ||
			uncompressedBytes === 0xffffffff ||
			localOffset + 30 > centralOffset ||
			offset + recordLength > endOffset ||
			localFlags !== flags ||
			localCompression !== compression ||
			view.getUint32(localOffset, true) !== 0x04034b50
		) {
			return false;
		}
		let name: string;
		try {
			name = decoder.decode(
				bytes.subarray(offset + 46, offset + 46 + nameLength),
			);
			if (
				decoder.decode(
					bytes.subarray(
						localOffset + 30,
						localOffset + 30 + nameLength,
					),
				) !== name
			) {
				return false;
			}
		} catch {
			return false;
		}
		const localNameLength = view.getUint16(localOffset + 26, true),
			localExtraLength = view.getUint16(localOffset + 28, true),
			dataStart = localOffset + 30 + localNameLength + localExtraLength;
		if (
			localNameLength !== nameLength ||
			dataStart + compressedBytes > centralOffset
		) {
			return false;
		}
		names.add(name);
		offset += recordLength;
	}
	return (
		offset === centralOffset + centralSize &&
		names.has("[Content_Types].xml") &&
		names.has("word/document.xml")
	);
}

export function validateAnalysisDocument(filename: string, bytes: Uint8Array) {
	if (bytes.byteLength > MAX_ANALYSIS_DOCUMENT_BYTES) {
		throw new Error("DOCUMENT_LIMIT");
	}
	if (/\.pdf$/i.test(filename) && bytes.byteLength >= 5) {
		if (
			bytes[0] === 0x25 &&
			bytes[1] === 0x50 &&
			bytes[2] === 0x44 &&
			bytes[3] === 0x46 &&
			bytes[4] === 0x2d
		) {
			return { contentType: PDF_CONTENT_TYPE };
		}
	} else if (/\.docx$/i.test(filename) && isDocx(bytes)) {
		return { contentType: DOCX_CONTENT_TYPE };
	}
	throw new Error("DOCUMENT_TYPE_INVALID");
}

const json = (value: unknown, status = 200) =>
	Response.json(value, {
		status,
		headers: { "cache-control": "no-store" },
	});

function sha256(bytes: Uint8Array) {
	return crypto.subtle
		.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)
		.then((hash) =>
			Array.from(
				new Uint8Array(hash),
				(byte) => byte.toString(16).padStart(2, "0"),
			).join("")
		);
}

export async function participantDocuments(
	request: Request,
	env: Env,
	session: ConsoleSession,
) {
	if (session.role !== "participant" || !session.team_id) {
		return json({ error: "PARTICIPANT_REQUIRED" }, 403);
	}
	if (!session.identity_id) {
		return json({ error: "PARTICIPANT_IDENTITY_REQUIRED" }, 403);
	}
	const db = env.ORG_DB;
	if (!db) return json({ error: "ORGANIZATION_NOT_CONFIGURED" }, 503);
	const path = new URL(request.url).pathname.replace(
			"/api/organization/participant/documents",
			"",
		),
		team = await db
			.prepare("SELECT id FROM teams WHERE id=? AND status='ACTIVE'")
			.bind(session.team_id)
			.first<{ id: string }>();
	if (!team) return json({ error: "UNAUTHORIZED" }, 401);

	if (path === "" && request.method === "GET") {
		const documents = await db
			.prepare(
				"SELECT id,version,filename,content_type,bytes,sha256,status,created_at FROM team_documents WHERE team_id=? AND status='STORED' ORDER BY version DESC",
			)
			.bind(session.team_id)
			.all();
		const deadlines = await db
			.prepare(
				"SELECT analysis_document_deadline AS analysisDocumentDeadline,pull_request_deadline AS pullRequestDeadline FROM hackathons WHERE id='initial'",
			)
			.first();
		return json({ documents: documents.results, deadlines });
	}

	if (path === "" && request.method === "POST") {
		if (!env.ARTIFACTS) {
			return json({ error: "DOCUMENT_STORAGE_UNAVAILABLE" }, 503);
		}
		let raw: Uint8Array;
		try {
			raw = await boundedBody(
				request,
				MAX_ANALYSIS_DOCUMENT_BYTES + 64 * 1024,
			);
		} catch {
			return json({ error: "DOCUMENT_LIMIT" }, 413);
		}
		let form: FormData;
		try {
			form = await new Request(request.url, {
				method: "POST",
				headers: request.headers,
				body: raw,
			}).formData();
		} catch {
			return json({ error: "INVALID_DOCUMENT_UPLOAD" }, 400);
		}
		const files = form.getAll("file"),
			file = files[0];
		if (files.length !== 1 || !(file instanceof File)) {
			return json({ error: "INVALID_DOCUMENT_UPLOAD" }, 400);
		}
		const filename = file.name
			.split(/[\\/]/)
			.pop()
			?.replace(/[\u0000-\u001f\u007f]/g, "")
			.trim();
		if (!filename || filename.length > 180) {
			return json({ error: "INVALID_DOCUMENT_UPLOAD" }, 400);
		}
		if (file.size > MAX_ANALYSIS_DOCUMENT_BYTES) {
			return json({ error: "DOCUMENT_LIMIT" }, 413);
		}
		const bytes = new Uint8Array(await file.arrayBuffer());
		if (bytes.byteLength !== file.size) {
			return json({ error: "INVALID_DOCUMENT_UPLOAD" }, 400);
		}
		let documentType: { contentType: string };
		try {
			documentType = validateAnalysisDocument(filename, bytes);
		} catch (error) {
			return error instanceof Error && error.message === "DOCUMENT_LIMIT"
				? json({ error: "DOCUMENT_LIMIT" }, 413)
				: json({ error: "DOCUMENT_TYPE_INVALID" }, 415);
		}
		const id = crypto.randomUUID(),
			objectKey = `analysis-documents/${crypto.randomUUID()}`,
			hash = await sha256(bytes),
			created = await db
				.prepare(
					"INSERT INTO team_documents(id,team_id,version,object_key,filename,content_type,bytes,sha256,uploaded_by_identity_id) SELECT ?,?,COALESCE(MAX(version)+1,1),?,?,?,?,?,? FROM team_documents WHERE team_id=? HAVING (SELECT analysis_document_deadline FROM hackathons WHERE id='initial') IS NULL OR julianday('now') < julianday((SELECT analysis_document_deadline FROM hackathons WHERE id='initial')) OR NOT EXISTS(SELECT 1 FROM team_documents WHERE team_id=? AND status IN('PENDING','STORED')) RETURNING id,version,created_at",
				)
				.bind(
					id,
					session.team_id,
					objectKey,
					filename,
					documentType.contentType,
					bytes.byteLength,
					hash,
					session.identity_id,
					session.team_id,
					session.team_id,
				)
				.first<{ id: string; version: number; created_at: string }>();
		if (!created) {
			const deadline = await db
				.prepare(
					"SELECT analysis_document_deadline AS deadline FROM hackathons WHERE id='initial'",
				)
				.first<{ deadline: string | null }>();
			const existing = await db
				.prepare(
					"SELECT id FROM team_documents WHERE team_id=? AND status IN('PENDING','STORED') LIMIT 1",
				)
				.bind(session.team_id)
				.first();
			if (
				existing &&
				deadline?.deadline &&
				Date.parse(deadline.deadline) <= Date.now()
			) {
				return json(
					{ error: "ANALYSIS_DOCUMENT_DEADLINE_PASSED" },
					409,
				);
			}
			return json({ error: "DOCUMENT_VERSION_CONFLICT" }, 409);
		}
		try {
			await env.ARTIFACTS.put(objectKey, bytes, {
				httpMetadata: { contentType: documentType.contentType },
				customMetadata: { sha256: hash },
			});
			const results = await db.batch([
				db
					.prepare(
						"UPDATE team_documents SET status='STORED' WHERE id=? AND status='PENDING'",
					)
					.bind(id),
				db
					.prepare(
						"INSERT INTO audit(action,entity,actor,changes) VALUES('document.uploaded',?,?,?)",
					)
					.bind(
						id,
						"participant:" + session.identity_id,
						JSON.stringify({
							teamId: session.team_id,
							version: created.version,
							bytes: bytes.byteLength,
							sha256: hash,
						}),
					),
			]);
			if (!results[0]?.meta.changes) {
				throw new Error("DOCUMENT_STATE_INVALID");
			}
		} catch {
			await db
				.prepare(
					"UPDATE team_documents SET status='FAILED' WHERE id=? AND status='PENDING'",
				)
				.bind(id)
				.run();
			await env.ARTIFACTS.delete(objectKey);
			return json({ error: "DOCUMENT_STORAGE_UNAVAILABLE" }, 503);
		}
		return json(
			{
				document: {
					id,
					version: created.version,
					filename,
					content_type: documentType.contentType,
					bytes: bytes.byteLength,
					sha256: hash,
					status: "STORED",
					created_at: created.created_at,
				},
			},
			201,
		);
	}

	const match = path.match(/^\/([a-f0-9-]{36})$/);
	if (!match || request.method !== "GET") {
		return json({ error: "NOT_FOUND" }, 404);
	}
	const document = await db
		.prepare(
			"SELECT object_key,filename,content_type FROM team_documents WHERE id=? AND team_id=? AND status='STORED'",
		)
		.bind(match[1], session.team_id)
		.first<{
			object_key: string;
			filename: string;
			content_type: string;
		}>();
	if (!document) return json({ error: "NOT_FOUND" }, 404);
	if (!env.ARTIFACTS) {
		return json({ error: "DOCUMENT_STORAGE_UNAVAILABLE" }, 503);
	}
	const object = await env.ARTIFACTS.get(document.object_key);
	if (!object) return json({ error: "DOCUMENT_STORAGE_UNAVAILABLE" }, 503);
	const safeName = document.filename.replace(/["\\\r\n]/g, "_");
	return new Response(await object.arrayBuffer(), {
		headers: {
			"cache-control": "private, no-store",
			"content-disposition":
				`attachment; filename="${safeName}"; filename*=UTF-8''${
					encodeURIComponent(
						document.filename,
					)
				}`,
			"content-type": document.content_type,
			"x-content-type-options": "nosniff",
		},
	});
}
