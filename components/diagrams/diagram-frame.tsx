"use client";

/** Shared chrome for the SVG diagram fences (chart, WaveDrom, ...). The
 *  renderer owns the picture; this owns loading/error, source copy,
 *  download, and full-screen. Kept out of md-blocks to avoid a cycle:
 *  diagram blocks must not import the Markdown registry that imports them. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { CheckIcon, CopyIcon, DownloadIcon, MaximizeIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { downloadFile } from "@/components/artifacts/download";
import { Hint } from "@/components/ui/hint";

async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		/* fall through */
	}
	try {
		const area = document.createElement("textarea");
		area.value = text;
		area.setAttribute("readonly", "");
		area.style.position = "fixed";
		area.style.opacity = "0";
		document.body.appendChild(area);
		area.select();
		const ok = document.execCommand("copy");
		area.remove();
		return ok;
	} catch {
		return false;
	}
}

export function DiagramFrame({
	source,
	label,
	testId,
	className,
	children,
	error = null,
	busy = false,
	downloadName,
	downloadText,
	downloadMime = "image/svg+xml",
	fullscreen = true,
}: {
	source: string;
	label: string;
	testId: string;
	className?: string;
	children?: ReactNode;
	error?: string | null;
	busy?: boolean;
	downloadName?: string;
	downloadText?: string;
	downloadMime?: string;
	fullscreen?: boolean;
}) {
	const cardRef = useRef<HTMLDivElement>(null);
	const timerRef = useRef<number | undefined>(undefined);
	const [copied, setCopied] = useState(false);
	const [canFullscreen, setCanFullscreen] = useState(false);
	useEffect(() => {
		setCanFullscreen(typeof cardRef.current?.requestFullscreen === "function");
		return () => window.clearTimeout(timerRef.current);
	}, []);
	const copy = () => {
		void copyText(source).then((ok) => {
			if (!ok) return;
			setCopied(true);
			window.clearTimeout(timerRef.current);
			timerRef.current = window.setTimeout(() => setCopied(false), 1500);
		});
	};
	const download = () => {
		if (!downloadName || downloadText === undefined) return;
		downloadFile(downloadName, downloadText, downloadMime);
	};
	const expand = () => {
		if (!fullscreen || typeof cardRef.current?.requestFullscreen !== "function") return;
		void cardRef.current.requestFullscreen().catch(() => undefined);
	};
	return (
		<div
			ref={cardRef}
			data-testid={testId}
			data-diagram={label}
			className={cn("group/diagram relative my-4 rounded-lg border bg-card p-3", busy && "min-h-32", className)}
		>
			<div className="absolute top-1.5 right-1.5 z-10 flex items-start gap-0.5">
				<Hint label={`Copy ${label} source`} side="bottom">
					<button
						type="button"
						aria-label={`Copy ${label} source`}
						className="flex size-7 items-center justify-center rounded-md bg-card/80 text-muted-foreground/80 opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/diagram:opacity-100"
						onClick={copy}
					>
						{copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
					</button>
				</Hint>
				{downloadName && downloadText !== undefined && (
					<Hint label={`Download ${label}`} side="bottom">
						<button
							type="button"
							aria-label={`Download ${label}`}
							className="flex size-7 items-center justify-center rounded-md bg-card/80 text-muted-foreground/80 opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/diagram:opacity-100"
							onClick={download}
						>
							<DownloadIcon className="size-3.5" />
						</button>
					</Hint>
				)}
				{fullscreen && canFullscreen && (
					<Hint label="Open full-screen" side="bottom">
						<button
							type="button"
							aria-label={`Expand ${label}`}
							className="flex size-7 items-center justify-center rounded-md bg-card/80 text-muted-foreground/80 opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/diagram:opacity-100"
							onClick={expand}
						>
							<MaximizeIcon className="size-3.5" />
						</button>
					</Hint>
				)}
			</div>
			{error !== null ? (
				<div role="alert" className="p-2 text-sm text-destructive" data-testid={`${testId}-error`}>
					<p>{error}</p>
					<details className="mt-2 text-xs text-muted-foreground">
						<summary className="cursor-pointer">Show diagram source</summary>
						<pre className="mt-2 max-h-72 overflow-auto rounded bg-muted p-2 font-mono text-[11px] whitespace-pre-wrap">{source}</pre>
					</details>
				</div>
			) : (
				<>
					<div className={busy ? "invisible" : undefined}>{children}</div>
					{busy && (
						<div className="absolute inset-0 flex items-center justify-center" aria-busy="true">
							<span className="inline-block size-4 animate-spin rounded-full border border-current border-b-2 text-muted-foreground" />
						</div>
					)}
				</>
			)}
		</div>
	);
}
