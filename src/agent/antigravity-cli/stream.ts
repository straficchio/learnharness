import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { isDeepStrictEqual } from "node:util";

import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type JsonObject,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type StreamFunction,
	type ThinkingLevel,
	type ToolCall,
	type ToolResultMessage,
	type TranscriptContext,
} from "@earendil-works/pi-ai";

import { externalCliEnv } from "../../core/auth-env.ts";
import { traceCliEvent, traceCliRequest, traceMcpCall, traceNote, traceToolIntent, traceToolResult } from "../model-trace.ts";
import { parseAgyLine, type AgyEvent, type AgyUsage } from "./cli-events.ts";
import { AGY_DEFAULT_MODEL_ID, AntigravityCliError } from "./constants.ts";
import { AgyLaunchError, createAgyLauncher } from "./launch.ts";
import { addLiveProcess, getLiveProcess, removeLiveProcess, type LiveProcess } from "./live-processes.ts";
import { configurationForReuse, conversationForReuse } from "./reuse-context.ts";
import { agyChildEnv, createAgyTurnFiles, type AgyTurnFiles } from "./session-files.ts";
import { createAgyToolBridge, harnessToolFromAgy, type AgyPendingToolCall, type AgyToolBridge } from "./tool-bridge.ts";
import { renderAgyContent, toAgyInput, toAgyStreamJsonLine } from "./transcript.ts";

type RunAgyOptions = { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal };

type AgyChild = ChildProcessWithoutNullStreams | null;
export type RunAgy = (args: string[], options: RunAgyOptions) => AgyChild | Promise<AgyChild>;

const ABORT_MESSAGE = "Request was aborted";
const START_FAILED_MESSAGE = "agy CLI failed to start";

type AgyArgsInput = {
	modelId: string;
	effort: string | undefined;
	logFile: string;
};

export function toAgyArgs(input: AgyArgsInput): string[] {
	return [
		"--input-format",
		"stream-json",
		"--output-format",
		"stream-json",
		"--print-timeout",
		"0",
		"--disable-slash-commands",
		"--log-file",
		input.logFile,
		...(input.modelId !== AGY_DEFAULT_MODEL_ID ? ["--model", input.modelId] : []),
		...(input.effort ? ["--effort", input.effort] : []),
	];
}

const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"] as const;

/** Map Pi's clamped thinking level onto the CLI family's available effort. */
export function toAgyEffort(model: Model<Api>, level: ThinkingLevel | undefined): string | undefined {
	if (!model.reasoning || model.id === AGY_DEFAULT_MODEL_ID) return undefined;
	const map = model.thinkingLevelMap ?? {};
	const available = EFFORT_ORDER.filter((effort) => typeof map[effort] === "string");
	if (available.length === 0) return undefined;

	if (level) {
		const mapped = map[level];
		if (typeof mapped === "string") return mapped;
	}
	if (!level) return undefined;
	if (level === "minimal") return available[0];

	const requested = EFFORT_ORDER.indexOf(level as (typeof EFFORT_ORDER)[number]);
	for (let index = requested; index < EFFORT_ORDER.length; index++) {
		const candidate = EFFORT_ORDER[index]!;
		if (available.includes(candidate)) return candidate;
	}
	for (let index = requested - 1; index >= 0; index--) {
		const candidate = EFFORT_ORDER[index]!;
		if (available.includes(candidate)) return candidate;
	}
	return available[0];
}

