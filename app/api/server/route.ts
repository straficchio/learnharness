import { serverConfigResponse, withUser, writeServerConfigResponse } from "@/src/server";

async function get(_req: Request, _ctx: unknown, user: Parameters<typeof serverConfigResponse>[0]) {
	return serverConfigResponse(user);
}

async function put(req: Request, _ctx: unknown, user: Parameters<typeof writeServerConfigResponse>[1]) {
	return writeServerConfigResponse(req, user);
}

export const GET = withUser(get, { admin: true, serverOnly: true });
export const PUT = withUser(put, { admin: true, serverOnly: true });
