/**
 * POST /api/attachments — one document upload for a message/draft.
 *
 * One file per request (the client fans out sequentially): this bounds the
 * multipart buffering to the 50 MB per-file ceiling instead of 10 × 50 MB.
 * Existing chats pass `chatId`; a home/new-session draft passes nothing and
 * is marked as a draft for the long retention sweep.
 */
import { ATTACHMENT_MAX_BODY_BYTES } from "@/lib/attachment-limits.ts";
import {
	AttachmentError,
	ensureAttachmentSweep,
	storeAttachment,
	stores,
	withUser,
} from "@/src/server";

class BodyLimitError extends Error {}

async function boundedFormData(request: Request): Promise<FormData> {
	if (Number(request.headers.get("content-length")) > ATTACHMENT_MAX_BODY_BYTES) {
		void request.body?.cancel().catch(() => undefined);
		throw new BodyLimitError();
	}
	const reader = request.body?.getReader();
	if (!reader) throw new SyntaxError("Missing upload body");
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > ATTACHMENT_MAX_BODY_BYTES) throw new BodyLimitError();
			chunks.push(value);
		}
		const body = new Uint8Array(bytes);
		let offset = 0;
		for (const chunk of chunks) {
			body.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return await new Response(body, { headers: { "Content-Type": request.headers.get("content-type") ?? "" } }).formData();
	} finally {
		void reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

async function POSTHandler(request: Request) {
	let form: FormData;
	try {
		form = await boundedFormData(request);
	} catch (error) {
		const tooLarge = error instanceof BodyLimitError;
		return Response.json({ error: tooLarge ? "That upload is too large." : "Could not read the upload." }, { status: tooLarge ? 413 : 400 });
	}
	const file = form.get("file");
	if (!(file instanceof File)) return Response.json({ error: "No file was uploaded." }, { status: 400 });
	const chatId = form.get("chatId");
	if (chatId !== null && typeof chatId !== "string") return Response.json({ error: "Invalid session." }, { status: 400 });
	if (typeof chatId === "string" && chatId.length > 0 && !stores.chatStore.getChat(chatId)) {
		return Response.json({ error: "No such session." }, { status: 404 });
	}
	try {
		const attachment = await storeAttachment(file, { draft: typeof chatId !== "string" || chatId.length === 0 });
		ensureAttachmentSweep();
		return Response.json({ attachment });
	} catch (error) {
		if (error instanceof AttachmentError) return Response.json({ error: error.message }, { status: error.status });
		return Response.json({ error: "Could not store the attachment." }, { status: 500 });
	}
}

export const POST = withUser(POSTHandler);
