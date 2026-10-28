/**
 * Credential-path guard + secret redaction for the learner-file tools.
 * These are the narrow defense that keeps the app's own key stores (and
 * common OS secret locations) out of the model context.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AUTH_FILE, PATHS } from "../config.ts";
import { isDeniedPath, resolveAllowedPath } from "../src/agent/tools/fs-shared.ts";
import { readTool } from "../src/agent/tools/read.ts";
import { redactSecrets } from "../src/agent/tools/redact.ts";

const scratch: string[] = [];
afterEach(async () => {
	for (const dir of scratch.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("isDeniedPath", () => {
	it("blocks the app's own key/data stores", () => {
		assert.ok(isDeniedPath(AUTH_FILE));
		assert.ok(isDeniedPath(PATHS.data));
		assert.ok(isDeniedPath(path.join(PATHS.data, "chats", "chat_x.json")));
		assert.ok(isDeniedPath(path.join(os.homedir(), ".config", "LearnHarness", "auth.json")));
		assert.ok(isDeniedPath(path.join(os.homedir(), "Library", "Application Support", "LearnHarness", "auth.json")));
		assert.ok(isDeniedPath(path.join(os.homedir(), "AppData", "Roaming", "LearnHarness", "auth.json")));
	});
	it("blocks common credential locations and names", () => {
		assert.ok(isDeniedPath("/proc/self/environ"));
		assert.ok(isDeniedPath("/etc/passwd"));
		assert.ok(isDeniedPath(path.join(os.homedir(), ".ssh", "id_rsa")));
		assert.ok(isDeniedPath(path.join(os.homedir(), ".aws", "credentials")));
		assert.ok(isDeniedPath(path.join(os.homedir(), ".gnupg", "private-keys-v1.d", "x.key")));
		assert.ok(isDeniedPath(path.join(os.homedir(), "project", ".env")));
		assert.ok(isDeniedPath(path.join(os.homedir(), "project", ".env.local")));
		assert.ok(isDeniedPath(path.join(os.homedir(), "project", "chatgpt-credentials.json")));
	});
	it("allows ordinary study files", () => {
		assert.ok(!isDeniedPath(path.join(os.homedir(), "Documents", "notes.md")));
		assert.ok(!isDeniedPath(path.join(os.homedir(), "project", "README.md")));
		assert.ok(!isDeniedPath("/tmp/lh-research-abc/paper.pdf"));
	});
});

describe("resolveAllowedPath", () => {
	it("rejects the app's auth file and /proc", async () => {
		await assert.rejects(() => resolveAllowedPath(AUTH_FILE), /Access to credentials/);
		await assert.rejects(() => resolveAllowedPath("/proc/self/environ"), /Access to credentials/);
	});
	it("rejects a symlink that escapes into a denied path", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-secret-guard-"));
		scratch.push(dir);
		const link = path.join(dir, "looks-innocent.txt");
		await fs.symlink("/etc/passwd", link);
		await assert.rejects(() => resolveAllowedPath(link), /Access to credentials/);
	});
	it("the read tool rejects the auth file before touching disk", async () => {
		await assert.rejects(async () => readTool.execute!("test", { path: AUTH_FILE }), /Access to credentials/);
	});
	it("returns the realpath for an allowed file", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-secret-ok-"));
		scratch.push(dir);
		const file = path.join(dir, "notes.md");
		await fs.writeFile(file, "study notes");
		assert.equal(await resolveAllowedPath(file), await fs.realpath(file));
	});
});

describe("redactSecrets", () => {
	it("redacts common key families and bearer tokens", () => {
		const text = [
			"OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456",
			"OPENROUTER_API_KEY=sk-or-v1-abcdefghijklmnopqrstuvwxyz123456",
			"TAVILY_API_KEY=tvly-abcdefghijklmnop",
			"Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
			"-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----",
		].join("\n");
		const out = redactSecrets(text);
		assert.match(out, /\[REDACTED KEY\]/);
		assert.match(out, /Bearer \[REDACTED\]/);
		assert.match(out, /\[REDACTED PRIVATE KEY\]/);
		assert.ok(!out.includes("sk-abcdefghijklmnopqrstuvwxyz123456"));
		assert.ok(!out.includes("tvly-abcdefghijklmnop"));
	});
	it("leaves ordinary prose alone", () => {
		const text = "The chain rule says the derivative of f(g(x)) is f'(g(x)) g'(x).";
		assert.equal(redactSecrets(text), text);
	});
});
