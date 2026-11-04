#!/usr/bin/env node
/**
 * Headless server-mode smoke (multi-user wave, 2026-11-03).
 *
 * Starts the built standalone server against a disposable data root and
 * exercises the real browser path: login list, passwordless login + remember
 * cookie, page redirects, API scoping, shared settings visibility, and
 * per-user chat isolation. Run after `npm run build`.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, ".next", "standalone", "server.js");
const SERVE = path.join(ROOT, "scripts", "serve.mjs");
if (!fs.existsSync(ENTRY)) {
	console.error(`[smoke-server-mode] missing ${ENTRY} — run npm run build first.`);
	process.exit(1);
}

const data = fs.mkdtempSync(path.join(os.tmpdir(), "lh-server-mode-"));
const port = await new Promise((resolve, reject) => {
	const server = net.createServer();
	server.once("error", reject);
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		server.close(() => resolve(address.port));
	});
});
const origin = `http://127.0.0.1:${port}`;
fs.writeFileSync(path.join(data, "server.json"), `${JSON.stringify({
	version: 1, host: "127.0.0.1", port, secret: randomBytes(32).toString("hex"),
}, null, "\t")}\n`, { mode: 0o600 });
const env = {
	...process.env,
	LH_DATA_DIR: data,
	LH_AUTH_FILE: path.join(data, "auth.json"),
};
delete env.LH_DESKTOP_SERVER;
delete env.LH_DESKTOP_API_SECRET;

const child = spawn(process.execPath, [SERVE], {
	cwd: ROOT,
	env,
	stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
child.stderr.on("data", (chunk) => { logs += chunk.toString(); });

async function waitForServer() {
	const deadline = Date.now() + 45_000;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`${origin}/api/auth/users`);
			if (response.ok) return response;
		} catch { /* not listening yet */ }
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`server did not start:\n${logs}`);
}

function cookieOf(response) {
	const header = response.headers.get("set-cookie");
	assert.ok(header, `missing Set-Cookie (${response.status})`);
	return header.split(";")[0];
}

async function json(response, expected = 200) {
	const body = await response.json().catch(() => null);
	assert.equal(response.status, expected, `${response.url}: ${JSON.stringify(body)}`);
	return body;
}

try {
	const usersResponse = await waitForServer();
	const users = await json(usersResponse);
	assert.equal(users.users.length, 1);
	assert.equal(users.users[0].role, "admin");
	assert.equal(users.users[0].hasPassword, false);

	const loginPage = await fetch(`${origin}/login`, { redirect: "manual" });
	assert.equal(loginPage.status, 200);
	const loginHtml = await loginPage.text();
	const asset = loginHtml.match(/src="(\/_next\/static\/[^"]+\.js)"/)?.[1];
	assert.ok(asset, "login page has a browser bundle");
	assert.equal((await fetch(`${origin}${asset}`)).status, 200);

	const rootPage = await fetch(`${origin}/`, { redirect: "manual" });
	assert([307, 308].includes(rootPage.status));
	assert.match(rootPage.headers.get("location") ?? "", /\/login$/);

	const anonymousSettings = await fetch(`${origin}/api/settings`);
	assert.equal(anonymousSettings.status, 401);

	const login = await fetch(`${origin}/api/auth/login`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ userId: users.users[0].id, remember: true }),
	});
	const adminCookie = cookieOf(login);
	assert.match(login.headers.get("set-cookie") ?? "", /Max-Age=/);
	await json(login);
	const adminSettings = await json(await fetch(`${origin}/api/settings`, { headers: { cookie: adminCookie } }));
	assert.equal(adminSettings.settings.version, 1);
	const appPage = await fetch(`${origin}/`, { headers: { cookie: adminCookie } });
	assert.equal(appPage.status, 200);
	assert.match(await appPage.text(), /Learning Harness/);
	assert.equal((await fetch(`${origin}/chat/new`, { headers: { cookie: adminCookie } })).status, 200);
	const loggedInLogin = await fetch(`${origin}/login`, { headers: { cookie: adminCookie }, redirect: "manual" });
	assert([307, 308].includes(loggedInLogin.status));

	const created = await json(await fetch(`${origin}/api/users`, {
		method: "POST",
		headers: { "content-type": "application/json", cookie: adminCookie },
		body: JSON.stringify({ name: "Bob" }),
	}));
	const bob = created.user;
	const bobLogin = await fetch(`${origin}/api/auth/login`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ userId: bob.id }),
	});
	const bobCookie = cookieOf(bobLogin);
	await json(bobLogin);
	const bobSettings = await json(await fetch(`${origin}/api/settings`, { headers: { cookie: bobCookie } }));
	assert.equal("models" in bobSettings.settings, false);
	assert.deepEqual(Object.keys(bobSettings.settings).sort(), ["appearance", "version"]);
	assert.equal((await fetch(`${origin}/`, { headers: { cookie: bobCookie } })).status, 200);

	const adminChat = await json(await fetch(`${origin}/api/chats`, {
		method: "POST",
		headers: { "content-type": "application/json", cookie: adminCookie },
		body: JSON.stringify({ title: "Admin only" }),
	}));
	const adminChats = await json(await fetch(`${origin}/api/chats`, { headers: { cookie: adminCookie } }));
	assert.equal(adminChats.chats.length, 1);
	const bobChats = await json(await fetch(`${origin}/api/chats`, { headers: { cookie: bobCookie } }));
	assert.equal(bobChats.chats.length, 0);
	assert.ok(fs.existsSync(path.join(data, "chats", `${adminChat.id}.json`)));
	assert.equal(fs.existsSync(path.join(data, "users", bob.id, "chats")), true);

	const denied = await fetch(`${origin}/api/users`, { headers: { cookie: bobCookie } });
	assert.equal(denied.status, 403);
	console.log("[smoke-server-mode] OK");
} finally {
	child.kill("SIGTERM");
	await new Promise((resolve) => {
		const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 3000);
		child.once("exit", () => { clearTimeout(timer); resolve(); });
	});
	fs.rmSync(data, { recursive: true, force: true });
}
