/**
 * POST /api/chats/import — restore one JSON session or a bulk ZIP.
 *
 * JSON accepts the versioned export wrapper and, for migration convenience,
 * a raw data/chats/<id>.json record. ZIP contains one or more such JSON
 * files; new sessions import immediately, existing ids are reported as
 * conflicts, and `?replace=1` retries with replace semantics. Per-file
 * validation and live-work gates are shared with the single import.
 */
import { strFromU8, unzipSync } from "fflate";
import {
	MAX_BULK_IMPORT_BYTES,
	MAX_BULK_IMPORT_ENTRIES,
	MAX_BULK_IMPORT_UNCOMPRESSED_BYTES,
	MAX_SESSION_IMPORT_BYTES,
	parseSessionExport,
} from "@/src/core";
import { importSessionRecord } from "@/src/server";

export const dynamic = "force-dynamic";

interface ImportedSession {
	id: string;
	title: string;
}

interface ImportFailure {
	file: string;
	error: string;
	id?: string;
	title?: string;
	code?: string;
}

function errorResponse(error: string, status: number, code: string, extra: Record<string, unknown> = {}): Response {
	return Response.json({ error, code, ...extra }, { status, headers: { "cache-control": "no-store" } });
}

function jsonResponse(body: unknown): Response {
	return Response.json(body, { headers: { "cache-control": "no-store" } });
}

async function importSingle(req: Request, replace: boolean): Promise<Response> {
	const declared = Number(req.headers.get("content-length") ?? "");
	if (Number.isFinite(declared) && declared > MAX_SESSION_IMPORT_BYTES) {
		return errorResponse("The session file is too large.", 413, "too_large");
	}

	const text = await req.text();
	if (Buffer.byteLength(text, "utf8") > MAX_SESSION_IMPORT_BYTES) {
		return errorResponse("The session file is too large.", 413, "too_large");
	}

	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return errorResponse("The file is not valid JSON.", 400, "invalid_json");
	}

	const parsed = parseSessionExport(value);
	if (!parsed.ok) return errorResponse(parsed.error, 400, "invalid_session");

	const outcome = importSessionRecord(parsed.session, { replace });
	if (!outcome.ok) {
		return errorResponse(outcome.error, 409, outcome.code, {
			id: outcome.id,
			title: outcome.title,
			...(outcome.jobIds ? { jobIds: outcome.jobIds } : {}),
		});
	}
	return jsonResponse(outcome);
}

async function importZip(req: Request, replace: boolean): Promise<Response> {
	const declared = Number(req.headers.get("content-length") ?? "");
	if (Number.isFinite(declared) && declared > MAX_BULK_IMPORT_BYTES) {
		return errorResponse("The ZIP file is too large.", 413, "too_large");
	}

	const bytes = new Uint8Array(await req.arrayBuffer());
	if (bytes.byteLength > MAX_BULK_IMPORT_BYTES) {
		return errorResponse("The ZIP file is too large.", 413, "too_large");
	}

	let entries: Record<string, Uint8Array>;
	let tooMany = false;
	let tooLarge = false;
	let count = 0;
	let uncompressed = 0;
	try {
		entries = unzipSync(bytes, {
			filter: (file) => {
				if (!/\.json$/i.test(file.name) || /^__MACOSX\//i.test(file.name)) return false;
				if (++count > MAX_BULK_IMPORT_ENTRIES) {
					tooMany = true;
					return false;
				}
				uncompressed += file.originalSize;
				if (uncompressed > MAX_BULK_IMPORT_UNCOMPRESSED_BYTES) {
					tooLarge = true;
					return false;
				}
				return true;
			},
		});
	} catch {
		return errorResponse("The file is not a valid ZIP archive.", 400, "invalid_zip");
	}
	if (tooMany) {
		return errorResponse(`A ZIP may contain at most ${MAX_BULK_IMPORT_ENTRIES} session files.`, 400, "too_many_entries");
	}
	if (tooLarge) {
		return errorResponse("The ZIP expands beyond the session import limit.", 413, "too_large");
	}

	const files = Object.entries(entries).filter(([name]) => !name.endsWith("/"));
	if (files.length === 0) {
		return errorResponse("The ZIP contains no .json session files.", 400, "no_sessions");
	}

	const imported: ImportedSession[] = [];
	const replaced: ImportedSession[] = [];
	const conflicts: ImportedSession[] = [];
	const failures: ImportFailure[] = [];

	for (const [file, data] of files) {
		if (data.byteLength > MAX_SESSION_IMPORT_BYTES) {
			failures.push({ file, error: "The session file is too large." });
			continue;
		}
		let value: unknown;
		try {
			value = JSON.parse(strFromU8(data));
		} catch {
			failures.push({ file, error: "The file is not valid JSON." });
			continue;
		}
		const parsed = parseSessionExport(value);
		if (!parsed.ok) {
			failures.push({ file, error: parsed.error });
			continue;
		}
		const outcome = importSessionRecord(parsed.session, { replace });
		if (outcome.ok) {
			(outcome.replaced ? replaced : imported).push({ id: outcome.id, title: outcome.title });
		} else if (outcome.code === "session_exists") {
			conflicts.push({ id: outcome.id, title: outcome.title });
		} else {
			failures.push({
				file,
				error: outcome.error,
				id: outcome.id,
				title: outcome.title,
				code: outcome.code,
			});
		}
	}

	return jsonResponse({ ok: true, imported, replaced, conflicts, failures });
}

export async function POST(req: Request): Promise<Response> {
	const url = new URL(req.url);
	const replace = url.searchParams.get("replace") === "1";
	const zipRequested =
		url.searchParams.get("zip") === "1" || (req.headers.get("content-type") ?? "").includes("application/zip");
	return zipRequested ? importZip(req, replace) : importSingle(req, replace);
}
