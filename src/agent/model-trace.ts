/**
 * model-trace — opt-in, local-only model I/O recorder.
 *
 * Foreground and background agents write one JSONL per session under
 * data/debug/model-traces/. The generic pi stream wrapper records the
 * model-facing request and final assistant message; API adapters also expose
 * their final payload, HTTP status and raw provider events. The Claude and
 * Antigravity adapters add their exact CLI arguments, rendered prompt and raw
 * CLI stream lines.
 *
 * Off by default. The Settings → Developer toggle persists the choice; the
 * LH_MODEL_TRACE=1 environment variable enables it for terminal/dev launches.
 * Traces carry full prompts and responses: private diagnostic data, not a
 * credential/header recorder and not a retention store. The 20 MB per-session
 * cap stops a runaway turn.
 */
import * as fs from "node:fs";
import path from "node:path";
import type {
	Api,
	AssistantMessage,
	Message,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	Tool,
	ToolResultMessage,
	TranscriptContext,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { PATHS } from "../../config.ts";

const CAP_BYTES = 20 * 1024 * 1024;
const PRIVATE_FIELD = /^(?:headers|authorization|proxyauthorization|apikey|accesstoken|refreshtoken|clientsecret|credentials|password|token)$/i;

/** Test seam: redirect the trace directory. */
export const modelTraceDir = { current: path.join(PATHS.debug, "model-traces") };
/** Test seam: shrink the per-session cap. */
export const modelTraceCap = { current: CAP_BYTES };

let configured = false;

export function configureModelTrace(enabled: boolean): void {
	configured = enabled;
}

export function modelTraceEnabled(): boolean {
	return configured || process.env.LH_MODEL_TRACE === "1";
}

export type TraceKind =
	| "request"
	| "cli-request"
	| "provider-event"
	| "payload"
	| "http"
	| "cli-event"
	| "tool-intent"
	| "mcp-call"
	| "tool-result"
	| "response"
	| "error"
	| "note";

type TraceState = { bytes: number; capped: boolean };
const files = new Map<string, TraceState>();

function safeSessionId(sessionId: string): string {
	const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
	return safe || "session";
}

function fileFor(sessionId: string): string {
	return path.join(modelTraceDir.current, `${safeSessionId(sessionId)}.jsonl`);
}

/** Redact credential/header fields and replace image bytes with a size note. */
function snapshot(value: unknown): unknown {
	try {
		const json = JSON.stringify(value, (key, item: unknown) => {
			if (PRIVATE_FIELD.test(key.replace(/[-_]/g, ""))) return "[redacted]";
			if (item && typeof item === "object" && !Array.isArray(item)) {
				const record = item as Record<string, unknown>;
				if (record.type === "image" && typeof record.data === "string") {
					return { ...record, data: `[image ${record.data.length} base64 chars]` };
				}
			}
			return item;
		});
		return json === undefined ? null : JSON.parse(json) as unknown;
	} catch {
		return { traceError: "Value could not be serialized." };
	}
}

function describeError(value: unknown, depth = 0): unknown {
	if (!(value instanceof Error)) return snapshot(value);
	return {
		name: value.name,
		message: value.message,
		...(value.cause === undefined ? {} : { cause: depth < 4 ? describeError(value.cause, depth + 1) : "[cause omitted]" }),
	};
}

function write(sessionId: string | undefined, kind: TraceKind, data: Record<string, unknown>): void {
	if (!sessionId || !modelTraceEnabled()) return;
	const file = fileFor(sessionId);
	const state = files.get(file);
	if (state?.capped) return;
	const body = snapshot(data) as Record<string, unknown>;
	const text = `${JSON.stringify({ t: Date.now(), sessionId, kind, ...body })}\n`;
	try {
		const before = state?.bytes ?? (fs.existsSync(file) ? fs.statSync(file).size : 0);
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		fs.appendFileSync(file, text, { mode: 0o600 });
		const bytes = before + Buffer.byteLength(text);
		if (bytes > modelTraceCap.current) {
			files.set(file, { bytes, capped: true });
			fs.appendFileSync(file, `${JSON.stringify({ t: Date.now(), sessionId, kind: "note", note: `cap ${modelTraceCap.current} bytes reached — recording stopped` })}\n`, { mode: 0o600 });
		} else {
			files.set(file, { bytes, capped: false });
		}
	} catch {
		// Tracing must never take a run down with it.
	}
}

function safeOptions(options: SimpleStreamOptions | undefined): Record<string, unknown> {
	if (!options) return {};
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(options)) {
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") out[key] = value;
	}
	return out;
}

export function traceRequest(
	sessionId: string | undefined,
	input: { provider: string; model: string; context: TranscriptContext; options?: SimpleStreamOptions },
): void {
	const messages = input.context.messages.filter((message: Message) => message.role !== "system");
	write(sessionId, "request", {
		provider: input.provider,
		model: input.model,
		reasoning: input.options?.reasoning ?? null,
		systemPrompt: getCurrentSystemPrompt(input.context.messages),
		tools: getCurrentTools(input.context.messages),
		messages,
		options: safeOptions(input.options),
	});
}

