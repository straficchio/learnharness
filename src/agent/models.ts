import {
	clampThinkingLevel,
	createModels,
	createProvider,
	getSupportedThinkingLevels,
	type Api,
	type Model,
	type Models,
	type StreamFunction,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type ModelRole } from "../../config.ts";
import { DEFAULT_THINKING_ORDER } from "../core/settings.ts";
import type { EffectiveLocalEngine } from "../core/settings-resolution.ts";
import packageMetadata from "../../package.json" with { type: "json" };
import { chatGPTModel } from "./chatgpt-bridge.ts";
import { chatGPTStream } from "./chatgpt-stream.ts";
import type { ChatGPTDispatchLifecycle } from "./chatgpt-request-cycle.ts";
import { nativeSubscriptionId, nativeSubscriptionModel } from "./subscription-bridge.ts";
import { nativeSubscriptionStream } from "./subscription-stream.ts";

/** App identity is immutable and shared by Models and every native Agent.
 * Agent's default Pi attribution otherwise overrides the Models identity. */
export const APP_IDENTITY = Object.freeze({
	userAgent: Object.freeze({ custom: `learnharness/${packageMetadata.version}` }),
	attribution: Object.freeze({ name: packageMetadata.name, url: packageMetadata.homepage }),
});

/**
 * The one engine factory every agent's model comes from (the pi-ai swap,
 * docs/pi-engine-swap.md). BYOK ALL THE WAY DOWN (owner, 2026-09-22):
 * there are no factory pins — every engine resolves from a RESOLVED SPEC
 * (the settings chain's output) and the one builder here wires it to
 * pi-ai's federated catalogs.
 *
 * An "engine" is the model + the stream function the agent loop runs on —
 * the two things a test fake replaces. Production engines resolve the model
 * from pi-ai's static catalogs and stream through the same Models
 * collection.
 */

export interface PiEngine {
	model: Model<Api>;
	streamFn: StreamFunction;
	/** The resolved (config-or-settings, CLAMPED) thinking level —
	 *  observability + tests; the streamFn pins it anyway. */
	level?: ThinkingLevel;
}

export type { ThinkingLevel };

let collection: ReturnType<typeof createModels> | undefined;

/** The process-wide pi-ai Models collection — EVERY builtin provider's
 *  catalog (model slots wave, 2026-09-20): engines and the picker resolve
 *  against all of pi-ai's per-provider catalogs, so a settings slot can pin
 *  any native model id. Auth is resolved per request by pi-ai itself from
 *  the environment (the keys seam reflects file-saved keys into env), and
 *  a provider with no key simply fails its stream with "not configured" —
 *  honest, late, and unreachable through the picker, which gates on
 *  keyPresent. */
export function piModels() {
	if (!collection) {
		collection = createModels({ identity: APP_IDENTITY });
		for (const provider of builtinProviders()) collection.setProvider(provider);
	}
	return collection;
}

// ─── Local OpenAI-compatible engine ─────────────────────────────────────────

/** The reserved provider id for the user-configured local engine. */
export const LOCAL_PROVIDER_ID = "local";

/** The last resolved local config and its signature — repeated syncs from
 *  every catalog read are cheap and idempotent. */
let localEngine: EffectiveLocalEngine | null = null;
let localEngineSignature = "";

function normalizeLocalBaseUrl(baseUrl: string): string {
	return baseUrl.trim().replace(/\/+$/, "");
}

function localModel(config: EffectiveLocalEngine): Model<"openai-completions"> {
	const model = config.model!;
	return {
		id: model.id,
		name: model.name,
		api: "openai-completions",
		provider: LOCAL_PROVIDER_ID,
		baseUrl: normalizeLocalBaseUrl(config.baseUrl),
		reasoning: model.reasoning,
		input: model.vision ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		// Local servers commonly reject the OpenAI `developer` role and
		// `reasoning_effort`; keep both off unless a future provider adapter
		// opts in. Tool calling is the one capability the app depends on.
		//
		// Qwen reasoning models on llama.cpp/Strata share max_tokens between
		// thinking and the answer/tool call. Without a thinking control a
		// complex brief can spend the whole output budget reasoning and emit
		// no write_demo call (observed 2026-10-28). The chat-template switch
		// lets a role's explicit "off" level disable thinking; non-Qwen
		// local models keep the old behavior.
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			// llama.cpp/Strata (and most local OpenAI-compatible servers)
			// honor max_tokens, not OpenAI's newer max_completion_tokens.
			// Without this, the configured maxTokens is silently ignored and
			// the server's default output cap wins.
			maxTokensField: "max_tokens",
			...(model.reasoning && /qwen/i.test(model.id) ? { thinkingFormat: "qwen-chat-template" as const } : {}),
		},
	};
}

