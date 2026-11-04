import { authPasswordResponse, withUser } from "@/src/server";

async function post(req: Request, _ctx: unknown, user: Parameters<typeof authPasswordResponse>[1]) {
	return authPasswordResponse(req, user);
}

export const POST = withUser(post);
