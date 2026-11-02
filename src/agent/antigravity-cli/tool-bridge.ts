import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import type { ImageContent, JsonObject, TextContent, Tool, ToolResultMessage } from "@earendil-works/pi-ai";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
	CallToolRequestSchema,
	ErrorCode,
	ListToolsRequestSchema,
	McpError,
	type CallToolResult,
	type Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";

export const AGY_BRIDGE_SERVER_NAME = "learnharness";
export const AGY_TOOL_PREFIX = `mcp_${AGY_BRIDGE_SERVER_NAME}_`;

const LOOPBACK_HOST = "127.0.0.1";
const TOKEN_BYTES = 32;
const PROGRESS_TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d+$/i;

export type AgyPendingToolCall = {
	/** `<conversation_id>:<step_index>` — the CLI's per-call identity. */
	id: string;
	name: string;
	arguments: JsonObject;
	stepIndex: number;
};

type BridgeCallbacks = {
	onCall(): void;
	onError(error: Error): void;
	onCancel?(call: AgyPendingToolCall): void;
};

export type AgyToolBridge = {
	mcp: { url: string; headers: Record<string, string> };
	getPendingToolCalls(): AgyPendingToolCall[];
	resolveToolCall(call: AgyPendingToolCall, result: ToolResultMessage): void;
	cancelToolCall(call: AgyPendingToolCall): void;
	close(): Promise<void>;
};

export const AGY_IDENTITY_ERROR = "agy CLI compatibility error: MCP calls must include a unique progressToken";

export function harnessToolFromAgy(name: string): string | null {
	return name.startsWith(AGY_TOOL_PREFIX) ? name.slice(AGY_TOOL_PREFIX.length) : null;
}

function toMcpContent(block: TextContent | ImageContent): CallToolResult["content"][number] {
	switch (block.type) {
		case "text":
			return { type: "text", text: block.text };

		case "image":
			return { type: "image", data: block.data, mimeType: block.mimeType };
	}
}

function toCallToolResult(result: ToolResultMessage): CallToolResult {
	return { content: result.content.map(toMcpContent), isError: result.isError };
}

function toMcpTool(tool: Tool): McpTool {
	return {
		name: tool.name,
		description: tool.description,
		inputSchema: tool.parameters as McpTool["inputSchema"],
		_meta: { "antigravity/alwaysLoad": true },
	};
}

class ToolCallQueue {
	private readonly results = new Map<AgyPendingToolCall, (result: CallToolResult) => void>();

	add(call: AgyPendingToolCall, signal: AbortSignal, onCancel?: (call: AgyPendingToolCall) => void): Promise<CallToolResult> {
		return new Promise<CallToolResult>((resolve) => {
			const settle = (result: CallToolResult) => {
				if (!this.results.has(call)) return;
				this.results.delete(call);
				signal.removeEventListener("abort", cancel);
				resolve(result);
			};
			const cancel = () => {
				if (!this.results.has(call)) return;
				settle({ content: [{ type: "text", text: "MCP request cancelled" }], isError: true });
				onCancel?.(call);
			};
			this.results.set(call, settle);
			signal.addEventListener("abort", cancel, { once: true });
			if (signal.aborted) cancel();
		});
	}

	resolve(call: AgyPendingToolCall, result: ToolResultMessage): void {
		this.results.get(call)?.(toCallToolResult(result));
	}

	cancel(call: AgyPendingToolCall): void {
		this.results.get(call)?.({ content: [{ type: "text", text: "MCP request cancelled" }], isError: true });
	}

	list(): AgyPendingToolCall[] {
		return [...this.results.keys()];
	}

	clear(): void {
		for (const settle of this.results.values()) {
			settle({ content: [{ type: "text", text: "MCP bridge closed" }], isError: true });
		}
	}
}

// Low-level Server on purpose: McpServer.registerTool only takes zod
// schemas, and pi tools carry JSON Schema that must reach the CLI unchanged.
function createMcpServer(tools: Tool[], queue: ToolCallQueue, callbacks?: BridgeCallbacks): Server {
	const server = new Server({ name: AGY_BRIDGE_SERVER_NAME, version: "1.0.0" }, { capabilities: { tools: {} } });

	server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: tools.map(toMcpTool) }));

	const seenIds = new Set<string>();
	server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
		const token = request.params._meta?.progressToken;
		if (typeof token !== "string" || !PROGRESS_TOKEN_RE.test(token) || seenIds.has(token)) {
			const error = new McpError(ErrorCode.InvalidParams, AGY_IDENTITY_ERROR);
			callbacks?.onError(error);
			throw error;
		}
		if (!tools.some((tool) => tool.name === request.params.name)) {
			const error = new McpError(ErrorCode.InvalidParams, "agy CLI requested an undeclared harness tool");
			callbacks?.onError(error);
			throw error;
		}
		const args = request.params.arguments ?? {};
		if (!args || typeof args !== "object" || Array.isArray(args)) {
			const error = new McpError(ErrorCode.InvalidParams, "agy CLI supplied invalid tool arguments");
			callbacks?.onError(error);
			throw error;
		}
		seenIds.add(token);
		const stepIndex = Number(token.slice(token.lastIndexOf(":") + 1));
		const result = queue.add(
			{ id: token, name: request.params.name, arguments: args as JsonObject, stepIndex },
			extra.signal,
			callbacks?.onCancel,
		);
		callbacks?.onCall();
		return result;
	});

	return server;
}

function isAuthorized(header: string | undefined, expected: Buffer): boolean {
	if (header === undefined) return false;

	const actual = Buffer.from(header);
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function createHttpServer(transport: StreamableHTTPServerTransport, authorization: string): http.Server {
	const expected = Buffer.from(authorization);

	return http.createServer((req, res) => {
		if (!isAuthorized(req.headers.authorization, expected)) {
			res.writeHead(401).end();
			return;
		}

		transport.handleRequest(req, res).catch((error: unknown) => {
			console.error("agy tool bridge request failed", error);

			if (!res.headersSent) res.writeHead(500);
			res.end();
		});
	});
}

function listen(server: http.Server): Promise<AddressInfo> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);

		server.listen(0, LOOPBACK_HOST, () => resolve(server.address() as AddressInfo));
	});
}

function closeHttpServer(server: http.Server): Promise<void> {
	server.closeAllConnections();

	return new Promise((resolve, reject) => {
		server.close((error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

export async function createAgyToolBridge(tools: Tool[], callbacks?: BridgeCallbacks): Promise<AgyToolBridge> {
	const authorization = `Bearer ${randomBytes(TOKEN_BYTES).toString("hex")}`;

	const queue = new ToolCallQueue();
	const mcpServer = createMcpServer(tools, queue, callbacks);
	const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
	await mcpServer.connect(transport);

	const httpServer = createHttpServer(transport, authorization);
	let port: number;
	try {
		({ port } = await listen(httpServer));
	} catch (error) {
		await mcpServer.close();
		throw error;
	}

	return {
		mcp: {
			url: `http://${LOOPBACK_HOST}:${port}/mcp`,
			headers: { Authorization: authorization },
		},
		getPendingToolCalls: () => queue.list(),
		resolveToolCall: (call, result) => queue.resolve(call, result),
		cancelToolCall: (call) => queue.cancel(call),
		close: async () => {
			const hadPending = queue.list().length > 0;
			queue.clear();
			// Give the transport one I/O turn to deliver the settlement before
			// tearing down the HTTP connection.
			if (hadPending) await new Promise<void>((resolve) => setImmediate(resolve));
			await mcpServer.close();
			await closeHttpServer(httpServer);
		},
	};
}