function localProvider(config: EffectiveLocalEngine) {
	return createProvider({
		id: LOCAL_PROVIDER_ID,
		name: "Local engine",
		baseUrl: normalizeLocalBaseUrl(config.baseUrl),
		// Keyless local servers are valid: auth resolves as configured with
		// no key, exactly like pi-ai's Ollama example. The optional key rides
		// the auth store's LOCAL_LLM_API_KEY (env-reflected) so it never
		// enters settings.json or the model catalog.
		auth: {
			apiKey: {
				name: "Local engine",
				resolve: async ({ ctx }) => {
					const key = await ctx.env("LOCAL_LLM_API_KEY");
					// pi's OpenAI-compatible adapter requires a non-empty auth
					// value even when the server is keyless. Local servers ignore
					// the placeholder Authorization header; a configured key wins.
					return key
						? { auth: { apiKey: key }, source: "LOCAL_LLM_API_KEY" }
						: { auth: { apiKey: "local" }, source: "local (keyless)" };
				},
			},
		},
		models: [localModel(config)],
		api: openAICompletionsApi(),
	});
}

/** Install/remove the local provider from the process-wide collection.
 *  Called by the server after settings reads/writes. The config is
 *  non-secret; the key is resolved per request from the env seam. */
export function configureLocalEngine(config: EffectiveLocalEngine | null): void {
	const next = config?.enabled && config.model ? config : null;
	const signature = next ? JSON.stringify(next) : "";
	if (signature === localEngineSignature) return;
	localEngine = next;
	localEngineSignature = signature;
	const models = piModels();
	if (models.getProvider(LOCAL_PROVIDER_ID)) models.deleteProvider(LOCAL_PROVIDER_ID);
	if (localEngine) models.setProvider(localProvider(localEngine));
}

/** Test/status view: the currently installed local config, if any. */
export function currentLocalEngine(): EffectiveLocalEngine | null {
	return localEngine;
}

/** OpenRouter API key (BYOK); tests never read this — they inject engines. */
export function openRouterApiKey(): string | undefined {
	return process.env.OPENROUTER_API_KEY || undefined;
}

/** A fully-resolved model pin — the shape every engine now comes from:
 *  the settings-resolution chain's output (role override → slot, or the
 *  chat's conversation chain). thinkingLevel is OPTIONAL: unset means
 *  the baked default resolves here (owner 2026-09-22) — the first entry
 *  of DEFAULT_THINKING_ORDER the model supports. */
export interface ResolvedModelSpec {
	provider: string;
	id: string;
	thinkingLevel?: ThinkingLevel;
}

/** The first entry of the baked default order the model supports (owner,
 *  2026-09-22). A non-reasoning model reports exactly ["off"], so the
 *  order walk lands there naturally. */
function defaultThinkingLevel(model: Model<Api>): ThinkingLevel {
	const supported = getSupportedThinkingLevels(model);
	for (const level of DEFAULT_THINKING_ORDER) {
		if (supported.includes(level)) return level;
	}
	return supported[0] ?? "off";
}

/** The production engine for a RESOLVED spec (model slots wave,
 *  2026-09-20): provider-aware catalog lookup + thinking clamp. The API
 *  key is resolved by pi-ai itself from the environment per request (the
 *  keys seam reflects file-saved keys into env), so the engine never
 *  hardcodes OpenRouter's. */
export function piEngineForSpec(spec: ResolvedModelSpec, background: boolean | (() => boolean) = true, lifecycle?: ChatGPTDispatchLifecycle): PiEngine {
	const models: Models = piModels();
	const nativeId = nativeSubscriptionId(spec.provider);
	const model = spec.provider === "chatgpt" ? chatGPTModel(spec.id) : nativeId ? nativeSubscriptionModel(spec.provider, spec.id) : models.getModel(spec.provider, spec.id);
	if (!model) {
		if (spec.provider === LOCAL_PROVIDER_ID && !models.getProvider(LOCAL_PROVIDER_ID)) {
			throw new Error("Local engine is disabled or not configured — enable it in Settings → Local engine.");
		}
		throw new Error(`${spec.provider} catalog has no model ${spec.id}`);
	}
	// UNSET level → the baked default order (first entry the model
	// supports); SET level → pi's native nearest-clamp (model swaps keep
	// the user's intent and adapt honestly).
	const level = spec.thinkingLevel
		? clampThinkingLevel(model, spec.thinkingLevel)
		: defaultThinkingLevel(model);
	return {
		model,
		level,
		// bound streamSimple: the agent loop forwards state.thinkingLevel as
		// `reasoning` (undefined = off on pi-ai's scale); the clamp above keeps
		// the pin honest even when config or settings drift off the map.
		streamFn: (requestModel, context, options) => {
			const purpose = typeof background === "function" ? background : () => background;
			const stream = spec.provider === "chatgpt" ? chatGPTStream(purpose, lifecycle) : nativeId ? nativeSubscriptionStream(models.getProvider(nativeId)!, purpose, lifecycle) : models.streamSimple.bind(models);
			return stream(requestModel, context, { ...options, reasoning: level === "off" ? undefined : level });
		},
	};
}

/** The LEGACY role entry point — BYOK made it an honest THROWER (owner,
 *  2026-09-22): no factory pins exist to fall back to, and this module
 *  cannot read settings (architecture law — the agent layer never
 *  imports the server layer). Production resolves the chain in
 *  chat-handler and ALWAYS injects engines; reaching this means a
 *  wiring bug, so it fails loudly instead of guessing a model. */
export function piEngineFor(role: ModelRole): PiEngine {
	throw new Error(
		`no configured model for role "${role}" — set your model slots (settings → models)`,
	);
}
