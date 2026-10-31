/**
 * Server-side session restoration — the shared gate used by the single
 * import route and the ZIP importer. Validation lives in core; this module
 * owns the existing-id/live-work gates and the store write.
 */
import type { ChatRecord } from "../core/contracts/chat.ts";
import { extractionStatuses } from "../agent/subagents/extraction.ts";
import { discardChatDeliveries } from "./jobs.ts";
import { clearTurnFailure } from "./turn-runs.ts";
import { getChat } from "./chats.ts";
import { isTurnRunning } from "./turn-liveness.ts";
import { stores } from "./stores.ts";

export type SessionImportFailureCode = "session_exists" | "turn_in_flight" | "jobs_running" | "extraction_running";

export type SessionImportOutcome =
	| { ok: true; id: string; title: string; replaced: boolean }
	| {
			ok: false;
			code: SessionImportFailureCode;
			error: string;
			id: string;
			title: string;
			jobIds?: string[];
	  };

export function importSessionRecord(session: ChatRecord, options: { replace?: boolean } = {}): SessionImportOutcome {
	const replace = options.replace === true;
	const existing = getChat(session.id);

	if (existing && !replace) {
		return {
			ok: false,
			code: "session_exists",
			error: "A session with this id already exists.",
			id: session.id,
			title: existing.title,
		};
	}
	if (existing) {
		if (isTurnRunning(session.id)) {
			return {
				ok: false,
				code: "turn_in_flight",
				error: "That session has a turn running — try again when it finishes.",
				id: session.id,
				title: existing.title,
			};
		}
		const runningJobs = stores.jobStore.listJobs(session.id).filter((job) => job.status === "running");
		if (runningJobs.length > 0) {
			return {
				ok: false,
				code: "jobs_running",
				error: "That session has background jobs running — try again when they finish.",
				id: session.id,
				title: existing.title,
				jobIds: runningJobs.map((job) => job.id),
			};
		}
		if (extractionStatuses().some((run) => run.chatId === session.id)) {
			return {
				ok: false,
				code: "extraction_running",
				error: "That session is still extracting — try again when it finishes.",
				id: session.id,
				title: existing.title,
			};
		}
	}

	const imported = stores.chatStore.importChat(session, { replace });
	if (!imported) {
		return {
			ok: false,
			code: "session_exists",
			error: "A session with this id already exists.",
			id: session.id,
			title: existing?.title ?? session.title,
		};
	}

	if (existing) {
		// The restored record is the new truth; stale live-view/pending-delivery
		// state from the replaced session must not write into it.
		clearTurnFailure(session.id);
		discardChatDeliveries(session.id);
	}

	return { ok: true, id: imported.id, title: imported.title, replaced: Boolean(existing) };
}
