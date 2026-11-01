/**
 * GET /api/chats/:id/export — the lossless session file.
 *
 * The Markdown route next door is for humans; this one carries the complete
 * ChatRecord (native messages, plan tree, per-session settings, usage logs,
 * kind, schema stamp) inside a versioned wrapper, so it can be restored on
 * another installation without reconstructing state. The body is JSON and
 * the download name is derived from the title + id.
 */
import { buildSessionExport, sessionExportFilename } from "@/src/core";
import { getChat } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	const record = getChat(id);
	if (!record) return Response.json({ error: "Unknown chat" }, { status: 404 });

	const body = buildSessionExport(record);
	return new Response(JSON.stringify(body, null, "\t"), {
		headers: {
			"content-type": "application/json; charset=utf-8",
			"content-disposition": `attachment; filename="${sessionExportFilename(record)}"`,
			"cache-control": "no-store",
		},
	});
}
