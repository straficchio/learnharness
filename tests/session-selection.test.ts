import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	hasBulkSelection,
	pruneSelection,
	selectAllVisible,
	toggleSelection,
} from "../components/session-selection.ts";

describe("session selection", () => {
	it("Ctrl/Cmd-click toggles and toggles back", () => {
		const one = toggleSelection(new Set(), "a");
		assert.deepEqual([...one], ["a"]);
		const two = toggleSelection(one, "b");
		assert.deepEqual([...two], ["a", "b"]);
		assert.deepEqual([...toggleSelection(two, "a")], ["b"]);
	});

	it("bulk actions need a genuine multi-selection", () => {
		assert.equal(hasBulkSelection(new Set()), false);
		assert.equal(hasBulkSelection(new Set(["a"])), false);
		assert.equal(hasBulkSelection(new Set(["a", "b"])), true);
	});

	it("Select all is exactly the visible set", () => {
		assert.deepEqual([...selectAllVisible(["b", "a"])], ["b", "a"]);
	});

	it("pruning drops vanished ids and preserves identity when unchanged", () => {
		const current = new Set(["a", "b"]);
		const unchanged = pruneSelection(current, ["a", "b", "c"]);
		assert.equal(unchanged, current);
		assert.deepEqual([...pruneSelection(current, ["b"])], ["b"]);
	});
});
