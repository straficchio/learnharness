/**
 * POST /api/local/models — list models from the configured (or supplied)
 * OpenAI-compatible local server. This is the Local engine settings page's
 * "Test / fetch models" seam; it never returns or logs the API key.
 *
 * Body: { baseUrl?: string } — a draft URL may be tested before saving.
 * The optional key is read server-side from LOCAL_LLM_API_KEY (auth.json
 * or env), exactly like the provider runtime.
 */
import { isLocalBaseUrl } from "@/src/core";
import { effectiveSettings, keyValue } from "@/src/server";

export const dynamic = "force-dynamic";

const MAX_MODELS = 200;
const TIMEOUT_MS = 5_000;

interface LocalModelInfo {
	id: string;
	name?: string;
}

export async function POST(request: Request) {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: "body must be JSON" }, { status: 400 });
	}
	const supplied = body && typeof body === "object" && !Array.isArray(body)
		? (body as { baseUrl?: unknown }).baseUrl
		: undefined;
	const baseUrl = typeof supplied === "string" && supplied.trim()
		? supplied.trim().replace(/\/+$/, "")
		: effectiveSettings().local.baseUrl;
	if (!isLocalBaseUrl(baseUrl)) {
		return Response.json(
			{ error: "baseUrl must be an http(s) URL with no credentials, query, or fragment" },
			{ status: 400 },
		);
	}

	const key = keyValue("LOCAL_LLM_API_KEY");
	try {
		const response = await fetch(`${baseUrl}/models`, {
			headers: {
				accept: "application/json",
				...(key ? { authorization: `Bearer ${key}` } : {}),
			},
			signal: AbortSignal.timeout(TIMEOUT_MS),
			redirect: "error",
		});
		if (!response.ok) {
			return Response.json(
				{ error: `Local engine returned HTTP ${response.status} for /models` },
				{ status: 502 },
			);
		}
		const payload = (await response.json()) as { data?: unknown };
		const models: LocalModelInfo[] = Array.isArray(payload.data)
			? payload.data
					.filter((entry): entry is { id: string; name?: unknown } =>
						!!entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string",
					)
					.map((entry) => ({
						id: entry.id,
						...(typeof entry.name === "string" && entry.name ? { name: entry.name } : {}),
					}))
					.slice(0, MAX_MODELS)
			: [];
		return Response.json({ models }, { headers: { "Cache-Control": "no-store" } });
	} catch (err) {
		const message = err instanceof Error && err.name === "TimeoutError"
			? "Local engine did not answer within 5 seconds"
			: "Could not reach the local engine";
		return Response.json({ error: message }, { status: 502 });
	}
}
