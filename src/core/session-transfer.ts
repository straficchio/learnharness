/**
 * Session transfer — the lossless session export/import format.
 *
 * The Markdown export is for humans. This format is for moving a session
 * between LearnHarness installations: it carries the full ChatRecord (native
 * messages, plan tree, per-session settings, usage logs, kind, schema stamp)
 * and nothing derived. The wrapper names the format/version so a future
 * change can be refused honestly instead of misread.
 *
 * Pure and browser-safe: the route reads/writes the files, the client only
 * needs the size constant and the filename helper.
 */
import { CURRENT_CHAT_VERSION, type ChatRecord, type ChatSettings, type ExtractionRunUsage, type TurnUsage } from "./contracts/chat.ts";
import type { PlanTree } from "./contracts/plan.ts";
import type { LhMessage } from "./native-messages.ts";

/** The on-disk export format. Bump only with a migration path. */
export const SESSION_EXPORT_FORMAT = "learnharness.session";
export const SESSION_EXPORT_VERSION = 1;

/** A single session blob is small (one transcript); 25 MiB leaves ample room
 *  for large artifacts without turning the import endpoint into an upload
 *  sink. */
export const MAX_SESSION_IMPORT_BYTES = 25 * 1024 * 1024;

/** Bulk transfer bounds: the sidebar caps a selection at 500, a ZIP upload
 *  at 100 MiB compressed with 500 JSON entries, and decompression at 250 MiB
 *  total. */
export const MAX_BULK_EXPORT_SESSIONS = 500;
export const MAX_BULK_IMPORT_BYTES = 100 * 1024 * 1024;
export const MAX_BULK_IMPORT_ENTRIES = 500;
export const MAX_BULK_IMPORT_UNCOMPRESSED_BYTES = 250 * 1024 * 1024;

export function bulkSessionExportFilename(date = new Date()): string {
	return `learnharness-sessions-${date.toISOString().slice(0, 10)}.zip`;
}

export interface SessionExportFile {
	format: typeof SESSION_EXPORT_FORMAT;
	version: typeof SESSION_EXPORT_VERSION;
	exportedAt: string;
	session: ChatRecord;
}

export type SessionImportParse =
	| { ok: true; session: ChatRecord }
	| { ok: false; error: string };

const MESSAGE_ROLES = new Set(["user", "assistant", "toolResult", "custom"]);
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown, max = 200): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max;
}

function fail(error: string): SessionImportParse {
	return { ok: false, error };
}

/** A readable, filesystem-safe slug for the download name. */
export function sessionSlug(title: string): string {
	const slug = title
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug.length > 0 ? slug : "session";
}

export function sessionExportFilename(record: Pick<ChatRecord, "id" | "title">): string {
	return `session-${sessionSlug(record.title)}-${record.id}.json`;
}

export function buildSessionExport(record: ChatRecord, exportedAt = new Date().toISOString()): SessionExportFile {
	return {
		format: SESSION_EXPORT_FORMAT,
		version: SESSION_EXPORT_VERSION,
		exportedAt,
		session: record,
	};
}

function parseSettings(value: unknown): ChatSettings | undefined | false {
	if (value === undefined) return undefined;
	if (!isRecord(value)) return false;
	const settings: ChatSettings = {};
	if (value.model !== undefined) {
		if (!isRecord(value.model) || !isNonEmptyString(value.model.provider) || !isNonEmptyString(value.model.id)) return false;
		settings.model = { provider: value.model.provider, id: value.model.id };
	}
	if (value.thinkingLevel !== undefined) {
		if (typeof value.thinkingLevel !== "string" || !THINKING_LEVELS.has(value.thinkingLevel)) return false;
		settings.thinkingLevel = value.thinkingLevel as ChatSettings["thinkingLevel"];
	}
	return settings;
}

function parseTree(value: unknown): PlanTree | undefined | false {
	if (value === undefined) return undefined;
	if (!isRecord(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges) || typeof value.version !== "number") return false;
	const nodes = value.nodes.map((node) => {
		if (!isRecord(node) || !isNonEmptyString(node.id) || !isNonEmptyString(node.title, 500)) return null;
		return typeof node.summary === "string" ? { id: node.id, title: node.title, summary: node.summary } : { id: node.id, title: node.title };
	});
	const edges = value.edges.map((edge) => {
		if (!isRecord(edge) || !isNonEmptyString(edge.from) || !isNonEmptyString(edge.to)) return null;
		return { from: edge.from, to: edge.to };
	});
	if (nodes.some((node) => node === null) || edges.some((edge) => edge === null)) return false;
	return { nodes: nodes as PlanTree["nodes"], edges: edges as PlanTree["edges"], version: value.version };
}

