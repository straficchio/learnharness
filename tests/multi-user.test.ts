import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-multi-user-"));
const originalEnv = process.env;
process.env = {
	...(originalEnv.NODE_TEST_CONTEXT ? { NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT } : {}),
	...(originalEnv.NODE_OPTIONS ? { NODE_OPTIONS: originalEnv.NODE_OPTIONS } : {}),
	NODE_ENV: "test",
	HOME: path.join(scratch, "home"),
	LH_DATA_DIR: path.join(scratch, "data"),
	LH_AUTH_FILE: path.join(scratch, "auth.json"),
	LH_SERVER_MODE: "1",
};
fs.mkdirSync(path.join(scratch, "home"), { recursive: true });

const config = await import("../config.ts");
const users = await import("../src/server/users.ts");
const session = await import("../src/server/session.ts");
const auth = await import("../src/server/auth-http.ts");
const sc = await import("../src/server/server-config.ts");
const runtime = await import("../src/server/runtime-settings.ts");
const appearance = await import("../src/store/appearance.ts");
const { stores } = await import("../src/server/stores.ts");
const { runInScope } = await import("../src/core/request-scope.ts");
const settingsRoute = await import("../app/api/settings/[section]/route.ts");
const { proxy } = await import("../proxy.ts");
const { NextRequest } = await import("next/server");

after(() => {
	process.env = originalEnv;
	fs.rmSync(scratch, { recursive: true, force: true });
});

function cookieOf(response: Response): string {
	const header = response.headers.get("set-cookie");
	assert.ok(header, "expected a Set-Cookie header");
	return header.split(";")[0]!;
}

function requestWithCookie(url: string, cookie: string, init: RequestInit = {}) {
	return new Request(url, { ...init, headers: { ...(init.headers ?? {}), cookie } });
}

async function login(userId: string, password?: string, remember = false, newPassword?: string) {
	return auth.authLoginResponse(new Request("http://localhost/api/auth/login", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ userId, password, remember, ...(newPassword ? { newPassword } : {}) }),
	}));
}

test("first server boot creates the passwordless admin; login, password set, reset and deletion invalidate sessions", async () => {
	const loaded = users.loadUsers();
	assert.equal(loaded.users.length, 1);
	const admin = loaded.users[0]!;
	assert.equal(admin.role, "admin");
	assert.equal(admin.password, null);

	const loginResponse = await login(admin.id, undefined, true);
	assert.equal(loginResponse.status, 200);
	const cookie = cookieOf(loginResponse);
	assert.match(loginResponse.headers.get("set-cookie") ?? "", /Max-Age=/);
	const adminUser = session.requestSessionUser(requestWithCookie("http://localhost/api/auth/me", cookie));
	assert.equal(adminUser?.id, admin.id);
	assert.equal(adminUser?.role, "admin");

	const publicList = auth.authUsersResponse();
	const listBody = await publicList.json() as { users: Array<Record<string, unknown>> };
	assert.equal(listBody.users.length, 1);
	assert.equal("password" in listBody.users[0]!, false);
	assert.equal("sessionVersion" in listBody.users[0]!, false);

	const createdResponse = await auth.createUserResponse(
		new Request("http://localhost/api/users", { method: "POST", body: JSON.stringify({ name: "Alice" }) }),
		adminUser!,
	);
	assert.equal(createdResponse.status, 200);
	const created = (await createdResponse.json() as { user: { id: string } }).user;
	const alice = users.findUserRecord(created.id)!;
	assert.equal(alice.role, "user");
	assert.equal(alice.password, null);

	const aliceLogin = await login(alice.id);
	assert.equal(aliceLogin.status, 200);
	const aliceCookie = cookieOf(aliceLogin);
	const aliceUser = session.requestSessionUser(requestWithCookie("http://localhost/api/auth/me", aliceCookie))!;
	assert.equal(aliceUser.role, "user");

	const passwordResponse = await auth.authPasswordResponse(
		new Request("http://localhost/api/auth/password", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ newPassword: "alice-password" }),
		}),
		aliceUser,
	);
	assert.equal(passwordResponse.status, 200);
	const newAliceCookie = cookieOf(passwordResponse);
	assert.equal(session.requestSessionUser(requestWithCookie("http://localhost/api/auth/me", aliceCookie)), null, "password change invalidates older sessions");
	assert.equal(session.requestSessionUser(requestWithCookie("http://localhost/api/auth/me", newAliceCookie))?.id, alice.id);

	const wrong = await login(alice.id, "nope");
	assert.equal(wrong.status, 401);
	const right = await login(alice.id, "alice-password");
	assert.equal(right.status, 200);

	const reset = auth.resetPasswordResponse(alice.id, adminUser!);
	assert.equal(reset.status, 200);
	assert.equal(session.requestSessionUser(requestWithCookie("http://localhost/api/auth/me", newAliceCookie)), null, "reset invalidates sessions");
	const afterReset = users.findUserRecord(alice.id)!;
	assert.equal(afterReset.password, null);

	const deletion = await auth.deleteUserResponse(alice.id, adminUser!);
	assert.equal(deletion.status, 200);
	assert.equal(users.findUserRecord(alice.id), null);
	assert.equal(fs.existsSync(path.join(config.USERS_DIR, alice.id)), false);
	const adminDelete = await auth.deleteUserResponse(admin.id, adminUser!);
	assert.equal(adminDelete.status, 400);
});

