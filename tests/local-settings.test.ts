/**
 * Local engine settings: the non-secret `local` section, its sanitizer,
 * resolution, and PUT parser. The provider runtime is covered separately
 * in local-engine.test.ts.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DEFAULT_LOCAL_BASE_URL,
	DEFAULT_LOCAL_CONTEXT_WINDOW,
	DEFAULT_LOCAL_MAX_TOKENS,
	isLocalBaseUrl,
	sanitizeUserSettings,
} from "../src/core/settings.ts";
import { resolveLocalEngine, resolveSettings } from "../src/core/settings-resolution.ts";
import { parseLocalEngineBody } from "../src/server/settings-body.ts";

describe("isLocalBaseUrl", () => {
	it("accepts loopback/LAN http(s) roots", () => {
		assert.ok(isLocalBaseUrl("http://127.0.0.1:8080/v1"));
		assert.ok(isLocalBaseUrl("http://192.168.1.5:11434/v1"));
		assert.ok(isLocalBaseUrl("https://localhost:8443/v1"));
	});
	it("rejects credentials, query, fragment, non-http", () => {
		assert.ok(!isLocalBaseUrl("http://user:pass@127.0.0.1:8080/v1"));
		assert.ok(!isLocalBaseUrl("http://127.0.0.1:8080/v1?x=1"));
		assert.ok(!isLocalBaseUrl("http://127.0.0.1:8080/v1#x"));
		assert.ok(!isLocalBaseUrl("file:///tmp/model"));
		assert.ok(!isLocalBaseUrl(""));
	});
});

describe("sanitizeUserSettings — local", () => {
	it("keeps a valid enabled engine and clamps limits", () => {
		const out = sanitizeUserSettings({
			version: 1,
			local: {
				enabled: true,
				baseUrl: "http://127.0.0.1:8080/v1/",
				model: { id: "qwen3.8-flash-next", name: "Qwen local", contextWindow: 999_999_999, maxTokens: 1, vision: true, reasoning: "yes" },
			},
		});
		assert.deepEqual(out?.local, {
			enabled: true,
			baseUrl: "http://127.0.0.1:8080/v1",
			model: { id: "qwen3.8-flash-next", name: "Qwen local", contextWindow: 2_000_000, maxTokens: 256, vision: true },
		});
	});
	it("drops bad URLs/ids but preserves the section for repair", () => {
		const out = sanitizeUserSettings({ version: 1, local: { enabled: true, baseUrl: "file:///tmp/x", model: { id: "" } } });
		assert.deepEqual(out?.local, { enabled: true });
	});
});

describe("resolveLocalEngine", () => {
	it("defaults to disabled, loopback, no model", () => {
		assert.deepEqual(resolveLocalEngine(undefined), {
			enabled: false,
			baseUrl: DEFAULT_LOCAL_BASE_URL,
			model: null,
		});
	});
	it("resolves concrete model defaults", () => {
		const local = resolveLocalEngine({ enabled: true, baseUrl: "http://127.0.0.1:8080/v1", model: { id: "m" } });
		assert.equal(local.enabled, true);
		assert.equal(local.baseUrl, "http://127.0.0.1:8080/v1");
		assert.deepEqual(local.model, {
			id: "m",
			name: "m",
			contextWindow: DEFAULT_LOCAL_CONTEXT_WINDOW,
			maxTokens: DEFAULT_LOCAL_MAX_TOKENS,
			vision: false,
			reasoning: false,
		});
	});
	it("resolveSettings carries the local section", () => {
		const eff = resolveSettings({ version: 1, local: { enabled: true, model: { id: "m" } } });
		assert.equal(eff.local.enabled, true);
		assert.equal(eff.local.model?.id, "m");
	});
});

describe("parseLocalEngineBody (the PUT gate)", () => {
	it("accepts the full shape", () => {
		const out = parseLocalEngineBody({
			enabled: true,
			baseUrl: "http://127.0.0.1:8080/v1/",
			model: { id: "qwen", name: "Qwen", contextWindow: 32768, maxTokens: 8192, vision: true, reasoning: false },
		});
		assert.ok(out.ok);
		if (out.ok) {
			assert.equal(out.settings.baseUrl, "http://127.0.0.1:8080/v1");
			assert.equal(out.settings.model?.id, "qwen");
		}
	});
	it("rejects enabled without a model id", () => {
		const out = parseLocalEngineBody({ enabled: true, baseUrl: "http://127.0.0.1:8080/v1" });
		assert.equal(out.ok, false);
	});
	it("rejects bad URLs and bad numbers", () => {
		assert.equal(parseLocalEngineBody({ baseUrl: "file:///tmp/x" }).ok, false);
		assert.equal(parseLocalEngineBody({ model: { id: "m", contextWindow: 10 } }).ok, false);
		assert.equal(parseLocalEngineBody({ model: { id: "m", maxTokens: 1 } }).ok, false);
	});
	it("allows a disabled pre-configuration with no model", () => {
		const out = parseLocalEngineBody({ enabled: false, baseUrl: "http://127.0.0.1:8080/v1" });
		assert.ok(out.ok);
	});
});
