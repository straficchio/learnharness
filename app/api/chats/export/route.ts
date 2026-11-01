/**
 * POST /api/chats/export — the bulk ZIP export.
 *
 * Each entry is the same lossless JSON the single-session export produces;
 * the UI sends the ids of the currently selected sessions. Missing ids are
 * skipped (a selection can race a deletion), and a selection with no live
 * records is a 404. The archive is built in memory and never touches disk.
 */
import { strToU8, zipSync } from "fflate";
import {
	buildSessionExport,
	bulkSessionExportFilename,
	MAX_BULK_EXPORT_SESSIONS,
	sessionExportFilename,
} from "@/src/core";
import { getChat } from "@/src/server";

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

export async function POST(req: Request): Promise<Response> {
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

	const entries: Record<string, Uint8Array> = {};
	for (const id of ids) {
		const record = getChat(id);
		if (!record) continue;
		entries[sessionExportFilename(record)] = strToU8(JSON.stringify(buildSessionExport(record), null, "\t"));
	}
	if (Object.keys(entries).length === 0) {
		return Response.json({ error: "No selected sessions exist." }, { status: 404 });
	}

	const archive = zipSync(entries);
	return new Response(archive, {
		headers: {
			"content-type": "application/zip",
			"content-disposition": `attachment; filename="${bulkSessionExportFilename()}"`,
			"cache-control": "no-store",
		},
	});
}