function createOutput(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

class AgyTurn {
	private readonly output: AssistantMessage;
	private started = false;
	private finished = false;
	private textStarted = false;
	private textIndex = -1;
	private usageSeen = false;

	constructor(
		private readonly stream: AssistantMessageEventStream,
		model: Model<Api>,
	) {
		this.output = createOutput(model);
	}

	get isFinished(): boolean { return this.finished; }

	getMessage(): AssistantMessage { return this.output; }

	handleAgentResponse(event: Extract<AgyEvent, { type: "agentResponse" }>): void {
		if (this.finished) return;
		if (event.usage) this.usageSeen = true;
		this.updateUsage(event.usage);

		if (event.text) {
			this.start();
			if (!this.textStarted) {
				const contentIndex = this.output.content.length;
				this.output.content.push({ type: "text", text: "" });
				this.textIndex = contentIndex;
				this.textStarted = true;
				this.stream.push({ type: "text_start", contentIndex, partial: this.output });
			}
			const block = this.output.content[this.textIndex];
			if (block?.type === "text") {
				block.text += event.text;
				this.stream.push({ type: "text_delta", contentIndex: this.textIndex, delta: event.text, partial: this.output });
			}
		}

		if (event.state === "DONE") this.closeText();
	}

	admit(calls: ToolCall[]): void {
		if (this.finished) return;
		this.start();
		this.closeText();
		for (const call of calls) {
			const contentIndex = this.output.content.length;
			this.output.content.push(call);
			this.stream.push({ type: "toolcall_start", contentIndex, partial: this.output });
			this.stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: this.output });
		}
		this.output.stopReason = "toolUse";
		this.finish();
	}

	finishSuccess(event: Extract<AgyEvent, { type: "result" }>): void {
		if (this.finished) return;
		// The result event's usage is cumulative over the whole CLI run, not
		// this Pi turn. Use it only when no per-step usage was reported.
		if (!this.usageSeen) this.updateUsage(event.usage);
		this.start();
		this.closeText();
		if (this.output.stopReason === "pending") this.output.stopReason = "stop";
		this.finish();
	}

	fail(message: string, reason: "aborted" | "error"): void {
		if (this.finished) return;

		this.finished = true;
		this.output.stopReason = reason;
		this.output.errorMessage = message;
		this.stream.push({ type: "error", reason, error: this.output });
		this.stream.end();
	}

	private start(): void {
		if (this.started) return;
		this.started = true;
		this.stream.push({ type: "start", partial: this.output });
	}

	private closeText(): void {
		if (!this.textStarted) return;
		const block = this.output.content[this.textIndex];
		if (block?.type === "text") {
			this.stream.push({ type: "text_end", contentIndex: this.textIndex, content: block.text, partial: this.output });
		}
		this.textStarted = false;
	}

	private updateUsage(usage: AgyUsage | null): void {
		if (!usage) return;
		Object.assign(this.output.usage, usage);

		const { input, output, cacheRead, cacheWrite } = this.output.usage;
		this.output.usage.totalTokens = input + output + cacheRead + cacheWrite;
	}

	private finish(): void {
		if (this.finished) return;

		if (this.output.stopReason === "error") {
			this.fail(this.output.errorMessage ?? "agy CLI failed", "error");
			return;
		}

		if (this.output.stopReason === "pending" || this.output.stopReason === "aborted") {
			this.fail(this.output.errorMessage ?? "agy CLI ended the message without a stop reason", "error");
			return;
		}

		this.finished = true;
		this.stream.push({ type: "done", reason: this.output.stopReason, message: this.output });
		this.stream.end();
	}
}

type AgyToolIntent = { stepIndex: number; name: string; arguments: JsonObject };

function stripToolSummary(parameters: JsonObject): JsonObject {
	const rest = { ...parameters } as Record<string, unknown>;
	delete rest.toolSummary;
	return rest as JsonObject;
}

/** agy's step_update summarizes long string arguments (observed: the first
 *  512 chars + U+2026) while the authenticated MCP request carries the full
 *  value. Accept that specific truncated-prefix form; every other value must
 *  still match exactly. */
function streamedValueMatches(streamed: unknown, actual: unknown): boolean {
	if (typeof streamed === "string" && typeof actual === "string") {
		if (streamed === actual) return true;
		return streamed.endsWith("\u2026") && actual.startsWith(streamed.slice(0, -1));
	}
	if (Array.isArray(streamed) || Array.isArray(actual)) {
		return Array.isArray(streamed)
			&& Array.isArray(actual)
			&& streamed.length === actual.length
			&& streamed.every((value, index) => streamedValueMatches(value, actual[index]));
	}
	if (streamed !== null && typeof streamed === "object" || actual !== null && typeof actual === "object") {
		if (streamed === null || actual === null || typeof streamed !== "object" || typeof actual !== "object") return false;
		const left = streamed as Record<string, unknown>;
		const right = actual as Record<string, unknown>;
		const keys = Object.keys(left);
		return keys.length === Object.keys(right).length
			&& keys.every((key) => Object.hasOwn(right, key) && streamedValueMatches(left[key], right[key]));
	}
	return isDeepStrictEqual(streamed, actual);
}

