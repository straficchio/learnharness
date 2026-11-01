"use client";

/**
 * Bulk session actions: the sticky selection bar and the bulk-delete
 * confirmation. Selection itself lives in the sidebar; this module owns the
 * ZIP transport and the destructive multi-session flow.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { downloadBlob } from "@/components/artifacts/download";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import { TRACES_COPY } from "@/components/delete-session-dialog";
import type { ChatDeleteMode, ChatListItem } from "@/src/core";

export interface BulkExportOutcome {
	ok: true;
	blob: Blob;
	filename: string;
}

export interface BulkExportFailure {
	ok: false;
	error: string;
}

/** POST the selected ids and return the ZIP the server built. */
export async function exportSessionsZip(
	ids: string[],
	options: { fetchImpl?: typeof fetch } = {},
): Promise<BulkExportOutcome | BulkExportFailure> {
	const fetchImpl = options.fetchImpl ?? fetch;
	try {
		const res = await fetchImpl("/api/chats/export", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ids }),
		});
		if (!res.ok) {
			const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
			return {
				ok: false,
				error: typeof body?.error === "string" && body.error.trim() ? body.error : `Export failed (${res.status}).`,
			};
		}
		const disposition = res.headers.get("content-disposition") ?? "";
		const filename =
			/filename="([^"]+)"/.exec(disposition)?.[1] ?? "learnharness-sessions.zip";
		return { ok: true, blob: await res.blob(), filename };
	} catch {
		return { ok: false, error: "Could not reach the server." };
	}
}

export function saveBulkExport(outcome: BulkExportOutcome): void {
	downloadBlob(outcome.filename, outcome.blob);
}

export interface BulkDeleteFailure {
	id: string;
	title: string;
	error: string;
	code?: string;
}

export interface BulkDeleteResult {
	deletedIds: string[];
	failed: BulkDeleteFailure[];
	graphRevision: number;
}

/** Delete sequentially through the existing per-session route. Continue past
 *  failures so one busy session cannot strand the rest of the batch. */
export async function deleteSessionsBulk(
	chats: Pick<ChatListItem, "id" | "title">[],
	mode: ChatDeleteMode,
	options: { fetchImpl?: typeof fetch; onProgress?: (done: number, total: number) => void } = {},
): Promise<BulkDeleteResult> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const deletedIds: string[] = [];
	const failed: BulkDeleteFailure[] = [];
	let graphRevision = 0;
	for (let i = 0; i < chats.length; i++) {
		const chat = chats[i];
		if (!chat) continue;
		try {
			const res = await fetchImpl(`/api/chats/${encodeURIComponent(chat.id)}?mode=${mode}`, { method: "DELETE" });
			const body = (await res.json().catch(() => null)) as {
				error?: string;
				code?: string;
				graphRevision?: number;
			} | null;
			if (res.ok) {
				deletedIds.push(chat.id);
				if (typeof body?.graphRevision === "number") graphRevision = Math.max(graphRevision, body.graphRevision);
			} else {
				failed.push({
					id: chat.id,
					title: chat.title,
					error: body?.error ?? `Delete failed (${res.status}).`,
					...(body?.code ? { code: body.code } : {}),
				});
			}
		} catch {
			failed.push({ id: chat.id, title: chat.title, error: "Delete failed — network error." });
		}
		options.onProgress?.(i + 1, chats.length);
	}
	return { deletedIds, failed, graphRevision };
}

