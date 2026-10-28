/**
 * Local engine provider registration: configureLocalEngine installs one
 * OpenAI-compatible provider in the process-wide pi-ai collection, maps the
 * model metadata, and removes it cleanly when disabled.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
	configureLocalEngine,
	currentLocalEngine,
	piEngineForSpec,
	piModels,
} from "../src/agent/models.ts";
import type { EffectiveLocalEngine } from "../src/core/settings-resolution.ts";

const base: EffectiveLocalEngine = {
	enabled: true,
	baseUrl: "http://127.0.0.1:8080/v1",
	model: {
		id: "qwen3.8-flash-next",
		name: "Qwen local",
		contextWindow: 32768,
		maxTokens: 8192,
		vision: false,
		reasoning: false,
	},
};

afterEach(() => configureLocalEngine(null));

describe("configureLocalEngine", () => {
	it("installs a local provider and model", () => {
		configureLocalEngine(base);
		const provider = piModels().getProvider("local");
		assert.ok(provider);
		assert.equal(provider?.name, "Local engine");
		const model = piModels().getModel("local", base.model!.id);
		assert.ok(model);
		assert.equal(model?.name, "Qwen local");
		assert.equal(model?.api, "openai-completions");
		assert.equal(model?.provider, "local");
		assert.equal(model?.baseUrl, "http://127.0.0.1:8080/v1");
		assert.deepEqual(model?.input, ["text"]);
		assert.equal(model?.contextWindow, 32768);
		assert.equal(model?.maxTokens, 8192);
		assert.deepEqual(model?.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		assert.equal(model?.reasoning, false);
		assert.equal(currentLocalEngine()?.model?.id, base.model!.id);
	});

	it("maps vision and reasoning flags", () => {
		configureLocalEngine({ ...base, model: { ...base.model!, vision: true, reasoning: true } });
		const model = piModels().getModel("local", base.model!.id);
		assert.deepEqual(model?.input, ["text", "image"]);
		assert.equal(model?.reasoning, true);
	});

	it("enables the Qwen chat-template thinking control only for Qwen reasoning models", () => {
		const compatOf = (id: string) =>
			piModels().getModel("local", id)?.compat as { thinkingFormat?: string; maxTokensField?: string } | undefined;

		configureLocalEngine({ ...base, model: { ...base.model!, reasoning: true } });
		assert.equal(compatOf(base.model!.id)?.maxTokensField, "max_tokens");
		assert.equal(compatOf(base.model!.id)?.thinkingFormat, "qwen-chat-template");

		configureLocalEngine({ ...base, model: { ...base.model!, id: "llama-3.1-local", reasoning: true } });
		assert.equal(compatOf("llama-3.1-local")?.thinkingFormat, undefined);
	});

	it("builds an engine for the configured model", () => {
		configureLocalEngine(base);
		const engine = piEngineForSpec({ provider: "local", id: base.model!.id });
		assert.equal(engine.model.provider, "local");
		assert.equal(engine.model.id, base.model!.id);
		assert.equal(engine.level, "off");
	});

	it("removes the provider when disabled", () => {
		configureLocalEngine(base);
		assert.ok(piModels().getProvider("local"));
		configureLocalEngine({ ...base, enabled: false });
		assert.equal(piModels().getProvider("local"), undefined);
		assert.equal(currentLocalEngine(), null);
	});

	it("is idempotent for the same config", () => {
		configureLocalEngine(base);
		const first = piModels().getProvider("local");
		configureLocalEngine(base);
		assert.equal(piModels().getProvider("local"), first);
	});
});
