"use client";

/**
 * Settings → Server (multi-user wave, 2026-11-03): the headless port/host.
 * The launcher reads data/server.json before Next starts, so changes take
 * effect on the next server restart.
 */
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ServerConfigView } from "@/src/core";

export function ServerSection() {
	const [view, setView] = useState<ServerConfigView | null>(null);
	const [port, setPort] = useState("");
	const [host, setHost] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);
	const [busy, setBusy] = useState(false);

	const load = useCallback(async () => {
		try {
			const response = await fetch("/api/server", { cache: "no-store" });
			const body = await response.json().catch(() => ({})) as { server?: ServerConfigView; error?: string };
			if (!response.ok || !body.server) throw new Error(body.error ?? "Could not load the server configuration.");
			setView(body.server);
			setPort(String(body.server.port));
			setHost(body.server.host);
			setError(null);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not load the server configuration.");
		}
	}, []);

	useEffect(() => { void load(); }, [load]);

	const save = async () => {
		setBusy(true);
		setError(null);
		setSaved(false);
		try {
			const response = await fetch("/api/server", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ port: Number(port), host: host.trim() }),
			});
			const body = await response.json().catch(() => ({})) as { server?: ServerConfigView; error?: string };
			if (!response.ok || !body.server) throw new Error(body.error ?? "Could not save.");
			setView(body.server);
			setPort(String(body.server.port));
			setHost(body.server.host);
			setSaved(true);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not save.");
		} finally {
			setBusy(false);
		}
	};

	return <div className="space-y-4" data-testid="server-section">
		<div className="grid max-w-md grid-cols-[1fr_2fr] gap-2">
			<label className="space-y-1 text-xs text-muted-foreground">
				<span>Port</span>
				<Input value={port} inputMode="numeric" onChange={(event) => setPort(event.target.value)} data-testid="server-port" />
			</label>
			<label className="space-y-1 text-xs text-muted-foreground">
				<span>Bind address</span>
				<Input value={host} onChange={(event) => setHost(event.target.value)} data-testid="server-host" />
			</label>
		</div>
		<div className="flex items-center gap-3">
			<Button type="button" size="sm" disabled={busy} onClick={() => void save()} data-testid="server-save">Save</Button>
			{saved && <span className="text-xs text-muted-foreground" data-testid="server-saved">Saved.</span>}
		</div>
		{view && (
			<div className="space-y-1 text-xs leading-relaxed text-muted-foreground">
				<p>
					Configured: <code className="font-mono">{view.host}:{view.port}</code>
					{view.runningPort !== null && <> · running: <code className="font-mono">{view.runningHost ?? "?"}:{view.runningPort}</code></>}
				</p>
				{view.restartRequired && <p className="text-amber-400" data-testid="server-restart">Restart the headless server to use the configured port.</p>}
			</div>
		)}
		<p className="text-[11px] leading-relaxed text-muted-foreground">
			The headless launcher (<code className="font-mono">npm run server</code>) reads this file before Next starts.
			Changes apply on restart. The default bind address is <code className="font-mono">0.0.0.0</code>; use
			<code className="mx-1 font-mono">127.0.0.1</code> for a local-only server.
		</p>
		{error && <p role="alert" className="text-xs text-destructive" data-testid="server-error">{error}</p>}
	</div>;
}
