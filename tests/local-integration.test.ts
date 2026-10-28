/**
 * Local engine end-to-end settings → provider → catalog integration, in an
 * isolated LH_DATA_DIR. This is the seam the settings route and the model
 * picker share; the provider's model mapping itself is covered in
 * local-engine.test.ts.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-local-integration-"));
process.env.LH_DATA_DIR = path.join(dir, "data");
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");
fs.mkdirSync(process.env.LH_DATA_DIR, { recursive: true });
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n", { mode: 0o600 });

const { writeSettingsRecord, syncLocalEngine, effectiveSettings, modelCatalog, catalogProviders, validateModelsSettings } =
	await import("../src/server/index.ts");
const { piModels, piEngineForSpec } = await import("../src/agent/models.ts");

after(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("local engine settings integration", () => {
	it("saves the section, registers the provider, and federates the model", () => {
		writeSettingsRecord({
			version: 1,
			local: {
				enabled: true,
				baseUrl: "http://127.0.0.1:8080/v1",
				model: { id: "qwen3.8-flash-next", name: "Qwen local", contextWindow: 65536, maxTokens: 16384, vision: true },
			},
		});
		syncLocalEngine();
		const local = effectiveSettings().local;
		assert.equal(local.enabled, true);
		assert.equal(local.model?.id, "qwen3.8-flash-next");

		assert.ok(catalogProviders().some((p) => p.id === "local" && p.keyPresent), "local provider federated");
		const catalog = modelCatalog();
		const entry = catalog.models.find((m) => m.provider === "local" && m.id === "qwen3.8-flash-next");
		assert.ok(entry, "local model in the picker catalog");
		assert.equal(entry?.contextWindow, 65536);
		assert.deepEqual(entry?.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		assert.deepEqual(entry?.input, ["text", "image"]);

		const verdict = validateModelsSettings({
			strong: { model: { provider: "local", id: "qwen3.8-flash-next" } },
		});
		assert.equal(verdict.ok, true);
		const engine = piEngineForSpec({ provider: "local", id: "qwen3.8-flash-next" });
		assert.equal(engine.model.provider, "local");
		assert.ok(piModels().getProvider("local"));
	});

	it("disabling removes the provider and makes local slot validation fail", () => {
		writeSettingsRecord({ version: 1, local: { enabled: false, baseUrl: "http://127.0.0.1:8080/v1" } });
		syncLocalEngine();
		assert.equal(piModels().getProvider("local"), undefined);
		assert.ok(!catalogProviders().some((p) => p.id === "local"));
		const verdict = validateModelsSettings({
			strong: { model: { provider: "local", id: "qwen3.8-flash-next" } },
		});
		assert.equal(verdict.ok, false);
	});
});