/** Names only — enough to point at the disagreement without copying the
 *  (possibly long, learner-authored) values into the chat error. */
function differingToolFields(intent: JsonObject, call: JsonObject): string[] {
	const left = intent as Record<string, unknown>;
	const right = call as Record<string, unknown>;
	return [...new Set([...Object.keys(left), ...Object.keys(right)])]
		.filter((key) => !streamedValueMatches(left[key], right[key]));
}

function resultError(event: Extract<AgyEvent, { type: "result" }>): string {
	const error = event.error?.trim();
	if (error && /authentication required|not signed in|login required|unauthorized|\b401\b/i.test(error)) {
		return AntigravityCliError.NotSignedIn;
	}
	if (event.finishedReason === "print_timeout") return "Antigravity CLI timed out before the turn completed.";
	if (error) return error.slice(0, 8_192);
	if (event.status === "CANCELED" || event.status === "INTERRUPTED") return ABORT_MESSAGE;
	return `agy CLI ended with status ${event.status}`;
}

class AgyProcess implements LiveProcess {
	toolCallIds: string[] = [];
	private stderr = "";
	private closed = false;
	private stopping = false;
	private killTimer: NodeJS.Timeout | undefined;
	private signal: AbortSignal | undefined;
	private readonly intents = new Map<number, AgyToolIntent>();
	private readonly tracedCalls = new Set<AgyPendingToolCall>();
	private readonly admittedSteps = new Set<number>();
	private readonly allowedNativeSteps = new Set<number>();
	private readonly blockedNativeSteps = new Set<number>();
	private readonly cancelledSteps = new Set<number>();
	private admitted: AgyPendingToolCall[] = [];
	private pendingError: string | undefined;

	constructor(
		private readonly child: ChildProcessWithoutNullStreams,
		private readonly bridge: AgyToolBridge,
		private readonly files: AgyTurnFiles,
		private turn: AgyTurn,
		readonly owner: symbol,
		readonly sessionId: string | undefined,
		private readonly configuration: unknown,
		private conversation: unknown[],
	) {}

