/**
 * GET /api/chats/:id/export — the lossless session file.
 *
 * Attachment-free sessions stay a JSON wrapper (the original format).
 * A session that names app-managed copies it can actually bundle becomes a
 * ZIP: session JSON(s) + manifest + attachment copies. Every other local
 * path is replaced with a portable placeholder during preparation, so the
 * download never carries another user's roots or a dead path.
 */
import { buildSessionExport, sessionExportFilename } from "@/src/core";
import { buildSessionBundleZip, getChat, hasBundleAttachments, prepareSessionForExport, SessionBundleError, withUser } from "@/src/server";

export const dynamic = "force-dynamic";

async function GETHandler(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	const record = getChat(id);
	if (!record) return Response.json({ error: "Unknown chat" }, { status: 404 });

	try {
		const prepared = await prepareSessionForExport(record);
		if (hasBundleAttachments([prepared])) {
			const bundle = await buildSessionBundleZip([prepared]);
			return new Response(bundle.bytes as unknown as BodyInit, {
				headers: {
					"content-type": "application/zip",
					"content-disposition": `attachment; filename="${sessionExportFilename(record).replace(/\.json$/i, ".zip")}"`,
					"cache-control": "no-store",
				},
			});
		}
		const body = buildSessionExport(prepared.record);
		return new Response(JSON.stringify(body, null, "\t"), {
			headers: {
				"content-type": "application/json; charset=utf-8",
				"content-disposition": `attachment; filename="${sessionExportFilename(record)}"`,
				"cache-control": "no-store",
			},
		});
	} catch (error) {
		if (error instanceof SessionBundleError) return Response.json({ error: error.message }, { status: error.status });
		throw error;
	}
}

export const GET = withUser(GETHandler);
