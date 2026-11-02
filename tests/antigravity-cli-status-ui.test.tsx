import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { AntigravityCliInstallationStatus, antigravityCliStatusLabel } from "../components/settings/antigravity-cli-status.tsx";
import { useModelCatalog } from "../components/model-catalog.ts";
import type { AntigravityCliStatus } from "../src/core/contracts/antigravity-cli.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
const originalFetch = globalThis.fetch;
let root: Root | undefined, host: HTMLDivElement | undefined;
const status = (state: AntigravityCliStatus["state"], version: string | null = null): AntigravityCliStatus => ({ state, version, minimumVersion: "1.4.7" });
const button = () => document.querySelector<HTMLButtonElement>('[data-testid="antigravity-cli-check-again"]')!;
const toggle = () => document.querySelector<HTMLButtonElement>('[role="switch"]')!;
const label = () => document.querySelector('[role="status"]')?.textContent;

function fixture(probe: (init?: RequestInit) => Promise<Response>, enabled = true, failSave = false) {
	const calls: string[] = [];
	let on = enabled;
	globalThis.fetch = (async (url, init) => {
		calls.push(`${init?.method ?? "GET"} ${url}`);
		if (url === "/api/settings") return Response.json({ settings: { version: 1, antigravityCli: { enabled: on } } });
		if (url === "/api/settings/antigravityCli") {
			assert.equal(init?.method, "PUT");
			assert.equal(new Headers(init.headers).get("Content-Type"), "application/json");
			if (failSave) return new Response(null, { status: 500 });
			on = JSON.parse(String(init.body)).enabled;
			return Response.json({ settings: { version: 1, antigravityCli: { enabled: on } } });
		}
		if (url === "/api/models") return Response.json({ models: on ? [{ provider: "antigravity-cli", id: "gemini-3.8-flash" }] : [] });
		assert.equal(url, "/api/antigravity-cli");
		assert.equal(init?.cache, "no-store");
		assert.equal(new Headers(init?.headers).get("x-learnharness-antigravity-cli"), "1");
		return probe(init);
	}) as typeof fetch;
	return calls;
}

async function mount(extra?: React.ReactNode) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(<><AntigravityCliInstallationStatus />{extra}</>));
}
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	root = undefined;
	host = undefined;
	globalThis.fetch = originalFetch;
});

test("initial render is collapsed and off, with no setup prose or version probe action", () => {
	const html = renderToStaticMarkup(<AntigravityCliInstallationStatus />);
	assert.match(html, /Antigravity CLI/);
	assert.match(html, /aria-checked="false"/);
	assert.equal((html.match(/<button/g) ?? []).length, 1);
	assert(!html.includes("Check again"));
	assert(!html.includes("Setup ↗"));
});

test("off by default; enabling persists before probing and reveals the version/action row", async () => {
	const calls = fixture(async () => Response.json(status("not-found")), false);
	await mount();
	assert.equal(toggle().getAttribute("aria-checked"), "false");
	assert(!button());
	assert.deepEqual(calls, ["GET /api/settings"]);
	await act(async () => toggle().click());
	assert.equal(toggle().getAttribute("aria-checked"), "true");
	assert.equal(label(), "Not found");
	assert(calls.indexOf("PUT /api/settings/antigravityCli") < calls.indexOf("GET /api/antigravity-cli"));
	assert.match(document.body.textContent ?? "", /no background process required/);
	assert.match(document.body.textContent ?? "", /not authentication, model access, or quota/);
	assert.match(document.body.textContent ?? "", /Antigravity CLI controls billing/);
	assert.match(document.body.textContent ?? "", /Verify AI claims independently/);
	assert.equal(document.querySelector("a")?.getAttribute("href"), "https://antigravity.google/docs/cli/reference");
	await act(async () => toggle().click());
	assert.equal(toggle().getAttribute("aria-checked"), "false");
	assert(!button());
	assert.equal(label(), undefined);
	assert.equal(calls.filter((call) => call === "GET /api/antigravity-cli").length, 1);
});

for (const [value, text] of [
	[status("not-found"), "Not found"],
	[status("meets-minimum", "1.4.8"), "Version 1.4.8 · meets minimum"],
	[status("update-required", "1.4.6"), "Version 1.4.6 · update required"],
	[status("version-unchecked"), "Version could not be checked"],
] as const) test(`installation display: ${text}`, () => assert.equal(antigravityCliStatusLabel(value), text));

test("enabled mount checks once; Check again refreshes", async () => {
	let probes = 0;
	const calls = fixture(async () => Response.json(++probes === 1 ? status("not-found") : status("meets-minimum", "1.4.8")));
	await mount();
	assert.equal(label(), "Not found");
	await act(async () => button().click());
	assert.equal(label(), "Version 1.4.8 · meets minimum");
	assert.equal(calls.filter((call) => call === "GET /api/antigravity-cli").length, 2);
});

test("failed opt-in save stays collapsed/off and never probes", async () => {
	const calls = fixture(async () => assert.fail("must not probe"), false, true);
	await mount();
	await act(async () => toggle().click());
	assert.equal(toggle().getAttribute("aria-checked"), "false");
	assert(!button());
	assert.match(document.querySelector('[role="alert"]')?.textContent ?? "", /Could not save/);
	assert(!calls.includes("GET /api/antigravity-cli"));
});

for (const failure of ["network", "http", "payload"] as const) test(`${failure} failure never retains a stale meets-minimum status`, async () => {
	let calls = 0;
	fixture(async () => {
		if (++calls === 1) return Response.json(status("meets-minimum", "1.4.8"));
		if (failure === "network") throw new Error("offline");
		return failure === "http" ? new Response(null, { status: 503 }) : Response.json({ state: "authenticated" });
	});
	await mount();
	assert.equal(label(), "Version 1.4.8 · meets minimum");
	await act(async () => button().click());
	assert.equal(label(), "Version could not be checked");
	assert(!button().disabled);
});

function CatalogReader() {
	const { catalog } = useModelCatalog();
	return <span data-testid="agy-catalog-models">{catalog?.models.map((m) => `${m.provider}:${m.id}`).join(",") ?? "loading"}</span>;
}

test("persisted toggle updates invalidate shared model availability in both directions", async () => {
	fixture(async () => Response.json(status("not-found")), false);
	await mount(<CatalogReader />);
	const models = () => document.querySelector('[data-testid="agy-catalog-models"]')?.textContent;
	assert.equal(models(), "");
	await act(async () => toggle().click());
	assert.equal(models(), "antigravity-cli:gemini-3.8-flash");
	await act(async () => toggle().click());
	assert.equal(models(), "");
});
