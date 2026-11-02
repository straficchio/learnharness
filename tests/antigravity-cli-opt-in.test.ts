import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test, { after, type TestContext } from "node:test";

const testData = mkdtempSync(join(tmpdir(), "lh-agy-opt-in-data-"));
process.env.LH_DATA_DIR = testData;
after(() => rmSync(testData, { recursive: true, force: true }));

const { SETTINGS_FILE } = await import("../config.ts");
const { PUT } = await import("../app/api/settings/[section]/route.ts");
const { sanitizeUserSettings, providerKeyMissing, isProviderKeyRefusal } = await import("../src/core/settings.ts");
const { parseAntigravityCliSettingsBody } = await import("../src/server/settings-body.ts");
const { antigravityCliAvailable, antigravityCliEnabled } = await import("../src/server/antigravity-cli-config.ts");
const { invalidateAntigravityCatalog, modelCatalog, toModelDto, validateModelsSettings } = await import("../src/server/model-catalog.ts");
const { providerKeyPresent } = await import("../src/server/keys.ts");
const { readSettings, writeSettings } = await import("../src/store/settings.ts");
const { DEFAULT_AGY_MODELS, resetAgyModelDiscovery, toAgyModel } = await import("../src/agent/antigravity-cli/model-discovery.ts");
const { setAntigravityModels, piModels } = await import("../src/agent/models.ts");

const FAMILY = toAgyModel({ id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", efforts: ["low", "medium", "high"] });

function setup(t: TestContext) {
	const previous = readSettings();
	const path = process.env.PATH;
	const dir = mkdtempSync(join(tmpdir(), "agy-opt-in-"));
	writeFileSync(join(dir, process.platform === "win32" ? "agy.exe" : "agy"), "", { mode: 0o755 });
	process.env.PATH = `${dir}${delimiter}${path ?? ""}`;
	t.after(() => {
		if (previous) writeSettings(previous); else rmSync(SETTINGS_FILE, { force: true });
		if (path === undefined) delete process.env.PATH; else process.env.PATH = path;
		rmSync(dir, { recursive: true, force: true });
		setAntigravityModels(DEFAULT_AGY_MODELS);
		resetAgyModelDiscovery();
	});
	writeSettings({ version: 1 });
	setAntigravityModels([...DEFAULT_AGY_MODELS, FAMILY]);
}

async function save(body: unknown) {
	return PUT(new Request("http://test/api/settings/antigravityCli", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	}), { params: Promise.resolve({ section: "antigravityCli" }) });
}

test("opt-in parses strictly and malformed stored values never enable the CLI", () => {
	assert.deepEqual(parseAntigravityCliSettingsBody({}), { ok: true, settings: {} });
	assert.deepEqual(parseAntigravityCliSettingsBody({ enabled: true, ignored: true }), { ok: true, settings: { enabled: true } });
	assert.deepEqual(parseAntigravityCliSettingsBody({ enabled: false }), { ok: true, settings: { enabled: false } });
	for (const raw of [true, null, [], "on", { enabled: "true" }, { enabled: 1 }]) assert.equal(parseAntigravityCliSettingsBody(raw).ok, false);
	for (const raw of [null, [], true, "on", { enabled: "true" }, { enabled: 1 }]) {
		assert.notEqual(sanitizeUserSettings({ version: 1, antigravityCli: raw })?.antigravityCli?.enabled, true);
	}
	assert.equal(sanitizeUserSettings({ version: 1 })?.antigravityCli, undefined);
});

test("default off even with an installed binary; enabling federates the discovered catalog and disabling hides it", async (t) => {
	setup(t);
	const models = { strong: { model: { provider: "antigravity-cli", id: "gemini-3.8-flash" } }, cheap: { model: { provider: "antigravity-cli", id: "default" } } };
	writeSettings({ version: 1, models, graph: { enabled: false }, futureSection: { keep: 1 } });

	assert.equal(antigravityCliEnabled(), false);
	assert.equal(antigravityCliAvailable(), false);
	assert.equal(providerKeyPresent("antigravity-cli"), false);
	assert(!modelCatalog().models.some((model) => model.provider === "antigravity-cli"));

	assert.equal((await save({ enabled: true })).status, 200);
	assert.equal(antigravityCliEnabled(), true);
	assert.equal(antigravityCliAvailable(), true);
	assert.equal(providerKeyPresent("antigravity-cli"), true);
	const catalog = modelCatalog();
	assert.deepEqual(catalog.models.filter((model) => model.provider === "antigravity-cli").map((model) => model.id), ["default", "gemini-3.8-flash"]);
	const dto = catalog.models.find((model) => model.id === "gemini-3.8-flash");
	assert.ok(dto);
	assert.equal(dto.cost, null);
	assert.equal(dto.contextWindow, null);
	assert.equal(dto.maxTokens, null);
	assert.deepEqual(dto.supportedLevels, ["low", "medium", "high"]);
	assert.equal(piModels().getProvider("antigravity-cli")?.name, "Antigravity CLI");

	assert.equal((await save({ enabled: false })).status, 200);
	assert.equal(antigravityCliAvailable(), false);
	assert(!modelCatalog().models.some((model) => model.provider === "antigravity-cli"));
	assert.deepEqual(readSettings()?.models, models);
	assert.deepEqual(readSettings()?.graph, { enabled: false });
	assert.deepEqual(readSettings()?.futureSection, { keep: 1 });
	assert.equal(validateModelsSettings(models, models).ok, true, "saved unavailable pins remain repairable");
	assert.equal(validateModelsSettings({ strong: { model: { provider: "antigravity-cli", id: "gemini-3.8-flash" } } }).ok, false, "new pins are refused while disabled");
	assert.equal((await save({ enabled: "true" })).status, 400);
	assert.equal(antigravityCliEnabled(), false);
	assert.equal((await save({})).status, 200);
	assert.equal(antigravityCliEnabled(), false);
});

test("enabled new model pins validate against the discovered catalog", async (t) => {
	setup(t);
	assert.equal((await save({ enabled: true })).status, 200);
	assert.equal(validateModelsSettings({ strong: { model: { provider: "antigravity-cli", id: "gemini-3.8-flash" } } }).ok, true);
	assert.equal(validateModelsSettings({ strong: { model: { provider: "antigravity-cli", id: "missing" } } }).ok, false);
});

test("the generic provider refusal names the CLI opt-in instead of a missing key", () => {
	const envelope = providerKeyMissing("antigravity-cli", ["strong"]);
	assert.match(envelope.error, /Antigravity CLI is unavailable/);
	assert.match(envelope.error, /Settings → Providers/);
	assert.equal(isProviderKeyRefusal(envelope.error), true);
	assert.equal(envelope.code, "provider_key_missing");
});

test("invalidateAntigravityCatalog does not throw when the provider is disabled", () => {
	assert.doesNotThrow(() => invalidateAntigravityCatalog());
});

test("toModelDto leaves CLI pricing and limits unknown for the agy provider", () => {
	const dto = toModelDto(FAMILY);
	assert.equal(dto.cost, null);
	assert.equal(dto.contextWindow, null);
	assert.equal(dto.maxTokens, null);
	assert.deepEqual(dto.input, ["text", "image"]);
});
