import { resetPasswordResponse, withUser } from "@/src/server";

type Ctx = { params: Promise<{ id: string }> };

async function post(_req: Request, ctx: Ctx, user: Parameters<typeof resetPasswordResponse>[1]) {
	const { id } = await ctx.params;
	return resetPasswordResponse(id, user);
}

export const POST = withUser(post, { admin: true, serverOnly: true });
