import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ATTACHMENT_UNAVAILABLE_PLACEHOLDER_PREFIX,
	LOCAL_FILE_PLACEHOLDER_PREFIX,
	SESSION_BUNDLE_FORMAT,
	SESSION_BUNDLE_VERSION,
	attachmentParts,
	bundleAttachmentEntry,
	bundleAttachmentRef,
	hasPortablePlaceholder,
	localFilePlaceholder,
	parseSessionBundleManifest,
	pathStringsIn,
	referencePathsIn,
	replaceExactPaths,
	unavailableAttachmentPlaceholder,
} from "../src/core/session-bundle.ts";
import { quoteFilePath } from "../src/core/file-paths.ts";

const ID = "1d367abe-a585-4867-b7cb-d6748f2306a1";
const PDF = `/Users/marco/learnharness/data/users/usr_a/attachments/${ID}/main.pdf`;
const LOCAL = "/Users/marco/notes/filtering.pdf";

test("pathStringsIn finds exact arguments, chips, and quoted prose paths", () => {
	const value = {
		messages: [
			{ content: `Read ${quoteFilePath(PDF)} and ${quoteFilePath(LOCAL)}` },
			{ content: [{ type: "toolCall", arguments: { path: PDF } }] },
			{ content: `The brief on "${LOCAL}" is ready.` },
		],
	};
	const paths = pathStringsIn(value);
	assert.ok(paths.includes(PDF));
	assert.ok(paths.includes(LOCAL));
});

test("pathStringsIn ignores relative names and arbitrary prose", () => {
	assert.deepEqual(pathStringsIn({ content: "main.pdf is not a path" }), []);
	assert.deepEqual(pathStringsIn({ content: "read ./main.pdf" }), []);
});

test("referencePathsIn keeps learner references and tool arguments, not teacher content", () => {
	const teacherPath = "/opt/examples/server.ts";
	const paths = referencePathsIn({
		messages: [
			{ role: "user", content: `Read ${quoteFilePath(LOCAL)}` },
			{ role: "assistant", content: [{ type: "toolCall", arguments: { path: PDF } }] },
			{ role: "assistant", content: [{ type: "text", text: `The example lives at ${teacherPath}.` }] },
			{ role: "toolResult", content: [{ type: "text", text: `contents of ${teacherPath}` }] },
		],
	});
	assert.ok(paths.includes(LOCAL));
	assert.ok(paths.includes(PDF));
	assert.equal(paths.includes(teacherPath), false);
});

test("replaceExactPaths rewrites chips and exact strings without touching other text", () => {
	const next = `/Users/marco/data/attachments/new-id/main.pdf`;
	const value = {
		text: `before ${quoteFilePath(PDF)} after`,
		args: { path: PDF },
		other: "nothing to change",
	};
	const replaced = replaceExactPaths(value, new Map([[PDF, next]])) as typeof value;
	assert.equal(replaced.text, `before ${next} after`);
	assert.equal(replaced.args.path, next);
	assert.equal(replaced.other, "nothing to change");
});

test("placeholders are plain text and detectable", () => {
	const local = localFilePlaceholder(LOCAL);
	const unavailable = unavailableAttachmentPlaceholder(PDF);
	assert.equal(local, "[local file not included: filtering.pdf]");
	assert.equal(unavailable, "[attachment unavailable: main.pdf]");
	assert.ok(hasPortablePlaceholder({ text: local }));
	assert.ok(hasPortablePlaceholder({ text: unavailable }));
	assert.equal(hasPortablePlaceholder({ text: "ordinary" }), false);
});

test("attachmentParts recognizes both path spellings", () => {
	assert.deepEqual(attachmentParts(PDF), { id: ID, name: "main.pdf" });
	assert.deepEqual(attachmentParts(`C:\\data\\attachments\\${ID}\\main.pdf`), { id: ID, name: "main.pdf" });
	assert.equal(attachmentParts("/Users/marco/notes/filtering.pdf"), null);
});

test("bundleAttachmentEntry keeps the id/name contract", () => {
	assert.equal(bundleAttachmentEntry(ID, "main.pdf"), `attachments/${ID}/main.pdf`);
});

test("parseSessionBundleManifest accepts a valid bundle and rejects traversal", () => {
	const valid = {
		format: SESSION_BUNDLE_FORMAT,
		version: SESSION_BUNDLE_VERSION,
		exportedAt: "2026-11-22T00:00:00.000Z",
		sessions: [{
			file: "sessions/session-filtering-chat_1.json",
			id: "chat_1",
			title: "Filtering",
			attachments: [{
				entry: `attachments/${ID}/main.pdf`,
				name: "main.pdf",
				size: 4,
				refs: [bundleAttachmentRef(ID, "main.pdf")],
			}],
		}],
	};
	const parsed = parseSessionBundleManifest(valid);
	assert.equal(parsed.ok, true);
	if (parsed.ok) assert.equal(parsed.manifest.sessions[0]!.attachments[0]!.name, "main.pdf");

	const traversal = structuredClone(valid);
	traversal.sessions[0]!.file = "sessions/../../evil.json";
	assert.equal(parseSessionBundleManifest(traversal).ok, false);

	const badEntry = structuredClone(valid);
	badEntry.sessions[0]!.attachments[0]!.entry = `attachments/${ID}/../evil`;
	assert.equal(parseSessionBundleManifest(badEntry).ok, false);
});

test("the placeholder prefixes are the documented wording", () => {
	assert.equal(LOCAL_FILE_PLACEHOLDER_PREFIX, "[local file not included: ");
	assert.equal(ATTACHMENT_UNAVAILABLE_PLACEHOLDER_PREFIX, "[attachment unavailable: ");
});
