import { runtimeSettings, withUser } from "@/src/server";

/** Read-only operational settings for the chat UI (models, graph budget,
 *  dictation language). The full shared record stays admin-only. */
async function get() {
	return Response.json(runtimeSettings(), { headers: { "Cache-Control": "no-store" } });
}

export const GET = withUser(get);