export function BulkSelectionBar({
	count,
	canSelectAll,
	onSelectAll,
	onExport,
	onDelete,
	onCancel,
	exporting,
	error,
}: {
	count: number;
	canSelectAll: boolean;
	onSelectAll: () => void;
	onExport: () => void;
	onDelete: () => void;
	onCancel: () => void;
	exporting: boolean;
	error: string | null;
}) {
	return (
		<div
			data-testid="bulk-selection-bar"
			className="mx-3 mb-2 rounded-lg border border-border/70 bg-card p-2 text-xs shadow-sm"
		>
			<div className="flex items-center justify-between gap-2">
				<span className="text-muted-foreground">
					<span data-testid="bulk-selection-count" className="text-foreground">{count}</span> selected
				</span>
				<button
					type="button"
					data-testid="bulk-cancel"
					onClick={onCancel}
					className="rounded-sm px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					Cancel
				</button>
			</div>
			<div className="mt-1.5 flex flex-wrap items-center gap-1">
				<button
					type="button"
					data-testid="bulk-select-all"
					disabled={!canSelectAll}
					onClick={onSelectAll}
					className="rounded-sm border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
				>
					Select all
				</button>
				<button
					type="button"
					data-testid="bulk-export"
					disabled={exporting}
					onClick={onExport}
					className="rounded-sm border border-border px-2 py-1 text-[11px] text-foreground transition-colors hover:bg-accent disabled:opacity-50"
				>
					{exporting ? "Exporting…" : "Export"}
				</button>
				<button
					type="button"
					data-testid="bulk-delete"
					onClick={onDelete}
					className="rounded-sm border border-destructive/50 bg-destructive/10 px-2 py-1 text-[11px] text-destructive transition-colors hover:bg-destructive/20"
				>
					Delete
				</button>
			</div>
			{error && (
				<p role="alert" data-testid="bulk-error" className="mt-1.5 text-[11px] text-red-400">
					{error}
				</p>
			)}
		</div>
	);
}

export function BulkDeleteBody({
	chats,
	traces,
	busy,
	progress,
	deleted,
	failed,
	onTraces,
	onClose,
	onRun,
	onRetry,
}: {
	chats: ChatListItem[];
	traces: boolean;
	busy: boolean;
	progress: { done: number; total: number } | null;
	deleted: number;
	failed: BulkDeleteFailure[];
	onTraces: (next: boolean) => void;
	onClose: () => void;
	onRun: () => void;
	onRetry: () => void;
}) {
	const finished = !busy && progress !== null && progress.done === progress.total;
	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Delete sessions"
			data-testid="bulk-delete-dialog"
			onClick={(e) => e.stopPropagation()}
			className="w-[32rem] max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-5 shadow-xl"
		>
			<h2 className="text-sm font-semibold text-destructive">
				Delete {chats.length} session{chats.length === 1 ? "" : "s"}?
			</h2>
			<ul className="mt-2 max-h-24 overflow-y-auto text-xs text-muted-foreground">
				{chats.slice(0, 8).map((chat) => (
					<li key={chat.id} className="truncate">{chat.title}</li>
				))}
				{chats.length > 8 && <li>and {chats.length - 8} more…</li>}
			</ul>
			<p className="mt-2 text-sm text-muted-foreground">
				This permanently removes {chats.length === 1 ? "the session" : "these sessions"} — messages,
				background jobs, and extraction records. Everything they added to the graph stays unless you check
				below. This cannot be undone.
			</p>
			<label
				data-testid={TRACES_COPY.testid}
				className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-lg border border-border/60 px-4 py-3"
			>
				<input
					type="checkbox"
					data-testid={TRACES_COPY.checkbox}
					checked={traces}
					onChange={(e) => onTraces(e.target.checked)}
					disabled={busy || deleted > 0}
					className="mt-0.5 size-4 shrink-0 accent-primary"
				/>
				<span className="min-w-0">
					<span className="block text-sm text-foreground">{TRACES_COPY.title}</span>
					<span className="mt-1 block text-xs text-muted-foreground">{TRACES_COPY.body}</span>
				</span>
			</label>
			{busy && progress && (
				<p data-testid="bulk-delete-progress" className="mt-3 text-xs text-muted-foreground">
					Deleting {progress.done} of {progress.total}…
				</p>
			)}
			{finished && deleted > 0 && failed.length === 0 && (
				<p data-testid="bulk-delete-success" className="mt-3 text-xs text-muted-foreground">
					Deleted {deleted} session{deleted === 1 ? "" : "s"}.
				</p>
			)}
			{failed.length > 0 && (
				<div role="alert" data-testid="bulk-delete-failures" className="mt-3 rounded-sm border border-border/60 px-3 py-2 text-xs">
					<div className="text-foreground">
						{deleted > 0 ? `Deleted ${deleted}; ` : ""}
						{failed.length} could not be deleted.
					</div>
					<ul className="mt-1 max-h-24 overflow-y-auto text-muted-foreground">
						{failed.slice(0, 6).map((entry) => (
							<li key={entry.id} className="truncate">
								{entry.title}: {entry.error}
							</li>
						))}
						{failed.length > 6 && <li>and {failed.length - 6} more…</li>}
					</ul>
				</div>
			)}
			<div className="mt-4 flex justify-end gap-2">
				<button
					type="button"
					data-testid="bulk-delete-cancel"
					onClick={onClose}
					disabled={busy}
					className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
				>
					{failed.length > 0 ? "Close" : "Cancel"}
				</button>
				{failed.length > 0 ? (
					<button
						type="button"
						data-testid="bulk-delete-retry"
						onClick={onRetry}
						disabled={busy}
						className="rounded-sm border border-destructive/50 bg-destructive/10 px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/20 disabled:opacity-40"
					>
						Retry failed
					</button>
				) : (
					<button
						type="button"
						data-testid="bulk-delete-confirm"
						onClick={onRun}
						disabled={busy}
						className="rounded-sm border border-destructive/50 bg-destructive/10 px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/20 disabled:opacity-40"
					>
						{busy ? "Deleting…" : "Delete"}
					</button>
				)}
			</div>
		</div>
	);
}

