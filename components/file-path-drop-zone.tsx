"use client";

import { useEffect, useRef, useState } from "react";
import { FileSymlinkIcon, XIcon } from "lucide-react";
import { quoteFilePath } from "@/src/core";
import { appendToPrimaryInput } from "@/components/dictation";
import { INSERT_FILE_PATHS_EVENT } from "@/components/path-input";
import { readPathInput } from "@/components/path-input-dom";
import { uploadAttachment } from "@/lib/attachment-upload.ts";
import { ATTACHMENT_MAX_FILES, attachmentPathsIn, isAttachableDocument } from "@/lib/attachment-limits.ts";

const BROWSER_NOTICE = "Only PDF and text documents can be uploaded from this browser. Other local files need the desktop app.";
type DragKind = "documents" | "mixed" | "other";

function isDirectoryItem(item: DataTransferItem): boolean {
	try { return item.webkitGetAsEntry?.()?.isDirectory === true; } catch { return false; }
}

function classifyTransfer(dataTransfer: DataTransfer): DragKind {
	let docs = 0;
	let other = 0;
	const items = Array.from(dataTransfer.items).filter((item) => item.kind === "file");
	for (const item of items) {
		if (isDirectoryItem(item)) { other++; continue; }
		let file: File | null = null;
		let entryName = "";
		try {
			file = item.getAsFile();
			const entry = item.webkitGetAsEntry?.();
			if (entry && "name" in entry && typeof entry.name === "string") entryName = entry.name;
		} catch { /* unavailable during this drag phase */ }
		if (file) {
			if (isAttachableDocument(file)) docs++;
			else other++;
		} else if (isAttachableDocument({ name: entryName, type: item.type })) docs++;
		else other++;
	}
	if (docs > 0 && other > 0) return "mixed";
	return docs > 0 ? "documents" : "other";
}

function dragMessage(kind: DragKind | null, desktop: boolean): { title: string; detail: string } {
	if (kind === "documents") return {
		title: "Drop to upload PDF/text to LearnHarness",
		detail: "The model reads the uploaded copy — no local path needed.",
	};
	if (kind === "mixed") return {
		title: "PDF/text will upload",
		detail: desktop ? "Other files add their local paths instead." : "Other files need the desktop app.",
	};
	if (kind === "other" && desktop) return {
		title: "Drop to add this file's local path",
		detail: "PDF/text documents upload; other files stay as local path references.",
	};
	return {
		title: "This file type can't be uploaded here",
		detail: "Only PDF and text documents upload from the browser. Other local files need the desktop app.",
	};
}

/** The content area only: the sidebar is deliberately outside this zone.
 * Existing files stay where they are; only quoted path strings enter drafts. */
