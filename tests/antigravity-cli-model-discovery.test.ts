import assert from "node:assert/strict";
import test from "node:test";

import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";

import {
	DEFAULT_AGY_MODELS,
	discoverAgyModels,
	parseAgyModels,
	resetAgyModelDiscovery,
	toAgyModel,
} from "../src/agent/antigravity-cli/model-discovery.ts";

const OUTPUT = [
	"Fetching available models...",
	"gemini-4-argon-medium\tGemini 4 Argon (Medium)",
	"gemini-4-argon-high\tGemini 4 Argon (High)",
	"gemini-4-argon-low\tGemini 4 Argon (Low)",
	"gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
	"gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
	"gemini-3.8-flash-low\tGemini 3.8 Flash (Low)",
	"claude-opus-5-5-low\tClaude Opus 5.5 (Low)",
	"claude-opus-5-5-medium\tClaude Opus 5.5 (Medium)",
	"claude-opus-5-5-high\tClaude Opus 5.5 (High)",
	"gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
	"custom-model\tCustom Model (Preview)",
	"slug-only  Spaced Name",
].join("\n");

test("parses effort variants into families, ignores the fetching notice, and keeps standalone models", () => {
	const parsed = parseAgyModels(OUTPUT);
	assert.equal(parsed[0]?.id, "default");
	assert.equal(parsed[0]?.name, "CLI default model");
	assert.deepEqual(parsed[1], { id: "claude-opus-5-5", name: "Claude Opus 5.5", efforts: ["low", "medium", "high"] });
	assert.deepEqual(parsed.find((model) => model.id === "gemini-3.8-flash"), { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", efforts: ["low", "medium", "high"] });
	assert.deepEqual(parsed.find((model) => model.id === "gemini-4-argon"), { id: "gemini-4-argon", name: "Gemini 4 Argon", efforts: ["low", "medium", "high"] });
	assert.deepEqual(parsed.find((model) => model.id === "gpt-oss-120b"), { id: "gpt-oss-120b", name: "GPT-OSS 120B", efforts: ["medium"] });
	assert.deepEqual(parsed.find((model) => model.id === "custom-model"), { id: "custom-model", name: "Custom Model (Preview)", efforts: [] });
	assert.deepEqual(parsed.find((model) => model.id === "slug-only"), { id: "slug-only", name: "Spaced Name", efforts: [] });
	assert.equal(parsed.some((model) => model.name.includes("Fetching")), false);
});

test("a slug whose suffix and display effort disagree is not collapsed into a family", () => {
	const parsed = parseAgyModels("mystery-low\tMystery (High)");
	assert.deepEqual(parsed, [
		{ id: "default", name: "CLI default model", efforts: [] },
		{ id: "mystery-low", name: "Mystery (High)", efforts: [] },
	]);
});

test("models advertise image input and exactly the family's effort levels", () => {
	const mediumOnly = toAgyModel({ id: "gpt-oss-120b", name: "GPT-OSS 120B", efforts: ["medium"] });
	assert.deepEqual(getSupportedThinkingLevels(mediumOnly), ["medium"]);
	assert.deepEqual(mediumOnly.input, ["text", "image"]);

	const family = toAgyModel({ id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", efforts: ["low", "medium", "high"] });
	assert.deepEqual(getSupportedThinkingLevels(family), ["low", "medium", "high"]);
	assert.equal(family.provider, "antigravity-cli");
	assert.equal(family.api, "antigravity-cli");

	const fallback = toAgyModel({ id: "default", name: "CLI default model", efforts: [] });
	assert.deepEqual(getSupportedThinkingLevels(fallback), ["off"]);
	assert.equal(fallback.reasoning, false);
});

test("discovery caches a good listing and keeps it when a later listing fails", async () => {
	resetAgyModelDiscovery();
	let calls = 0;
	const first = await discoverAgyModels(async () => { calls++; return OUTPUT; }, 1_000);
	assert.ok(first);
	assert.equal(first[0]?.id, "default");
	assert.equal(calls, 1);
	const second = await discoverAgyModels(async () => { calls++; return OUTPUT; }, 2_000);
	assert.equal(calls, 1, "the TTL cache avoids a second CLI call");
	assert.deepEqual(second?.map((model) => model.id), first.map((model) => model.id));

	resetAgyModelDiscovery();
	const failed = await discoverAgyModels(async () => { throw new Error("not authenticated"); }, 3_000);
	assert.equal(failed, null);
	resetAgyModelDiscovery();
});

test("an empty listing keeps the last good catalog and the CLI default fallback instead of wiping it", async () => {
	resetAgyModelDiscovery();
	const models = await discoverAgyModels(async () => "", 1_000);
	assert.equal(models, null);
	assert.deepEqual(DEFAULT_AGY_MODELS.map((model) => model.id), ["default"]);
	resetAgyModelDiscovery();
});
