/**
 * LAN HTTP regression: the app intentionally runs on trusted-LAN HTTP, where
 * `crypto.randomUUID` is absent (secure-context-only). Message ids must still
 * mint before the first `/api/chat` POST, or the UI stays at "Thinking…".
 */
import assert from "node:assert/strict";
import test from "node:test";

import { newMessageId, newPlanBlockMessage } from "../src/core/native-messages.ts";

function withCrypto<T>(value: unknown, run: () => T): T {
	const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
	Object.defineProperty(globalThis, "crypto", { configurable: true, value });
	try {
		return run();
	} finally {
		if (original) Object.defineProperty(globalThis, "crypto", original);
	}
}

test("mints message ids without crypto.randomUUID on an insecure origin", () => {
	const id = withCrypto({
		getRandomValues(array: Uint8Array) {
			array.fill(0xab);
			return array;
		},
	}, newMessageId);
	assert.match(id, /^msg_[a-z0-9]+_abababab$/);

	const plan = withCrypto({
		getRandomValues(array: Uint8Array) {
			array.fill(0xcd);
			return array;
		},
	}, () => newPlanBlockMessage("plan-call", {}));
	assert.match(plan.id, /^pb_[a-z0-9]+_cdcdcdcd$/);
});

test("falls back when crypto itself is unavailable", () => {
	const id = withCrypto(undefined, newMessageId);
	assert.match(id, /^msg_[a-z0-9]+_[a-z0-9]{8}$/);
});

test("keeps using randomUUID when the secure context provides it", () => {
	const id = withCrypto({
		randomUUID: () => "12345678-0000-4000-8000-000000000000",
	}, newMessageId);
	assert.match(id, /^msg_[a-z0-9]+_12345678$/);
});
