"use client";

/**
 * The Local engine settings section (local-engine wave): an
 * OpenAI-compatible server configured by base URL + one model entry.
 * Deliberately non-secret: the optional API key lives in auth.json under
 * LOCAL_LLM_API_KEY and is managed through /api/keys (the same seam the
 * Providers section uses). The model appears in the ordinary model picker
 * after save; assign it to Strong/Cheap/Vision there.
 */
import { useEffect, useState } from "react";
import {
	DEFAULT_LOCAL_BASE_URL,
	DEFAULT_LOCAL_CONTEXT_WINDOW,
	DEFAULT_LOCAL_MAX_TOKENS,
	isLocalBaseUrl,
	type AuthKeyStatus,
	type LocalEngineSettings,
} from "@/src/core";
import { Button } from "@/components/ui/button";
import { notifySettingsSaved } from "@/components/settings-signal";
import { SettingsGroup, SettingsRow, Toggle } from "./controls.tsx";

interface LocalModelInfo {
	id: string;
	name?: string;
}

interface SaveResult {
	ok: boolean;
	error?: string;
}

const INPUT_CLASS =
	"h-7 w-72 rounded-sm border border-border bg-background px-2 font-ui text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50";

function messageOf(body: unknown, fallback: string): string {
	return body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
		? (body as { error: string }).error
		: fallback;
}