	start(stdinLine: string, signal: AbortSignal | undefined): void {
		this.child.once("close", (code: number | null) => this.handleClose(`agy CLI exited with code ${code}`));
		this.child.once("error", (error) => {
			console.error("agy CLI process failed:", error);
			this.turn.fail(START_FAILED_MESSAGE, "error");
			this.handleClose(START_FAILED_MESSAGE);
		});
		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-65_536); });
		this.child.stdin.on("error", (error) => console.error("agy CLI stdin closed early:", error));
		createInterface({ input: this.child.stdout }).on("line", (line) => {
			try { this.handleLine(line); }
			catch { this.fail("agy CLI emitted malformed stream output"); }
		});
		this.setSignal(signal);
		if (this.stopping) return;
		this.child.stdin.write(`${stdinLine}\n`);
		this.child.stdin.end();
	}

	canContinue(owner: symbol, sessionId: string | undefined, configuration: unknown, messages: Message[], results: ToolResultMessage[]): boolean {
		const conversation = conversationForReuse(messages);
		return !this.stopping && owner === this.owner && !!sessionId && sessionId === this.sessionId
			&& isDeepStrictEqual(configuration, this.configuration)
			&& isDeepStrictEqual(conversation.slice(0, this.conversation.length), this.conversation)
			&& conversation.length === this.conversation.length + this.admitted.length
			&& results.length === this.admitted.length
			&& new Set(results.map((result) => result.toolCallId)).size === results.length
			&& this.admitted.every((call) => results.some((result) => result.toolCallId === call.id && result.toolName === call.name));
	}

	continueTurn(turn: AgyTurn, messages: Message[], results: ToolResultMessage[], signal: AbortSignal | undefined): void {
		removeLiveProcess(this);
		const admitted = this.admitted;
		this.admitted = [];
		this.conversation = structuredClone(conversationForReuse(messages));
		this.turn = turn;
		this.setSignal(signal);
		if (this.stopping) return;
		for (const call of admitted) {
			const result = results.find((candidate) => candidate.toolCallId === call.id)!;
			this.bridge.resolveToolCall(call, result);
			traceToolResult(this.sessionId, result);
		}
		this.flushAdmissions();
	}

	kill(): void {
		removeLiveProcess(this);
		if (this.stopping || this.closed) return;
		this.stopping = true;
		this.child.kill();
		this.killTimer = setTimeout(() => this.child.kill("SIGKILL"), 1000);
		this.killTimer.unref();
	}

	fail(message: string): void {
		// A parallel request can fail after the admitted slice was handed to
		// Pi. Retain that failure for its continuation instead of silently
		// replaying and hiding the compatibility error.
		if (this.sessionId && this.turn.isFinished && this.toolCallIds.length > 0) this.pendingError = message;
		this.turn.fail(message, "error");
		this.kill();
		if (this.pendingError) addLiveProcess(this);
	}

	consumeFailure(owner: symbol, turn: AgyTurn): boolean {
		if (owner !== this.owner || !this.pendingError) return false;
		const message = this.pendingError;
		this.pendingError = undefined;
		this.kill();
		turn.fail(message, "error");
		return true;
	}

	cancelCall(call: AgyPendingToolCall): void {
		// Already admitted work belongs to Pi and cannot be undone. A queued
		// request, however, must never become executable after cancellation.
		if (this.admitted.some((admitted) => admitted.id === call.id)) return;
		this.cancelledSteps.add(call.stepIndex);
		this.intents.delete(call.stepIndex);
		this.bridge.cancelToolCall(call);
	}

	/** Only a matching streamed intent and authenticated MCP request admit side effects. */
	flushAdmissions(): void {
		if (this.stopping || this.turn.isFinished) return;
		const pending = this.bridge.getPendingToolCalls();
		if (pending.length === 0) return;
		if (pending.length > 1) {
			this.fail("agy CLI emitted multiple concurrent harness tool calls");
			return;
		}

		const call = pending[0]!;
		if (!this.tracedCalls.has(call)) {
			this.tracedCalls.add(call);
			traceMcpCall(this.sessionId, call);
		}
		const intent = this.intents.get(call.stepIndex);
		if (!intent) return;
		if (intent.name !== call.name || !streamedValueMatches(intent.arguments, call.arguments)) {
			const fields = differingToolFields(intent.arguments, call.arguments);
			traceNote(this.sessionId, `harness tool mismatch at step ${call.stepIndex}: streamed ${intent.name}, MCP ${call.name}${fields.length > 0 ? ` — differing fields: ${fields.join(", ")}` : ""}`);
			this.fail(`agy CLI compatibility error: MCP call does not match its streamed tool intent (${call.name}, step ${call.stepIndex}${fields.length > 0 ? `; differing fields: ${fields.join(", ")}` : ""})`);
			return;
		}

		this.intents.delete(call.stepIndex);
		this.admittedSteps.add(call.stepIndex);
		this.admitted = [call];
		this.toolCallIds = [call.id];
		this.turn.admit([{ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments }]);
		this.conversation.push(...structuredClone(conversationForReuse([this.turn.getMessage()])));
		if (this.sessionId) addLiveProcess(this);
		else this.kill(); // No trusted scope: return the batch, then use fresh replay.
	}

	private readonly abort = () => {
		this.turn.fail(ABORT_MESSAGE, "aborted");
		this.kill();
	};

	/** The CLI gave up on a held harness result while the learner-facing turn
	 * was already complete. Retire it silently: the pending question (and its
	 * answer) survives, and the answer turn starts a fresh replay instead of
	 * surfacing a protocol/timeout error the learner cannot act on. */
	private retireWaiting(reason: string): void {
		console.warn(`agy CLI retired while a harness tool result was pending: ${reason}`);
		this.kill();
	}

	private setSignal(signal: AbortSignal | undefined): void {
		this.signal?.removeEventListener("abort", this.abort);
		this.signal = signal;
		signal?.addEventListener("abort", this.abort, { once: true });
		if (signal?.aborted) this.abort();
	}

	private isAllowedImageRead(event: Extract<AgyEvent, { type: "tool" }>): boolean {
		if (event.toolName !== "read_file" && event.toolName !== "view_file") return false;
		const candidate = event.parameters.Path ?? event.parameters.AbsolutePath ?? event.parameters.path ?? event.parameters.file_path;
		if (typeof candidate !== "string") return false;
		const path = relative(resolve(this.files.imageDir), resolve(candidate));
		return path !== "" && !path.startsWith("..") && !isAbsolute(path);
	}

	private handleLine(line: string): void {
		if (this.stopping || this.closed || !line.trim()) return;
		traceCliEvent(this.sessionId, line);
		const event = parseAgyLine(line);
		if (!event) return;

		if (event.type === "init") return;

		if (event.type === "agentResponse") {
			if (this.turn.isFinished) {
				this.retireWaiting("agent response after the held tool call");
				return;
			}
			this.turn.handleAgentResponse(event);
			return;
		}

		if (event.type === "tool") {
			const harnessName = harnessToolFromAgy(event.toolName);

			if (event.state === "ACTIVE") {
				if (this.turn.isFinished) {
					this.retireWaiting("new tool step after the held tool call");
					return;
				}
				if (!harnessName) {
					if (this.isAllowedImageRead(event)) this.allowedNativeSteps.add(event.stepIndex);
					else this.blockedNativeSteps.add(event.stepIndex);
					return;
				}
				if (this.admittedSteps.has(event.stepIndex)) return;
				const intent = { stepIndex: event.stepIndex, name: harnessName, arguments: stripToolSummary(event.parameters) };
				this.intents.set(event.stepIndex, intent);
				traceToolIntent(this.sessionId, intent);
				this.flushAdmissions();
				return;
			}

			if (event.state === "DONE") {
				if (this.admittedSteps.has(event.stepIndex)) {
					if (this.turn.isFinished) this.retireWaiting("held tool call completed before its result was resolved");
					return;
				}
				if (!harnessName) {
					if (this.allowedNativeSteps.has(event.stepIndex)) return;
					this.fail(this.blockedNativeSteps.has(event.stepIndex)
						? "agy CLI executed a native tool outside the harness bridge"
						: "agy CLI executed an undeclared native tool");
					return;
				}
				this.fail("agy CLI moved on without admitting its harness tool call");
				return;
			}

			if (event.state === "ERROR") {
				if (this.admittedSteps.has(event.stepIndex)) {
					if (this.turn.isFinished) this.retireWaiting("CLI failed the held tool call");
					return;
				}
				if (this.cancelledSteps.has(event.stepIndex)) return;
				if (!harnessName) {
					// The hook denied it; the model may retry with the bridge.
					return;
				}
				this.fail(event.error?.message
					? `Antigravity CLI failed its harness tool call before LearnHarness could execute it: ${event.error.message}`
					: "Antigravity CLI failed its harness tool call before LearnHarness could execute it.");
				return;
			}

			return;
		}

		if (event.type === "result") {
			if (this.turn.isFinished) {
				this.retireWaiting("terminal result after the held tool call");
				return;
			}
			if (event.status === "SUCCESS") {
				if (this.admitted.length > 0) {
					this.fail("agy CLI ended while harness tool calls were waiting for results");
					return;
				}
				this.turn.finishSuccess(event);
				this.kill();
				return;
			}
			this.turn.fail(resultError(event), event.status === "CANCELED" || event.status === "INTERRUPTED" ? "aborted" : "error");
			this.kill();
			return;
		}

		// error_message, checkpoint, and unknown steps carry no model input.
	}

	private handleClose(message: string): void {
		if (this.closed) return;
		this.closed = true;
		clearTimeout(this.killTimer);
		removeLiveProcess(this);
		if (this.pendingError) addLiveProcess(this);
		this.signal?.removeEventListener("abort", this.abort);
		if (this.stderr.trim()) console.error("agy CLI stderr:", this.stderr.trim());
		const error = /authentication required|not signed in|login required|unauthorized|\b401\b/i.test(this.stderr)
			? AntigravityCliError.NotSignedIn
			: message;
		this.turn.fail(error, "error");
		removeTurnResources(this.bridge, this.files).catch((error: unknown) => {
			console.error("agy CLI cleanup failed:", error);
		});
	}
}

