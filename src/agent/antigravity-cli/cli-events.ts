import type { JsonObject, Usage } from "@earendil-works/pi-ai";

export type AgyUsage = Partial<Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">>;

export type AgyToolError = { type: string | null; message: string };

export type AgyEvent =
	| { type: "init"; conversationId: string | null; tools: string[]; permissionMode: string | null }
	| { type: "agentResponse"; stepIndex: number; state: string; text: string; usage: AgyUsage | null }
	| {
			type: "tool";
			stepIndex: number;
			state: string;
			toolName: string;
			parameters: JsonObject;
			output: string | null;
			error: AgyToolError | null;
	  }
	| { type: "errorMessage"; stepIndex: number; state: string }
	| { type: "checkpoint"; stepIndex: number; state: string }
	| { type: "otherStep"; stepIndex: number; state: string; stepType: string }
	| {
			type: "result";
			status: string;
			response: string;
			error: string | null;
			usage: AgyUsage | null;
			finishedReason: string | null;
	  };

type RawUsage = {
	input_tokens?: unknown;
	output_tokens?: unknown;
	thinking_tokens?: unknown;
	cache_read_tokens?: unknown;
	cache_write_tokens?: unknown;
	total_tokens?: unknown;
};

type RawToolInfo = {
	name?: unknown;
	parameters?: unknown;
	output?: unknown;
	error?: unknown;
};

type RawStep = {
	conversation_id?: unknown;
	step_index?: unknown;
	state?: unknown;
	step_type?: unknown;
	tool_name?: unknown;
	text_delta?: unknown;
	usage?: unknown;
	tool_info?: unknown;
};

type RawResult = {
	status?: unknown;
	response?: unknown;
	error?: unknown;
	usage?: unknown;
	finished_reason?: unknown;
};

type RawLine = {
	event?: unknown;
	conversation_id?: unknown;
	init?: unknown;
	step_update?: unknown;
	result?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function toUsage(raw: unknown): AgyUsage | null {
	const record = asRecord(raw) as RawUsage | null;
	if (!record) return null;
	const usage: AgyUsage = {};
	if (typeof record.input_tokens === "number" && Number.isSafeInteger(record.input_tokens) && record.input_tokens >= 0) usage.input = record.input_tokens;
	if (typeof record.output_tokens === "number" && Number.isSafeInteger(record.output_tokens) && record.output_tokens >= 0) usage.output = record.output_tokens;
	if (typeof record.cache_read_tokens === "number" && Number.isSafeInteger(record.cache_read_tokens) && record.cache_read_tokens >= 0) usage.cacheRead = record.cache_read_tokens;
	if (typeof record.cache_write_tokens === "number" && Number.isSafeInteger(record.cache_write_tokens) && record.cache_write_tokens >= 0) usage.cacheWrite = record.cache_write_tokens;
	return Object.keys(usage).length > 0 ? usage : null;
}

function toToolError(raw: unknown): AgyToolError | null {
	const record = asRecord(raw);
	if (!record) return null;
	const message = typeof record.message === "string" ? record.message : null;
	const type = typeof record.type === "string" ? record.type : null;
	return message || type ? { type, message: message ?? type ?? "tool failed" } : null;
}

function toToolInfo(raw: unknown): { name: string; parameters: JsonObject; output: string | null; error: AgyToolError | null } | null {
	const record = asRecord(raw) as RawToolInfo | null;
	if (!record) return null;
	const name = typeof record.name === "string" ? record.name : null;
	if (!name) return null;
	const parameters = asRecord(record.parameters) ?? {};
	return {
		name,
		parameters: parameters as JsonObject,
		output: typeof record.output === "string" ? record.output : null,
		error: toToolError(record.error),
	};
}

function parseStep(raw: unknown): AgyEvent | null {
	const step = asRecord(raw) as RawStep | null;
	if (!step) return null;
	const stepIndex = step.step_index;
	const state = step.state;
	const stepType = step.step_type;
	if (typeof stepIndex !== "number" || !Number.isSafeInteger(stepIndex) || stepIndex < 0) return null;
	if (typeof state !== "string" || typeof stepType !== "string") return null;

	if (stepType === "agent_response") {
		return {
			type: "agentResponse",
			stepIndex,
			state,
			text: typeof step.text_delta === "string" ? step.text_delta : "",
			usage: toUsage(step.usage),
		};
	}

	if (stepType === "tool") {
		const info = toToolInfo(step.tool_info);
		if (!info) return null;
		const toolName = typeof step.tool_name === "string" ? step.tool_name : info.name;
		return {
			type: "tool",
			stepIndex,
			state,
			toolName,
			parameters: info.parameters,
			output: info.output,
			error: info.error,
		};
	}

	if (stepType === "error_message") return { type: "errorMessage", stepIndex, state };
	if (stepType === "checkpoint") return { type: "checkpoint", stepIndex, state };
	return { type: "otherStep", stepIndex, state, stepType };
}

function parseResult(raw: unknown): AgyEvent | null {
	const result = asRecord(raw) as RawResult | null;
	if (!result || typeof result.status !== "string") return null;
	return {
		type: "result",
		status: result.status,
		response: typeof result.response === "string" ? result.response : "",
		error: typeof result.error === "string" && result.error.trim() ? result.error : null,
		usage: toUsage(result.usage),
		finishedReason: typeof result.finished_reason === "string" ? result.finished_reason : null,
	};
}

export function parseAgyLine(text: string): AgyEvent | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	const line = asRecord(parsed) as RawLine | null;
	if (!line) return null;

	switch (line.event) {
		case "init": {
			const init = asRecord(line.init);
			const conversationId = typeof line.conversation_id === "string"
				? line.conversation_id
				: typeof init?.conversation_id === "string" ? init.conversation_id : null;
			return {
				type: "init",
				conversationId,
				tools: Array.isArray(init?.tools) ? init.tools.filter((tool): tool is string => typeof tool === "string") : [],
				permissionMode: typeof init?.permission_mode === "string" ? init.permission_mode : null,
			};
		}
		case "step_update":
			return parseStep(line.step_update);
		case "result":
			return parseResult(line.result);
		default:
			return null;
	}
}