export function traceProviderEvent(sessionId: string | undefined, data: unknown, model: Pick<Model<Api>, "provider" | "id">): void {
	write(sessionId, "provider-event", { provider: model.provider, model: model.id, event: data });
}

export function tracePayload(sessionId: string | undefined, payload: unknown): void {
	write(sessionId, "payload", { payload });
}

export function traceHttp(sessionId: string | undefined, status: number): void {
	write(sessionId, "http", { status });
}

export function traceCliRequest(
	sessionId: string | undefined,
	input: { provider: string; model: string; args: string[]; systemPrompt: string; tools: Tool[]; userContent: unknown; imagePaths?: string[] },
): void {
	write(sessionId, "cli-request", input as unknown as Record<string, unknown>);
}

export function traceCliEvent(sessionId: string | undefined, line: string): void {
	write(sessionId, "cli-event", { line });
}

/** The CLI's streamed announcement of a harness tool step. Compared against
 *  the authenticated MCP request before the harness admits side effects. */
export function traceToolIntent(
	sessionId: string | undefined,
	input: { stepIndex: number; name: string; arguments: unknown },
): void {
	write(sessionId, "tool-intent", input as unknown as Record<string, unknown>);
}

/** The authenticated MCP call as received by the harness bridge. */
export function traceMcpCall(
	sessionId: string | undefined,
	input: { id: string; stepIndex: number; name: string; arguments: unknown },
): void {
	write(sessionId, "mcp-call", input as unknown as Record<string, unknown>);
}

export function traceToolResult(sessionId: string | undefined, message: ToolResultMessage): void {
	write(sessionId, "tool-result", { message });
}

export function traceResponse(sessionId: string | undefined, message: AssistantMessage): void {
	write(sessionId, "response", { message });
}

export function traceError(sessionId: string | undefined, error: unknown): void {
	write(sessionId, "error", { error: describeError(error) });
}

/** A provider-shaped error message so a throwing source stream still settles
 *  the wrapper's result promise instead of hanging the agent loop. */
function errorMessageFor(model: Pick<Model<Api>, "api" | "provider" | "id">, error: unknown): AssistantMessage {
	const described = describeError(error) as { message?: unknown } | null;
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		timestamp: Date.now(),
		errorMessage: typeof described?.message === "string" ? described.message : "model stream failed",
	};
}

export function traceNote(sessionId: string | undefined, note: string): void {
	write(sessionId, "note", { note });
}

/** Wrap one engine stream: record the request, raw API events, and the final
 *  assistant message without changing the caller's stream semantics. */
export function traceStream(
	streamFn: StreamFunction<Api, SimpleStreamOptions>,
	identity: { provider: string; id: string },
): StreamFunction<Api, SimpleStreamOptions> {
	return (model, context, options) => {
		const sessionId = options?.sessionId;
		if (!sessionId || !modelTraceEnabled()) return streamFn(model, context, options);

		traceRequest(sessionId, { provider: identity.provider, model: identity.id, context, options });
		traceNote(sessionId, `stream start ${identity.provider}:${identity.id}`);

		const tracedOptions: SimpleStreamOptions = {
			...options,
			onPayload: async (raw, nativeModel) => {
				tracePayload(sessionId, raw);
				return options?.onPayload?.(raw, nativeModel);
			},
			onResponse: async (response, nativeModel) => {
				traceHttp(sessionId, response.status);
				await options?.onResponse?.(response, nativeModel);
			},
			onProviderStreamEvent: async (data, nativeModel) => {
				traceProviderEvent(sessionId, data, nativeModel);
				await options?.onProviderStreamEvent?.(data, nativeModel);
			},
		};

		let source;
		try {
			source = streamFn(model, context, tracedOptions);
		} catch (error) {
			traceError(sessionId, error);
			throw error;
		}

		const output = createAssistantMessageEventStream();
		void (async () => {
			try {
				for await (const event of source) {
					if (event.type === "done") traceResponse(sessionId, event.message);
					else if (event.type === "error") traceError(sessionId, event.error);
					output.push(event);
				}
			} catch (error) {
				traceError(sessionId, error);
				output.push({ type: "error", reason: "error", error: errorMessageFor(model, error) });
			} finally {
				output.end();
			}
		})();
		return output;
	};
}

/** Server/UI read: parsed JSONL entries from `after` (0-based line index). */
export function readModelTrace(sessionId: string, after = 0): { events: unknown[]; total: number } {
	let text: string;
	try {
		text = fs.readFileSync(fileFor(sessionId), "utf8");
	} catch {
		return { events: [], total: 0 };
	}
	const all = text.split("\n");
	// A poll can race an append: drop the final element unconditionally. It is
	// either the terminator of the last complete line or a partial tail that
	// the next poll re-reads complete.
	all.pop();
	const events: unknown[] = [];
	for (let index = after; index < all.length; index++) {
		try {
			events.push(JSON.parse(all[index]!));
		} catch {
			events.push({ kind: "parse-error", raw: all[index]!.slice(0, 500) });
		}
	}
	return { events, total: all.length };
}

export function clearModelTrace(sessionId: string): void {
	const file = fileFor(sessionId);
	files.delete(file);
	try {
		fs.rmSync(file, { force: true });
	} catch {
		// A missing/unwritable trace is already effectively clear.
	}
}
