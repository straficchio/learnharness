import { modelTraceClear, modelTraceSnapshot } from "@/src/server";

/** GET /api/model-trace?session=<chat>&after=<line> — the chat-side drawer's
 *  read surface. DELETE clears one session's trace file. */
export async function GET(request: Request) {
	const url = new URL(request.url);
	const session = url.searchParams.get("session");
	if (!session) return Response.json({ error: "session is required" }, { status: 400 });
	const afterRaw = url.searchParams.get("after") ?? "0";
	const after = Number(afterRaw);
	if (!Number.isSafeInteger(after) || after < 0) {
		return Response.json({ error: "after must be a non-negative integer" }, { status: 400 });
	}
	return Response.json(modelTraceSnapshot(session, after), {
		headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
	});
}

export async function DELETE(request: Request) {
	const url = new URL(request.url);
	const session = url.searchParams.get("session");
	if (!session) return Response.json({ error: "session is required" }, { status: 400 });
	modelTraceClear(session);
	return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
