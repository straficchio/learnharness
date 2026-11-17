"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { PaperclipIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BrailleSpinner } from "@/components/braille-spinner";
import { appendToPrimaryInput } from "@/components/dictation";
import { INSERT_FILE_PATHS_EVENT } from "@/components/path-input";
import { cn } from "@/lib/utils";
import { quoteFilePath } from "@/src/core";
import {
	ATTACHMENT_ACCEPT,
	ATTACHMENT_MAX_BYTES,
	ATTACHMENT_MAX_FILES,
	attachmentPathsIn,
	isAttachableDocument,
} from "@/lib/attachment-limits.ts";

export interface UploadedAttachment {
	id: string;
	name: string;
	path: string;
	size: number;
}

/** Upload one file. One request per file keeps multipart buffering bounded
 *  to the 50 MB per-file ceiling even when a message carries ten files. */
export async function uploadAttachment(file: File, chatId?: string): Promise<UploadedAttachment> {
	const form = new FormData();
	form.append("file", file);
	if (chatId) form.append("chatId", chatId);
	const response = await fetch("/api/attachments", { method: "POST", body: form });
	const body = await response.json().catch(() => null) as { attachment?: UploadedAttachment; error?: string } | null;
	if (!response.ok || !body?.attachment) {
		throw new Error(body?.error ?? `Could not attach ${file.name}.`);
	}
	return body.attachment;
}

function insertPaths(root: HTMLElement | null, paths: string[]): boolean {
	if (paths.length === 0) return true;
	if (root) {
		root.dispatchEvent(new CustomEvent(INSERT_FILE_PATHS_EVENT, { detail: paths }));
		return true;
	}
	return appendToPrimaryInput(paths.map(quoteFilePath).join(" "));
}

/** Paperclip control shared by every model-facing text box. It uploads
 *  PDF/text files and inserts their app-managed paths into the adjacent
 *  PathInput as ordinary atomic chips. */
export function AttachDocumentButton({
	inputRef,
	value,
	chatId,
	compact = false,
	className,
}: {
	inputRef: React.RefObject<HTMLElement | null>;
	value: string;
	/** An existing session id; absent = a new-session draft. */
	chatId?: string;
	compact?: boolean;
	className?: string;
}) {
	const fileRef = React.useRef<HTMLInputElement>(null);
	const wrapperRef = React.useRef<HTMLSpanElement>(null);
	const [busy, setBusy] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);
	const [anchor, setAnchor] = React.useState<{ left: number; top: number } | null>(null);

	const clearError = () => {
		setError(null);
		setAnchor(null);
	};
	const reportError = (message: string) => {
		const rect = wrapperRef.current?.getBoundingClientRect();
		setAnchor(rect
			? { left: Math.max(8, Math.min(window.innerWidth - 272, rect.right - 256)), top: rect.top - 6 }
			: null);
		setError(message);
	};

	const pick = () => {
		clearError();
		fileRef.current?.click();
	};

	const attach = async (files: File[]) => {
		if (files.length === 0) return;
		const documents = files.filter(isAttachableDocument);
		if (documents.length !== files.length) {
			reportError("Only PDF and text documents can be attached.");
			if (documents.length === 0) return;
		}
		const existing = attachmentPathsIn(value).length;
		if (existing + documents.length > ATTACHMENT_MAX_FILES) {
			reportError(`You can attach up to ${ATTACHMENT_MAX_FILES} documents to one message.`);
			return;
		}
		const tooLarge = documents.find((file) => file.size > ATTACHMENT_MAX_BYTES);
		if (tooLarge) {
			reportError(`${tooLarge.name} is larger than ${ATTACHMENT_MAX_BYTES / (1024 * 1024)} MB.`);
			return;
		}
		setBusy(true);
		clearError();
		const uploaded: string[] = [];
		try {
			for (const file of documents) {
				try {
					uploaded.push((await uploadAttachment(file, chatId)).path);
				} catch (cause) {
					reportError(cause instanceof Error ? cause.message : `Could not attach ${file.name}.`);
					break;
				}
			}
			if (!insertPaths(inputRef.current, uploaded)) {
				reportError("Could not place the document in this field.");
			}
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			<span ref={wrapperRef} className={cn("relative inline-flex shrink-0", className)}>
				<input
					ref={fileRef}
					type="file"
					multiple
					accept={ATTACHMENT_ACCEPT}
					className="hidden"
					onChange={(event) => {
						const files = Array.from(event.target.files ?? []);
						event.target.value = "";
						void attach(files);
					}}
				/>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					aria-label="Attach PDF or text"
					aria-busy={busy}
					title="Attach PDF or text"
					disabled={busy}
					onMouseDown={(event) => event.preventDefault()}
					onClick={pick}
					className={cn(compact ? "size-7" : "size-10", "lh-no-drag")}
				>
					{busy ? <BrailleSpinner /> : <PaperclipIcon className={compact ? "size-3.5" : "size-4"} />}
				</Button>
			</span>
			{error && typeof document !== "undefined" && createPortal(
				<span
					role="alert"
					style={{
						position: "fixed",
						left: anchor?.left ?? 8,
						top: anchor?.top ?? 8,
						transform: anchor ? "translateY(-100%)" : undefined,
					}}
					className="z-[70] flex w-64 items-start gap-1.5 rounded-md border bg-card p-2 text-left text-xs text-destructive shadow-lg"
				>
					<span className="min-w-0 flex-1">{error}</span>
					<button
						type="button"
						aria-label="Dismiss attachment error"
						onClick={clearError}
						className="shrink-0 rounded-sm p-0.5 hover:bg-accent"
					>
						<XIcon className="size-3" />
					</button>
				</span>,
				document.body,
			)}
		</>
	);
}
