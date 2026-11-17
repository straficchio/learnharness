/**
 * Attachment storage + retention contract. The module reads config at import
 * time, so this file claims its own LH_DATA_DIR before any dynamic import —
 * the same isolation pattern as the other store tests.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-attachments-"));
process.env.LH_DATA_DIR = root;
process.env.LH_AUTH_FILE = path.join(root, "auth.json");

const {
	attachmentIdsInText,
	cleanupChatAttachments,
	storeAttachment,
	sweepAttachmentsNow,
} = await import("../src/server/attachments.ts");
const { writeSettings } = await import("../src/store/settings.ts");
const { isDeniedPath } = await import("../src/agent/tools/fs-shared.ts");
const { ATTACHMENT_GRACE_MS } = await import("../lib/attachment-limits.ts");

after(() => fs.rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
	fs.rmSync(attachmentRoot, { recursive: true, force: true });
	fs.rmSync(chatsRoot, { recursive: true, force: true });
	fs.rmSync(path.join(root, "settings.json"), { force: true });
});

const DAY = 24 * 60 * 60 * 1000;
const attachmentRoot = path.join(root, "attachments");
const chatsRoot = path.join(root, "chats");

function file(name: string, text = "document text", type = "text/plain"): File {
	return new File([text], name, { type });
}

function age(dir: string, ageMs: number, draft?: boolean): void {
	const metaPath = path.join(dir, "meta.json");
	const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as Record<string, unknown>;
	meta.createdAt = new Date(Date.now() - ageMs).toISOString();
	if (draft !== undefined) meta.draft = draft;
	fs.writeFileSync(metaPath, JSON.stringify(meta));
}

function chat(id: string, text: string): void {
	fs.mkdirSync(chatsRoot, { recursive: true });
	fs.writeFileSync(path.join(chatsRoot, `${id}.json`), JSON.stringify({ messages: [{ role: "user", content: text }] }));
}

test("stores a document under an app-managed UUID directory with metadata", async () => {
	const stored = await storeAttachment(file("Course Notes.txt", "hello"), { draft: false });
	assert.match(stored.id, /^[0-9a-f-]{36}$/);
	assert.equal(stored.name, "Course Notes.txt");
	assert.equal(stored.size, 5);
	assert.equal(stored.path, path.join(attachmentRoot, stored.id, "Course Notes.txt"));
	assert.equal(fs.readFileSync(stored.path, "utf-8"), "hello");
	const meta = JSON.parse(fs.readFileSync(path.join(attachmentRoot, stored.id, "meta.json"), "utf-8"));
	assert.equal(meta.draft, false);
	assert.equal(meta.name, "Course Notes.txt");
});

test("rejects binaries, empty files and credential-shaped names cannot become tools escape", async () => {
	await assert.rejects(storeAttachment(file("photo.jpg", "x", "image/jpeg"), { draft: true }), /PDF and text/);
	await assert.rejects(storeAttachment(file("empty.txt", "", "text/plain"), { draft: true }), /empty/);
	await assert.rejects(storeAttachment(file("auth.json", "{}", "application/json"), { draft: true }), /PDF and text/);
	const stored = await storeAttachment(file("../../study-notes.txt", "not a credential store"), { draft: true });
	assert.equal(path.dirname(stored.path), path.join(attachmentRoot, stored.id));
	assert.equal(isDeniedPath(stored.path), false, "attachment copies are readable");
	assert.equal(isDeniedPath(path.join(root, "settings.json")), true, "the rest of the data root stays denied");
});

test("extracts app attachment ids from POSIX and Windows message text", () => {
	const id = "11111111-2222-4333-8444-555555555555";
	assert.deepEqual([...attachmentIdsInText(`see /x/attachments/${id}/paper.pdf`)], [id]);
	assert.deepEqual([...attachmentIdsInText(`see C:\\x\\attachments\\${id}\\paper.pdf`)], [id]);
	// Session cleanup scans the serialized record, where Windows separators
	// are doubled by JSON escaping.
	assert.deepEqual([...attachmentIdsInText(JSON.stringify([{ content: `C:\\x\\attachments\\${id}\\paper.pdf` }]))], [id]);
	assert.equal(attachmentIdsInText(`/x/attachments/not-a-uuid/paper.pdf`).size, 0);
});

test("draft attachments get the configured retention; existing-session copies get the one-hour grace", async () => {
	writeSettings({ version: 1, general: { attachmentRetentionDays: 45 } });
	const draft = await storeAttachment(file("draft.pdf", "%PDF-1.4", "application/pdf"), { draft: true });
	const session = await storeAttachment(file("session.txt", "session", "text/plain"), { draft: false });
	age(path.join(attachmentRoot, draft.id), 31 * DAY);
	age(path.join(attachmentRoot, session.id), ATTACHMENT_GRACE_MS + 1000);
	let stats = await sweepAttachmentsNow();
	assert.equal(fs.existsSync(path.join(attachmentRoot, draft.id)), true, "45-day draft survives day 31");
	assert.equal(fs.existsSync(path.join(attachmentRoot, session.id)), false, "unreferenced existing-session copy is gone");
	assert.equal(stats.deleted, 1);

	writeSettings({ version: 1, general: { attachmentRetentionDays: 30 } });
	age(path.join(attachmentRoot, draft.id), 31 * DAY);
	stats = await sweepAttachmentsNow();
	assert.equal(fs.existsSync(path.join(attachmentRoot, draft.id)), false, "default-30 delete after day 31");
	assert.equal(stats.deleted, 1);
});

test("referenced copies are kept regardless of age; deleting the final session reference removes them", async () => {
	const kept = await storeAttachment(file("kept.txt", "kept", "text/plain"), { draft: true });
	age(path.join(attachmentRoot, kept.id), 90 * DAY);
	chat("other", `Read /x/attachments/${kept.id}/kept.txt`);
	let stats = await sweepAttachmentsNow();
	assert.equal(fs.existsSync(path.join(attachmentRoot, kept.id)), true);
	assert.equal(stats.kept, 1);

	const messages = [{ role: "user", content: `Read /x/attachments/${kept.id}/kept.txt` }];
	fs.rmSync(path.join(chatsRoot, "other.json"));
	assert.equal(await cleanupChatAttachments(root, messages), 1);
	assert.equal(fs.existsSync(path.join(attachmentRoot, kept.id)), false);
});

test("an unreadable chat suppresses deletion rather than guessing unreferenced", async () => {
	const stored = await storeAttachment(file("safe.txt", "safe", "text/plain"), { draft: true });
	age(path.join(attachmentRoot, stored.id), 90 * DAY);
	fs.mkdirSync(chatsRoot, { recursive: true });
	fs.mkdirSync(path.join(chatsRoot, "broken.json"));
	const stats = await sweepAttachmentsNow();
	assert.equal(fs.existsSync(path.join(attachmentRoot, stored.id)), true);
	assert.equal(stats.deleted, 0);
});
