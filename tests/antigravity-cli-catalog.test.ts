import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test, { after } from "node:test";

const testData = mkdtempSync(join(tmpdir(), "lh-agy-catalog-data-"));
process.env.LH_DATA_DIR = testData;
after(() => rmSync(testData, { recursive: true, force: true }));

const { SETTINGS_FILE } = await import("../config.ts");
const { readSettings, writeSettings } = await import("../src/store/settings.ts");
const { invalidateAntigravityCatalog, modelCatalog, refreshConnectionCatalog } = await import("../src/server/model-catalog.ts");
const { DEFAULT_AGY_MODELS, resetAgyModelDiscovery } = await import("../src/agent/antigravity-cli/model-discovery.ts");
const { setAntigravityModels } = await import("../src/agent/models.ts");

test("the catalog refresh discovers agy families from the CLI and exposes them to the picker", { skip: process.platform === "win32" }, async (t) => {
	const previous = readSettings();
	const path = process.env.PATH;
	const dir = mkdtempSync(join(tmpdir(), "agy-catalog-"));
	const binary = join(dir, "agy");
	writeFileSync(binary, `#!/bin/sh
if [ "$1" = "models" ]; then
  printf 'gemini-3.8-flash-low\\tGemini 3.8 Flash (Low)\\n'
  printf 'gemini-3.8-flash-high\\tGemini 3.8 Flash (High)\\n'
  printf 'claude-opus-5-5-low\\tClaude Opus 5.5 (Low)\\n'
  printf 'claude-opus-5-5-high\\tClaude Opus 5.5 (High)\\n'
  exit 0
fi
echo 1.4.7
`, { mode: 0o755 });
	process.env.PATH = `${dir}${delimiter}${path ?? ""}`;
	writeSettings({ version: 1, antigravityCli: { enabled: true } });
	resetAgyModelDiscovery();
	invalidateAntigravityCatalog();

	t.after(() => {
		if (previous) writeSettings(previous); else rmSync(SETTINGS_FILE, { force: true });
		if (path === undefined) delete process.env.PATH; else process.env.PATH = path;
		rmSync(dir, { recursive: true, force: true });
		setAntigravityModels(DEFAULT_AGY_MODELS);
		resetAgyModelDiscovery();
	});

	await refreshConnectionCatalog("antigravity-cli");
	const catalog = modelCatalog();
	const models = catalog.models.filter((model) => model.provider === "antigravity-cli");
	assert.deepEqual(models.map((model) => model.id), ["claude-opus-5-5", "default", "gemini-3.8-flash"]);
	assert.deepEqual(models.find((model) => model.id === "gemini-3.8-flash")?.supportedLevels, ["low", "high"]);
	assert.equal(models.find((model) => model.id === "gemini-3.8-flash")?.cost, null);
	assert.equal(catalog.providers.find((provider) => provider.id === "antigravity-cli")?.keyPresent, true);
});
