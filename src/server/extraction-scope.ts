/**
 * Extraction registry views scoped to the ACTIVE user (multi-user wave,
 * 2026-11-03). The pipeline registry is process-global; routes and deletion
 * guards must never see (or wait on) another user's runs. A run's chatId is
 * either a chat id or a notes-source id, so both scoped inventories count.
 */
import { extractionStatuses, type RunningExtraction } from "../agent/subagents/extraction.ts";
import { currentScopeId } from "../core/request-scope.ts";
import { graphStore } from "../store/graph.ts";
import { chatStore } from "../store/chats.ts";

export function scopedExtractionRuns(): RunningExtraction[] {
	const scope = currentScopeId();
	const chats = new Set(chatStore.listChats().map((chat) => chat.id));
	const sources = new Set(graphStore.readSources().map((source) => source.id));
	return extractionStatuses().filter((run) => {
		if (run.scope) return run.scope === scope;
		// Standalone has no scope; it sees the legacy/global registry. In
		// server mode an unscoped run is global (boot/recovery) and belongs
		// to the admin surface.
		if (scope === undefined || scope === "local" || scope === "usr_admin") return true;
		return chats.has(run.chatId) || sources.has(run.chatId);
	});
}

export function extractionRunningForScope(): boolean {
	return scopedExtractionRuns().length > 0;
}
