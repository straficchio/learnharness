import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { Type } from "typebox";
import { createAssistantMessageEventStream, type AssistantMessage, type Message, type Tool } from "@earendil-works/pi-ai";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-model-trace-"));
const traceDir = path.join(scratch, "traces");
const originalEnv = process.env;
process.env = {
	...(originalEnv.NODE_TEST_CONTEXT ? { NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT } : {}),
	...(originalEnv.NODE_OPTIONS ? { NODE_OPTIONS: originalEnv.NODE_OPTIONS } : {}),
	NODE_ENV: "test",
	HOME: path.join(scratch, "home"),
	LH_DATA_DIR: path.join(scratch, "data"),
	LH_AUTH_FILE: path.join(scratch, "auth.json"),
};

const trace = await import("../src/agent/model-trace.ts");
const serverTrace = await import("../src/server/model-trace.ts");
const route = await import("../app/api/model-trace/route.ts");

trace.modelTraceDir.current = traceDir;
const originalCap = trace.modelTraceCap.current;

after(() => {
	trace.configureModelTrace(false);
	delete process.env.LH_MODEL_TRACE;
	trace.modelTraceCap.current = originalCap;
	process.env = originalEnv;
	fs.rmSync(scratch, { recursive: true, force: true });
});

function reset(t: { after: (fn: () => void) => void }) {
	trace.configureModelTrace(false);
	delete process.env.LH_MODEL_TRACE;
	trace.modelTraceCap.current = originalCap;
	fs.rmSync(traceDir, { recursive: true, force: true });
	t.after(() => {
		trace.configureModelTrace(false);
		delete process.env.LH_MODEL_TRACE;
		trace.modelTraceCap.current = originalCap;
	});
}

function events(sessionId: string) {
	return trace.readModelTrace(sessionId).events as Array<Record<string, unknown>>;
}

const tool: Tool = {
	name: "read",
	description: "Read a file",
	parameters: Type.Object({ path: Type.String() }),
};

function context(): Parameters<typeof trace.traceRequest>[1]["context"] {
	const system: Message = {
		role: "system",
		content: "SYSTEM PROMPT TEXT",
		toolsAdded: [tool],
		timestamp: 0,
	};
	const user: Message = {
		role: "user",
		content: [{ type: "text", text: "hello" }],
		timestamp: 1,
	};
	return { messages: [system, user] } as unknown as Parameters<typeof trace.traceRequest>[1]["context"];
}

function assistant(text = "world"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "openai",
		model: "test-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
}

test("disabled recorder writes nothing and the environment seam enables it", (t) => {
	reset(t);
	trace.traceNote("off-session", "not recorded");
	assert.deepEqual(trace.readModelTrace("off-session"), { events: [], total: 0 });

	process.env.LH_MODEL_TRACE = "1";
	trace.traceNote("env-session", "recorded");
	const recorded = events("env-session");
	assert.equal(recorded.length, 1);
	assert.equal(recorded[0]!.kind, "note");
	assert.equal(recorded[0]!.note, "recorded");
});

test("request captures the system prompt, tools and messages", (t) => {
	reset(t);
	trace.configureModelTrace(true);
	trace.traceRequest("request-session", {
		provider: "openai",
		model: "test-model",
		context: context(),
		options: { reasoning: "high", temperature: 0.2, apiKey: "SK-NEVER-LEAK", headers: { authorization: "Bearer NEVER" } },
	});
	const [request] = events("request-session");
	assert.ok(request);
	assert.equal(request.kind, "request");
	assert.equal(request.provider, "openai");
	assert.equal(request.model, "test-model");
	assert.equal(request.reasoning, "high");
	assert.equal(request.systemPrompt, "SYSTEM PROMPT TEXT");
	assert.equal((request.tools as unknown[]).length, 1);
	assert.equal((request.messages as unknown[]).length, 1);
	assert.deepEqual(request.options, { reasoning: "high", temperature: 0.2, apiKey: "[redacted]" });
	const raw = fs.readFileSync(path.join(traceDir, "request-session.jsonl"), "utf8");
	assert.equal(raw.includes("SK-NEVER-LEAK"), false);
	assert.equal(raw.includes("Bearer NEVER"), false);
});

