import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { uploadAttachment, type UploadProgress } from "../lib/attachment-upload.ts";

type ProgressListener = (event: { lengthComputable: boolean; loaded: number; total: number }) => void;

class FakeXHR {
	static status = 200;
	static responseText = JSON.stringify({ attachment: { id: "a1", name: "paper.pdf", path: "/tmp/paper.pdf", size: 4 } });
	static networkError = false;
	static last: FakeXHR | null = null;

	status = FakeXHR.status;
	responseText = FakeXHR.responseText;
	networkError = FakeXHR.networkError;
	form: FormData | null = null;
	method = "";
	url = "";
	private readonly progress = new Set<ProgressListener>();
	private readonly load = new Set<() => void>();
	private readonly fail = new Set<() => void>();
	readonly upload = {
		addEventListener: (type: string, listener: ProgressListener) => {
			if (type === "progress") this.progress.add(listener);
		},
	};
	open(method: string, url: string) {
		this.method = method;
		this.url = url;
	}
	addEventListener(type: string, listener: () => void) {
		if (type === "load") this.load.add(listener);
		if (type === "error") this.fail.add(listener);
	}
	send(form: FormData) {
		this.form = form;
		FakeXHR.last = this;
		if (this.networkError) {
			for (const listener of this.fail) listener();
			return;
		}
		for (const listener of this.progress) listener({ lengthComputable: true, loaded: 2, total: 4 });
		for (const listener of this.load) listener();
	}
}

const original = (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
afterEach(() => {
	(globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = original;
	FakeXHR.last = null;
	FakeXHR.status = 200;
	FakeXHR.responseText = JSON.stringify({ attachment: { id: "a1", name: "paper.pdf", path: "/tmp/paper.pdf", size: 4 } });
	FakeXHR.networkError = false;
});

function install(): void {
	(globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = FakeXHR;
}

test("uploadAttachment reports byte progress and returns the stored attachment", async () => {
	install();
	const seen: UploadProgress[] = [];
	const file = new File(["data"], "paper.pdf", { type: "application/pdf" });
	const result = await uploadAttachment(file, "chat_1", (progress) => seen.push(progress));
	assert.deepEqual(seen, [{ loaded: 2, total: 4 }]);
	assert.deepEqual(result, { id: "a1", name: "paper.pdf", path: "/tmp/paper.pdf", size: 4 });
	assert.equal(FakeXHR.last?.method, "POST");
	assert.equal(FakeXHR.last?.url, "/api/attachments");
	assert.equal(FakeXHR.last?.form?.get("chatId"), "chat_1");
	assert.equal(FakeXHR.last?.form?.get("file") instanceof File, true);
});

test("uploadAttachment surfaces the server envelope on a refusal", async () => {
	FakeXHR.status = 413;
	FakeXHR.responseText = JSON.stringify({ error: "That file is too large." });
	install();
	await assert.rejects(
		uploadAttachment(new File(["x"], "huge.pdf", { type: "application/pdf" })),
		/That file is too large\./,
	);
});

test("uploadAttachment distinguishes a dropped connection", async () => {
	FakeXHR.networkError = true;
	install();
	await assert.rejects(
		uploadAttachment(new File(["x"], "paper.pdf", { type: "application/pdf" })),
		/Check the connection and try again/,
	);
});
