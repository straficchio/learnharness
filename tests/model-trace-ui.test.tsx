import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { ModelTraceDrawer } from "../components/model-trace-drawer.tsx";
import { DeveloperSection } from "../components/settings/developer-section.tsx";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
});
const originalFetch = globalThis.fetch;
let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	root = undefined;
	host = undefined;
	globalThis.fetch = originalFetch;
});

const requestEvent = {
	kind: "request",
	provider: "openai",
	model: "test-model",
	reasoning: "high",
	systemPrompt: "SYSTEM TRACE PROMPT",
	tools: [{ name: "read" }, { name: "write" }],
	messages: [{ role: "user", content: [{ type: "text", text: "question" }] }],
	options: { reasoning: "high" },
};
const cliRequestEvent = {
	kind: "cli-request",
	provider: "antigravity-cli",
	model: "gemini-3-pro",
	args: ["--model", "gemini-3-pro"],
	systemPrompt: "CLI TRACE PROMPT",
	tools: [{ name: "read" }],
	userContent: "cli question",
};
const responseEvent = {
	kind: "response",
	message: {
		role: "assistant",
		content: [{ type: "text", text: "TRACE RESPONSE TEXT" }],
		usage: { input: 3, output: 4, totalTokens: 7 },
		stopReason: "stop",
	},
};

function fixture(body: unknown = { enabled: true, total: 3, events: [requestEvent, cliRequestEvent, responseEvent] }, failSettings = false, failDelete = false) {
	const calls: string[] = [];
	let enabled = true;
	let events = (body as { events?: unknown[] }).events ?? [];
	globalThis.fetch = (async (url, init) => {
		const method = init?.method ?? "GET";
		calls.push(`${method} ${url}`);
		if (url === "/api/settings/developer") {
			if (failSettings) return new Response(null, { status: 500 });
			enabled = JSON.parse(String(init?.body)).modelTrace;
			return Response.json({ settings: { version: 1, developer: { modelTrace: enabled } } });
		}
		if (method === "DELETE") {
			if (failDelete) return new Response(null, { status: 500 });
			events = [];
			return Response.json({ ok: true });
		}
		return Response.json({ enabled, total: events.length, events });
	}) as typeof fetch;
	return calls;
}

async function mount(node: React.ReactNode) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(<>{node}</>));
}

test("a closed drawer renders nothing and makes no requests", () => {
	const calls: string[] = [];
	globalThis.fetch = (async (url) => { calls.push(String(url)); return Response.json({}); }) as typeof fetch;
	const html = renderToStaticMarkup(<ModelTraceDrawer chatId="chat-1" title="Session" open={false} onClose={() => {}} />);
	assert.equal(html, "");
	assert.deepEqual(calls, []);
});

test("the open drawer shows the request, CLI input, response and raw lines", async () => {
	const calls = fixture();
	await mount(<ModelTraceDrawer chatId="chat-1" title="Session" open onClose={() => {}} />);
	assert.equal(calls[0], "GET /api/model-trace?session=chat-1&after=0");
	assert.equal(document.querySelector('[data-testid="model-trace-toggle"]')?.getAttribute("aria-checked"), "true");
	assert.match(document.querySelector("[role=status]")?.textContent ?? "", /Recording/);
	const text = document.body.textContent ?? "";
	assert.match(text, /SYSTEM TRACE PROMPT/);
	assert.match(text, /CLI TRACE PROMPT/);
	assert.match(text, /TRACE RESPONSE TEXT/);
	assert.match(text, /Tools \(2\)/);
	assert.match(text, /Raw events \(3\)/);
});

test("the toggle writes the Developer setting and clear deletes the session trace", async () => {
	const calls = fixture();
	await mount(<ModelTraceDrawer chatId="chat-1" title="Session" open onClose={() => {}} />);
	await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="model-trace-toggle"]')!.click());
	assert.equal(calls.includes("PUT /api/settings/developer"), true);
	assert.equal(document.querySelector('[data-testid="model-trace-toggle"]')?.getAttribute("aria-checked"), "false");
	assert.match(document.querySelector("[role=status]")?.textContent ?? "", /Off/);

	await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="model-trace-clear"]')!.click());
	assert.equal(calls.includes("DELETE /api/model-trace?session=chat-1"), true);
	assert.match(document.body.textContent ?? "", /No trace yet/);
});

test("failed writes surface an alert without losing the view", async () => {
	fixture(undefined, true);
	await mount(<ModelTraceDrawer chatId="chat-1" title="Session" open onClose={() => {}} />);
	await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="model-trace-toggle"]')!.click());
	assert.match(document.querySelector("[role=alert]")?.textContent ?? "", /Could not update/);
	assert.match(document.body.textContent ?? "", /TRACE RESPONSE TEXT/);
});

test("the Developer section describes the trace and toggles it", async () => {
	let written: { modelTrace?: boolean } | undefined;
	await mount(<DeveloperSection developer={{ modelTrace: false }} onSectionChange={(next) => { written = next; }} />);
	const text = document.body.textContent ?? "";
	assert.match(text, /Model trace/);
	assert.match(text, /data\/debug\/model-traces\//);
	const toggle = document.querySelector<HTMLButtonElement>('[role="switch"]')!;
	assert.equal(toggle.getAttribute("aria-checked"), "false");
	await act(async () => toggle.click());
	assert.deepEqual(written, { modelTrace: true });
});