test("chats, graphs, jobs and appearance are scoped; shared settings are global", () => {
	const adminRecord = users.loadUsers().users.find((user) => user.role === "admin")!;
	const alice = users.createUserRecord("Alice Scoped");
	const adminScope = { userId: adminRecord.id, root: users.userDataRoot(adminRecord) };
	const aliceScope = { userId: alice.id, root: users.userDataRoot(alice) };

	const adminChat = runInScope(adminScope, () => stores.chatStore.createChat("Admin chat"));
	const aliceChat = runInScope(aliceScope, () => stores.chatStore.createChat("Alice chat"));
	assert.deepEqual(runInScope(adminScope, () => stores.chatStore.listChats().map((chat) => chat.id)), [adminChat.id]);
	assert.deepEqual(runInScope(aliceScope, () => stores.chatStore.listChats().map((chat) => chat.id)), [aliceChat.id]);

	const node = (id: string, statement: string) => ({
		id, name: id, statement, aliases: [], createdAt: new Date().toISOString(),
		provenance: [{ chatId: "c", messageId: "m" }],
	});
	runInScope(adminScope, () => stores.graphStore.appendNode(node("n_admin", "admin fact")));
	runInScope(aliceScope, () => stores.graphStore.appendNode(node("n_alice", "alice fact")));
	assert.deepEqual(runInScope(adminScope, () => stores.graphStore.readNodes().map((n) => n.id)), ["n_admin"]);
	assert.deepEqual(runInScope(aliceScope, () => stores.graphStore.readNodes().map((n) => n.id)), ["n_alice"]);

	const adminJob = runInScope(adminScope, () => stores.jobStore.createJob({ kind: "research", chatId: adminChat.id, toolCallId: "tc-admin" }));
	const aliceJob = runInScope(aliceScope, () => stores.jobStore.createJob({ kind: "research", chatId: aliceChat.id, toolCallId: "tc-alice" }));
	assert.deepEqual(runInScope(adminScope, () => stores.jobStore.listJobs(adminChat.id).map((job) => job.id)), [adminJob.id]);
	assert.deepEqual(runInScope(aliceScope, () => stores.jobStore.listJobs(aliceChat.id).map((job) => job.id)), [aliceJob.id]);

	runInScope(adminScope, () => appearance.writeAppearance({ mode: "light" }));
	runInScope(aliceScope, () => appearance.writeAppearance({ mode: "dark", proseFontSize: 18 }));
	assert.equal(runInScope(adminScope, () => appearance.readAppearance())?.mode, "light");
	assert.equal(runInScope(aliceScope, () => appearance.readAppearance())?.proseFontSize, 18);

	stores.settingsStore.writeSettings({
		version: 1,
		models: { strong: { model: { provider: "openai", id: "shared-model" } } },
	});
	assert.equal(users.loadUsers().users.length >= 2, true);
	assert.deepEqual(runInScope(adminScope, () => stores.settingsStore.readSettings()?.models?.strong?.model), { provider: "openai", id: "shared-model" });
	assert.deepEqual(runInScope(aliceScope, () => stores.settingsStore.readSettings()?.models?.strong?.model), { provider: "openai", id: "shared-model" });

	assert.equal(runInScope(adminScope, () => config.PATHS.chats), path.join(config.BASE_DATA_ROOT, "chats"));
	assert.equal(runInScope(aliceScope, () => config.PATHS.chats), path.join(config.USERS_DIR, alice.id, "chats"));
});

