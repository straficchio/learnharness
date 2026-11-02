export type LiveProcess = { readonly owner: symbol; readonly sessionId: string | undefined; toolCallIds: string[]; kill(): void };

// A held learner question keeps the CLI blocked on the MCP call. Retire the
// process before the CLI's own (undocumented) MCP timeout; a later answer
// starts a fresh process with the question and answer in replay.
export const AGY_LIVE_PROCESS_IDLE_TIMEOUT_MS = 4 * 60_000;

/** Test seam. */
export const liveProcessIdleTimeoutMs = { current: AGY_LIVE_PROCESS_IDLE_TIMEOUT_MS };

const liveProcesses = new Map<LiveProcess, NodeJS.Timeout>();

export function addLiveProcess(process: LiveProcess): void {
	removeLiveProcess(process);
	const timer = setTimeout(() => {
		removeLiveProcess(process);
		process.kill();
	}, liveProcessIdleTimeoutMs.current);

	timer.unref();

	liveProcesses.set(process, timer);
}

function hasSameIds(ids: string[], otherIds: string[]): boolean {
	return ids.length === otherIds.length && new Set(otherIds).size === otherIds.length && ids.every((id) => otherIds.includes(id));
}

export function getLiveProcess(toolCallIds: string[], owner: symbol, sessionId: string | undefined): LiveProcess | null {
	if (!sessionId || toolCallIds.length === 0) return null;

	for (const process of liveProcesses.keys()) {
		if (process.owner === owner && process.sessionId === sessionId && hasSameIds(process.toolCallIds, toolCallIds)) return process;
	}

	return null;
}

export function removeLiveProcess(process: LiveProcess): void {
	clearTimeout(liveProcesses.get(process));
	liveProcesses.delete(process);
}
