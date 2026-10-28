/**
 * LocalEngineSection SSR: the connection/model fields render from the
 * record, the default base URL is the Strata/Ollama shape, and no secret
 * is ever rendered (the key is a write-only input plus a masked status).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LocalEngineSection } from "../components/settings/local-engine-section.tsx";
import { DEFAULT_LOCAL_BASE_URL } from "../src/core/settings.ts";

const noopSave = async () => ({ ok: true as const });

test("renders the default loopback connection and the model fields", () => {
	const html = renderToStaticMarkup(<LocalEngineSection local={undefined} onSave={noopSave} />);
	assert.match(html, /Local engine base URL/);
	assert.match(html, new RegExp(DEFAULT_LOCAL_BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.match(html, /Local model ID/);
	assert.match(html, /Save local engine/);
	assert.match(html, /Test \/ fetch models/);
	// The key input is a password field; the persisted value never renders.
	assert.match(html, /type="password"/);
	assert.doesNotMatch(html, /sk-live-secret/);
});

test("renders a stored model and the enabled switch state", () => {
	const html = renderToStaticMarkup(
		<LocalEngineSection
			local={{
				enabled: true,
				baseUrl: "http://127.0.0.1:8080/v1",
				model: { id: "qwen3.8-flash-next", name: "Qwen local", contextWindow: 65536, maxTokens: 16384, vision: true },
			}}
			onSave={noopSave}
		/>,
	);
	assert.match(html, /value="qwen3.8-flash-next"/);
	assert.match(html, /value="Qwen local"/);
	assert.match(html, /value="65536"/);
	assert.match(html, /aria-checked="true"/);
});
