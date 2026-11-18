/**
 * The isolated `agy` home must still carry the user's existing native login.
 * agy has no config-home override, so LearnHarness seeds the file token into
 * the temporary home, keeps a server-owned backup outside the CLI-managed
 * directory, and forces the CLI's file-storage path.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import { agyChildEnv, createAgyTurnFiles, type AgyMcpConfig } from "../src/agent/antigravity-cli/session-files.ts";

const MCP: AgyMcpConfig = {
	url: "http://127.0.0.1:1/mcp",
	headers: { Authorization: "Bearer test" },
};

function tokenFile(home: string): string {
	return join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token");
}

function backupFile(home: string): string {
	return join(home, ".learnharness", "agy-oauth-token");
}

function makeSourceHome(t: TestContext, token?: string): string {
	const home = mkdtempSync(join(tmpdir(), "agy-credential-source-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	if (token !== undefined) {
		const file = tokenFile(home);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, token, { mode: 0o600 });
	}
	return home;
}

async function createFiles(t: TestContext, credentialHome?: string) {
	const files = await createAgyTurnFiles({ systemPrompt: "You are a tutor.", mcp: MCP, images: [], credentialHome });
	t.after(async () => { await files.cleanup().catch(() => {}); });
	return files;
}

test("seeds only the agy OAuth token into the isolated home", async (t) => {
	const source = makeSourceHome(t, "source-token");
	writeFileSync(join(source, ".gemini", "antigravity-cli", "settings.json"), "user settings");
	writeFileSync(join(source, ".gemini", "settings.json"), "user root settings");

	const files = await createFiles(t, source);
	const isolated = tokenFile(files.home);

	assert.equal(readFileSync(isolated, "utf8"), "source-token");
	assert.equal(statSync(isolated).mode & 0o777, 0o600);
	assert.equal(readFileSync(backupFile(source), "utf8"), "source-token");
	assert.equal(statSync(backupFile(source)).mode & 0o777, 0o600);
	const isolatedSettings = JSON.parse(readFileSync(join(files.home, ".gemini", "antigravity-cli", "settings.json"), "utf8"));
	assert.equal(isolatedSettings.permissions.allow[0], "mcp(learnharness/*)");
	assert.equal(
		isolatedSettings.permissions.allow.filter((entry: string) => /^(?:read|view)_file\(.*private\/images\)$/.test(entry)).length,
		4,
	);
	assert.equal(existsSync(join(files.home, ".gemini", "settings.json")), false);
	assert.notEqual(files.home, source);
});

test("syncs a token refreshed in the isolated home back to the real CLI login", async (t) => {
	const source = makeSourceHome(t, "old-token");
	const files = await createFiles(t, source);

	writeFileSync(tokenFile(files.home), "refreshed-token", { mode: 0o600 });
	await files.cleanup();

	assert.equal(readFileSync(tokenFile(source), "utf8"), "refreshed-token");
	assert.equal(statSync(tokenFile(source)).mode & 0o777, 0o600);
	assert.equal(readFileSync(backupFile(source), "utf8"), "refreshed-token");
	assert.equal(existsSync(files.home), false);
});

test("never clobbers a real login changed while the turn ran", async (t) => {
	const source = makeSourceHome(t, "old-token");
	const files = await createFiles(t, source);

	writeFileSync(tokenFile(source), "user-relogin", { mode: 0o600 });
	writeFileSync(tokenFile(files.home), "turn-refresh", { mode: 0o600 });
	await files.cleanup();

	assert.equal(readFileSync(tokenFile(source), "utf8"), "user-relogin");
	assert.equal(readFileSync(backupFile(source), "utf8"), "user-relogin");
});

test("an absent token file is not an error and nothing is fabricated", async (t) => {
	const source = makeSourceHome(t);
	const files = await createFiles(t, source);

	assert.equal(existsSync(tokenFile(files.home)), false);
});

test("uses the server-owned backup after a local CLI login removes the file token", async (t) => {
	const source = makeSourceHome(t, "backup-token");
	await createFiles(t, source);
	rmSync(tokenFile(source));

	const files = await createFiles(t, source);
	assert.equal(readFileSync(tokenFile(files.home), "utf8"), "backup-token");
	assert.equal(existsSync(tokenFile(source)), false);
	assert.equal(readFileSync(backupFile(source), "utf8"), "backup-token");
});

test("forces the CLI's file-storage path even outside an SSH launch", async (t) => {
	const files = await createFiles(t);
	const env = agyChildEnv({ NODE_ENV: "test", HOME: "/Users/example", PATH: "/usr/bin" }, files);

	assert.equal(env.SSH_CONNECTION, "127.0.0.1 0 127.0.0.1 22");
	assert.equal(env.SSH_CLIENT, "127.0.0.1 0 22");
	assert.equal(env.SSH_TTY, "/dev/ttys000");
	assert.equal(env.PATH, "/usr/bin");
	assert.notEqual(env.HOME, "/Users/example");
});
