/**
 * The session-import surface: the sidebar button, its transport helper, and
 * the source wiring to the context-menu export entry. The route itself is
 * pinned in session-export-import.test.ts.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionImportButton, importSessionText } from "../components/session-import.tsx";

describe("SessionImportButton", () => {
	it("renders the import door and the hidden JSON picker", () => {
		const html = renderToStaticMarkup(<SessionImportButton onImported={() => {}} />);
		assert.match(html, /data-testid="import-session"/);
		assert.match(html, /Import session…/);
		assert.match(html, /data-testid="import-session-input"/);
		assert.match(html, /accept="\.json,application\/json"/);
	});
});

describe("importSessionText", () => {
	it("returns the restored session id and title", async () => {
		let url = "";
		const outcome = await importSessionText("{}", {
			fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
				url = String(input);
				assert.equal(init?.method, "POST");
				assert.equal(init?.headers && (init.headers as Record<string, string>)["content-type"], "application/json");
				return new Response(JSON.stringify({ ok: true, id: "chat_imported", title: "Restored", replaced: false }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}) as typeof fetch,
		});
		assert.equal(url, "/api/chats/import");
		assert.deepEqual(outcome, { ok: true, id: "chat_imported", title: "Restored", replaced: false });
	});

	it("surfaces the collision id/title so the UI can ask before replacing", async () => {
		const outcome = await importSessionText("{}", {
			fetchImpl: (async () =>
				new Response(JSON.stringify({ error: "A session with this id already exists.", code: "session_exists", id: "chat_x", title: "Old" }), {
					status: 409,
					headers: { "content-type": "application/json" },
				})) as typeof fetch,
		});
		assert.equal(outcome.ok, false);
		if (outcome.ok) return;
		assert.equal(outcome.code, "session_exists");
		assert.equal(outcome.id, "chat_x");
		assert.equal(outcome.title, "Old");
	});

	it("passes the explicit replace flag", async () => {
		const outcome = await importSessionText("{}", {
			replace: true,
			fetchImpl: (async (input: RequestInfo | URL) => {
				assert.equal(String(input), "/api/chats/import?replace=1");
				return new Response(JSON.stringify({ ok: true, id: "chat_x", title: "Replaced", replaced: true }), {
					status: 200,
				});
			}) as typeof fetch,
		});
		assert.deepEqual(outcome, { ok: true, id: "chat_x", title: "Replaced", replaced: true });
	});

	it("turns server errors and network failures into honest errors", async () => {
		const server = await importSessionText("{}", {
			fetchImpl: (async () => new Response(JSON.stringify({ error: "bad file" }), { status: 400 })) as typeof fetch,
		});
		assert.deepEqual(server, { ok: false, error: "bad file" });

		const network = await importSessionText("{}", {
			fetchImpl: (async () => {
				throw new Error("offline");
			}) as typeof fetch,
		});
		assert.deepEqual(network, { ok: false, error: "Could not reach the server." });
	});
});

describe("sidebar wiring", () => {
	it("offers the lossless export next to Markdown and mounts the import door", () => {
		const source = readFileSync(new URL("../components/sidebar.tsx", import.meta.url), "utf8");
		assert.match(source, /<SessionImportButton/);
		assert.match(source, /data-testid="ctx-export-md"/);
		assert.match(source, /data-testid="ctx-export-session"/);
		assert.ok(source.indexOf('data-testid="ctx-export-md"') < source.indexOf('data-testid="ctx-export-session"'));
		assert.ok(source.indexOf('data-testid="ctx-export-session"') < source.indexOf('data-testid="ctx-delete"'));
	});
});
