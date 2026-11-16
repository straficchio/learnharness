/**
 * The isolated `agy` home must still carry the user's existing native login.
 * agy stores that login in a FILE (not the OS keyring) and has no config-home
 * override, so LearnHarness seeds only `antigravity-oauth-token` into its
 * temporary home and syncs a refreshed token back.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import { createAgyTurnFiles, type AgyMcpConfig } from "../src/agent/antigravity-cli/session-files.ts";

const MCP: AgyMcpConfig = {
	url: "http://127.0.0.1:1/mcp",
	headers: { Authorization: "Bearer test" },
};

function tokenFile(home: string): string {
	return join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token");
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
	assert.deepEqual(
		JSON.parse(readFileSync(join(files.home, ".gemini", "antigravity-cli", "settings.json"), "utf8")),
		{ permissions: { allow: ["mcp(learnharness/*)"] } },
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
	assert.equal(existsSync(files.home), false);
});

test("never clobbers a real login changed while the turn ran", async (t) => {
	const source = makeSourceHome(t, "old-token");
	const files = await createFiles(t, source);

	writeFileSync(tokenFile(source), "user-relogin", { mode: 0o600 });
	writeFileSync(tokenFile(files.home), "turn-refresh", { mode: 0o600 });
	await files.cleanup();

	assert.equal(readFileSync(tokenFile(source), "utf8"), "user-relogin");
});

test("an absent token file is not an error and nothing is fabricated", async (t) => {
	const source = makeSourceHome(t);
	const files = await createFiles(t, source);

	assert.equal(existsSync(tokenFile(files.home)), false);
});
