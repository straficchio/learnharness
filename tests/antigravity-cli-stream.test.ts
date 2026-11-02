import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";

import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Message,
	SimpleStreamOptions,
	StreamFunction,
	Api,
	Tool,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";

import { toAgyModel } from "../src/agent/antigravity-cli/model-discovery.ts";
import { createAntigravityCliStreamFunction, toAgyArgs, toAgyEffort, type RunAgy } from "../src/agent/antigravity-cli/stream.ts";
import { AGY_LIVE_PROCESS_IDLE_TIMEOUT_MS } from "../src/agent/antigravity-cli/live-processes.ts";

const FAKE_AGY = fileURLToPath(new URL("./fixtures/antigravity-cli/fake-agy.mjs", import.meta.url));
const CLEANUP_TIMEOUT_MS = 3000;
const SESSION_ID = "agy-stream-test";
const PROGRESS_TOKEN = "00000000-0000-4000-8000-000000000001:2";

const MODEL = toAgyModel({ id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", efforts: ["low", "medium", "high"] });
const READ_TOOL: Tool = { name: "read", description: "Read a file", parameters: { type: "object", properties: {} } };
const ECHO_TOOL: Tool = { name: "echo", description: "Echo text", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } };
const OTHER_TOOL: Tool = { name: "other", description: "Other tool", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } };
const HI: Message = { role: "user", content: "hi", timestamp: 0 };

type RunCall = {
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	child: ChildProcessWithoutNullStreams;
};

function createFakeRun(t: TestContext, scenario: string[] | string[][]): { runAgy: RunAgy; calls: RunCall[] } {
	const dir = mkdtempSync(join(tmpdir(), "agy-stream-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const scenarios = scenario.length === 0 || typeof scenario[0] === "string"
		? [scenario as string[]]
		: scenario as string[][];

	const calls: RunCall[] = [];
	const runAgy: RunAgy = (args, options) => {
		const current = scenarios[calls.length];
		assert.ok(current, `unexpected spawn #${calls.length + 1}`);
		const scenarioFile = join(dir, `scenario-${calls.length}.jsonl`);
		writeFileSync(scenarioFile, `${current.join("\n")}\n`);
		const child = spawn(process.execPath, [FAKE_AGY, ...args], {
			cwd: options.cwd,
			env: { ...options.env, FAKE_AGY_SCENARIO: scenarioFile },
			stdio: ["pipe", "pipe", "pipe"],
		}) as ChildProcessWithoutNullStreams;
		t.after(() => child.kill("SIGKILL"));
		calls.push({ args, cwd: options.cwd, env: options.env, child });
		return child;
	};

	return { runAgy, calls };
}

async function collectEvents(
	stream: AssistantMessageEventStream,
	onEvent: (event: AssistantMessageEvent) => void = () => {},
): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
		onEvent(event);
	}
	return events;
}

function getLastEvent(events: AssistantMessageEvent[]): AssistantMessageEvent {
	const event = events.at(-1);
	assert.ok(event);
	return event;
}

function getDone(events: AssistantMessageEvent[]): Extract<AssistantMessageEvent, { type: "done" }> {
	const event = getLastEvent(events);
	assert.equal(event.type, "done");
	return event as Extract<AssistantMessageEvent, { type: "done" }>;
}

function getError(events: AssistantMessageEvent[]): Extract<AssistantMessageEvent, { type: "error" }> {
	const event = getLastEvent(events);
	assert.equal(event.type, "error");
	return event as Extract<AssistantMessageEvent, { type: "error" }>;
}

