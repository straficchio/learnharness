import assert from "node:assert/strict";
import * as os from "node:os";
import test from "node:test";

import type { Tool, ToolResultMessage } from "@earendil-works/pi-ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
	AGY_BRIDGE_SERVER_NAME,
	AGY_IDENTITY_ERROR,
	createAgyToolBridge,
	harnessToolFromAgy,
	type AgyToolBridge,
} from "../src/agent/antigravity-cli/tool-bridge.ts";

const READ_TOOL: Tool = { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } };
const TOKEN = "00000000-0000-4000-8000-000000000001:2";

function authorization(bridge: AgyToolBridge): string {
	const value = bridge.mcp.headers.Authorization;
	assert.ok(value);
	return value;
}

async function connectClient(bridge: AgyToolBridge, auth = authorization(bridge)): Promise<Client> {
	const transport = new StreamableHTTPClientTransport(new URL(bridge.mcp.url), {
		requestInit: { headers: { Authorization: auth } },
	});
	const client = new Client({ name: "test", version: "0" });
	await client.connect(transport);
	return client;
}

function toolResult(content: ToolResultMessage["content"], isError = false): ToolResultMessage {
	return { role: "toolResult", toolCallId: TOKEN, toolName: "read", content, isError, timestamp: 0 };
}

async function waitForPending(bridge: AgyToolBridge, count: number): Promise<void> {
	const deadline = Date.now() + 2000;
	while (bridge.getPendingToolCalls().length < count) {
		assert.ok(Date.now() < deadline, "bridge call did not arrive");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

test("lists the given tools with alwaysLoad metadata and JSON schemas", async (t) => {
	const bridge = await createAgyToolBridge([READ_TOOL]);
	t.after(() => bridge.close());
	const client = await connectClient(bridge);
	t.after(() => client.close());

	const { tools } = await client.listTools();
	assert.equal(tools.length, 1);
	assert.equal(tools[0]?.name, "read");
	assert.equal(tools[0]?.description, "Read a file");
	assert.deepEqual(tools[0]?.inputSchema, JSON.parse(JSON.stringify(READ_TOOL.parameters)));
	assert.deepEqual((tools[0] as { _meta?: unknown })._meta, { "antigravity/alwaysLoad": true });
});

test("binds only 127.0.0.1 and requires the bearer token", async (t) => {
	const bridge = await createAgyToolBridge([READ_TOOL]);
	t.after(() => bridge.close());

	assert.equal(new URL(bridge.mcp.url).hostname, "127.0.0.1");
	await assert.rejects(connectClient(bridge, "Bearer wrong"), (error: { code?: number }) => error.code === 401);
	const response = await fetch(bridge.mcp.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
	assert.equal(response.status, 401);

	const externalAddress = Object.values(os.networkInterfaces()).flat()
		.find((address) => address && !address.internal && address.family === "IPv4");
	if (!externalAddress) return;
	const url = new URL(bridge.mcp.url);
	const net = await import("node:net");
	await assert.rejects(new Promise((resolve, reject) => {
		const socket = net.connect(Number(url.port), externalAddress.address, () => resolve(socket.end()));
		socket.once("error", reject);
	}), { code: "ECONNREFUSED" });
});

test("tools/call holds until resolved and returns text and image content", async (t) => {
	const bridge = await createAgyToolBridge([READ_TOOL]);
	t.after(() => bridge.close());
	const client = await connectClient(bridge);
	t.after(() => client.close());

	let settled = false;
	const pending = client.callTool({ name: "read", arguments: { path: "notes.md" }, _meta: { progressToken: TOKEN } }).finally(() => {
		settled = true;
	});
	await waitForPending(bridge, 1);
	const [call] = bridge.getPendingToolCalls();
	assert.deepEqual(call, { id: TOKEN, name: "read", arguments: { path: "notes.md" }, stepIndex: 2 });
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(settled, false);

	bridge.resolveToolCall(call!, toolResult([
		{ type: "text", text: "# Notes" },
		{ type: "image", data: "AAAA", mimeType: "image/png" },
	]));
	const result = await pending;
	assert.deepEqual(result.content, [
		{ type: "text", text: "# Notes" },
		{ type: "image", data: "AAAA", mimeType: "image/png" },
	]);
	assert.notEqual(result.isError, true);
	assert.deepEqual(bridge.getPendingToolCalls(), []);
});

test("rejects missing, duplicate, undeclared, and malformed identities", async (t) => {
	const errors: string[] = [];
	const bridge = await createAgyToolBridge([READ_TOOL], {
		onCall() {},
		onError(error) { errors.push(error.message); },
	});
	t.after(() => bridge.close());
	const client = await connectClient(bridge);
	t.after(() => client.close());

	await assert.rejects(client.callTool({ name: "read", arguments: { path: "a" } }), (error: unknown) => String(error).includes(AGY_IDENTITY_ERROR));
	await assert.rejects(client.callTool({ name: "read", arguments: { path: "a" }, _meta: { progressToken: "no-colon" } }), (error: unknown) => String(error).includes(AGY_IDENTITY_ERROR));
	await assert.rejects(client.callTool({ name: "missing", arguments: {}, _meta: { progressToken: TOKEN } }), /undeclared/);
	assert.ok(errors.some((message) => message.includes(AGY_IDENTITY_ERROR)));
	assert.ok(errors.some((message) => message.includes("undeclared")));

	const first = client.callTool({ name: "read", arguments: { path: "a" }, _meta: { progressToken: TOKEN } });
	await waitForPending(bridge, 1);
	await assert.rejects(client.callTool({ name: "read", arguments: { path: "b" }, _meta: { progressToken: TOKEN } }), (error: unknown) => String(error).includes(AGY_IDENTITY_ERROR));
	bridge.resolveToolCall(bridge.getPendingToolCalls()[0]!, toolResult([{ type: "text", text: "ok" }]));
	await first;
});

test("closing the bridge settles pending calls instead of hanging", async (t) => {
	const bridge = await createAgyToolBridge([READ_TOOL]);
	const client = await connectClient(bridge);
	t.after(() => client.close());

	const pending = client.callTool({ name: "read", arguments: { path: "a" }, _meta: { progressToken: TOKEN } });
	await waitForPending(bridge, 1);
	await bridge.close();
	const result = await pending;
	assert.equal(result.isError, true);
	assert.deepEqual(result.content, [{ type: "text", text: "MCP bridge closed" }]);
});

test("harnessToolFromAgy strips only the exact bridge prefix", () => {
	assert.equal(harnessToolFromAgy(`mcp_${AGY_BRIDGE_SERVER_NAME}_read`), "read");
	assert.equal(harnessToolFromAgy("mcp_other_read"), null);
	assert.equal(harnessToolFromAgy("read"), null);
});
