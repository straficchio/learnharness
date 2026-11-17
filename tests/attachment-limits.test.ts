import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	ATTACHMENT_MAX_BYTES,
	attachmentPathsIn,
	isAttachableDocument,
	safeAttachmentName,
} from "../lib/attachment-limits.ts";

const id = "11111111-2222-4333-8444-555555555555";

describe("attachment document gate", () => {
	it("accepts PDFs and text formats, rejects binary and empty types", () => {
		assert.equal(isAttachableDocument({ name: "paper.pdf", type: "application/pdf" }), true);
		assert.equal(isAttachableDocument({ name: "notes.md", type: "" }), true);
		assert.equal(isAttachableDocument({ name: "data.csv", type: "text/csv" }), true);
		assert.equal(isAttachableDocument({ name: "README", type: "text/plain" }), true);
		assert.equal(isAttachableDocument({ name: "photo.jpg", type: "image/jpeg" }), false);
		assert.equal(isAttachableDocument({ name: "archive.zip", type: "application/zip" }), false);
		assert.equal(isAttachableDocument({ name: "auth.json", type: "application/json" }), false);
		assert.equal(isAttachableDocument({ name: "id_rsa", type: "text/plain" }), false);
		assert.equal(isAttachableDocument({ name: "study-key.pem", type: "text/plain" }), false);
	});

	it("uses a safe basename and keeps the 50 MB ceiling explicit", () => {
		assert.equal(safeAttachmentName("../../Course Notes.pdf"), "Course Notes.pdf");
		assert.equal(safeAttachmentName("a/b\\c.txt"), "c.txt");
		assert.equal(safeAttachmentName(".."), "document");
		assert.equal(ATTACHMENT_MAX_BYTES, 50 * 1024 * 1024);
	});

	it("counts only app-managed paths already chipped into a draft", () => {
		const value = [
			"see `/Users/me/course notes.pdf`",
			`and \`/Users/me/data/attachments/${id}/paper.pdf\``,
			`plus \`C:\\Users\\me\\attachments\\${id}\\notes.txt\``,
		].join(" ");
		assert.deepEqual(attachmentPathsIn(value).sort(), [
			`/Users/me/data/attachments/${id}/paper.pdf`,
			`C:\\Users\\me\\attachments\\${id}\\notes.txt`,
		].sort());
		assert.deepEqual(attachmentPathsIn("plain words"), []);
	});
});
