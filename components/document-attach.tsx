"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { PaperclipIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { appendToPrimaryInput } from "@/components/dictation";
import { INSERT_FILE_PATHS_EVENT } from "@/components/path-input";
import { cn } from "@/lib/utils";
import { quoteFilePath } from "@/src/core";
import { uploadAttachment } from "@/lib/attachment-upload.ts";
import {
	ATTACHMENT_ACCEPT,
	ATTACHMENT_MAX_BYTES,
	ATTACHMENT_MAX_FILES,
	attachmentPathsIn,
	isAttachableDocument,
} from "@/lib/attachment-limits.ts";

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
	const [progress, setProgress] = React.useState<{
		index: number;
		total: number;
		name: string;
		loaded: number;
		totalBytes: number;
	} | null>(null);
	const [anchor, setAnchor] = React.useState<{ left: number; top: number } | null>(null);

	const anchorNow = () => {
		const rect = wrapperRef.current?.getBoundingClientRect();
		setAnchor(rect
			? { left: Math.max(8, Math.min(window.innerWidth - 272, rect.right - 256)), top: rect.top - 6 }
			: null);
	};
	const clearError = () => {
		setError(null);
		if (!progress) setAnchor(null);
	};
	const reportError = (message: string) => {
		anchorNow();
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
		anchorNow();
		const uploaded: string[] = [];
		try {
			for (const [index, file] of documents.entries()) {
				setProgress({ index: index + 1, total: documents.length, name: file.name, loaded: 0, totalBytes: file.size });
				try {
					const attachment = await uploadAttachment(file, chatId, ({ loaded, total }) => {
						setProgress((current) => current
							? { ...current, loaded, totalBytes: total > 0 ? total : current.totalBytes }
							: current);
					});
					uploaded.push(attachment.path);
				} catch (cause) {
					reportError(cause instanceof Error ? cause.message : `Could not attach ${file.name}.`);
					break;
				}
			}
			if (!insertPaths(inputRef.current, uploaded)) {
				reportError("Could not place the document in this field.");
			}
		} finally {
			setProgress(null);
			setBusy(false);
		}
	};

	const percent = progress ? Math.min(100, Math.round((progress.loaded / Math.max(1, progress.totalBytes)) * 100)) : 0;

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
					className={cn("relative", compact ? "size-7" : "size-10", "lh-no-drag")}
				>
					{busy && (
						<svg viewBox="0 0 40 40" className="pointer-events-none absolute inset-0 size-full -rotate-90 text-primary" aria-hidden="true">
							<circle cx="20" cy="20" r="17" fill="none" stroke="currentColor" strokeOpacity="0.18" strokeWidth="2" />
							<circle
								cx="20"
								cy="20"
								r="17"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeDasharray={`${(percent / 100) * 106.8} 106.8`}
							/>
						</svg>
					)}
					<PaperclipIcon className={cn("relative", compact ? "size-3.5" : "size-4")} />
				</Button>
			</span>
			{(error || progress) && typeof document !== "undefined" && createPortal(
				error ? (
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
					</span>
				) : progress ? (
					<span
						role="status"
						aria-live="polite"
						style={{
							position: "fixed",
							left: anchor?.left ?? 8,
							top: anchor?.top ?? 8,
							transform: anchor ? "translateY(-100%)" : undefined,
						}}
						className="z-[70] block w-72 rounded-md border bg-card p-3 text-left text-xs shadow-lg"
					>
						<span className="flex items-center justify-between gap-2">
							<span className="min-w-0 truncate font-medium">{progress.name}</span>
							<span className="shrink-0 tabular-nums text-muted-foreground">{percent}%</span>
						</span>
						<span className="mt-0.5 block text-[11px] text-muted-foreground">
							Uploading {progress.index} of {progress.total}
						</span>
						<span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-muted">
							<span
								className="block h-full rounded-full bg-primary transition-[width] duration-150"
								style={{ width: `${percent}%` }}
							/>
						</span>
					</span>
				) : null,
				document.body,
			)}
		</>
	);
}