test("image bytes are replaced by a size note, nested credential keys are redacted", (t) => {
	reset(t);
	trace.configureModelTrace(true);
	trace.tracePayload("private-session", {
		messages: [{
			role: "user",
			content: [{ type: "image", mediaType: "image/png", data: "A".repeat(64) }],
		}],
		credentials: { apiKey: "NESTED-SECRET" },
	});
	const raw = fs.readFileSync(path.join(traceDir, "private-session.jsonl"), "utf8");
	assert.equal(raw.includes("A".repeat(64)), false);
	assert.equal(raw.includes("NESTED-SECRET"), false);
	assert.match(raw, /\[image 64 base64 chars\]/);
	assert.match(raw, /\[redacted\]/);
});

test("readModelTrace returns a tail from the requested line and the total", (t) => {
	reset(t);
	trace.configureModelTrace(true);
	trace.traceNote("tail-session", "one");
	trace.traceNote("tail-session", "two");
	trace.traceNote("tail-session", "three");
	const tail = trace.readModelTrace("tail-session", 2);
	assert.equal(tail.total, 3);
	assert.deepEqual(tail.events.map((event) => (event as { note?: string }).note), ["three"]);
});

test("a partial trailing append is not counted until it is complete", (t) => {
	reset(t);
	trace.configureModelTrace(true);
	trace.traceNote("partial-session", "complete");
	const file = path.join(traceDir, "partial-session.jsonl");
	fs.appendFileSync(file, '{"kind":"note","note":"partial"');
	assert.equal(trace.readModelTrace("partial-session").total, 1, "the incomplete line waits for the next poll");
	fs.appendFileSync(file, "}\n");
	const tail = trace.readModelTrace("partial-session", 1);
	assert.equal(tail.total, 2);
	assert.equal((tail.events[0] as { note?: string }).note, "partial");
});

test("the per-session cap stops recording and appends one note", (t) => {
	reset(t);
	trace.configureModelTrace(true);
	trace.modelTraceCap.current = 160;
	for (let index = 0; index < 20; index++) trace.traceNote("cap-session", `line ${index} ${"x".repeat(20)}`);
	const all = events("cap-session");
	assert.ok(all.some((event) => typeof event.note === "string" && event.note.startsWith("cap ")));
	assert.ok(all.length < 20, "recording stopped at the cap");
});

test("clear removes the session file and its cached size state", (t) => {
	reset(t);
	trace.configureModelTrace(true);
	trace.traceNote("clear-session", "one");
	assert.equal(fs.existsSync(path.join(traceDir, "clear-session.jsonl")), true);
	trace.clearModelTrace("clear-session");
	assert.deepEqual(trace.readModelTrace("clear-session"), { events: [], total: 0 });
	trace.traceNote("clear-session", "two");
	assert.equal(trace.readModelTrace("clear-session").total, 1);
});

