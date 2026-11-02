import { clearModelTrace, modelTraceEnabled, readModelTrace } from "../agent/model-trace.ts";

/** The trace drawer's data surface: capture state plus parsed JSONL entries
 * from the requested line index. */
export function modelTraceSnapshot(sessionId: string, after = 0): { enabled: boolean; events: unknown[]; total: number } {
	return { enabled: modelTraceEnabled(), ...readModelTrace(sessionId, after) };
}

export function modelTraceClear(sessionId: string): void {
	clearModelTrace(sessionId);
}

export { modelTraceEnabled };