function parseTurns(value: unknown): TurnUsage[] | undefined | false {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) return false;
	for (const turn of value) {
		if (
			!isRecord(turn) ||
			!isNonEmptyString(turn.id) ||
			!isNonEmptyString(turn.messageId) ||
			typeof turn.at !== "string" ||
			!isNonEmptyString(turn.model) ||
			!Array.isArray(turn.steps) ||
			turn.steps.some((step) => !isRecord(step))
		) {
			return false;
		}
	}
	return value as TurnUsage[];
}

function parseExtractions(value: unknown): ExtractionRunUsage[] | undefined | false {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) return false;
	for (const run of value) {
		if (!isRecord(run) || typeof run.startedAt !== "number" || typeof run.at !== "string" || typeof run.durationMs !== "number" || !isRecord(run.stages)) return false;
		for (const stageName of ["extractor", "auditor"] as const) {
			const stage = run.stages[stageName];
			if (!isRecord(stage) || !isNonEmptyString(stage.model) || !Array.isArray(stage.steps) || stage.steps.some((step) => !isRecord(step))) return false;
		}
	}
	return value as ExtractionRunUsage[];
}

/** Parse either the export wrapper or a raw `data/chats/<id>.json` record.
 *  Unknown fields are dropped; the known ChatRecord fields are preserved. */
export function parseSessionExport(value: unknown): SessionImportParse {
	if (!isRecord(value)) return fail("The file is not a JSON object.");

	const wrapped = isRecord(value.session);
	if (wrapped) {
		if (value.format !== undefined && value.format !== SESSION_EXPORT_FORMAT) {
			return fail("This is not a LearnHarness session export.");
		}
		if (value.version !== undefined && value.version !== SESSION_EXPORT_VERSION) {
			return fail("This session uses a newer export format than this app understands.");
		}
	} else if (value.format !== undefined) {
		return fail("The export file is missing its session record.");
	}

	const raw = wrapped ? value.session : value;
	if (!isRecord(raw)) return fail("The export file has no session record.");

	if (!isNonEmptyString(raw.id) || !/^[A-Za-z0-9_-]+$/.test(raw.id)) {
		return fail("The session id is missing or invalid.");
	}
	if (typeof raw.title !== "string") return fail("The session title is missing.");
	const title = raw.title.trim().slice(0, 500) || "Imported session";

	const version = raw.version;
	if (version !== undefined) {
		if (typeof version !== "number" || !Number.isInteger(version) || version > CURRENT_CHAT_VERSION) {
			return fail("This session was created by a newer LearnHarness version.");
		}
	}

	if (!Array.isArray(raw.messages)) return fail("The session has no messages array.");
	if (raw.messages.length > 100_000) return fail("The session has too many messages.");
	for (let i = 0; i < raw.messages.length; i++) {
		const message = raw.messages[i];
		if (!isRecord(message) || !isNonEmptyString((message as { id?: unknown }).id)) {
			return fail(`Message ${i + 1} is missing its id.`);
		}
		const role = (message as { role?: unknown }).role;
		if (typeof role !== "string" || !MESSAGE_ROLES.has(role)) {
			return fail(`Message ${i + 1} has an unsupported role.`);
		}
	}

	if (raw.kind !== undefined && raw.kind !== "teach" && raw.kind !== "practice") {
		return fail("The session kind is invalid.");
	}

	const settings = parseSettings(raw.settings);
	if (settings === false) return fail("The session settings are invalid.");
	const tree = parseTree(raw.tree);
	if (tree === false) return fail("The session plan tree is invalid.");
	const turns = parseTurns(raw.turns);
	if (turns === false) return fail("The session usage log is invalid.");
	const extractions = parseExtractions(raw.extractions);
	if (extractions === false) return fail("The session extraction log is invalid.");

	const now = new Date().toISOString();
	const createdAt = typeof raw.createdAt === "string" ? raw.createdAt : now;
	const updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : createdAt;

	return {
		ok: true,
		session: {
			id: raw.id,
			title,
			createdAt,
			updatedAt,
			messages: raw.messages as LhMessage[],
			...(raw.kind === "teach" || raw.kind === "practice" ? { kind: raw.kind } : {}),
			...(settings !== undefined ? { settings } : {}),
			...(tree !== undefined ? { tree } : {}),
			...(turns !== undefined ? { turns } : {}),
			...(extractions !== undefined ? { extractions } : {}),
			...(version !== undefined ? { version } : {}),
		},
	};
}
