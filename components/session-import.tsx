"use client";

/**
 * Import session — the restore half of the lossless transfer pair.
 *
 * The button sits with the sidebar's create doors. It reads a `.json`
 * export (or a raw data/chats record), POSTs it to /api/chats/import, and
 * navigates to the restored session. An existing id is a two-step replace:
 * the server refuses it first, and this component asks before retrying with
 * the explicit replace flag.
 */
import { useRef, useState } from "react";
import { UploadIcon } from "lucide-react";
import { MAX_SESSION_IMPORT_BYTES } from "@/src/core";

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

export function SessionImportButton({ onImported }: { onImported: (id: string) => void }) {
	const inputRef = useRef<HTMLInputElement>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState<{ text: string; id: string; title: string } | null>(null);

	async function send(text: string, replace: boolean) {
		setBusy(true);
		setError(null);
		const outcome = await importSessionText(text, { replace });
		setBusy(false);
		if (outcome.ok) {
			setPending(null);
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

	async function choose(event: React.ChangeEvent<HTMLInputElement>) {
		const file = event.target.files?.[0];
		event.target.value = ""; // allow re-picking the same file
		if (!file) return;
		if (file.size > MAX_SESSION_IMPORT_BYTES) {
			setError("The session file is too large.");
			return;
		}
		try {
			await send(await file.text(), false);
		} catch {
			setError("Could not read the session file.");
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
				accept=".json,application/json"
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
		</div>
	);
}
