/**
 * Antigravity CLI provider driven through the real chat handler: a learner
 * question ends the turn while the agy process waits on the held MCP call,
 * and the learner's answer arrives later as that call's tool result.
 *
 * The runAgy seam spawns tests/fixtures/antigravity-cli/fake-agy.mjs, one
 * scenario per spawn, so the spawn count shows whether the answer continued
 * the waiting process or started a fresh one with a replay.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test, { after, type TestContext } from "node:test";

import type { RunAgy } from "../src/agent/antigravity-cli/stream.ts";
import type { PiEngine } from "../src/agent/models.ts";

const testData = mkdtempSync(join(tmpdir(), "lh-agy-harness-data-"));
process.env.LH_DATA_DIR = testData;
after(() => rmSync(testData, { recursive: true, force: true }));

const { PATHS, SETTINGS_FILE } = await import("../config.ts");
const { readSettings, writeSettings } = await import("../src/store/settings.ts");
const { AGY_LIVE_PROCESS_IDLE_TIMEOUT_MS, liveProcessIdleTimeoutMs } = await import("../src/agent/antigravity-cli/live-processes.ts");
const { DEFAULT_AGY_MODELS, toAgyModel, resetAgyModelDiscovery } = await import("../src/agent/antigravity-cli/model-discovery.ts");
const { createAntigravityCliStreamFunction } = await import("../src/agent/antigravity-cli/stream.ts");
const { setAntigravityModels } = await import("../src/agent/models.ts");
const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { danglingQuestionOf } = await import("../src/core/native-messages.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { isTurnRunning } = await import("../src/server/turn-liveness.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { chatStore } = await import("../src/store/chats.ts");

const FAKE_AGY = fileURLToPath(new URL("./fixtures/antigravity-cli/fake-agy.mjs", import.meta.url));
const TURN_TIMEOUT_MS = 10_000;
const ASK_ID = "00000000-0000-4000-8000-000000000001:2";
const ASK_INPUT = { question: "What do you already know about sockets?" };
const ANSWER_TEXT = "Only that they carry bytes between programs";
const MODEL = toAgyModel({ id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", efforts: ["low", "medium", "high"] });

type FakeRun = { runAgy: RunAgy; children: ChildProcessWithoutNullStreams[]; stdinFiles: string[] };

function toAskScenario(): string[] {
	return [
		JSON.stringify({ fake: "call", stepIndex: 2, name: "ask_user_question", arguments: ASK_INPUT, progressToken: ASK_ID }),
		JSON.stringify({ fake: "text", stepIndex: 3, text: "Got it." }),
		JSON.stringify({ fake: "result", status: "SUCCESS", response: "Got it." }),
	];
}

function createFakeRun(t: TestContext, scenarios: string[][]): FakeRun {
	const previous = readSettings();
	const path = process.env.PATH;
	const dir = mkdtempSync(join(tmpdir(), "agy-harness-"));
	// Satisfy the real presence gate; this marker is NEVER executed. All work
	// below goes through the injected fake-CLI seam.
	writeFileSync(join(dir, process.platform === "win32" ? "agy.exe" : "agy"), "", { mode: 0o755 });
	process.env.PATH = `${dir}${delimiter}${path ?? ""}`;
	writeSettings({ ...(previous ?? { version: 1 }), antigravityCli: { enabled: true } });
	setAntigravityModels([...DEFAULT_AGY_MODELS, MODEL]);

	t.after(() => {
		if (previous) writeSettings(previous); else rmSync(SETTINGS_FILE, { force: true });
		if (path === undefined) delete process.env.PATH; else process.env.PATH = path;
		rmSync(dir, { recursive: true, force: true });
		setAntigravityModels(DEFAULT_AGY_MODELS);
		resetAgyModelDiscovery();
	});

	const children: ChildProcessWithoutNullStreams[] = [];
	const stdinFiles: string[] = [];

	const runAgy: RunAgy = (args, options) => {
		const scenario = scenarios[children.length];
		assert.ok(scenario, `unexpected spawn #${children.length + 1}`);

		const scenarioFile = join(dir, `scenario-${children.length}.jsonl`);
		const stdinFile = join(dir, `stdin-${children.length}.jsonl`);
		writeFileSync(scenarioFile, `${scenario.join("\n")}\n`);

		const child = spawn(process.execPath, [FAKE_AGY, ...args], {
			cwd: options.cwd,
			env: { ...options.env, FAKE_AGY_SCENARIO: scenarioFile, FAKE_AGY_STDIN: stdinFile },
			stdio: ["pipe", "pipe", "pipe"],
		}) as ChildProcessWithoutNullStreams;
		t.after(() => child.kill("SIGKILL"));

		children.push(child);
		stdinFiles.push(stdinFile);
		return child;
	};

	return { runAgy, children, stdinFiles };
}

function createChat(t: TestContext): string {
	const chat = chatStore.createChat("Antigravity CLI: question answered later");
	chatStore.saveSettings(chat.id, { model: { provider: "antigravity-cli", id: "gemini-3.8-flash" } });
	t.after(() => unlinkSync(join(PATHS.chats, `${chat.id}.json`)));
	return chat.id;
}

function createAgentFactory(fakeRun: FakeRun): Parameters<typeof handleChatRequest>[1] {
	const engine: PiEngine = { model: MODEL, streamFn: createAntigravityCliStreamFunction(fakeRun.runAgy) };
	return (options) => createTeacherAgent(undefined, { engine, chatId: options.chatId, messages: options.messages });
}

async function runChatTurn(chatId: string, input: object, agentFactory: Parameters<typeof handleChatRequest>[1]): Promise<void> {
	const request = new Request("http://test/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId, input }),
	});
	const ack = await handleChatRequest(request, agentFactory);
	assert.equal(ack.status, 200, await ack.clone().text());

	const handle = runningTurn(chatId);
	if (handle) await new Response(handle.subscribe()).text();

	const deadline = Date.now() + TURN_TIMEOUT_MS;
	while (isTurnRunning(chatId)) {
		assert.ok(Date.now() < deadline, "turn did not settle");
		await sleep(10);
	}
}

function toAnswerInput() {
	return {
		type: "answer",
		toolCallId: ASK_ID,
		answer: { kind: "ask", questionText: ASK_INPUT.question, dontKnow: false, answers: [], text: ANSWER_TEXT, answeredAt: new Date().toISOString() },
	};
}

function getLastAssistantText(chatId: string): string {
	const messages = chatStore.getChat(chatId)?.messages ?? [];
	const assistant = messages.findLast((message) => message.role === "assistant");
	assert.ok(assistant?.role === "assistant");
	return assistant.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await once(child, "exit", { signal: AbortSignal.timeout(TURN_TIMEOUT_MS) });
}

test("a question answered before the idle timeout continues the waiting agy process with the answer", async (t) => {
	const fakeRun = createFakeRun(t, [toAskScenario()]);
	const agentFactory = createAgentFactory(fakeRun);
	const chatId = createChat(t);

	await runChatTurn(chatId, { type: "text", text: "teach me sockets" }, agentFactory);

	assert.equal(danglingQuestionOf(chatStore.getChat(chatId)?.messages ?? [])?.toolCallId, ASK_ID);
	const [waiting] = fakeRun.children;
	assert.ok(waiting);
	assert.equal(waiting.exitCode, null, "the agy process should wait on the held question call");

	await runChatTurn(chatId, toAnswerInput(), agentFactory);

	assert.equal(fakeRun.children.length, 1, "the held process must be reused");
	assert.equal(getLastAssistantText(chatId), "Got it.");
	assert.equal(danglingQuestionOf(chatStore.getChat(chatId)?.messages ?? []), null);
	await waitForExit(waiting);
});

test("a question answered after the idle timeout starts a fresh process that replays the question and answer", async (t) => {
	liveProcessIdleTimeoutMs.current = 300;
	t.after(() => (liveProcessIdleTimeoutMs.current = AGY_LIVE_PROCESS_IDLE_TIMEOUT_MS));

	const fakeRun = createFakeRun(t, [
		toAskScenario(),
		[JSON.stringify({ fake: "text", stepIndex: 1, text: "Got it after replay" }), JSON.stringify({ fake: "result", status: "SUCCESS", response: "Got it after replay" })],
	]);
	const agentFactory = createAgentFactory(fakeRun);
	const chatId = createChat(t);

	await runChatTurn(chatId, { type: "text", text: "teach me sockets" }, agentFactory);
	const [waiting] = fakeRun.children;
	assert.ok(waiting);
	await waitForExit(waiting);

	await runChatTurn(chatId, toAnswerInput(), agentFactory);

	assert.equal(fakeRun.children.length, 2);
	assert.equal(getLastAssistantText(chatId), "Got it after replay");
	const replay = readFileSync(fakeRun.stdinFiles[1] ?? "", "utf8");
	assert.match(replay, /\[tool call ask_user_question\]/);
	assert.match(replay, /What do you already know about sockets\?/);
	assert.match(replay, /\[tool result ask_user_question\]/);
	assert.match(replay, /Only that they carry bytes between programs/);
});
