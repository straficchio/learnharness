import { createUserResponse, usersAdminResponse, withUser } from "@/src/server";

async function get(_req: Request, _ctx: unknown, user: Parameters<typeof usersAdminResponse>[0]) {
	return usersAdminResponse(user);
}

async function post(req: Request, _ctx: unknown, user: Parameters<typeof createUserResponse>[1]) {
	return createUserResponse(req, user);
}

export const GET = withUser(get, { admin: true, serverOnly: true });
export const POST = withUser(post, { admin: true, serverOnly: true });
