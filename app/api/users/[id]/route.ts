import { deleteUserResponse, updateUserResponse, withUser } from "@/src/server";

type Ctx = { params: Promise<{ id: string }> };

async function patch(req: Request, ctx: Ctx, user: Parameters<typeof updateUserResponse>[2]) {
	const { id } = await ctx.params;
	return updateUserResponse(req, id, user);
}

async function remove(_req: Request, ctx: Ctx, user: Parameters<typeof deleteUserResponse>[1]) {
	const { id } = await ctx.params;
	return deleteUserResponse(id, user);
}

export const PATCH = withUser(patch, { admin: true, serverOnly: true });
export const DELETE = withUser(remove, { admin: true, serverOnly: true });
