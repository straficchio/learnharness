/**
 * GET /api/settings — the signed-in user's settings view.
 *
 * Admin: the full shared record (with the admin's own per-user appearance).
 * Regular user: version + their appearance only. Operational read-only data
 * for the chat UI lives at /api/runtime; the full shared record never leaves
 * the admin surface.
 */
import { settingsViewFor, withUser } from "@/src/server";

export const dynamic = "force-dynamic";

async function GETHandler(_req: Request, _ctx: unknown, user: Parameters<typeof settingsViewFor>[0]) {
	return Response.json({ settings: settingsViewFor(user) }, { headers: { "Cache-Control": "no-store" } });
}

export const GET = withUser(GETHandler);
