/**
 * The async title job: file-only prompts are re-titled from the selected
 * model's reading of the file excerpt, and a learner rename always wins.
 * Runs under an isolated LH_DATA_DIR.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import type { PiEngine } from "../src/agent/models.ts";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-title-job-"));
process.env.LH_DATA_DIR = TMP_DATA;
const FILE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "lh-title-files-"));

let generateSessionTitle: typeof import("../src/server/session-title.ts").generateSessionTitle;
let chatStore: typeof import("../src/store/chats.ts").chatStore;

before(async () => {
	const mod = await import("../src/server/session-title.ts");
	generateSessionTitle = mod.generateSessionTitle;
	const store = await import("../src/store/chats.ts");
	chatStore = store.chatStore;
});

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
	fs.rmSync(FILE_ROOT, { recursive: true, force: true });
});

function original(text: string): Promise<{ text: string; newMessages: never[] }> {
	return Promise.resolve({ text, newMessages: [] });
}

describe("generateSessionTitle", () => {
	it("sends the file excerpt to the selected model and renames the session", async () => {
		const file = path.join(FILE_ROOT, "notes.txt");
		fs.writeFileSync(file, "Fourier sampling, aliasing, and decimation filters.");
		const chat = chatStore.createChat("notes", undefined);
		let seen = "";
		const run = (async (_tools: unknown[], opts: { prompt?: string }) => {
			seen = opts.prompt ?? "";
			return original("Sampling and Aliasing");
		}) as unknown as typeof import("../src/agent/subagents/pi-run.ts").runSubagent;
		await generateSessionTitle(chat.id, `\`${file}\``, chat.title, {
			engine: {} as PiEngine,
			run,
		});
		assert.equal(chatStore.getChat(chat.id)?.title, "Sampling and Aliasing");
		assert.ok(seen.includes("Fourier sampling, aliasing, and decimation filters."));
		assert.ok(seen.includes("[file: notes.txt]"));
		assert.equal(seen.includes(file), false, "the absolute path never reaches the title prompt");
	});

	it("does not overwrite a learner rename that lands while the model works", async () => {
		const file = path.join(FILE_ROOT, "second.txt");
		fs.writeFileSync(file, "Z transforms and pole-zero geometry.");
		const chat = chatStore.createChat("second", undefined);
		const run = (async () => {
			chatStore.renameChat(chat.id, "Learner title");
			return original("Model title");
		}) as unknown as typeof import("../src/agent/subagents/pi-run.ts").runSubagent;
		await generateSessionTitle(chat.id, `\`${file}\``, chat.title, {
			engine: {} as PiEngine,
			run,
		});
		assert.equal(chatStore.getChat(chat.id)?.title, "Learner title");
	});
});
