/**
 * The session transfer routes: GET /api/chats/:id/export and
 * POST /api/chats/import. Runs under an isolated LH_DATA_DIR (the seam is
 * set before any config-loading import, so app modules are dynamic).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { ChatRecord } from "../src/core/contracts/chat.ts";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-session-transfer-"));
process.env.LH_DATA_DIR = TMP_DATA;

let GET: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let POST: (req: Request) => Promise<Response>;
let BULK_EXPORT: (req: Request) => Promise<Response>;
let getChat: (id: string) => ChatRecord | null;
let importChat: (record: ChatRecord, options?: { replace?: boolean }) => ChatRecord | null;
let deleteChat: (id: string) => boolean;
let currentVersion: number;
let maxBytes: number;

const ID = "chat_transfer_route";

function fullRecord(overrides: Partial<ChatRecord> = {}): ChatRecord {
	return {
		id: ID,
		title: "Transfer me",
		createdAt: "2026-10-01T10:00:00.000Z",
		updatedAt: "2026-10-02T11:00:00.000Z",
		kind: "practice",
		messages: [
			{ id: "m1", role: "user", content: "hello", timestamp: 1 } as never,
			{ id: "m2", role: "assistant", content: [{ type: "text", text: "world" }], timestamp: 2 } as never,
		],
		settings: { model: { provider: "local", id: "qwen3" }, thinkingLevel: "medium" },
		tree: { nodes: [{ id: "n1", title: "One" }], edges: [], version: 3 },
		turns: [{ id: "t1", messageId: "m2", at: "2026-10-01T10:00:00.000Z", model: "local:qwen3", steps: [] }],
		extractions: [
			{
				startedAt: 1,
				at: "2026-10-01T10:01:00.000Z",
				durationMs: 100,
				stages: {
					extractor: { model: "local:qwen3", steps: [] },
					auditor: { model: "local:qwen3", steps: [] },
				},
			},
		],
		version: 1,
		...overrides,
	};
}

before(async () => {
	const exportRoute = await import("../app/api/chats/[id]/export/route.ts");
	const importRoute = await import("../app/api/chats/import/route.ts");
	const bulkExportRoute = await import("../app/api/chats/export/route.ts");
	GET = exportRoute.GET;
	POST = importRoute.POST;
	BULK_EXPORT = bulkExportRoute.POST;
	const { chatStore } = await import("../src/store/chats.ts");
	getChat = chatStore.getChat;
	importChat = chatStore.importChat;
	deleteChat = chatStore.deleteChat;
	const transfer = await import("../src/core/session-transfer.ts");
	maxBytes = transfer.MAX_SESSION_IMPORT_BYTES;
	const chatContracts = await import("../src/core/contracts/chat.ts");
	currentVersion = chatContracts.CURRENT_CHAT_VERSION;
});

describe("GET /api/chats/:id/export", () => {
	it("404s unknown sessions", async () => {
		const res = await GET(new Request("http://x/api/chats/nope/export"), { params: Promise.resolve({ id: "nope" }) });
		assert.equal(res.status, 404);
	});

	it("downloads the full record in the versioned wrapper", async () => {
		const seeded = fullRecord({ version: currentVersion });
		assert.ok(importChat(seeded));
		const res = await GET(new Request("http://x/api"), { params: Promise.resolve({ id: ID }) });
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
		assert.ok((res.headers.get("content-disposition") ?? "").startsWith("attachment;"));
		assert.ok((res.headers.get("content-disposition") ?? "").includes("session-transfer-me-chat_transfer_route.json"));
		const body = (await res.json()) as {
			format: string;
			version: number;
			exportedAt: string;
			session: ChatRecord;
		};
		assert.equal(body.format, "learnharness.session");
		assert.equal(body.version, 1);
		assert.ok(Date.parse(body.exportedAt));
		assert.deepEqual(body.session, seeded);
	});
});

describe("POST /api/chats/import", () => {
	it("refuses an existing id without an explicit replace", async () => {
		const res = await POST(
			new Request("http://x/api/chats/import", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ format: "learnharness.session", version: 1, session: fullRecord() }),
			}),
		);
		assert.equal(res.status, 409);
		const body = (await res.json()) as { code: string; id: string; title: string };
		assert.equal(body.code, "session_exists");
		assert.equal(body.id, ID);
		assert.equal(body.title, "Transfer me");
	});

	it("replaces the existing record when explicitly asked", async () => {
		const replacement = fullRecord({ title: "Replacement", updatedAt: "2026-10-03T11:00:00.000Z" });
		const res = await POST(
			new Request("http://x/api/chats/import?replace=1", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ format: "learnharness.session", version: 1, session: replacement }),
			}),
		);
		assert.equal(res.status, 200);
		const body = (await res.json()) as { ok: boolean; id: string; title: string; replaced: boolean };
		assert.deepEqual(body, { ok: true, id: ID, title: "Replacement", replaced: true });
		assert.equal(getChat(ID)?.title, "Replacement");
	});

	it("restores a raw data/chats record after deletion", async () => {
		assert.equal(deleteChat(ID), true);
		const raw = fullRecord({ version: currentVersion });
		const res = await POST(
			new Request("http://x/api/chats/import", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(raw),
			}),
		);
		assert.equal(res.status, 200);
		const body = (await res.json()) as { ok: boolean; replaced: boolean; id: string };
		assert.equal(body.ok, true);
		assert.equal(body.replaced, false);
		assert.deepEqual(getChat(ID), raw);
	});

	it("rejects invalid JSON and invalid session shapes", async () => {
		const badJson = await POST(
			new Request("http://x/api/chats/import", { method: "POST", headers: { "content-type": "application/json" }, body: "{nope" }),
		);
		assert.equal(badJson.status, 400);
		assert.equal(((await badJson.json()) as { code: string }).code, "invalid_json");

		const badShape = await POST(
			new Request("http://x/api/chats/import", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ format: "learnharness.session", version: 1, session: { id: "x", title: "x" } }),
			}),
		);
		assert.equal(badShape.status, 400);
		assert.equal(((await badShape.json()) as { code: string }).code, "invalid_session");
	});

	it("refuses a file above the import ceiling before parsing", async () => {
		const res = await POST(
			new Request("http://x/api/chats/import", {
				method: "POST",
				headers: { "content-type": "application/json", "content-length": String(maxBytes + 1) },
				body: "{}",
			}),
		);
		assert.equal(res.status, 413);
		assert.equal(((await res.json()) as { code: string }).code, "too_large");
	});
});

describe("bulk ZIP export/import", () => {
	const OTHER = "chat_transfer_bulk_other";
	const NEW = "chat_bulk_zip_new";

	function wrapper(session: ChatRecord): string {
		return JSON.stringify({
			format: "learnharness.session",
			version: 1,
			exportedAt: "2026-10-31T12:00:00.000Z",
			session,
		});
	}

	it("exports one full session JSON per selected id", async () => {
		assert.ok(importChat(fullRecord({ id: OTHER, title: "Other session" })));
		const res = await BULK_EXPORT(
			new Request("http://x/api/chats/export", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ ids: [ID, OTHER, "missing"] }),
			}),
		);
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("content-type"), "application/zip");
		assert.match(res.headers.get("content-disposition") ?? "", /learnharness-sessions-\d{4}-\d{2}-\d{2}\.zip/);
		const entries = unzipSync(new Uint8Array(await res.arrayBuffer()));
		const names = Object.keys(entries).sort();
		assert.equal(names.length, 2);
		assert.ok(names.some((name) => name.endsWith(`-${ID}.json`)));
		assert.ok(names.some((name) => name.endsWith(`-${OTHER}.json`)));
		for (const name of names) {
			const body = JSON.parse(strFromU8(entries[name]!)) as { format: string; session: ChatRecord };
			assert.equal(body.format, "learnharness.session");
			assert.ok([ID, OTHER].includes(body.session.id));
		}
	});

	it("imports new ZIP sessions, reports conflicts, and replaces them on request", async () => {
		deleteChat(NEW);
		const newRecord = fullRecord({ id: NEW, title: "ZIP New" });
		const existingRecord = fullRecord({ id: ID, title: "ZIP Existing" });
		const zip = zipSync({
			"new.json": strToU8(wrapper(newRecord)),
			"existing.json": strToU8(wrapper(existingRecord)),
			"bad.json": strToU8("{not json"),
		});

		const first = await POST(
			new Request("http://x/api/chats/import?zip=1", {
				method: "POST",
				headers: { "content-type": "application/zip" },
				body: zip,
			}),
		);
		assert.equal(first.status, 200);
		const firstBody = (await first.json()) as {
			ok: boolean;
			imported: { id: string }[];
			conflicts: { id: string }[];
			failures: { file: string }[];
		};
		assert.equal(firstBody.ok, true);
		assert.deepEqual(firstBody.imported.map((entry) => entry.id), [NEW]);
		assert.deepEqual(firstBody.conflicts.map((entry) => entry.id), [ID]);
		assert.deepEqual(firstBody.failures.map((entry) => entry.file), ["bad.json"]);
		assert.equal(getChat(NEW)?.title, "ZIP New");

		const second = await POST(
			new Request("http://x/api/chats/import?zip=1&replace=1", {
				method: "POST",
				headers: { "content-type": "application/zip" },
				body: zip,
			}),
		);
		assert.equal(second.status, 200);
		const secondBody = (await second.json()) as {
			imported: { id: string }[];
			replaced: { id: string }[];
			conflicts: { id: string }[];
			failures: { file: string }[];
		};
		assert.equal(secondBody.imported.length, 0);
		assert.deepEqual(secondBody.replaced.map((entry) => entry.id).sort(), [ID, NEW].sort());
		assert.equal(secondBody.conflicts.length, 0);
		assert.deepEqual(secondBody.failures.map((entry) => entry.file), ["bad.json"]);
		assert.equal(getChat(ID)?.title, "ZIP Existing");
		assert.equal(deleteChat(NEW), true);
	});
});

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});
