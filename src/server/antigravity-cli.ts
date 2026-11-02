import { inspectAgyInstallation } from "../agent/antigravity-cli/installation.ts";
import { initAuthEnv } from "./keys.ts";
import { subscriptionRequestOrigin } from "./web-subscription-http.ts";
import { antigravityCliEnabled } from "./antigravity-cli-config.ts";

/** The Settings status seam: initialize provenance before any child env is copied. */
export async function antigravityCliInstallationStatus() {
	initAuthEnv();
	return inspectAgyInstallation();
}

/** Same-origin browser intent, not user authentication. No CORS grants.
 * A public/shared server still requires its own access-control boundary. */
export async function antigravityCliInstallationResponse(
	request: Request,
	inspect = antigravityCliInstallationStatus,
	enabled = antigravityCliEnabled,
): Promise<Response> {
	const origin = subscriptionRequestOrigin(request);
	const supplied = request.headers.get("origin");
	const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
	if (request.method !== "GET" || !origin
		|| request.headers.get("x-learnharness-antigravity-cli") !== "1"
		|| request.headers.get("sec-fetch-site") === "cross-site"
		|| (supplied !== null && supplied !== origin)) {
		return Response.json({ error: "Antigravity CLI checks require a same-origin LearnHarness request." }, { status: 403, headers });
	}
	if (!enabled()) return Response.json({ error: "Antigravity CLI is disabled." }, { status: 403, headers });
	return Response.json(await inspect(), { headers });
}