test("traceStream records the request, callbacks, raw events and final response without altering the stream", async (t) => {
	reset(t);
	trace.configureModelTrace(true);
	const payloadSeen: unknown[] = [];
	const responseSeen: number[] = [];
	const providerSeen: unknown[] = [];
	const message = assistant();
	const streamFn: Parameters<typeof trace.traceStream>[0] = (_model, _context, options) => {
		const stream = createAssistantMessageEventStream();
		void (async () => {
			await options?.onPayload?.({ model: "wire", messages: [] }, {} as never);
			await options?.onResponse?.({ status: 200, headers: {} }, {} as never);
			await options?.onProviderStreamEvent?.({ type: "raw-event" }, { provider: "openai", id: "test-model" } as never);
			stream.push({ type: "text_delta", contentIndex: 0, delta: "world", partial: message });
			stream.push({ type: "done", reason: "stop", message });
			stream.end();
		})();
		return stream;
	};
	const traced = trace.traceStream(streamFn, { provider: "openai", id: "test-model" });
	const options = {
		sessionId: "stream-session",
		onPayload: async (payload: unknown) => { payloadSeen.push(payload); },
		onResponse: async (response: { status: number }) => { responseSeen.push(response.status); },
		onProviderStreamEvent: async (event: unknown) => { providerSeen.push(event); },
	};
	const stream = traced({} as never, context() as never, options as never);
	const seen: string[] = [];
	for await (const event of stream) {
		seen.push(event.type);
		if (event.type === "done") assert.deepEqual(event.message, message);
	}
	assert.deepEqual(seen, ["text_delta", "done"]);
	assert.deepEqual(payloadSeen, [{ model: "wire", messages: [] }]);
	assert.deepEqual(responseSeen, [200]);
	assert.deepEqual(providerSeen, [{ type: "raw-event" }]);

	const recorded = events("stream-session");
	const kinds = recorded.map((event) => event.kind);
	for (const kind of ["request", "payload", "http", "provider-event", "response"]) assert.ok(kinds.includes(kind), `missing ${kind}`);
	const http = recorded.find((event) => event.kind === "http");
	assert.equal(http?.status, 200);
	assert.deepEqual((recorded.find((event) => event.kind === "response"))?.message, message);
});

test("CLI helpers record the launch request, raw lines and tool results", (t) => {
	reset(t);
	trace.configureModelTrace(true);
	trace.traceCliRequest("cli-session", {
		provider: "antigravity-cli",
		model: "gemini-3-pro",
		args: ["--model", "gemini-3-pro"],
		systemPrompt: "CLI SYSTEM",
		tools: [tool],
		userContent: "hello",
		imagePaths: ["/tmp/image.png"],
	});
	trace.traceCliEvent("cli-session", '{"type":"step"}');
	trace.traceToolResult("cli-session", {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text", text: "result" }],
		isError: false,
		timestamp: 3,
	});
	const recorded = events("cli-session");
	assert.deepEqual(recorded.map((event) => event.kind), ["cli-request", "cli-event", "tool-result"]);
	assert.equal(recorded[0]!.systemPrompt, "CLI SYSTEM");
	assert.equal(recorded[1]!.line, '{"type":"step"}');
});

test("GET /api/model-trace validates the session and the after index", async (t) => {
	reset(t);
	trace.configureModelTrace(true);
	trace.traceNote("route-session", "visible");

	const missing = await route.GET(new Request("http://localhost/api/model-trace"));
	assert.equal(missing.status, 400);
	const badIndex = await route.GET(new Request("http://localhost/api/model-trace?session=x&after=-1"));
	assert.equal(badIndex.status, 400);
	const badIndex2 = await route.GET(new Request("http://localhost/api/model-trace?session=x&after=1.5"));
	assert.equal(badIndex2.status, 400);

	const ok = await route.GET(new Request("http://localhost/api/model-trace?session=route-session&after=0"));
	assert.equal(ok.status, 200);
	assert.equal(ok.headers.get("cache-control"), "no-store");
	const body = await ok.json() as { enabled: boolean; total: number; events: Array<{ note?: string }> };
	assert.equal(body.enabled, true);
	assert.equal(body.total, 1);
	assert.equal(body.events[0]?.note, "visible");
});

test("DELETE /api/model-trace clears one session and leaves others alone", async (t) => {
	reset(t);
	trace.configureModelTrace(true);
	trace.traceNote("delete-session", "remove");
	trace.traceNote("keep-session", "keep");
	const deleted = await route.DELETE(new Request("http://localhost/api/model-trace?session=delete-session", { method: "DELETE" }));
	assert.equal(deleted.status, 200);
	assert.equal(trace.readModelTrace("delete-session").total, 0);
	assert.equal(trace.readModelTrace("keep-session").total, 1);
	assert.equal(serverTrace.modelTraceSnapshot("keep-session").enabled, true);
});
