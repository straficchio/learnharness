import { authMeResponse, withUser } from "@/src/server";

async function get(_req: Request, _ctx: unknown, user: Parameters<typeof authMeResponse>[0]) {
	return authMeResponse(user);
}

export const GET = withUser(get);