async function removeTurnResources(bridge: AgyToolBridge, files: AgyTurnFiles): Promise<void> {
	await Promise.all([
		bridge.close(),
		files.cleanup(),
	]);
}

function continueLiveProcess(turn: AgyTurn, owner: symbol, sessionId: string | undefined, configuration: unknown, messages: Message[], signal: AbortSignal | undefined): boolean {
	const assistantIndex = messages.findLastIndex((message) => message.role === "assistant");
	const assistant = messages[assistantIndex];
	if (assistant?.role !== "assistant") return false;
	const ids = assistant.content.flatMap((block) => block.type === "toolCall" ? [block.id] : []);
	const process = getLiveProcess(ids, owner, sessionId);
	if (!(process instanceof AgyProcess)) return false;
	if (process.consumeFailure(owner, turn)) return true;
	const trailing = messages.slice(assistantIndex + 1);
	const results = trailing.filter((message) => message.role === "toolResult");
	if (trailing.length !== results.length || !process.canContinue(owner, sessionId, configuration, messages, results)) {
		process.kill();
		return false;
	}
	process.continueTurn(turn, messages, results, signal);
	return true;
}

function toAgyEnv(): NodeJS.ProcessEnv {
	// Preserve native CLI auth/routing, including launch-environment credentials.
	// The CLI chooses the account and billing method, not LearnHarness.
	return externalCliEnv();
}

