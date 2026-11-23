import assert from "node:assert/strict";
import { test } from "node:test";
import {
	fallbackTitleForPrompt,
	normalizeGeneratedTitle,
	promptFilePaths,
	TITLE_MAX_WORDS,
} from "../src/core/session-title.ts";

const FILE = "/Users/marco/notes/FilteringMonograph.pdf";

test("a file-only prompt falls back to the file stem, never the path", () => {
	assert.equal(fallbackTitleForPrompt(`\`${FILE}\``), "FilteringMonograph");
	assert.equal(fallbackTitleForPrompt(FILE), "FilteringMonograph");
	assert.deepEqual(promptFilePaths(`\`${FILE}\``), [FILE]);
});

test("a mixed prompt keeps its prose and shows the file label, not the path", () => {
	const prompt = "Read `/tmp/notes.pdf` and explain aliasing";
	assert.equal(fallbackTitleForPrompt(prompt), "Read notes.pdf and explain aliasing");
});

test("generated titles lose labels, wrappers, and the five-word overflow", () => {
	assert.equal(normalizeGeneratedTitle("Title: **Sampling and Filtering**", "Fallback"), "Sampling and Filtering");
	assert.equal(
		normalizeGeneratedTitle("Here is a short title: Sampling Filtering Aliasing Decimation Reconstruction Basics", "Fallback"),
		"Sampling Filtering Aliasing Decimation Reconstruction",
	);
	assert.equal(normalizeGeneratedTitle("```\nFiltering Basics\n```", "Fallback"), "Filtering Basics");
	assert.equal(normalizeGeneratedTitle("one two three four five six", "Fallback"), "one two three four five");
	assert.equal(normalizeGeneratedTitle("", "Fallback"), "Fallback");
	assert.equal(TITLE_MAX_WORDS, 5);
});
