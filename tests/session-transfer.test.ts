/**
 * The lossless session-transfer contract: the wrapper shape, the filename,
 * and the import validator. Route behavior is pinned separately in
 * session-export-import.test.ts.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildSessionExport,
	MAX_SESSION_IMPORT_BYTES,
	parseSessionExport,
	SESSION_EXPORT_FORMAT,
	SESSION_EXPORT_VERSION,
	sessionExportFilename,
} from "../src/core/session-transfer.ts";
import { CURRENT_CHAT_VERSION, type ChatRecord } from "../src/core/contracts/chat.ts";

const record = (overrides: Partial<ChatRecord> = {}): ChatRecord => ({
	id: "chat_transfer_1",
	title: "Relational Databases — Joins & Normal Forms",
	createdAt: "2026-10-01T10:00:00.000Z",
	updatedAt: "2026-10-02T11:00:00.000Z",
	kind: "practice",
	messages: [
		{ id: "m1", role: "user", content: "Teach me joins", timestamp: 1 } as never,
		{ id: "m2", role: "assistant", content: [{ type: "text", text: "A join combines rows." }], timestamp: 2 } as never,
	],
	settings: { model: { provider: "local", id: "qwen3" }, thinkingLevel: "medium" },
	tree: { nodes: [{ id: "joins", title: "Joins" }], edges: [], version: 2 },
	turns: [{ id: "turn-1", messageId: "m2", at: "2026-10-01T10:00:00.000Z", model: "local:qwen3", steps: [] }],
	extractions: [
		{
			startedAt: 1,
			at: "2026-10-01T10:05:00.000Z",
			durationMs: 1200,
			stages: {
				extractor: { model: "local:qwen3", steps: [] },
				auditor: { model: "local:qwen3", steps: [] },
			},
		},
	],
	version: CURRENT_CHAT_VERSION,
	...overrides,
});

describe("buildSessionExport", () => {
	it("wraps the full record with a format and version", () => {
		const exported = buildSessionExport(record(), "2026-10-31T12:00:00.000Z");
		assert.equal(exported.format, SESSION_EXPORT_FORMAT);
		assert.equal(exported.version, SESSION_EXPORT_VERSION);
		assert.equal(exported.exportedAt, "2026-10-31T12:00:00.000Z");
		assert.deepEqual(exported.session, record());
	});

	it("round-trips every preserved field through the import parser", () => {
		const parsed = parseSessionExport(buildSessionExport(record()));
		assert.equal(parsed.ok, true);
		if (!parsed.ok) return;
		assert.deepEqual(parsed.session, record());
	});

	it("accepts a raw data/chats record as a migration convenience", () => {
		const parsed = parseSessionExport(record());
		assert.equal(parsed.ok, true);
		if (!parsed.ok) return;
		assert.equal(parsed.session.id, "chat_transfer_1");
		assert.equal(parsed.session.kind, "practice");
		assert.deepEqual(parsed.session.tree, record().tree);
	});

	it("preserves a teach record and omits absent optional fields", () => {
		const parsed = parseSessionExport(record({ kind: undefined, settings: undefined, tree: undefined, turns: undefined, extractions: undefined }));
		assert.equal(parsed.ok, true);
		if (!parsed.ok) return;
		assert.equal(parsed.session.kind, undefined);
		assert.equal(parsed.session.settings, undefined);
		assert.equal(parsed.session.tree, undefined);
		assert.equal(parsed.session.turns, undefined);
		assert.equal(parsed.session.extractions, undefined);
	});
});

describe("sessionExportFilename", () => {
	it("slugifies the title and keeps the id unique", () => {
		assert.equal(
			sessionExportFilename(record()),
			"session-relational-databases-joins-normal-forms-chat_transfer_1.json",
		);
	});
	it("falls back to 'session' for a non-ascii title", () => {
		assert.equal(sessionExportFilename(record({ title: "日本語" })), "session-session-chat_transfer_1.json");
	});
});

describe("parseSessionExport rejection", () => {
	it("rejects non-objects, legacy wrappers, and future formats", () => {
		assert.equal(parseSessionExport(null).ok, false);
		assert.equal(parseSessionExport([]).ok, false);
		assert.equal(parseSessionExport({ format: "other", version: 1, session: record() }).ok, false);
		assert.equal(parseSessionExport({ format: SESSION_EXPORT_FORMAT, version: 99, session: record() }).ok, false);
		assert.equal(parseSessionExport({ format: SESSION_EXPORT_FORMAT, version: 1 }).ok, false);
		assert.equal(parseSessionExport(record({ version: CURRENT_CHAT_VERSION + 1 })).ok, false);
	});

	it("rejects unsafe ids, missing messages, and unknown roles", () => {
		assert.equal(parseSessionExport(record({ id: "../escape" })).ok, false);
		assert.equal(parseSessionExport(record({ messages: undefined as never })).ok, false);
		assert.equal(
			parseSessionExport(record({ messages: [{ id: "m1", role: "system", content: "x" } as never] })).ok,
			false,
		);
		assert.equal(
			parseSessionExport(record({ messages: [{ role: "user", content: "no id" } as never] })).ok,
			false,
		);
	});

	it("rejects malformed settings, tree, turns, and extractions", () => {
		assert.equal(parseSessionExport(record({ settings: { model: { provider: "local" } } as never })).ok, false);
		assert.equal(parseSessionExport(record({ settings: { thinkingLevel: "ultra" } as never })).ok, false);
		assert.equal(parseSessionExport(record({ tree: { nodes: "no", edges: [], version: 1 } as never })).ok, false);
		assert.equal(parseSessionExport(record({ turns: [{ id: "t" }] as never })).ok, false);
		assert.equal(parseSessionExport(record({ extractions: [{ startedAt: 1 }] as never })).ok, false);
		const missingAuditor = record().extractions![0]!;
		assert.equal(
			parseSessionExport(record({ extractions: [{ ...missingAuditor, stages: { extractor: missingAuditor.stages.extractor } }] as never })).ok,
			false,
		);
	});

	it("rejects malformed kinds and oversized message lists", () => {
		assert.equal(parseSessionExport(record({ kind: "lecture" as never })).ok, false);
		const tooMany = Array.from({ length: 100_001 }, (_, i) => ({ id: `m${i}`, role: "user", content: "x" }));
		assert.equal(parseSessionExport(record({ messages: tooMany as never })).ok, false);
	});
});

it("the import ceiling is a real positive bound", () => {
	assert.ok(MAX_SESSION_IMPORT_BYTES >= 1024 * 1024);
	assert.ok(MAX_SESSION_IMPORT_BYTES <= 100 * 1024 * 1024);
});
