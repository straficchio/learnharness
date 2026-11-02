import { createProvider, type Api, type Model, type Provider, type SimpleStreamOptions, type StreamFunction } from "@earendil-works/pi-ai";

import { ANTIGRAVITY_CLI_PROVIDER } from "../../core/contracts/antigravity-cli.ts";
import { ANTIGRAVITY_CLI_API } from "./constants.ts";

export function createAntigravityCliProvider(
	streamSimple: StreamFunction<Api, SimpleStreamOptions>,
	models: readonly Model<Api>[],
): Provider {
	return createProvider({
		id: ANTIGRAVITY_CLI_PROVIDER,
		name: "Antigravity CLI",
		auth: { apiKey: { name: "Antigravity CLI", resolve: async () => ({ auth: {}, source: "agy CLI" }) } },
		models: [...models],
		api: { stream: streamSimple, streamSimple },
	});
}