async function startProcess(
	runAgy: RunAgy,
	turn: AgyTurn,
	model: Model<Api>,
	effort: string | undefined,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	owner: symbol,
	configuration: unknown,
	env: NodeJS.ProcessEnv,
): Promise<void> {
	if (options?.signal?.aborted) { turn.fail(ABORT_MESSAGE, "aborted"); return; }
	const input = toAgyInput(context.messages);
	if (input.tools.length === 0) {
		console.warn("agy CLI turn started without harness tools; the agent's current tool declarations are empty");
	}
	let cliProcess: AgyProcess | undefined;
	const bridge = await createAgyToolBridge(input.tools, {
		onCall: () => cliProcess?.flushAdmissions(),
		onError: (error) => cliProcess?.fail(error.message),
		onCancel: (call) => cliProcess?.cancelCall(call),
	});
	let files: AgyTurnFiles;
	try {
		files = await createAgyTurnFiles({ systemPrompt: input.systemPrompt, mcp: bridge.mcp, images: input.images });
	} catch (error) {
		await bridge.close();
		throw error;
	}
	if (options?.signal?.aborted) {
		turn.fail(ABORT_MESSAGE, "aborted");
		await removeTurnResources(bridge, files);
		return;
	}

	let child: AgyChild;
	const content = renderAgyContent(input.userContent, files.imagePaths);
	const args = toAgyArgs({ modelId: model.id, effort, logFile: files.logFile });
	traceCliRequest(options?.sessionId, {
		provider: "antigravity-cli",
		model: model.id,
		args,
		systemPrompt: input.systemPrompt,
		tools: input.tools,
		userContent: content,
		imagePaths: files.imagePaths,
	});
	try {
		child = await runAgy(args, {
			cwd: files.cwd,
			env: agyChildEnv(env, files),
			signal: options?.signal,
		});
	} catch (error) {
		await removeTurnResources(bridge, files);
		throw error;
	}

	if (!child) {
		turn.fail(AntigravityCliError.CliNotFound, "error");
		await removeTurnResources(bridge, files);
		return;
	}

	cliProcess = new AgyProcess(child, bridge, files, turn, owner, options?.sessionId, configuration, structuredClone(conversationForReuse(context.messages)));
	cliProcess.start(toAgyStreamJsonLine(content), options?.signal);
}

export function createAntigravityCliStreamFunction(runAgy: RunAgy): StreamFunction<Api, SimpleStreamOptions> {
	const owner = Symbol("antigravity-cli stream owner");
	return (model, context, options) => {
		const stream = createAssistantMessageEventStream();
		const turn = new AgyTurn(stream, model);

		const effort = toAgyEffort(model, options?.reasoning);
		const env = toAgyEnv();
		// An existing child must not retain stale authentication/routing after env changes.
		const configuration = { request: configurationForReuse(model, context, effort), env };
		if (continueLiveProcess(turn, owner, options?.sessionId, configuration, context.messages, options?.signal)) return stream;

		startProcess(runAgy, turn, model, effort, context, options, owner, configuration, env).catch((error: unknown) => {
			console.error("agy CLI turn failed:", error);
			turn.fail(options?.signal?.aborted ? ABORT_MESSAGE : error instanceof AgyLaunchError ? error.message : START_FAILED_MESSAGE, options?.signal?.aborted ? "aborted" : "error");
		});

		return stream;
	};
}

export const streamAntigravityCli = createAntigravityCliStreamFunction(createAgyLauncher());