function getText(message: AssistantMessage): string {
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

const streamFunctions = new WeakMap<RunAgy, StreamFunction<Api, SimpleStreamOptions>>();

function streamFor(runAgy: RunAgy): StreamFunction<Api, SimpleStreamOptions> {
	let streamFn = streamFunctions.get(runAgy);
	if (!streamFn) {
		streamFn = createAntigravityCliStreamFunction(runAgy);
		streamFunctions.set(runAgy, streamFn);
	}
	return streamFn;
}

async function runTurn(
	runAgy: RunAgy,
	messages: Message[],
	tools: Tool[] = [READ_TOOL],
	options: SimpleStreamOptions = {},
): Promise<AssistantMessageEvent[]> {
	const context = normalizeContext({ systemPrompt: "You are a tutor.", messages, tools });
	return collectEvents(streamFor(runAgy)(MODEL, context, { sessionId: SESSION_ID, reasoning: "medium", ...options }));
}

function toToolResult(call: Extract<AssistantMessage["content"][number], { type: "toolCall" }>, text = "ECHO:hi"): ToolResultMessage {
	return { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text }], isError: false, timestamp: 0 };
}

async function waitForRemoval(path: string): Promise<void> {
	const deadline = Date.now() + CLEANUP_TIMEOUT_MS;
	while (existsSync(path)) {
		assert.ok(Date.now() < deadline, `${path} was not removed`);
		await sleep(10);
	}
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await assert.doesNotReject(once(child, "exit", { signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) }), "agy process was not killed");
}

test("toAgyArgs uses stream-json, waits without a print deadline, and omits CLI default model/effort", () => {
	assert.deepEqual(toAgyArgs({ modelId: "gemini-3.8-flash", effort: "high", logFile: "/private/agy.log" }), [
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"--print-timeout", "0",
		"--disable-slash-commands",
		"--log-file", "/private/agy.log",
		"--model", "gemini-3.8-flash",
		"--effort", "high",
	]);
	assert.deepEqual(toAgyArgs({ modelId: "default", effort: undefined, logFile: "/private/agy.log" }), [
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"--print-timeout", "0",
		"--disable-slash-commands",
		"--log-file", "/private/agy.log",
	]);
});

test("toAgyEffort maps advertised efforts and clamps unsupported levels to the nearest", () => {
	assert.equal(toAgyEffort(MODEL, "high"), "high");
	assert.equal(toAgyEffort(MODEL, "xhigh"), "high");
	assert.equal(toAgyEffort(MODEL, "minimal"), "low");
	assert.equal(toAgyEffort(MODEL, undefined), undefined);

	const mediumOnly = toAgyModel({ id: "gpt-oss-120b", name: "GPT-OSS 120B", efforts: ["medium"] });
	assert.equal(toAgyEffort(mediumOnly, "high"), "medium");
	assert.equal(toAgyEffort(mediumOnly, "low"), "medium");
});

test("text scenario streams agent-response deltas and per-step usage, not the cumulative result usage", async (t) => {
	const { runAgy, calls } = createFakeRun(t, [
		JSON.stringify({ fake: "text", stepIndex: 1, text: "hello there", usage: { input_tokens: 7, output_tokens: 3, cache_read_tokens: 2, cache_write_tokens: 1, total_tokens: 13 } }),
		JSON.stringify({ fake: "result", status: "SUCCESS", response: "hello there", usage: { input_tokens: 900, output_tokens: 90, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 990 } }),
	]);

	const events = await runTurn(runAgy, [HI]);
	const done = getDone(events);

	assert.equal(done.reason, "stop");
	assert.equal(getText(done.message), "hello there");
	assert.deepEqual({ input: done.message.usage.input, output: done.message.usage.output, cacheRead: done.message.usage.cacheRead, cacheWrite: done.message.usage.cacheWrite, totalTokens: done.message.usage.totalTokens }, {
		input: 7, output: 3, cacheRead: 2, cacheWrite: 1, totalTokens: 13,
	});
	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.cwd.includes("agy-cwd-"), true);
	assert.equal(calls[0]!.env.HOME?.includes("agy-home-"), true);
	const mcpConfig = JSON.parse(readFileSync(join(calls[0]!.env.HOME!, ".gemini", "config", "mcp_config.json"), "utf8"));
	assert.equal(mcpConfig.mcpServers.learnharness.timeoutSeconds, 1800);
	assert.equal(mcpConfig.mcpServers.learnharness.type, "http");
	assert.equal(typeof mcpConfig.mcpServers.learnharness.url, "string");
	assert.equal(typeof mcpConfig.mcpServers.learnharness.headers.Authorization, "string");
	assert.equal(statSync(join(calls[0]!.env.HOME!, ".gemini", "config", "mcp_config.json")).mode & 0o777, 0o600);
	assert.equal(readFileSync(join(calls[0]!.env.HOME!, ".gemini", "config", "hooks.json"), "utf8").includes("PreToolUse"), true);
	const rulesDir = join(calls[0]!.env.HOME!, ".gemini", "config", "rules");
	const preamble = readFileSync(join(rulesDir, "00-tool-bridge.md"), "utf8");
	assert.match(preamble, /trigger: always_on/);
	assert.match(preamble, /mcp_learnharness_/);
	assert.match(preamble, /mcp_learnharness_probe/);
	const rules = readFileSync(join(rulesDir, "01-learnharness.md"), "utf8");
	assert.match(rules, /trigger: always_on/);
	assert.match(rules, /You are a tutor\./);
	const gate = readFileSync(join(calls[0]!.env.HOME!, "private", "gate.mjs"), "utf8");
	assert.match(gate, /mcp_learnharness_<name>/);
});

