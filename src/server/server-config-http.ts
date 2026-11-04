/**
 * Settings → Server HTTP surface (multi-user wave): admin-only port/host.
 * The cookie-signing secret is never returned; writes preserve it.
 */
import { isServerMode, type RequestUser } from "./session.ts";
import { serverConfigView, writeServerConfig } from "./server-config.ts";

function json(body: unknown, init?: ResponseInit): Response {
	return Response.json(body, {
		...init,
		headers: { "Cache-Control": "no-store", ...(init?.headers ?? {}) },
	});
}

export function serverConfigResponse(user: RequestUser): Response {
	if (!isServerMode()) return json({ error: "Server settings are available only in server mode." }, { status: 404 });
	if (user.role !== "admin") return json({ error: "Admin access required." }, { status: 403 });
	return json({ server: serverConfigView() });
}

export async function writeServerConfigResponse(req: Request, user: RequestUser): Promise<Response> {
	if (!isServerMode()) return json({ error: "Server settings are available only in server mode." }, { status: 404 });
	if (user.role !== "admin") return json({ error: "Admin access required." }, { status: 403 });
	const body = await req.json().catch(() => null) as { port?: unknown; host?: unknown } | null;
	if (!body || typeof body.port !== "number" || typeof body.host !== "string") {
		return json({ error: "Body must be { port: number, host: string }." }, { status: 400 });
	}
	try {
		writeServerConfig({ port: body.port, host: body.host });
		return json({ server: serverConfigView() });
	} catch (error) {
		return json({ error: error instanceof Error ? error.message : "Could not save the server configuration." }, { status: 400 });
	}
}