test("withUser authenticates, scopes, and enforces admin", async () => {
	const adminRecord = users.loadUsers().users.find((user) => user.role === "admin")!;
	const alice = users.createUserRecord("Alice Auth");
	const admin = session.requestUser(users.toSessionUser(adminRecord));
	const aliceUser = session.requestUser(users.toSessionUser(alice));
	const adminCookie = session.sessionCookieFor(admin, false);
	const aliceCookie = session.sessionCookieFor(aliceUser, false);

	let seen: string | null = null;
	const guarded = session.withUser((_req, _ctx, user) => {
		// The store path must resolve inside the wrapper's scope.
		seen = config.PATHS.chats;
		return Response.json({ id: user.id });
	});
	const missing = await guarded(new Request("http://localhost/api/test"));
	assert.equal(missing.status, 401);
	const ok = await guarded(requestWithCookie("http://localhost/api/test", cookieOf(new Response(null, { headers: { "set-cookie": adminCookie } }))));
	assert.equal(ok.status, 200);
	assert.equal(seen, path.join(config.BASE_DATA_ROOT, "chats"));

	const adminOnly = session.withUser(() => Response.json({ ok: true }), { admin: true });
	const denied = await adminOnly(requestWithCookie("http://localhost/api/test", cookieOf(new Response(null, { headers: { "set-cookie": aliceCookie } }))));
	assert.equal(denied.status, 403);
	const allowed = await adminOnly(requestWithCookie("http://localhost/api/test", cookieOf(new Response(null, { headers: { "set-cookie": adminCookie } }))));
	assert.equal(allowed.status, 200);
});

test("settings views split shared config from per-user appearance; the route enforces admin", async () => {
	const adminRecord = users.loadUsers().users.find((user) => user.role === "admin")!;
	const alice = users.createUserRecord("Alice Settings");
	const admin = session.requestUser(users.toSessionUser(adminRecord));
	const aliceUser = session.requestUser(users.toSessionUser(alice));
	const adminScope = { userId: admin.id, root: admin.root };
	const aliceScope = { userId: alice.id, root: aliceUser.root };

	stores.settingsStore.writeSettings({
		version: 1,
		models: { strong: { model: { provider: "openai", id: "shared-model" } } },
	});
	assert.ok(runtime.runtimeSettings().models?.strong?.model);
	runInScope(adminScope, () => appearance.writeAppearance({ mode: "dark" }));
	const adminView = runtime.settingsViewFor(admin);
	assert.ok(adminView.models, "admin sees the shared models");
	const aliceView = runtime.settingsViewFor(aliceUser);
	assert.equal("models" in aliceView, false, "regular users do not get the shared record");

	const aliceCookie = session.sessionCookieFor(aliceUser, false);
	const putAppearance = await settingsRoute.PUT(
		requestWithCookie("http://localhost/api/settings/appearance", cookieOf(new Response(null, { headers: { "set-cookie": aliceCookie } })), {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ mode: "light" }),
		}),
		{ params: Promise.resolve({ section: "appearance" }) },
	);
	assert.equal(putAppearance.status, 200);
	const body = await putAppearance.json() as { settings: { appearance?: { mode?: string }; models?: unknown } };
	assert.equal(body.settings.appearance?.mode, "light");
	assert.equal("models" in body.settings, false);
	assert.equal(runInScope(aliceScope, () => appearance.readAppearance())?.mode, "light");
	assert.notEqual(runInScope(adminScope, () => appearance.readAppearance())?.mode, "light");

	const denied = await settingsRoute.PUT(
		requestWithCookie("http://localhost/api/settings/models", cookieOf(new Response(null, { headers: { "set-cookie": aliceCookie } })), {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ strong: { model: { provider: "openai", id: "shared-model" } } }),
		}),
		{ params: Promise.resolve({ section: "models" }) },
	);
	assert.equal(denied.status, 403);
});

test("server config persists the port/host and keeps its signing secret", () => {
	const initial = sc.ensureServerConfig();
	assert.ok(initial.secret.length >= 32);
	const changed = sc.writeServerConfig({ port: 4567, host: "127.0.0.1" });
	assert.equal(changed.port, 4567);
	assert.equal(changed.secret, initial.secret);
	const view = sc.serverConfigView();
	assert.equal(view.port, 4567);
	assert.equal(view.host, "127.0.0.1");
	assert.equal(fs.existsSync(config.SERVER_CONFIG_FILE), true);
	const publicView = sc.serverConfigView();
	assert.equal("secret" in publicView, false);
});

test("server-mode proxy gates pages but leaves API handlers to return 401", () => {
	const page = new NextRequest("http://localhost/chat/new");
	const redirect = proxy(page);
	assert.equal(redirect.status, 307);
	assert.match(redirect.headers.get("location") ?? "", /\/login$/);

	const withCookie = proxy(new NextRequest("http://localhost/chat/new", { headers: { cookie: "lh_session=present" } }));
	assert.equal(withCookie.headers.get("x-middleware-next"), "1");
	assert.equal(proxy(new NextRequest("http://localhost/login")).headers.get("x-middleware-next"), "1");
	assert.equal(proxy(new NextRequest("http://localhost/api/settings")).headers.get("x-middleware-next"), "1");

	const previous = process.env.LH_SERVER_MODE;
	delete process.env.LH_SERVER_MODE;
	try {
		assert.equal(proxy(new NextRequest("http://localhost/chat/new")).headers.get("x-middleware-next"), "1");
	} finally {
		process.env.LH_SERVER_MODE = previous;
	}
});
