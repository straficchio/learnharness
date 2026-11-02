"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { notifySettingsSaved } from "@/components/settings-signal";

type TraceEntry = { t?: number; kind?: string; [key: string]: unknown };
type TraceResponse = { enabled: boolean; events: TraceEntry[]; total: number };
type TraceTurn = { request?: TraceEntry; cliRequest?: TraceEntry; response?: TraceEntry; events: TraceEntry[] };

function groupTurns(events: TraceEntry[]): TraceTurn[] {
	const turns: TraceTurn[] = [];
	for (const event of events) {
		if (event.kind === "request") {
			turns.push({ request: event, events: [event] });
			continue;
		}
		const current = turns.at(-1);
		if (!current) {
			turns.push({ events: [event] });
			continue;
		}
		if (event.kind === "cli-request" && !current.cliRequest) current.cliRequest = event;
		else if (event.kind === "response") current.response = event;
		current.events.push(event);
	}
	return turns;
}

function textOf(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((block) => block && typeof block === "object" && (block as { type?: string }).type === "text"
		? [String((block as { text?: unknown }).text ?? "")]
		: []).join("");
}

function JsonBlock({ label, value, testid }: { label: string; value: unknown; testid?: string }) {
	return <details data-testid={testid} className="rounded-md border border-border/70 bg-background/60">
		<summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</summary>
		<pre className="max-h-72 overflow-auto border-t border-border/60 p-3 font-mono text-[11px] leading-relaxed text-card-foreground">{JSON.stringify(value, null, 2)}</pre>
	</details>;
}

function RequestPane({ turn }: { turn: TraceTurn | undefined }) {
	if (!turn?.request && !turn?.cliRequest) {
		return <p className="text-xs text-muted-foreground">No request recorded for this turn.</p>;
	}
	const request = turn.request;
	return <div className="space-y-2" data-testid="model-trace-request">
		{request && <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
			<span className="font-mono text-card-foreground">{String(request.provider ?? "")}:{String(request.model ?? "")}</span>
			{typeof request.reasoning === "string" && <span>· effort {request.reasoning}</span>}
		</div>}
		{request && <JsonBlock label="System prompt" value={request.systemPrompt ?? ""} />}
		{request && <JsonBlock label={`Tools (${Array.isArray(request.tools) ? request.tools.length : 0})`} value={request.tools ?? []} />}
		{request && <JsonBlock label={`Messages (${Array.isArray(request.messages) ? request.messages.length : 0})`} value={request.messages ?? []} />}
		{request && <JsonBlock label="Options" value={request.options ?? {}} />}
		{turn.cliRequest && <>
			<div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">CLI input</div>
			<JsonBlock label="Arguments" value={turn.cliRequest.args ?? []} />
			<JsonBlock label="CLI system prompt" value={turn.cliRequest.systemPrompt ?? ""} />
			<JsonBlock label="CLI tools" value={turn.cliRequest.tools ?? []} />
			<JsonBlock label="CLI user content" value={turn.cliRequest.userContent ?? ""} />
		</>}
	</div>;
}

function ResponsePane({ turn }: { turn: TraceTurn | undefined }) {
	const response = turn?.response;
	const message = response?.message;
	if (!message) {
		const error = turn?.events.find((event) => event.kind === "error");
		return <p className="text-xs text-muted-foreground">{error ? "The turn ended with an error." : "Waiting for the model response…"}</p>;
	}
	const content = (message as { content?: unknown }).content;
	const usage = (message as { usage?: unknown }).usage;
	const stopReason = (message as { stopReason?: unknown }).stopReason;
	const errorMessage = (message as { errorMessage?: unknown }).errorMessage;
	return <div className="space-y-2" data-testid="model-trace-response">
		<div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
			<span>stop: <span className="font-mono text-card-foreground">{String(stopReason ?? "—")}</span></span>
			{typeof errorMessage === "string" && <span className="text-red-400">{errorMessage}</span>}
		</div>
		<pre className="whitespace-pre-wrap rounded-md border border-border/70 bg-background/60 p-3 font-prose text-sm leading-relaxed text-card-foreground">{textOf(message) || "(no text content)"}</pre>
		<JsonBlock label="Content blocks" value={content ?? []} />
		<JsonBlock label="Usage" value={usage ?? {}} />
	</div>;
}

