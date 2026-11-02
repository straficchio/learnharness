import assert from "node:assert/strict";
import test from "node:test";

import type { Message, Tool } from "@earendil-works/pi-ai";

import { renderAgyContent, toAgyInput, toAgyStreamJsonLine } from "../src/agent/antigravity-cli/transcript.ts";

const TOOL: Tool = { name: "read", description: "Read", parameters: { type: "object", properties: {} } };
const SYSTEM: Message = { role: "system", content: "You are a tutor.", toolsAdded: [TOOL], timestamp: 0 } as Message;
const IMAGE = { type: "image" as const, mimeType: "image/png", data: "AAAA" };

test("a single user message is replayed unlabelled", () => {
	const input = toAgyInput([{ role: "user", content: "hello", timestamp: 0 }]);
	assert.equal(input.userContent, "hello");
	assert.equal(input.systemPrompt, "");
	assert.deepEqual(input.images, []);
});

test("replays user, assistant tool calls, and tool results with explicit labels", () => {
	const messages: Message[] = [
		SYSTEM,
		{ role: "user", content: "find the answer", timestamp: 0 },
		{ role: "assistant", content: [{ type: "text", text: "checking" }, { type: "toolCall", id: "call-1", name: "read", arguments: { path: "notes.md" } }], timestamp: 0 } as Message,
		{ role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "the answer is 42" }], isError: false, timestamp: 0 },
	];
	const input = toAgyInput(messages);
	assert.equal(input.systemPrompt, "You are a tutor.");
	assert.deepEqual(input.tools.map((tool) => tool.name), ["read"]);
	assert.match(input.userContent, /\[user\]\nfind the answer/);
	assert.match(input.userContent, /\[assistant\]\nchecking/);
	assert.match(input.userContent, /\[tool call read\] \{"path":"notes.md"\}/);
	assert.match(input.userContent, /\[tool result read\]\nthe answer is 42/);
});

test("tool errors are labelled and images become ordered render markers", () => {
	const input = toAgyInput([
		SYSTEM,
		{ role: "user", content: [{ type: "text", text: "look" }, IMAGE], timestamp: 0 },
		{ role: "toolResult", toolCallId: "call-1", toolName: "read", content: [IMAGE, { type: "text", text: "failed" }], isError: true, timestamp: 0 },
	]);
	assert.deepEqual(input.images, [
		{ mimeType: "image/png", data: "AAAA" },
		{ mimeType: "image/png", data: "AAAA" },
	]);
	assert.match(input.userContent, /\u0001LH_IMAGE_0\u0001/);
	assert.match(input.userContent, /\u0001LH_IMAGE_1\u0001/);
	assert.match(input.userContent, /\[tool result read error\]/);
	assert.match(input.userContent, /Images are available at the local paths/);

	const rendered = renderAgyContent(input.userContent, ["/tmp/image-0.png", "/tmp/image-1.png"]);
	assert.match(rendered, /\[image: \/tmp\/image-0\.png\]/);
	assert.match(rendered, /\[image: \/tmp\/image-1\.png\]/);
	assert.equal(rendered.includes("LH_IMAGE"), false);
});

test("a missing image path renders an explicit unavailable marker", () => {
	assert.equal(renderAgyContent("before \u0001LH_IMAGE_3\u0001 after", []), "before [image unavailable] after");
});

test("stream-json input uses the CLI's user event shape", () => {
	assert.equal(toAgyStreamJsonLine("hello"), JSON.stringify({ event: "user", message: { content: "hello" } }));
});
