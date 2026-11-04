import { eventsResponse, withUser } from "@/src/server";

export const dynamic = "force-dynamic";

/** One SSE channel per open window, scoped to the signed-in user. */
async function GETHandler(_req: Request, _ctx: unknown, user: Parameters<typeof eventsResponse>[0]) {
	return eventsResponse(user);
}

export const GET = withUser(GETHandler);
