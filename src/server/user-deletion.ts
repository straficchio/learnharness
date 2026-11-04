/**
 * Full user removal (multi-user wave, 2026-11-03): account + every per-user
 * record. Runs the target's work under their data scope so the store lookups
 * see their chats/jobs; abort is best-effort, then we wait briefly for the
 * in-memory loops to settle. If they refuse to settle we keep the account and
 * return a retryable 409 instead of racing a writer into a deleted folder.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { USERS_DIR } from "../../config.ts";
import { runInScope } from "../core/request-scope.ts";
import { stores } from "./stores.ts";
import { abortTurn } from "./turn-runs.ts";
import { isTurnRunning } from "./turn-liveness.ts";
import { abortJob, discardChatDeliveries } from "./jobs.ts";
import { isJobLive } from "../agent/subagents/aborts.ts";
import { abortExtraction } from "../agent/subagents/extraction.ts";
import { extractionRunningForScope, scopedExtractionRuns } from "./extraction-scope.ts";
import { findUserRecord, removeUserRecord, userDataRoot } from "./users.ts";

const SETTLE_TIMEOUT_MS = 5_000;
const SETTLE_STEP_MS = 100;

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function deleteUserCompletely(id: string) {
	const record = findUserRecord(id);
	if (!record) throw new Error("User not found.");
	if (record.role === "admin") throw new Error("The admin account cannot be deleted.");
	const root = userDataRoot(record);
	const scope = { userId: record.id, root };

	const chats = runInScope(scope, () => stores.chatStore.listChats());
	const jobs = runInScope(scope, () =>
		chats.flatMap((chat) => stores.jobStore.listJobs(chat.id)),
	);

	runInScope(scope, () => {
		// Covers chat extractions AND notes-source imports (their run.chatId
		// is the source id).
		for (const run of scopedExtractionRuns()) abortExtraction(run.chatId);
		for (const chat of chats) {
			abortTurn(chat.id);
			discardChatDeliveries(chat.id);
		}
		for (const job of jobs) abortJob(job.id);
	});

	const deadline = Date.now() + SETTLE_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const busyTurn = chats.some((chat) => isTurnRunning(chat.id));
		const busyJob = jobs.some((job) => isJobLive(job.id));
		const busyExtraction = runInScope(scope, () => extractionRunningForScope());
		if (!busyTurn && !busyJob && !busyExtraction) break;
		await wait(SETTLE_STEP_MS);
	}
	if (
		chats.some((chat) => isTurnRunning(chat.id))
		|| jobs.some((job) => isJobLive(job.id))
		|| runInScope(scope, () => extractionRunningForScope())
	) {
		throw new Error("This user still has running work. Try again once those turns/jobs stop.");
	}

	// Move the data out of the live namespace first (same filesystem, atomic),
	// then remove the account. If the account write fails, put it back.
	let trash: string | null = null;
	if (fs.existsSync(root)) {
		trash = path.join(USERS_DIR, `.deleted-${record.id}-${randomUUID().slice(0, 8)}`);
		fs.renameSync(root, trash);
	}
	try {
		removeUserRecord(id);
	} catch (error) {
		if (trash) fs.renameSync(trash, root);
		throw error;
	}
	if (trash) {
		try {
			fs.rmSync(trash, { recursive: true, force: true });
		} catch (error) {
			console.warn(`[users] removed ${record.name}, but could not delete ${trash}:`, error);
		}
	}
	return record;
}