export function LocalEngineSection({
	local,
	onSave,
}: {
	local: LocalEngineSettings | undefined;
	onSave: (next: LocalEngineSettings) => Promise<SaveResult>;
}) {
	const [enabled, setEnabled] = useState(local?.enabled ?? false);
	const [baseUrl, setBaseUrl] = useState(local?.baseUrl ?? DEFAULT_LOCAL_BASE_URL);
	const [modelId, setModelId] = useState(local?.model?.id ?? "");
	const [modelName, setModelName] = useState(local?.model?.name ?? "");
	const [contextWindow, setContextWindow] = useState(String(local?.model?.contextWindow ?? DEFAULT_LOCAL_CONTEXT_WINDOW));
	const [maxTokens, setMaxTokens] = useState(String(local?.model?.maxTokens ?? DEFAULT_LOCAL_MAX_TOKENS));
	const [vision, setVision] = useState(local?.model?.vision ?? false);
	const [reasoning, setReasoning] = useState(local?.model?.reasoning ?? false);
	const [keyStatus, setKeyStatus] = useState<AuthKeyStatus | null>(null);
	const [keyDraft, setKeyDraft] = useState("");
	const [keyBusy, setKeyBusy] = useState(false);
	const [keyMessage, setKeyMessage] = useState<string | null>(null);
	const [models, setModels] = useState<LocalModelInfo[] | null>(null);
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	// Follow the persisted record after a save or an external write. Draft
	// fields are initialized from it; the user's unsaved edits are only
	// replaced when the section receives a new stored record.
	useEffect(() => {
		setEnabled(local?.enabled ?? false);
		setBaseUrl(local?.baseUrl ?? DEFAULT_LOCAL_BASE_URL);
		setModelId(local?.model?.id ?? "");
		setModelName(local?.model?.name ?? "");
		setContextWindow(String(local?.model?.contextWindow ?? DEFAULT_LOCAL_CONTEXT_WINDOW));
		setMaxTokens(String(local?.model?.maxTokens ?? DEFAULT_LOCAL_MAX_TOKENS));
		setVision(local?.model?.vision ?? false);
		setReasoning(local?.model?.reasoning ?? false);
	}, [local]);

	const readKey = () => {
		fetch("/api/keys")
			.then((r) => (r.ok ? r.json() : null))
			.then((body: { keys?: AuthKeyStatus[] } | null) => {
				setKeyStatus(body?.keys?.find((k) => k.id === "LOCAL_LLM_API_KEY") ?? null);
			})
			.catch(() => setKeyStatus(null));
	};

	useEffect(() => {
		readKey();
	}, []);

	async function saveKey() {
		if (!keyDraft.trim() || keyBusy) return;
		setKeyBusy(true);
		setKeyMessage(null);
		try {
			const res = await fetch("/api/keys/LOCAL_LLM_API_KEY", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ value: keyDraft }),
			});
			if (!res.ok) {
				setKeyMessage(messageOf(await res.json().catch(() => null), `Save failed (${res.status})`));
				return;
			}
			setKeyDraft("");
			setKeyMessage("Key saved.");
			readKey();
			notifySettingsSaved("keys");
		} catch {
			setKeyMessage("Could not reach the server.");
		} finally {
			setKeyBusy(false);
		}
	}

	async function deleteKey() {
		setKeyBusy(true);
		setKeyMessage(null);
		try {
			await fetch("/api/keys/LOCAL_LLM_API_KEY", { method: "DELETE" });
			setKeyMessage("Key removed.");
			readKey();
			notifySettingsSaved("keys");
		} catch {
			setKeyMessage("Could not reach the server.");
		} finally {
			setKeyBusy(false);
		}
	}

	async function fetchModels() {
		setError(null);
		setStatus(null);
		setModels(null);
		if (!isLocalBaseUrl(baseUrl.trim())) {
			setError("Base URL must be an http(s) URL with no credentials, query, or fragment.");
			return;
		}
		try {
			const res = await fetch("/api/local/models", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ baseUrl: baseUrl.trim() }),
			});
			const body = (await res.json().catch(() => null)) as { models?: LocalModelInfo[]; error?: string } | null;
			if (!res.ok) {
				setError(messageOf(body, `Test failed (${res.status})`));
				return;
			}
			const list = body?.models ?? [];
			setModels(list);
			setStatus(list.length > 0 ? `Found ${list.length} model${list.length === 1 ? "" : "s"}.` : "Server reachable, but it listed no models.");
			if (!modelId && list[0]) setModelId(list[0].id);
			if (!modelName && list[0]?.name) setModelName(list[0].name);
		} catch {
			setError("Could not reach the local engine.");
		}
	}

	async function save() {
		setError(null);
		setStatus(null);
		const url = baseUrl.trim().replace(/\/+$/, "");
		if (!isLocalBaseUrl(url)) {
			setError("Base URL must be an http(s) URL with no credentials, query, or fragment.");
			return;
		}
		if (enabled && !modelId.trim()) {
			setError("A model ID is required when the local engine is enabled.");
			return;
		}
		const context = Number(contextWindow);
		const max = Number(maxTokens);
		if (!Number.isInteger(context) || context < 1_024 || context > 2_000_000) {
			setError("Context window must be an integer between 1024 and 2000000.");
			return;
		}
		if (!Number.isInteger(max) || max < 256 || max > 1_000_000) {
			setError("Max output tokens must be an integer between 256 and 1000000.");
			return;
		}
		setBusy(true);
		try {
			const result = await onSave({
				enabled,
				baseUrl: url,
				...(modelId.trim()
					? {
							model: {
								id: modelId.trim(),
								...(modelName.trim() ? { name: modelName.trim() } : {}),
								contextWindow: context,
								maxTokens: max,
								vision,
								reasoning,
							},
						}
					: {}),
			});
			if (!result.ok) {
				setError(result.error ?? "Save failed.");
				return;
			}
			setStatus("Saved. The model is available in the model picker — assign it to Strong, Cheap, or Vision there.");
		} catch {
			setError("Could not reach the server.");
		} finally {
			setBusy(false);
		}
	}

	const nonLoopback = (() => {
		try {
			const host = new URL(baseUrl).hostname;
			return host !== "127.0.0.1" && host !== "localhost" && host !== "::1";
		} catch {
			return false;
		}
	})();

	return (
		<>
			<SettingsGroup label="Connection" testid="group-local-connection">
				<SettingsRow
					label="Enable local engine"
					hint="Off by default. The model becomes selectable only after saving."
					testid="row-local-enabled"
				>
					<Toggle checked={enabled} onChange={setEnabled} label="local engine" />
				</SettingsRow>
				<SettingsRow
					label="Base URL"
					hint="OpenAI-compatible root, usually http://127.0.0.1:8080/v1"
					testid="row-local-base-url"
				>
					<input
						value={baseUrl}
						onChange={(e) => setBaseUrl(e.target.value)}
						aria-label="Local engine base URL"
						data-testid="local-base-url"
						placeholder={DEFAULT_LOCAL_BASE_URL}
						className={INPUT_CLASS}
					/>
				</SettingsRow>
				<SettingsRow
					label="API key"
					hint="Optional; keyless loopback servers work without one."
					testid="row-local-key"
				>
					<div className="flex items-center gap-2">
						<span className="max-w-40 truncate font-ui text-xs text-muted-foreground" data-testid="local-key-status">
							{keyStatus?.present ? keyStatus.masked : "not set"}
						</span>
						<input
							type="password"
							value={keyDraft}
							onChange={(e) => setKeyDraft(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") void saveKey();
							}}
							aria-label="Local engine API key"
							data-testid="local-key-input"
							placeholder="Paste key…"
							autoComplete="new-password"
							className="h-7 w-44 rounded-sm border border-border bg-background px-2 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60"
						/>
						<Button size="xs" variant="outline" disabled={keyBusy || !keyDraft.trim()} onClick={() => void saveKey()}>
							Save
						</Button>
						{keyStatus?.present && (
							<Button size="xs" variant="ghost" disabled={keyBusy} onClick={() => void deleteKey()}>
								Remove
							</Button>
						)}
					</div>
				</SettingsRow>
				{keyMessage && <p className="text-xs text-muted-foreground">{keyMessage}</p>}
				{nonLoopback && (
					<p className="text-xs text-amber-500" data-testid="local-remote-warning">
						This base URL is not loopback: prompts and lesson content leave this machine, possibly unencrypted.
					</p>
				)}
			</SettingsGroup>

			<SettingsGroup label="Model" testid="group-local-model">
				<SettingsRow
					label="Model ID"
					hint="The exact id the server expects (strata connect / GET /v1/models)."
					testid="row-local-model-id"
				>
					<input
						value={modelId}
						onChange={(e) => setModelId(e.target.value)}
						aria-label="Local model ID"
						data-testid="local-model-id"
						placeholder="e.g. qwen3.8-flash-next"
						className={INPUT_CLASS}
					/>
				</SettingsRow>
				<SettingsRow label="Display name" hint="Optional; defaults to the model id." testid="row-local-model-name">
					<input
						value={modelName}
						onChange={(e) => setModelName(e.target.value)}
						aria-label="Local model display name"
						data-testid="local-model-name"
						placeholder="My local model"
						className={INPUT_CLASS}
					/>
				</SettingsRow>
				<SettingsRow label="Context window" hint="Tokens; match the server's --context." testid="row-local-context">
					<input
						type="number"
						min={1024}
						max={2_000_000}
						step={1024}
						value={contextWindow}
						onChange={(e) => setContextWindow(e.target.value)}
						aria-label="Local model context window"
						data-testid="local-context-window"
						className="h-7 w-32 rounded-sm border border-border bg-background px-2 font-ui text-xs text-foreground outline-none"
					/>
				</SettingsRow>
				<SettingsRow label="Max output tokens" hint="Per model call." testid="row-local-max-tokens">
					<input
						type="number"
						min={256}
						max={1_000_000}
						step={256}
						value={maxTokens}
						onChange={(e) => setMaxTokens(e.target.value)}
						aria-label="Local model max output tokens"
						data-testid="local-max-tokens"
						className="h-7 w-32 rounded-sm border border-border bg-background px-2 font-ui text-xs text-foreground outline-none"
					/>
				</SettingsRow>
				<SettingsRow
					label="Vision"
					hint="Enable only if the server accepts image input; required for Visual/PDF slots."
					testid="row-local-vision"
				>
					<Toggle checked={vision} onChange={setVision} label="local vision" />
				</SettingsRow>
				<SettingsRow
					label="Reasoning"
					hint="Leave off unless the server/model supports a thinking control."
					testid="row-local-reasoning"
				>
					<Toggle checked={reasoning} onChange={setReasoning} label="local reasoning" />
				</SettingsRow>
			</SettingsGroup>

			<div className="flex flex-wrap items-center gap-2">
				<Button size="sm" variant="outline" disabled={busy} onClick={() => void fetchModels()}>
					Test / fetch models
				</Button>
				<Button size="sm" disabled={busy} onClick={() => void save()}>
					{busy ? "Saving…" : "Save local engine"}
				</Button>
				{models && models.length > 0 && (
					<select
						aria-label="Detected local models"
						data-testid="local-detected-models"
						value={models.some((m) => m.id === modelId) ? modelId : ""}
						onChange={(e) => {
							const picked = models.find((m) => m.id === e.target.value);
							if (picked) {
								setModelId(picked.id);
								if (picked.name) setModelName(picked.name);
							}
						}}
						className="h-7 max-w-72 rounded-sm border border-border bg-background px-1.5 font-ui text-xs text-foreground outline-none"
					>
						<option value="">Pick a detected model…</option>
						{models.map((m) => (
							<option key={m.id} value={m.id}>
								{m.name ? `${m.name} (${m.id})` : m.id}
							</option>
						))}
					</select>
				)}
			</div>
			{error && (
				<p className="text-xs text-red-400" role="alert" data-testid="local-error">
					{error}
				</p>
			)}
			{status && (
				<p className="text-xs text-muted-foreground" data-testid="local-status">
					{status}
				</p>
			)}
			<p className="text-xs text-muted-foreground/70">
				The local model appears in the ordinary model picker after saving. Assign it to Strong and Cheap;
				assign it to Vision only when the Vision checkbox is on. Lower Settings → Agent → Compaction below the
				context window for long sessions.
			</p>
		</>
	);
}
