import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { LoginForm } from "../components/login.tsx";
import { SettingsDialogBody } from "../components/settings/settings-dialog.tsx";
import { SessionProvider } from "../components/session-user.tsx";

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
const navigations: string[] = [];
Object.defineProperty(dom.window, "location", {
	configurable: true,
	value: { assign: (url: string) => navigations.push(url) },
});

afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	root = undefined;
	host = undefined;
	globalThis.fetch = originalFetch;
	navigations.length = 0;
});

const users = [
	{ id: "usr_admin", name: "Admin", role: "admin" as const, hasPassword: false },
	{ id: "usr_alice", name: "Alice", role: "user" as const, hasPassword: true },
];

function fixture() {
	const calls: Array<{ url: string; body?: unknown }> = [];
	globalThis.fetch = (async (url, init) => {
		const href = String(url);
		if (href === "/api/auth/users") return Response.json({ users, serverMode: true, standalone: false });
		if (href === "/api/auth/login") {
			calls.push({ url: href, body: JSON.parse(String(init?.body)) });
			return Response.json({ user: users[0], serverMode: true, standalone: false });
		}
		throw new Error(`unexpected fetch ${href}`);
	}) as typeof fetch;
	return calls;
}

async function mount(node: React.ReactNode) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(<>{node}</>));
}

test("login lists users, defaults remember off, and skips password setup without sending one", async () => {
	const calls = fixture();
	await mount(<LoginForm />);
	assert.match(document.body.textContent ?? "", /Admin/);
	assert.match(document.body.textContent ?? "", /Alice/);
	await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="login-user-Admin"]')!.click());
	assert.equal(document.querySelector<HTMLInputElement>('[data-testid="login-remember"]')!.checked, false);
	assert.match(document.body.textContent ?? "", /This account has no password yet/);
	await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="login-skip"]')!.click());
	assert.deepEqual(calls[0]?.body, { userId: "usr_admin", remember: false });
	assert.deepEqual(navigations, ["/"]);
});

function settingsMarkup(role: "admin" | "user", serverMode: boolean) {
	return renderToStaticMarkup(
		<SessionProvider
			user={{ id: role === "admin" ? "usr_admin" : "usr_alice", name: role === "admin" ? "Admin" : "Alice", role, hasPassword: true }}
			serverMode={serverMode}
			standalone={!serverMode}
		>
			<SettingsDialogBody onClose={() => {}} />
		</SessionProvider>,
	);
}

test("non-admin settings expose only Appearance", () => {
	const html = settingsMarkup("user", true);
	assert.match(html, /data-testid="settings-nav-appearance"/);
	assert.doesNotMatch(html, /settings-nav-keys/);
	assert.doesNotMatch(html, /settings-nav-users/);
	assert.match(html, /settings-nav-appearance[^>]*aria-current="true"/);
});

test("admin server settings add Users, Server and the admin-only General", () => {
	const html = settingsMarkup("admin", true);
	assert.match(html, /settings-nav-users/);
	assert.match(html, /settings-nav-server/);
	assert.match(html, /settings-nav-general/);
	assert.match(html, /settings-nav-keys[^>]*aria-current="true"/);
});

test("admin standalone settings keep General and hide multi-user sections", () => {
	const html = settingsMarkup("admin", false);
	assert.match(html, /settings-nav-general/);
	assert.doesNotMatch(html, /settings-nav-users/);
	assert.doesNotMatch(html, /settings-nav-server/);
});
