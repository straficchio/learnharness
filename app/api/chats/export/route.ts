/**
 * POST /api/chats/export — the bulk ZIP export.
 *
 * The archive carries the same lossless JSON as the single-session route.
 * When any selected session has app-managed attachment copies that can be
 * bundled, the ZIP also carries the bundle manifest and those copies;
 * otherwise it stays the original JSON-only archive. The UI sends the ids
 * of the currently selected sessions. Missing ids are skipped (a selection
 * can race a deletion), and a selection with no live records is a 404.
 */
import { strToU8, zipSync } from "fflate";
import {
	buildSessionExport,
	bulkSessionExportFilename,
	MAX_BULK_EXPORT_SESSIONS,
	sessionExportFilename,
} from "@/src/core";
import {
	buildSessionBundleZip,
	getChat,
	hasBundleAttachments,
	prepareSessionForExport,
	SessionBundleError,
	withUser,
} from "@/src/server";

export const dynamic = "force-dynamic";

function validIds(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	const ids: string[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		if (typeof item !== "string" || !/^[A-Za-z0-9_-]+$/.test(item) || seen.has(item)) continue;
		seen.add(item);
		ids.push(item);
	}
	return ids;
}

async function POSTHandler(req: Request): Promise<Response> {
	const body = (await req.json().catch(() => null)) as { ids?: unknown } | null;
	const ids = validIds(body?.ids);
	if (!ids || ids.length === 0) {
		return Response.json({ error: "Select at least one session to export." }, { status: 400 });
	}
	if (ids.length > MAX_BULK_EXPORT_SESSIONS) {
		return Response.json(
			{ error: `Select at most ${MAX_BULK_EXPORT_SESSIONS} sessions at a time.` },
			{ status: 400 },
		);
	}

	const records = ids.map((id) => getChat(id)).filter((record) => record !== null);
	if (records.length === 0) return Response.json({ error: "No selected sessions exist." }, { status: 404 });

	try {
		const prepared = await Promise.all(records.map((record) => prepareSessionForExport(record)));
		if (hasBundleAttachments(prepared)) {
			const bundle = await buildSessionBundleZip(prepared);
			return new Response(bundle.bytes as unknown as BodyInit, {
				headers: {
					"content-type": "application/zip",
					"content-disposition": `attachment; filename="${bulkSessionExportFilename()}"`,
					"cache-control": "no-store",
				},
			});
		}
		const entries: Record<string, Uint8Array> = {};
		for (const item of prepared) {
			entries[sessionExportFilename(item.record)] = strToU8(JSON.stringify(buildSessionExport(item.record), null, "\t"));
		}
		const archive = zipSync(entries);
		return new Response(archive, {
			headers: {
				"content-type": "application/zip",
				"content-disposition": `attachment; filename="${bulkSessionExportFilename()}"`,
				"cache-control": "no-store",
			},
		});
	} catch (error) {
		if (error instanceof SessionBundleError) return Response.json({ error: error.message }, { status: error.status });
		throw error;
	}
}

export const POST = withUser(POSTHandler);
