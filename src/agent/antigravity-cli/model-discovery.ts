import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import type { Api, Model } from "@earendil-works/pi-ai";

import { externalCliEnv } from "../../core/auth-env.ts";
import { ANTIGRAVITY_CLI_API, AGY_DEFAULT_MODEL_ID } from "./constants.ts";
import { ANTIGRAVITY_CLI_PROVIDER } from "../../core/contracts/antigravity-cli.ts";
import { getAgyBinary } from "./binary.ts";

const MODEL_LIST_TIMEOUT_MS = 10_000;
const MODEL_LIST_CACHE_MS = 5 * 60_000;
const MODEL_LIST_MAX_BUFFER = 1_048_576;
const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORT_ORDER)[number];

export type AgyModelDescriptor = {
	id: string;
	name: string;
	efforts: Effort[];
};

export type DiscoverAgyModels = () => Promise<string>;

const DEFAULT_MODEL: AgyModelDescriptor = {
	id: AGY_DEFAULT_MODEL_ID,
	name: "CLI default model",
	efforts: [],
};

/** No shell; model listing is read-only and never authenticates a session. */
export const listAgyModels: DiscoverAgyModels = () => new Promise((resolve, reject) => {
	const binary = getAgyBinary();
	if (!binary) {
		reject(new Error("agy CLI not found"));
		return;
	}
	execFile(binary, ["models"], {
		cwd: tmpdir(), env: externalCliEnv(), windowsHide: true,
		timeout: MODEL_LIST_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: MODEL_LIST_MAX_BUFFER,
	}, (error, stdout) => error ? reject(error) : resolve(stdout));
});

function effortFromLabel(label: string): Effort | null {
	const match = /\((low|medium|high|xhigh|max)\)\s*$/i.exec(label);
	return match ? match[1]!.toLowerCase() as Effort : null;
}

function stripEffortLabel(label: string): string {
	return label.replace(/\s*\((low|medium|high|xhigh|max)\)\s*$/i, "").trim();
}

function stripEffortSlug(slug: string, effort: Effort): string | null {
	const suffix = `-${effort}`;
	return slug.toLowerCase().endsWith(suffix) ? slug.slice(0, -suffix.length) : null;
}

/** Parse `slug<TAB>Display Name (Effort)` lines into user-selectable families. */
export function parseAgyModels(output: string): AgyModelDescriptor[] {
	const groups = new Map<string, { name: string; efforts: Set<Effort> }>();
	const standalone: AgyModelDescriptor[] = [];

	for (const rawLine of output.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || /^fetching\b/i.test(line)) continue;
		const match = /^(\S+)\s+(.+)$/.exec(line);
		if (!match) continue;

		const [, slug, label] = match;
		if (!slug || !label) continue;
		const effort = effortFromLabel(label);
		const baseSlug = effort ? stripEffortSlug(slug, effort) : null;

		if (effort && baseSlug) {
			const baseName = stripEffortLabel(label);
			const group = groups.get(baseSlug) ?? { name: baseName, efforts: new Set<Effort>() };
			group.efforts.add(effort);
			// Keep the first display name; variants differ only by effort suffix.
			groups.set(baseSlug, group);
		} else {
			standalone.push({ id: slug, name: label, efforts: [] });
		}
	}

	const families: AgyModelDescriptor[] = [...groups.entries()]
		.map(([id, group]) => ({
			id,
			name: group.name,
			efforts: EFFORT_ORDER.filter((effort) => group.efforts.has(effort)),
		}))
		.sort((a, b) => a.name.localeCompare(b.name));

	return [DEFAULT_MODEL, ...families, ...standalone.sort((a, b) => a.name.localeCompare(b.name))];
}

export function toAgyModel(descriptor: AgyModelDescriptor): Model<Api> {
	const reasoning = descriptor.efforts.length > 0;
	const thinkingLevelMap = reasoning
		? {
				off: null,
				minimal: null,
				...Object.fromEntries(EFFORT_ORDER.map((effort) => [
					effort,
					descriptor.efforts.includes(effort) ? effort : null,
				])),
			}
		: { off: null, minimal: null };

	return {
		id: descriptor.id,
		name: descriptor.name,
		api: ANTIGRAVITY_CLI_API,
		provider: ANTIGRAVITY_CLI_PROVIDER,
		baseUrl: "",
		input: ["text", "image"],
		// Pi-required placeholders, not prices: the CLI's own auth/routing
		// determines charges. Server pricing and the client catalog report unpriced.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning,
		thinkingLevelMap,
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	};
}

export const DEFAULT_AGY_MODELS: readonly Model<Api>[] = [toAgyModel(DEFAULT_MODEL)];

let cache: { models: Model<Api>[]; at: number } | undefined;
let inflight: Promise<Model<Api>[] | null> | undefined;

/** Cached discovery. An empty/failed listing keeps the previous good catalog;
 * the CLI-default entry is always available. */
export async function discoverAgyModels(
	list: DiscoverAgyModels = listAgyModels,
	now = Date.now(),
): Promise<Model<Api>[] | null> {
	if (cache && now - cache.at < MODEL_LIST_CACHE_MS) return cache.models;
	if (inflight) return inflight;

	inflight = (async () => {
		try {
			const output = await list();
			const descriptors = parseAgyModels(output);
			// An empty/unauthenticated listing is not a catalog. Keep the last
			// good list (and the always-present CLI-default fallback) instead
			// of wiping a previously discovered family.
			if (descriptors.length <= 1) return null;
			const models = descriptors.map(toAgyModel);
			cache = { models, at: now };
			return models;
		} catch {
			return null;
		} finally {
			inflight = undefined;
		}
	})();
	return inflight;
}

/** Settings changes and explicit refreshes bypass the TTL. */
export function invalidateAgyModelCache(): void {
	cache = undefined;
}

/** Test seam. */
export function resetAgyModelDiscovery(): void {
	cache = undefined;
	inflight = undefined;
}