export function ModelTraceDrawer({
	chatId,
	title,
	open,
	onClose,
}: {
	chatId: string;
	title: string;
	open: boolean;
	onClose: () => void;
}) {
	const [events, setEvents] = useState<TraceEntry[]>([]);
	const [total, setTotal] = useState(0);
	const [enabled, setEnabled] = useState(false);
	const [selected, setSelected] = useState<number | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const totalRef = useRef(0);
	const requestSeq = useRef(0);
	const inFlight = useRef<Set<AbortController>>(new Set());

	const abortAll = useCallback(() => {
		for (const controller of inFlight.current) controller.abort();
		inFlight.current.clear();
	}, []);

	const load = useCallback(async (reset: boolean) => {
		const seq = ++requestSeq.current;
		const after = reset ? 0 : totalRef.current;
		if (reset) abortAll();
		const controller = new AbortController();
		inFlight.current.add(controller);
		try {
			const response = await fetch(`/api/model-trace?session=${encodeURIComponent(chatId)}&after=${after}`, { cache: "no-store", signal: controller.signal });
			if (!response.ok) throw new Error("trace unavailable");
			const body = await response.json() as TraceResponse;
			// A newer poll owns the view; never append an older response.
			if (seq !== requestSeq.current) return;
			setEnabled(body.enabled === true);
			if (reset || body.total < after) {
				setEvents(body.events);
			} else if (body.events.length > 0) {
				setEvents((previous) => [...previous, ...body.events]);
			}
			totalRef.current = body.total;
			setTotal(body.total);
			setError(null);
		} catch {
			if (!controller.signal.aborted) setError("Could not read the model trace.");
		} finally {
			inFlight.current.delete(controller);
		}
	}, [abortAll, chatId]);

	useEffect(() => {
		if (!open) {
			requestSeq.current++;
			abortAll();
			return;
		}
		void load(true);
		const interval = setInterval(() => { void load(false); }, 1000);
		return () => {
			requestSeq.current++;
			clearInterval(interval);
			abortAll();
		};
	}, [open, load, abortAll]);

	useEffect(() => {
		setSelected(null);
		setEvents([]);
		totalRef.current = 0;
		setTotal(0);
	}, [chatId]);

	const turns = useMemo(() => groupTurns(events), [events]);
	const activeTurn = selected === null ? turns.at(-1) : turns[selected];
	const rawEvents = activeTurn?.events ?? [];

	const toggle = async () => {
		setBusy(true);
		try {
			const response = await fetch("/api/settings/developer", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ modelTrace: !enabled }),
			});
			if (!response.ok) throw new Error("settings write failed");
			const body = await response.json() as { settings?: { developer?: { modelTrace?: boolean } } };
			const next = body.settings?.developer?.modelTrace === true;
			setEnabled(next);
			notifySettingsSaved("developer");
			if (next) void load(true);
		} catch {
			setError("Could not update the model-trace setting.");
		} finally {
			setBusy(false);
		}
	};

	const clear = async () => {
		setBusy(true);
		try {
			const response = await fetch(`/api/model-trace?session=${encodeURIComponent(chatId)}`, { method: "DELETE" });
			if (!response.ok) throw new Error("clear failed");
			setEvents([]);
			setTotal(0);
			totalRef.current = 0;
			setSelected(null);
		} catch {
			setError("Could not clear the model trace.");
		} finally {
			setBusy(false);
		}
	};

	if (!open) return null;

	return <aside
		role="complementary"
		aria-label="Model trace"
		data-testid="model-trace-drawer"
		className="absolute inset-y-0 right-0 z-40 flex w-[min(720px,calc(100%-1rem))] flex-col border-l border-border bg-background shadow-2xl"
	>
		<header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
			<div className="min-w-0 flex-1">
				<div className="text-xs uppercase tracking-widest text-muted-foreground">Model trace</div>
				<div className="truncate font-prose text-sm text-foreground">{title}</div>
			</div>
			<button type="button" data-testid="model-trace-close" onClick={onClose} className="cursor-pointer rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">Close</button>
		</header>
		<div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-4 py-2">
			<button
				type="button"
				role="switch"
				aria-checked={enabled}
				aria-label="Model trace"
				data-testid="model-trace-toggle"
				disabled={busy}
				onClick={() => void toggle()}
				className={`relative h-5 w-9 cursor-pointer rounded-full transition-colors disabled:cursor-not-allowed ${enabled ? "bg-primary" : "bg-border"}`}
			>
				<span className={`absolute top-0.5 size-4 rounded-full bg-background transition-transform ${enabled ? "translate-x-4" : "translate-x-0.5"}`} />
			</button>
			<span role="status" className="text-xs text-muted-foreground">{enabled ? "Recording" : "Off — enable to record new calls"}</span>
			{turns.length > 1 && <select
				aria-label="Trace turn"
				className="cursor-pointer rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
				value={selected ?? turns.length - 1}
				onChange={(event) => setSelected(Number(event.target.value))}
			>
				{turns.map((_, index) => <option key={index} value={index}>Turn {index + 1}{index === turns.length - 1 ? " (latest)" : ""}</option>)}
			</select>}
			<div className="ml-auto flex items-center gap-2">
				<span className="text-[11px] tabular-nums text-muted-foreground">{total} lines</span>
				<Button type="button" size="xs" variant="outline" disabled={busy || events.length === 0} onClick={() => void clear()} data-testid="model-trace-clear">Clear</Button>
			</div>
		</div>
		{error && <p role="alert" className="border-b border-red-500/30 px-4 py-2 text-xs text-red-400">{error}</p>}
		<div className="min-h-0 flex-1 overflow-y-auto p-4">
			{events.length === 0 ? <div className="rounded-lg border border-dashed border-border p-4 text-xs leading-relaxed text-muted-foreground">
				No trace yet. Enable <strong className="font-medium text-foreground">Model trace</strong>, then send a message. Traces are local, contain full prompts and responses, and can be cleared here.
			</div> : <div className="space-y-4">
				<section className="space-y-2">
					<div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Request</div>
					<RequestPane turn={activeTurn} />
				</section>
				<section className="space-y-2">
					<div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Response</div>
					<ResponsePane turn={activeTurn} />
				</section>
				<details className="rounded-md border border-border/70 bg-background/60" data-testid="model-trace-raw">
					<summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Raw events ({rawEvents.length})</summary>
					<pre className="max-h-80 overflow-auto border-t border-border/60 p-3 font-mono text-[11px] leading-relaxed text-card-foreground">{rawEvents.map((event) => JSON.stringify(event)).join("\n")}</pre>
				</details>
			</div>}
		</div>
	</aside>;
}
