/**
 * Stand-in for the Antigravity CLI (`agy`) in tests. Reads the stream-json
 * prompt from stdin, then replays the scenario file named by
 * FAKE_AGY_SCENARIO line by line. Lines with a "fake" key are directives:
 *   {"fake":"call","stepIndex":2,"name":"echo","arguments":{...},"progressToken":"...","output":"..."}
 *       emit a tool ACTIVE, call the real MCP bridge, wait for the held result,
 *       then emit the tool DONE and continue
 *   {"fake":"native","stepIndex":3,"name":"run_command","arguments":{...},"state":"ERROR","message":"..."}
 *       emit a native tool transition (ACTIVE, then the requested state)
 *   {"fake":"hold"}                           stay alive until killed
 *   {"fake":"exit","code":1,"stderr":"..."}   write stderr and exit
 *   {"fake":"ignore-term"}                    ignore SIGTERM to exercise kill escalation
 *   {"fake":"text","stepIndex":4,"text":"..."} emit an agent_response ACTIVE/DONE pair
 *   {"fake":"result","status":"SUCCESS","response":"..."} emit the terminal result
 * `$LH_AGY_IMAGE_DIR` in any directive string is expanded from the process env.
 * FAKE_AGY_STDIN, when set, receives the stdin JSON line the fixture read.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const CONVERSATION_ID = "00000000-0000-4000-8000-000000000001";

function expand(value) {
	return JSON.parse(JSON.stringify(value), (_key, item) => typeof item === "string"
		? item.replaceAll("$LH_AGY_IMAGE_DIR", process.env.LH_AGY_IMAGE_DIR ?? "")
		: item);
}

function line(value) {
	return new Promise((resolve) => process.stdout.write(`${JSON.stringify(value)}\n`, resolve));
}

function step(stepIndex, state, stepType, extra = {}) {
	return line({
		event: "step_update",
		step_update: {
			conversation_id: CONVERSATION_ID,
			step_index: stepIndex,
			state,
			step_type: stepType,
			...extra,
		},
	});
}

function toolEvent(stepIndex, state, name, parameters, extra = {}) {
	return step(stepIndex, state, "tool", {
		tool_name: name,
		tool_info: { name, parameters, ...extra },
	});
}

async function connectBridge() {
	const config = JSON.parse(readFileSync(join(process.env.HOME, ".gemini", "config", "mcp_config.json"), "utf8"));
	const server = config.mcpServers.learnharness;
	const client = new Client({ name: "fake-agy", version: "1.0.0" });
	const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } });
	await client.connect(transport);
	return client;
}

let input = "";
const userReceived = new Promise((resolve) => {
	createInterface({ input: process.stdin }).on("line", (value) => {
		input += `${value}\n`;
		if (process.env.FAKE_AGY_STDIN) writeFileSync(process.env.FAKE_AGY_STDIN, input);
		resolve();
	});
});

await line({ event: "init", conversation_id: CONVERSATION_ID, init: { tools: [], permission_mode: "request-review" } });
await userReceived;

let bridge;
const lines = readFileSync(process.env.FAKE_AGY_SCENARIO, "utf8").split("\n").filter(Boolean);
for (const raw of lines) {
	const directive = expand(JSON.parse(raw));

	if (directive.fake === "hold") {
		setInterval(() => {}, 60_000);
		break;
	}
	if (directive.fake === "exit") {
		process.stderr.write(directive.stderr ?? "");
		process.exit(directive.code ?? 1);
	}
	if (directive.fake === "ignore-term") {
		process.on("SIGTERM", () => {});
		continue;
	}
	if (directive.fake === "text") {
		await step(directive.stepIndex, "ACTIVE", "agent_response", { text_delta: directive.text });
		await step(directive.stepIndex, "DONE", "agent_response", {
			text_delta: "",
			usage: directive.usage ?? { input_tokens: 10, output_tokens: 2, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 12 },
		});
		continue;
	}
	if (directive.fake === "result") {
		await line({
			event: "result",
			result: {
				conversation_id: CONVERSATION_ID,
				status: directive.status ?? "SUCCESS",
				response: directive.response ?? "",
				...(directive.error ? { error: directive.error } : {}),
				usage: directive.usage ?? { input_tokens: 100, output_tokens: 20, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 120 },
			},
		});
		continue;
	}
	if (directive.fake === "native") {
		await toolEvent(directive.stepIndex, "ACTIVE", directive.name, directive.arguments ?? {});
		await toolEvent(directive.stepIndex, directive.state ?? "ERROR", directive.name, directive.arguments ?? {}, directive.message
			? { error: { type: "TOOL_ERROR", message: directive.message } }
			: { output: directive.output ?? "" });
		continue;
	}
	if (directive.fake === "call") {
		bridge ??= await connectBridge();
		const streamName = directive.streamName ?? directive.name;
		await toolEvent(directive.stepIndex, "ACTIVE", `mcp_learnharness_${streamName}`, directive.arguments ?? {});
		const result = await bridge.callTool({
			name: directive.name,
			arguments: directive.arguments ?? {},
			...(directive.progressToken !== undefined ? { _meta: { progressToken: directive.progressToken } } : {}),
		});
		const output = directive.output ?? result.content.map((block) => block.text ?? "").join("");
		await toolEvent(directive.stepIndex, "DONE", `mcp_learnharness_${streamName}`, directive.arguments ?? {}, { output });
		continue;
	}

	await line(JSON.parse(raw));
}