test("a held MCP tool call returns control to Pi and the same process continues with its result", async (t) => {
	const { runAgy, calls } = createFakeRun(t, [
		JSON.stringify({ fake: "call", stepIndex: 2, name: "echo", arguments: { text: "hi" }, progressToken: PROGRESS_TOKEN, output: "ECHO:hi" }),
		JSON.stringify({ fake: "text", stepIndex: 3, text: "got ECHO:hi" }),
		JSON.stringify({ fake: "result", status: "SUCCESS", response: "got ECHO:hi" }),
	]);

	const first = await runTurn(runAgy, [HI], [ECHO_TOOL]);
	const firstDone = getDone(first);
	assert.equal(firstDone.reason, "toolUse");
	const call = firstDone.message.content.find((block) => block.type === "toolCall");
	assert.ok(call?.type === "toolCall");
	assert.equal(call.id, PROGRESS_TOKEN);
	assert.equal(call.name, "echo");
	assert.deepEqual(call.arguments, { text: "hi" });

	const second = await runTurn(runAgy, [HI, firstDone.message, toToolResult(call)], [ECHO_TOOL]);
	const secondDone = getDone(second);
	assert.equal(secondDone.reason, "stop");
	assert.equal(getText(secondDone.message), "got ECHO:hi");
	assert.equal(calls.length, 1, "the held process must be reused, not replayed");

	await waitForExit(calls[0]!.child);
	await waitForRemoval(calls[0]!.cwd);
	await waitForRemoval(calls[0]!.env.HOME!);
});

test("a fresh session replays the transcript instead of reusing another process", async (t) => {
	let run = 0;
	const scenarios = [
		[JSON.stringify({ fake: "call", stepIndex: 2, name: "echo", arguments: { text: "hi" }, progressToken: PROGRESS_TOKEN, output: "ECHO:hi" })],
		[JSON.stringify({ fake: "text", stepIndex: 1, text: "replayed" }), JSON.stringify({ fake: "result", status: "SUCCESS", response: "replayed" })],
	];
	const dir = mkdtempSync(join(tmpdir(), "agy-replay-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const scenarioFiles = scenarios.map((scenario, index) => {
		const file = join(dir, `scenario-${index}.jsonl`);
		writeFileSync(file, `${scenario.join("\n")}\n`);
		return file;
	});
	const calls: RunCall[] = [];
	const runAgy: RunAgy = (args, options) => {
		const child = spawn(process.execPath, [FAKE_AGY, ...args], {
			cwd: options.cwd,
			env: { ...options.env, FAKE_AGY_SCENARIO: scenarioFiles[run]! },
			stdio: ["pipe", "pipe", "pipe"],
		}) as ChildProcessWithoutNullStreams;
		t.after(() => child.kill("SIGKILL"));
		calls.push({ args, cwd: options.cwd, env: options.env, child });
		run++;
		return child;
	};

	const first = await runTurn(runAgy, [HI], [ECHO_TOOL]);
	const firstDone = getDone(first);
	const call = firstDone.message.content.find((block) => block.type === "toolCall");
	assert.ok(call?.type === "toolCall");

	const second = await runTurn(runAgy, [HI, firstDone.message, toToolResult(call)], [ECHO_TOOL], { sessionId: "different-session" });
	const secondDone = getDone(second);
	assert.equal(secondDone.reason, "stop");
	assert.equal(getText(secondDone.message), "replayed");
	assert.equal(calls.length, 2);
});