export function BulkDeleteDialog({
	chats,
	onClose,
	onComplete,
}: {
	chats: ChatListItem[] | null;
	onClose: () => void;
	onComplete: (deletedIds: string[], graphRevision: number) => void;
}) {
	const [traces, setTraces] = useState(false);
	const [busy, setBusy] = useState(false);
	const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
	const [deleted, setDeleted] = useState(0);
	const [failed, setFailed] = useState<BulkDeleteFailure[]>([]);

	useEffect(() => {
		if (!chats) {
			setTraces(false);
			setBusy(false);
			setProgress(null);
			setDeleted(0);
			setFailed([]);
		}
	}, [chats]);

	const backdropDismiss = useBackdropDismiss(() => {
		if (!busy) onClose();
	});

	useEffect(() => {
		if (!chats) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape" && !busy) {
				e.preventDefault();
				e.stopPropagation();
				onClose();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [busy, chats, onClose]);

	async function run(targets: Pick<ChatListItem, "id" | "title">[]) {
		if (busy || targets.length === 0) return;
		setBusy(true);
		setFailed([]);
		setProgress({ done: 0, total: targets.length });
		const mode: ChatDeleteMode = traces ? "delete-nodes" : "preserve-graph";
		const result = await deleteSessionsBulk(targets, mode, {
			onProgress: (done, total) => setProgress({ done, total }),
		});
		setDeleted((n) => n + result.deletedIds.length);
		setFailed(result.failed);
		setBusy(false);
		if (result.deletedIds.length > 0) onComplete(result.deletedIds, result.graphRevision);
		if (result.failed.length === 0) onClose();
	}

	if (!chats) return null;
	return createPortal(
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80" {...backdropDismiss}>
			<BulkDeleteBody
				chats={chats}
				traces={traces}
				busy={busy}
				progress={progress}
				deleted={deleted}
				failed={failed}
				onTraces={setTraces}
				onClose={onClose}
				onRun={() => void run(chats)}
				onRetry={() => void run(failed)}
			/>
		</div>,
		document.body,
	);
}
