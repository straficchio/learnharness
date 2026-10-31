/**
 * Bulk session UI + transport: the sticky bar, the delete confirmation
 * body, and the ZIP export request.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	BulkDeleteBody,
	BulkSelectionBar,
	deleteSessionsBulk,
	exportSessionsZip,
} from "../components/session-bulk.tsx";
import type { ChatListItem } from "../src/core/index.ts";

function chat(id: string, title: string): ChatListItem {
	return {
		id,
		title,
		kind: "teach",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-02T00:00:00.000Z",
		messageCount: 2,
		phase: "teach",
		pendingQuestion: false,
		pendingProblem: false,
		busy: false,
		compacting: false,
	};
}

describe("BulkSelectionBar", () => {
	it("renders the count, select-all, export, delete, and cancel", () => {
		const html = renderToStaticMarkup(
			<BulkSelectionBar
				count={3}
				canSelectAll
				onSelectAll={() => {}}
				onExport={() => {}}
				onDelete={() => {}}
				onCancel={() => {}}
				exporting={false}
				error={null}
			/>,
		);
		assert.match(html, /data-testid="bulk-selection-bar"/);
		assert.match(html, /data-testid="bulk-selection-count"[^>]*>3</);
		assert.match(html, /data-testid="bulk-select-all"/);
		assert.match(html, /data-testid="bulk-export"/);
		assert.match(html, /data-testid="bulk-delete"/);
		assert.match(html, /data-testid="bulk-cancel"/);
	});

	it("shows the export failure inline", () => {
		const html = renderToStaticMarkup(
			<BulkSelectionBar
				count={2}
				canSelectAll={false}
				onSelectAll={() => {}}
				onExport={() => {}}
				onDelete={() => {}}
				onCancel={() => {}}
				exporting
				error="Could not reach the server."
			/>,
		);
		assert.match(html, /data-testid="bulk-error"/);
		assert.match(html, /Could not reach the server\./);
		assert.match(html, /Exporting…/);
	});
});

describe("BulkDeleteBody", () => {
	it("names the selection, carries the traces checkbox, and offers Delete", () => {
		const html = renderToStaticMarkup(
			<BulkDeleteBody
				chats={[chat("a", "Alpha"), chat("b", "Beta")]}
				traces={false}
				busy={false}
				progress={null}
				deleted={0}
				failed={[]}
				onTraces={() => {}}
				onClose={() => {}}
				onRun={() => {}}
				onRetry={() => {}}
			/>,
		);
		assert.match(html, /Delete 2 sessions\?/);
		assert.match(html, /Alpha/);
		assert.match(html, /Beta/);
		assert.match(html, /data-testid="delete-traces-checkbox"/);
		assert.match(html, /data-testid="bulk-delete-confirm"/);
	});

	it("reports failures and offers Retry failed", () => {
		const html = renderToStaticMarkup(
			<BulkDeleteBody
				chats={[chat("a", "Alpha"), chat("b", "Beta")]}
				traces
				busy={false}
				progress={{ done: 2, total: 2 }}
				deleted={1}
				failed={[{ id: "b", title: "Beta", error: "A turn is running.", code: "turn_in_flight" }]}
				onTraces={() => {}}
				onClose={() => {}}
				onRun={() => {}}
				onRetry={() => {}}
			/>,
		);
		assert.match(html, /data-testid="bulk-delete-failures"/);
		assert.match(html, /Deleted 1; 1 could not be deleted/);
		assert.match(html, /A turn is running\./);
		assert.match(html, /data-testid="bulk-delete-retry"/);
		assert.match(html, /Retry failed/);
	});
});

describe("sidebar bulk wiring", () => {
	it("mounts the select-all link, selected rows, bar, and bulk dialog", () => {
		const source = readFileSync(new URL("../components/sidebar.tsx", import.meta.url), "utf8");
		assert.match(source, /data-testid="select-all-sessions"/);
		assert.match(source, /selected=\{selectedIds\.has\(c\.id\)\}/);
		assert.match(source, /<BulkSelectionBar/);
		assert.match(source, /<BulkDeleteDialog/);
		assert.match(source, /onBulkImported=/);
	});
});

describe("deleteSessionsBulk", () => {
	it("continues past a failure and reports it with the successful ids", async () => {
		const progress: number[] = [];
		const calls: string[] = [];
		const result = await deleteSessionsBulk(
			[
				{ id: "a", title: "Alpha" },
				{ id: "b", title: "Beta" },
				{ id: "c", title: "Gamma" },
			],
			"preserve-graph",
			{
				onProgress: (done) => progress.push(done),
				fetchImpl: (async (input: RequestInfo | URL) => {
					const url = String(input);
					calls.push(url);
					if (url.includes("/b?")) {
						return new Response(
							JSON.stringify({ error: "A turn is running.", code: "turn_in_flight" }),
							{ status: 409 },
						);
					}
					return new Response(JSON.stringify({ ok: true, graphRevision: url.includes("/c?") ? 7 : 3 }), {
						status: 200,
					});
				}) as typeof fetch,
			},
		);
		assert.equal(calls.length, 3, "the failed middle session did not stop the batch");
		assert.deepEqual(progress, [1, 2, 3]);
		assert.deepEqual(result.deletedIds, ["a", "c"]);
		assert.deepEqual(result.failed, [
			{ id: "b", title: "Beta", error: "A turn is running.", code: "turn_in_flight" },
		]);
		assert.equal(result.graphRevision, 7);
	});
});

describe("exportSessionsZip", () => {
	it("POSTs the ids and reads the server filename", async () => {
		let body = "";
		const outcome = await exportSessionsZip(["a", "b"], {
			fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
				assert.equal(String(input), "/api/chats/export");
				assert.equal(init?.method, "POST");
				body = String(init?.body);
				return new Response(new Uint8Array([1, 2, 3]), {
					status: 200,
					headers: {
						"content-type": "application/zip",
						"content-disposition": 'attachment; filename="learnharness-sessions-2026-10-31.zip"',
					},
				});
			}) as typeof fetch,
		});
		assert.equal(body, JSON.stringify({ ids: ["a", "b"] }));
		assert.equal(outcome.ok, true);
		if (outcome.ok) {
			assert.equal(outcome.filename, "learnharness-sessions-2026-10-31.zip");
			assert.equal(outcome.blob.size, 3);
		}
	});

	it("surfaces a server refusal", async () => {
		const outcome = await exportSessionsZip(["a"], {
			fetchImpl: (async () =>
				new Response(JSON.stringify({ error: "Select at least one session." }), { status: 400 })) as typeof fetch,
		});
		assert.deepEqual(outcome, { ok: false, error: "Select at least one session." });
	});
});