export function FilePathDropZone({ children, className, inert = false, attachmentChatId }: { children: React.ReactNode; className?: string; inert?: boolean; attachmentChatId?: string }) {
	const root = useRef<HTMLElement>(null);
	const depth = useRef(0);
	const [dragging, setDragging] = useState(false);
	const [dragKind, setDragKind] = useState<DragKind | null>(null);
	const [notice, setNotice] = useState("");
	const [dropProgress, setDropProgress] = useState<{
		index: number;
		total: number;
		name: string;
		loaded: number;
		totalBytes: number;
	} | null>(null);
	const hasFiles = (event: React.DragEvent) => Array.from(event.dataTransfer.types).includes("Files");
	const clearDrag = () => { depth.current = 0; setDragging(false); setDragKind(null); };
	const desktop = typeof window !== "undefined" && Boolean(window.lh?.getPathForFile);
	const dragCopy = dragMessage(dragKind, desktop);
	const progressPercent = dropProgress
		? Math.min(100, Math.round((dropProgress.loaded / Math.max(1, dropProgress.totalBytes)) * 100))
		: 0;
	const dropFiles = async (event: React.DragEvent<HTMLElement>) => {
		event.preventDefault();
		event.stopPropagation();
		const kind = classifyTransfer(event.dataTransfer);
		clearDrag();
		const dropZone = event.currentTarget;
		const files = Array.from(event.dataTransfer.files);
		const entries = Array.from(event.dataTransfer.items).filter((item) => item.kind === "file");
		const resolve = window.lh?.getPathForFile;
		const desktop = Boolean(resolve);
		const paths: string[] = [];
		const dropTarget = document.activeElement?.closest<HTMLElement>("[data-file-path-input]");
		const existing = dropTarget ? attachmentPathsIn(readPathInput(dropTarget)).length : 0;
		const directoryFlags = files.map((_, index) => entries[index] ? isDirectoryItem(entries[index]!) : false);
		const documentCount = files.filter((file, index) => !directoryFlags[index] && isAttachableDocument(file)).length;
		const allowedDocs = Math.max(0, Math.min(documentCount, ATTACHMENT_MAX_FILES - existing));
		let attachedDocs = 0;
		let skipped = 0;
		let failed = 0;
		let firstError: string | null = null;
		setNotice("");
		try {
			for (const [index, file] of files.entries()) {
				if (directoryFlags[index]) { skipped++; continue; }
				if (isAttachableDocument(file)) {
					if (attachedDocs >= allowedDocs) { skipped++; continue; }
					setDropProgress({ index: attachedDocs + 1, total: allowedDocs, name: file.name, loaded: 0, totalBytes: file.size });
					try {
						const attachment = await uploadAttachment(file, attachmentChatId, ({ loaded, total }) => {
							setDropProgress((current) => current
								? { ...current, loaded, totalBytes: total > 0 ? total : current.totalBytes }
								: current);
						});
						paths.push(attachment.path);
						attachedDocs++;
					} catch (cause) {
						failed++;
						firstError ??= cause instanceof Error ? cause.message : null;
					}
					continue;
				}
				if (!resolve) { skipped++; continue; }
				try {
					const path = resolve(file);
					quoteFilePath(path); // Same rooted-path validity rule as typed chips.
					paths.push(path);
				} catch {
					skipped++;
				}
			}
			if (paths.length === 0) {
				setNotice(firstError ?? (failed > 0
					? "Could not upload the dropped document."
					: desktop ? (skipped > 0 ? "No local file paths were available. Drop existing files from your computer." : "") : BROWSER_NOTICE));
				return;
			}
			const focused = document.activeElement?.closest<HTMLElement>("[data-file-path-input]");
			if (focused && dropZone.contains(focused)) {
				focused.dispatchEvent(new CustomEvent(INSERT_FILE_PATHS_EVENT, { detail: paths }));
			} else if (!appendToPrimaryInput(paths.map(quoteFilePath).join(" "))) {
				setNotice("Open a chat to attach file paths.");
				return;
			}
			if (failed > 0) setNotice(firstError ?? "Some documents could not be uploaded.");
			else if (skipped > 0) setNotice(kind === "mixed" && !desktop
				? "PDF/text uploaded; other files need the desktop app."
				: "Some dropped items were not attached.");
			else setNotice("");
		} finally {
			setDropProgress(null);
		}
	};
	useEffect(() => {
		// The sidebar remains a non-target, but dropping a file there must not
		// navigate the app away. No indicator or attachment is produced there.
		const preventOutsideNavigation = (event: DragEvent) => {
			if (Array.from(event.dataTransfer?.types ?? []).includes("Files")
				&& event.target instanceof Node && !root.current?.contains(event.target)) event.preventDefault();
		};
		window.addEventListener("dragover", preventOutsideNavigation);
		window.addEventListener("drop", preventOutsideNavigation);
		return () => {
			window.removeEventListener("dragover", preventOutsideNavigation);
			window.removeEventListener("drop", preventOutsideNavigation);
		};
	}, []);
	return (
		<main
			ref={root}
			className={className}
			data-testid="file-path-drop-zone"
			aria-busy={dropProgress !== null}
			{...(inert ? { inert: true } : {})}
			onDragEnter={(event) => {
				if (!hasFiles(event)) return;
				event.preventDefault();
				depth.current++;
				setDragging(true);
				setDragKind(classifyTransfer(event.dataTransfer));
				setNotice("");
			}}
			onDragOver={(event) => {
				if (!hasFiles(event)) return;
				event.preventDefault();
				event.dataTransfer.dropEffect = "copy";
				const next = classifyTransfer(event.dataTransfer);
				setDragKind((current) => current === next ? current : next);
			}}
			onDragLeave={(event) => {
				if (!hasFiles(event)) return;
				depth.current = Math.max(0, depth.current - 1);
				if (depth.current === 0) {
					setDragging(false);
					setDragKind(null);
				}
			}}
			onDragEnd={clearDrag}
			onDrop={(event) => {
				if (!hasFiles(event)) return;
				void dropFiles(event);
			}}
		>
			{children}
			{dragging && !dropProgress && (
				<div data-testid="file-path-drop-indicator" className="pointer-events-none absolute inset-2 z-50 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-background/85 p-6 text-center backdrop-blur-sm">
					<div className="flex max-w-md flex-col items-center gap-3">
						<FileSymlinkIcon className="size-8 text-primary" aria-hidden />
						<span className="font-ui text-sm">{dragCopy.title}</span>
						<span className="text-xs text-muted-foreground">{dragCopy.detail}</span>
					</div>
				</div>
			)}
			{dropProgress && (
				<div
					role="dialog"
					aria-modal="true"
					aria-labelledby="lh-attachment-upload-title"
					data-testid="attachment-upload-progress"
					className="fixed inset-0 z-[60] flex items-center justify-center bg-background/75 p-4 backdrop-blur-sm"
				>
					<div className="w-full max-w-sm rounded-xl border bg-card p-5 shadow-2xl">
						<div className="flex items-baseline justify-between gap-3">
							<p id="lh-attachment-upload-title" className="text-sm font-medium">
								Uploading {dropProgress.index} of {dropProgress.total}
							</p>
							<span className="text-sm tabular-nums text-muted-foreground">{progressPercent}%</span>
						</div>
						<p className="mt-1 truncate text-xs text-muted-foreground">{dropProgress.name}</p>
						<div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
							<div
								className="h-full rounded-full bg-primary transition-[width] duration-150"
								style={{ width: `${progressPercent}%` }}
							/>
						</div>
						<p className="mt-2 text-[11px] text-muted-foreground">Transferring the document copy to LearnHarness…</p>
					</div>
				</div>
			)}
			{notice && <div role="status" className="absolute bottom-2 left-1/2 z-50 flex max-w-[90%] -translate-x-1/2 items-center gap-2 rounded-md border bg-card px-3 py-2 font-ui text-xs shadow-sm">
				<span>{notice}</span>
				<button type="button" aria-label="Dismiss attachment notice" onClick={() => setNotice("")} className="shrink-0 rounded-sm p-1 hover:bg-accent"><XIcon className="size-3" aria-hidden /></button>
			</div>}
		</main>
	);
}
