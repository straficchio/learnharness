"use client";

/**
 * Import session — the restore half of the lossless transfer pair.
 *
 * The button sits with the sidebar's create doors. It accepts one `.json`
 * export (or a raw data/chats record), or a bulk `.zip` produced by the
 * selection bar. A single session opens after restore; a ZIP stays here,
 * refreshes the sidebar, and reports imported/conflict/failure counts.
 */
import { useRef, useState } from "react";
import { UploadIcon } from "lucide-react";
import { MAX_BULK_IMPORT_BYTES, MAX_SESSION_IMPORT_BYTES } from "@/src/core";

export type SessionImportOutcome =
	| { ok: true; id: string; title: string; replaced: boolean }
	| { ok: false; code?: string; error: string; id?: string; title?: string };

interface ImportBody {
	ok?: unknown;
	id?: unknown;
	title?: unknown;
	replaced?: unknown;
	error?: unknown;
	code?: unknown;
}

/** The transport seam, exported for tests. `fetchImpl` defaults to fetch. */
export async function importSessionText(
	text: string,
	options: { replace?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<SessionImportOutcome> {
	const fetchImpl = options.fetchImpl ?? fetch;
	try {
		const res = await fetchImpl(`/api/chats/import${options.replace ? "?replace=1" : ""}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: text,
		});
		const body = (await res.json().catch(() => null)) as ImportBody | null;
		if (res.ok && body?.ok === true && typeof body.id === "string") {
			return {
				ok: true,
				id: body.id,
				title: typeof body.title === "string" ? body.title : "Imported session",
				replaced: body.replaced === true,
			};
		}
		const error = typeof body?.error === "string" && body.error.trim() ? body.error : `Import failed (${res.status}).`;
		const code = typeof body?.code === "string" ? body.code : undefined;
		return {
			ok: false,
			error,
			...(code ? { code } : {}),
			...(typeof body?.id === "string" ? { id: body.id } : {}),
			...(typeof body?.title === "string" ? { title: body.title } : {}),
		};
	} catch {
		return { ok: false, error: "Could not reach the server." };
	}
}

export interface ImportedSessionSummary {
	id: string;
	title: string;
}

export interface ZipImportFailure {
	file: string;
	error: string;
	id?: string;
	title?: string;
	code?: string;
}

export interface ZipImportResult {
	imported: ImportedSessionSummary[];
	replaced: ImportedSessionSummary[];
	conflicts: ImportedSessionSummary[];
	failures: ZipImportFailure[];
}

export type ZipImportOutcome =
	| ({ ok: true } & ZipImportResult)
	| { ok: false; error: string; code?: string };

function summaryList(value: unknown): ImportedSessionSummary[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter(
			(entry): entry is ImportedSessionSummary =>
				typeof entry === "object" &&
				entry !== null &&
				typeof (entry as ImportedSessionSummary).id === "string" &&
				typeof (entry as ImportedSessionSummary).title === "string",
		)
		.map((entry) => ({ id: entry.id, title: entry.title }));
}

/** POST a ZIP and normalize the per-session summary. */
export async function importSessionZip(
	bytes: ArrayBuffer,
	options: { replace?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<ZipImportOutcome> {
	const fetchImpl = options.fetchImpl ?? fetch;
	try {
		const res = await fetchImpl(`/api/chats/import?zip=1${options.replace ? "&replace=1" : ""}`, {
			method: "POST",
			headers: { "content-type": "application/zip" },
			body: bytes,
		});
		const body = (await res.json().catch(() => null)) as
			| (Partial<ZipImportResult> & { ok?: unknown; error?: unknown; code?: unknown })
			| null;
		if (!res.ok || body?.ok !== true) {
			const error =
				typeof body?.error === "string" && body.error.trim() ? body.error : `Import failed (${res.status}).`;
			const code = typeof body?.code === "string" ? body.code : undefined;
			return { ok: false, error, ...(code ? { code } : {}) };
		}
		return {
			ok: true,
			imported: summaryList(body.imported),
			replaced: summaryList(body.replaced),
			conflicts: summaryList(body.conflicts),
			failures: Array.isArray(body.failures)
				? body.failures
						.filter(
							(entry): entry is ZipImportFailure =>
								typeof entry === "object" &&
								entry !== null &&
								typeof (entry as ZipImportFailure).file === "string" &&
								typeof (entry as ZipImportFailure).error === "string",
						)
						.map((entry) => ({
							file: entry.file,
							error: entry.error,
							...(typeof entry.id === "string" ? { id: entry.id } : {}),
							...(typeof entry.title === "string" ? { title: entry.title } : {}),
							...(typeof entry.code === "string" ? { code: entry.code } : {}),
						}))
				: [],
		};
	} catch {
		return { ok: false, error: "Could not reach the server." };
	}
}

export function SessionImportButton({
	onImported,
	onBulkImported,
}: {
	onImported: (id: string) => void;
	onBulkImported?: () => void;
}) {
	const inputRef = useRef<HTMLInputElement>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState<{ text: string; id: string; title: string } | null>(null);
	const [zipSource, setZipSource] = useState<ArrayBuffer | null>(null);
	const [zipResult, setZipResult] = useState<ZipImportResult | null>(null);

	async function send(text: string, replace: boolean) {
		setBusy(true);
		setError(null);
		const outcome = await importSessionText(text, { replace });
		setBusy(false);
		if (outcome.ok) {
			setPending(null);
			setZipResult(null);
			setZipSource(null);
			onImported(outcome.id);
			return;
		}
		if (outcome.code === "session_exists") {
			setPending({
				text,
				id: outcome.id ?? "",
				title: outcome.title ?? "this session",
			});
			return;
		}
		setError(outcome.error);
	}

	async function sendZip(bytes: ArrayBuffer, replace: boolean) {
		setBusy(true);
		setError(null);
		const outcome = await importSessionZip(bytes, { replace });
		setBusy(false);
		if (!outcome.ok) {
			setError(outcome.error);
			return;
		}
		setZipResult(outcome);
		if (outcome.imported.length > 0 || outcome.replaced.length > 0) onBulkImported?.();
	}

	async function choose(event: React.ChangeEvent<HTMLInputElement>) {
		const file = event.target.files?.[0];
		event.target.value = ""; // allow re-picking the same file
		if (!file) return;
		setError(null);
		setPending(null);
		setZipResult(null);
		const isZip = file.name.toLowerCase().endsWith(".zip") || file.type === "application/zip";
		if (file.size > (isZip ? MAX_BULK_IMPORT_BYTES : MAX_SESSION_IMPORT_BYTES)) {
			setError(isZip ? "The ZIP file is too large." : "The session file is too large.");
			return;
		}
		try {
			if (isZip) {
				const bytes = await file.arrayBuffer();
				setZipSource(bytes);
				await sendZip(bytes, false);
			} else {
				setZipSource(null);
				await send(await file.text(), false);
			}
		} catch {
			setError("Could not read the import file.");
		}
	}

	return (
		<div className="flex flex-col gap-1">
			<button
				type="button"
				data-testid="import-session"
				disabled={busy}
				onClick={() => inputRef.current?.click()}
				className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
			>
				<UploadIcon className="size-3" />
				{busy ? "Importing…" : "Import session…"}
			</button>
			<input
				ref={inputRef}
				type="file"
				accept=".json,.zip,application/json,application/zip"
				className="hidden"
				data-testid="import-session-input"
				onChange={(event) => void choose(event)}
			/>
			{error && (
				<p role="alert" data-testid="import-session-error" className="px-2 text-xs text-red-400">
					{error}
				</p>
			)}
			{pending && (
				<div
					role="alertdialog"
					aria-label="Replace existing session?"
					data-testid="import-session-conflict"
					className="mx-1 rounded-md border border-border bg-background p-2 text-xs"
				>
					<p>
						A session with this id already exists: <span className="text-foreground">{pending.title}</span>.
					</p>
					<p className="mt-1 text-muted-foreground">
						Replacing it discards the current record; the imported state becomes the session.
					</p>
					<div className="mt-2 flex gap-2">
						<button
							type="button"
							data-testid="import-session-replace"
							disabled={busy}
							onClick={() => void send(pending.text, true)}
							className="rounded-sm bg-destructive px-2 py-1 text-destructive-foreground disabled:opacity-50"
						>
							Replace session
						</button>
						<button
							type="button"
							data-testid="import-session-cancel"
							disabled={busy}
							onClick={() => setPending(null)}
							className="rounded-sm border border-border px-2 py-1 disabled:opacity-50"
						>
							Cancel
						</button>
					</div>
				</div>
			)}
			{zipResult && (
				<div
					data-testid="zip-import-result"
					className="mx-1 rounded-md border border-border bg-background p-2 text-xs"
				>
					<p>
						Imported <span className="text-foreground">{zipResult.imported.length}</span>
						{zipResult.replaced.length > 0 ? `, replaced ${zipResult.replaced.length}` : ""}
						{zipResult.conflicts.length > 0 ? `, ${zipResult.conflicts.length} conflict${zipResult.conflicts.length === 1 ? "" : "s"}` : ""}
						{zipResult.failures.length > 0 ? `, ${zipResult.failures.length} failed` : ""}.
					</p>
					{zipResult.conflicts.length > 0 && zipSource && (
						<button
							type="button"
							data-testid="zip-import-replace-all"
							disabled={busy}
							onClick={() => void sendZip(zipSource, true)}
							className="mt-2 rounded-sm bg-destructive px-2 py-1 text-destructive-foreground disabled:opacity-50"
						>
							Replace all conflicts
						</button>
					)}
					{zipResult.failures.length > 0 && (
						<ul className="mt-1 max-h-24 overflow-y-auto text-red-400">
							{zipResult.failures.slice(0, 5).map((failure) => (
								<li key={`${failure.file}-${failure.error}`} className="truncate">
									{failure.file}: {failure.error}
								</li>
							))}
							{zipResult.failures.length > 5 && <li>and {zipResult.failures.length - 5} more…</li>}
						</ul>
					)}
					<button
						type="button"
						data-testid="zip-import-dismiss"
						onClick={() => {
							setZipResult(null);
							setZipSource(null);
						}}
						className="mt-2 text-[11px] text-muted-foreground underline-offset-2 hover:underline"
					>
						Dismiss
					</button>
				</div>
			)}
		</div>
	);
}