test("a native tool that actually executes fails the turn closed", async (t) => {
	const { runAgy } = createFakeRun(t, [
		JSON.stringify({ fake: "native", stepIndex: 2, name: "run_command", arguments: { CommandLine: "touch /tmp/nope" }, state: "DONE", output: "ok" }),
	]);
	const events = await runTurn(runAgy, [HI]);
	const error = getError(events);
	assert.match(error.error.errorMessage ?? "", /native tool outside the harness bridge/);
});

test("a denied native tool is ignored and the model can continue with harness work", async (t) => {
	const { runAgy } = createFakeRun(t, [
		JSON.stringify({ fake: "native", stepIndex: 2, name: "run_command", arguments: { CommandLine: "touch /tmp/nope" }, state: "ERROR", message: "denied by hook" }),
		JSON.stringify({ fake: "text", stepIndex: 3, text: "recovered" }),
		JSON.stringify({ fake: "result", status: "SUCCESS", response: "recovered" }),
	]);
	const events = await runTurn(runAgy, [HI]);
	assert.equal(getDone(events).reason, "stop");
});

test("image reads are allowed only inside the turn's image directory", async (t) => {
	const { runAgy, calls } = createFakeRun(t, [
		JSON.stringify({ fake: "native", stepIndex: 2, name: "read_file", arguments: { Path: "$LH_AGY_IMAGE_DIR/image-0.png" }, state: "DONE", output: "image" }),
		JSON.stringify({ fake: "text", stepIndex: 3, text: "white" }),
		JSON.stringify({ fake: "result", status: "SUCCESS", response: "white" }),
	]);
	const image: Message = {
		role: "user",
		content: [{ type: "text", text: "describe" }, { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=" }],
		timestamp: 0,
	};
	const events = await runTurn(runAgy, [image]);
	assert.equal(getDone(events).reason, "stop");
	const home = calls[0]!.env.HOME!;
	const imagePath = join(home, "private", "images", "image-0.png");
	assert.equal(existsSync(imagePath), true);
});

test("deleting the image directory path is not enough: traversal outside it fails closed", async (t) => {
	const { runAgy } = createFakeRun(t, [
		JSON.stringify({ fake: "native", stepIndex: 2, name: "read_file", arguments: { Path: "$LH_AGY_IMAGE_DIR/../../etc/passwd" }, state: "DONE", output: "root" }),
	]);
	const events = await runTurn(runAgy, [HI]);
	assert.match(getError(events).error.errorMessage ?? "", /native tool outside the harness bridge/);
});

test("an MCP call without a progressToken fails closed", async (t) => {
	const { runAgy } = createFakeRun(t, [
		JSON.stringify({ fake: "call", stepIndex: 2, name: "echo", arguments: { text: "hi" } }),
	]);
	const events = await runTurn(runAgy, [HI], [ECHO_TOOL]);
	assert.match(getError(events).error.errorMessage ?? "", /progressToken/);
});

test("an MCP call whose tool does not match the streamed intent fails closed", async (t) => {
	const { runAgy } = createFakeRun(t, [
		JSON.stringify({ fake: "call", stepIndex: 2, streamName: "echo", name: "other", arguments: { text: "hi" }, progressToken: PROGRESS_TOKEN }),
	]);
	const events = await runTurn(runAgy, [HI], [ECHO_TOOL, OTHER_TOOL]);
	assert.match(getError(events).error.errorMessage ?? "", /does not match/);
});

test("argument drift between the streamed intent and the MCP call names the differing fields", async (t) => {
	const { runAgy } = createFakeRun(t, [
		JSON.stringify({
			fake: "call", stepIndex: 2, name: "echo",
			streamArguments: { text: "streamed" }, arguments: { text: "actual" },
			progressToken: PROGRESS_TOKEN,
		}),
	]);
	const events = await runTurn(runAgy, [HI], [ECHO_TOOL]);
	const message = getError(events).error.errorMessage ?? "";
	assert.match(message, /does not match/);
	assert.match(message, /differing fields: text/);
});

test("abort kills the child and ends the stream as aborted", async (t) => {
	const { runAgy, calls } = createFakeRun(t, [JSON.stringify({ fake: "hold" })]);
	const controller = new AbortController();
	const context = normalizeContext({ systemPrompt: "You are a tutor.", messages: [HI], tools: [READ_TOOL] });
	const stream = createAntigravityCliStreamFunction(runAgy)(MODEL, context, { sessionId: SESSION_ID, signal: controller.signal });
	setTimeout(() => controller.abort(), 150);
	const events = await collectEvents(stream);
	const error = getError(events);
	assert.equal(error.reason, "aborted");
	assert.equal(calls.length, 1);
	await waitForExit(calls[0]!.child);
});

test("error results surface the CLI message and preserve unsupported failures", async (t) => {
	const { runAgy } = createFakeRun(t, [
		JSON.stringify({ fake: "result", status: "ERROR", error: "invalid model selection (--model \"nope\")" }),
	]);
	const events = await runTurn(runAgy, [HI]);
	assert.match(getError(events).error.errorMessage ?? "", /invalid model selection/);
});

test("the CLI giving up on a held question call retires quietly and the answer replays", async (t) => {
	const { runAgy, calls } = createFakeRun(t, [
		[JSON.stringify({ fake: "abandon", stepIndex: 2, name: "echo", arguments: { text: "hi" }, progressToken: PROGRESS_TOKEN, message: "request terminated without response" })],
		[JSON.stringify({ fake: "text", stepIndex: 1, text: "replayed answer" }), JSON.stringify({ fake: "result", status: "SUCCESS", response: "replayed answer" })],
	]);

	const first = await runTurn(runAgy, [HI], [ECHO_TOOL]);
	const firstDone = getDone(first);
	assert.equal(firstDone.reason, "toolUse");
	const call = firstDone.message.content.find((block) => block.type === "toolCall");
	assert.ok(call?.type === "toolCall");

	await waitForExit(calls[0]!.child);
	assert.equal(calls[0]!.child.exitCode !== null || calls[0]!.child.signalCode !== null, true, "the abandoned process must be retired");

	const second = await runTurn(runAgy, [HI, firstDone.message, toToolResult(call)], [ECHO_TOOL]);
	const secondDone = getDone(second);
	assert.equal(calls.length, 2, "the answer must start a fresh replay, not reuse the abandoned process");
	assert.equal(secondDone.reason, "stop");
	assert.equal(getText(secondDone.message), "replayed answer");
});

test("authentication failures map to the not-signed-in message", async (t) => {
	const { runAgy } = createFakeRun(t, [
		JSON.stringify({ fake: "result", status: "ERROR", error: "authentication required" }),
	]);
	const events = await runTurn(runAgy, [HI]);
	assert.equal(getError(events).error.errorMessage, "not signed in");
});

test("an authentication stderr on process exit maps to the not-signed-in message", async (t) => {
	const { runAgy } = createFakeRun(t, [
		JSON.stringify({ fake: "exit", code: 1, stderr: "authentication required" }),
	]);
	const events = await runTurn(runAgy, [HI]);
	assert.equal(getError(events).error.errorMessage, "not signed in");
});

test("the live-process retention is bounded below the CLI's MCP ceiling", () => {
	assert.equal(AGY_LIVE_PROCESS_IDLE_TIMEOUT_MS, 10 * 60_000);
});
