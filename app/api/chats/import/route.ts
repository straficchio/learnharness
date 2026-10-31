/**
 * POST /api/chats/import — restore a lossless session file.
 *
 * Accepts the versioned export wrapper (and, for migration convenience, a
 * raw data/chats/<id>.json record). The route validates the structural
 * contract, preserves the id/state, and refuses an existing id unless the
 * caller explicitly asks to replace it. A replacement is refused while the
 * existing session has a live turn or background job; those writers would
 * otherwise race the restored record.
 */
import { MAX_SESSION_IMPORT_BYTES, parseSessionExport } from "@/src/core";
import { clearTurnFailure, discardChatDeliveries, extractionStatuses, getChat, isTurnRunning, stores } from "@/src/server";

export const dynamic = "force-dynamic";

function errorResponse(error: string, status: number, code: string, extra: Record<string, unknown> = {}): Response {
	return Response.json({ error, code, ...extra }, { status, headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request): Promise<Response> {
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

	const session = parsed.session;
	const replace = new URL(req.url).searchParams.get("replace") === "1";
	const existing = getChat(session.id);

	if (existing && !replace) {
		return errorResponse("A session with this id already exists.", 409, "session_exists", {
			id: session.id,
			title: existing.title,
		});
	}
	if (existing) {
		if (isTurnRunning(session.id)) {
			return errorResponse("That session has a turn running — try again when it finishes.", 409, "turn_in_flight", {
				id: session.id,
			});
		}
		const runningJobs = stores.jobStore.listJobs(session.id).filter((job) => job.status === "running");
		if (runningJobs.length > 0) {
			return errorResponse("That session has background jobs running — try again when they finish.", 409, "jobs_running", {
				id: session.id,
				jobIds: runningJobs.map((job) => job.id),
			});
		}
		if (extractionStatuses().some((run) => run.chatId === session.id)) {
			return errorResponse("That session is still extracting — try again when it finishes.", 409, "extraction_running", {
				id: session.id,
			});
		}
	}

	const imported = stores.chatStore.importChat(session, { replace });
	if (!imported) {
		return errorResponse("A session with this id already exists.", 409, "session_exists", {
			id: session.id,
			title: existing?.title ?? session.title,
		});
	}

	if (existing) {
		// The restored record is the new truth; stale live-view/pending-delivery
		// state from the replaced session must not write into it.
		clearTurnFailure(session.id);
		discardChatDeliveries(session.id);
	}

	return Response.json(
		{ ok: true, id: imported.id, title: imported.title, replaced: Boolean(existing) },
		{ headers: { "cache-control": "no-store" } },
	);
}
