/**
 * Portable session bundles: export carries the uploaded copies, import
 * restores them under the importing user's root, and every non-uploaded
 * local path becomes a placeholder. Runs under an isolated LH_DATA_DIR.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { strFromU8, unzipSync } from "fflate";
import type { ChatRecord } from "../src/core/contracts/chat.ts";
import { bundleAttachmentRef } from "../src/core/session-bundle.ts";
import { runInScope } from "../src/core/request-scope.ts";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-session-bundle-"));
process.env.LH_DATA_DIR = TMP_DATA;

type ExportGet = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
type Post = (req: Request) => Promise<Response>;

let GET: ExportGet;
let BULK_EXPORT: Post;
let IMPORT: Post;
let chatStore: { importChat: (record: ChatRecord) => ChatRecord | null; getChat: (id: string) => ChatRecord | null; deleteChat: (id: string) => boolean };
let storeAttachment: (file: File, options: { draft: boolean }) => Promise<{ id: string; path: string; name: string; size: number }>;
let prepareSessionForExport: (record: ChatRecord) => Promise<{ record: ChatRecord; attachments: Array<{ entry: string; refs: string[] }> }>;
let PATHS: { attachments: string };
let BASE_DATA_ROOT: string;

const PDF_BYTES = Buffer.from("%PDF-1.4\nbundle attachment\n");
const TEACHER_PATH = "/opt/examples/server.ts";

function record(id: string, pdfPath: string, localPath = "/Users/marco/notes/local.pdf"): ChatRecord {
	return {
		id,
		title: `Bundle ${id}`,
		createdAt: "2026-11-22T00:00:00.000Z",
		updatedAt: "2026-11-22T00:00:00.000Z",
		messages: [
			{ id: "m1", role: "user", content: `Read \`${pdfPath}\` and \`${localPath}\``, timestamp: 1 } as never,
			{
				id: "m2",
				role: "assistant",
				content: [
					{ type: "text", text: `The example server lives at ${TEACHER_PATH}.` },
					{ type: "toolCall", id: "tc1", name: "pdf", arguments: { path: pdfPath, question: "summarize" } },
				],
				timestamp: 2,
			} as never,
		],
	};
}

function attachmentPaths(value: unknown): string[] {
	const found: string[] = [];
	const visit = (node: unknown): void => {
		if (typeof node === "string") {
			for (const match of node.matchAll(/[^`"\s]*[\\/]attachments[\\/][0-9a-f-]{36}[\\/][^`"\s]+/gi)) found.push(match[0]);
			return;
		}
		if (Array.isArray(node)) { for (const item of node) visit(item); return; }
		if (node !== null && typeof node === "object") { for (const item of Object.values(node)) visit(item); }
	};
	visit(value);
	return [...new Set(found)];
}

async function seedAttachment(): Promise<{ path: string; id: string }> {
	const stored = await storeAttachment(new File([PDF_BYTES], "main.pdf", { type: "application/pdf" }), { draft: false });
	return { path: stored.path, id: stored.id };
}

before(async () => {
	const exportRoute = await import("../app/api/chats/[id]/export/route.ts");
	const bulkRoute = await import("../app/api/chats/export/route.ts");
	const importRoute = await import("../app/api/chats/import/route.ts");
	const stores = await import("../src/store/chats.ts");
	const attachments = await import("../src/server/attachments.ts");
	const bundle = await import("../src/server/session-bundle.ts");
	const config = await import("../config.ts");
	GET = exportRoute.GET;
	BULK_EXPORT = bulkRoute.POST;
	IMPORT = importRoute.POST;
	chatStore = stores.chatStore;
	storeAttachment = attachments.storeAttachment;
	prepareSessionForExport = bundle.prepareSessionForExport;
	PATHS = config.PATHS;
	BASE_DATA_ROOT = config.BASE_DATA_ROOT;
});

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

describe("single-session attachment bundle", () => {
	it("exports the uploaded copy, placeholders local paths, and restores it on import", async () => {
		const attachment = await seedAttachment();
		const source = record("chat_bundle_single", attachment.path);
		assert.ok(chatStore.importChat(source));

		const exported = await GET(new Request("http://x/api"), { params: Promise.resolve({ id: source.id }) });
		assert.equal(exported.status, 200);
		assert.equal(exported.headers.get("content-type"), "application/zip");
		assert.match(exported.headers.get("content-disposition") ?? "", /\.zip"/);

		const exportedBytes = new Uint8Array(await exported.arrayBuffer());
		const entries = unzipSync(exportedBytes);
		assert.ok(entries["manifest.json"]);
		assert.ok(entries[`attachments/${attachment.id}/main.pdf`]);
		const manifest = JSON.parse(strFromU8(entries["manifest.json"]!)) as {
			format: string;
			sessions: Array<{ file: string; attachments: Array<{ entry: string; refs: string[] }> }>;
		};
		assert.equal(manifest.format, "learnharness.session.bundle");
		assert.equal(manifest.sessions.length, 1);
		const manifestSession = manifest.sessions[0]!;
		const ref = bundleAttachmentRef(attachment.id, "main.pdf");
		assert.deepEqual(manifestSession.attachments[0]!.refs, [ref]);
		assert.ok(entries[manifestSession.file]);

		const portable = JSON.parse(strFromU8(entries[manifestSession.file]!)) as { session: ChatRecord };
		const portableText = JSON.stringify(portable.session);
		assert.ok(portableText.includes(ref), "the session carries a portable reference, not a path");
		assert.equal(portableText.includes(attachment.path), false);
		assert.ok(portableText.includes("[local file not included: local.pdf]"));
		assert.equal(portableText.includes("/Users/marco/notes/local.pdf"), false);
		assert.ok(portableText.includes(TEACHER_PATH), "teacher prose/code paths are content, not references");

		const imported = await IMPORT(new Request("http://x/api/chats/import?replace=1", {
			method: "POST",
			headers: { "content-type": "application/zip" },
			body: exportedBytes,
		}));
		assert.equal(imported.status, 200);
		const body = (await imported.json()) as { ok: boolean; replaced: unknown[]; notices: string[] };
		assert.equal(body.ok, true);
		assert.equal(body.replaced.length, 1);
		assert.equal(body.notices.length, 1);

		const restored = chatStore.getChat(source.id)!;
		const [restoredPath] = attachmentPaths(restored);
		assert.ok(restoredPath);
		assert.notEqual(restoredPath, attachment.path);
		assert.equal(path.dirname(path.dirname(restoredPath!)), PATHS.attachments);
		assert.deepEqual(fs.readFileSync(restoredPath!), PDF_BYTES);
		assert.ok(JSON.stringify(restored).includes("[local file not included: local.pdf]"));
	});

	it("does not bundle a copy that belongs to another user's root", async () => {
		const otherId = randomUUID();
		const otherRoot = path.join(BASE_DATA_ROOT, "users", "usr_other");
		const otherPath = path.join(otherRoot, "attachments", otherId, "main.pdf");
		fs.mkdirSync(path.dirname(otherPath), { recursive: true });
		fs.writeFileSync(otherPath, PDF_BYTES);

		const otherRecord = record("chat_bundle_cross_user", otherPath);
		const otherPrepared = await runInScope({ userId: "usr_other", root: otherRoot }, () => prepareSessionForExport(otherRecord));
		assert.equal(otherPrepared.attachments.length, 1);

		const secondRoot = path.join(BASE_DATA_ROOT, "users", "usr_second");
		const secondPrepared = await runInScope({ userId: "usr_second", root: secondRoot }, () => prepareSessionForExport(otherRecord));
		assert.equal(secondPrepared.attachments.length, 0);
		assert.ok(JSON.stringify(secondPrepared.record).includes("[attachment unavailable: main.pdf]"));
	});

	it("marks a missing app-managed copy unavailable instead of leaking its path", async () => {
		const missing = path.join(PATHS.attachments, randomUUID(), "gone.pdf");
		const prepared = await prepareSessionForExport(record("chat_bundle_missing", missing));
		assert.equal(prepared.attachments.length, 0);
		const text = JSON.stringify(prepared.record);
		assert.ok(text.includes("[attachment unavailable: gone.pdf]"));
		assert.equal(text.includes(missing), false);
	});

	it("neutralizes learner paths in an old JSON import", async () => {
		const old = record("chat_bundle_old_json", "/Users/marco/notes/filtering.pdf");
		const res = await IMPORT(new Request("http://x/api/chats/import", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(old),
		}));
		assert.equal(res.status, 200);
		const body = (await res.json()) as { ok: boolean; notices: string[] };
		assert.equal(body.ok, true);
		assert.equal(body.notices.length, 1);
		const stored = JSON.stringify(chatStore.getChat(old.id));
		assert.ok(stored.includes("[local file not included: filtering.pdf]"));
		assert.equal(stored.includes("/Users/marco/notes/filtering.pdf"), false);
	});

	it("restores a shared attachment once across a multi-session bundle", async () => {
		const attachment = await seedAttachment();
		const first = record("chat_bundle_shared_a", attachment.path);
		const second = record("chat_bundle_shared_b", attachment.path);
		assert.ok(chatStore.importChat(first));
		assert.ok(chatStore.importChat(second));

		const exported = await BULK_EXPORT(new Request("http://x/api/chats/export", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ids: [first.id, second.id] }),
		}));
		assert.equal(exported.status, 200);
		const bytes = new Uint8Array(await exported.arrayBuffer());
		const entries = unzipSync(bytes);
		const manifest = JSON.parse(strFromU8(entries["manifest.json"]!)) as {
			sessions: Array<{ id: string; attachments: Array<{ entry: string; refs: string[] }> }>;
		};
		assert.equal(manifest.sessions.length, 2);
		const attachmentEntries = Object.keys(entries).filter((name) => name.startsWith("attachments/"));
		assert.equal(attachmentEntries.length, 1, "shared copy is archived once");

		const imported = await IMPORT(new Request("http://x/api/chats/import?replace=1", {
			method: "POST",
			headers: { "content-type": "application/zip" },
			body: bytes,
		}));
		assert.equal(imported.status, 200);
		const body = (await imported.json()) as { replaced: unknown[]; failures: unknown[] };
		assert.equal(body.replaced.length, 2);
		assert.equal(body.failures.length, 0);

		const a = attachmentPaths(chatStore.getChat(first.id))[0];
		const b = attachmentPaths(chatStore.getChat(second.id))[0];
		assert.ok(a && b);
		assert.equal(a, b, "both sessions point at the one restored copy");
		assert.deepEqual(fs.readFileSync(a!), PDF_BYTES);
	});
});
