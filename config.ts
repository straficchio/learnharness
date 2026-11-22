import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scopeRoot } from "./src/core/request-scope.ts";

/** Repository root (this file is at <root>/config.ts). */
export const ROOT = path.dirname(fileURLToPath(import.meta.url));

/**
 * THE data-location seam (the Electron contract, 2026-09-17): LH_DATA_DIR
 * relocates every MUTABLE record — chat sessions, graph ledgers, the
 * embedding model cache — when set. The desktop shell points it at
 * userData so nothing is written inside the read-only .app bundle
 * (macOS translocation guarantees the bundle is read-only anyway).
 * Unset (plain web dev / repo work) it resolves to the repo's data/,
 * byte-for-byte as before. Read-only assets (prompts) stay ROOT-anchored
 * on purpose: they ship inside the app bundle by design.
 *
 * MULTI-USER (2026-11-03): this is the BASE root. Admin (and standalone)
 * records live directly here; every non-admin server user gets
 * <base>/users/<id>/. PATHS below resolves the ACTIVE request's root through
 * the AsyncLocalStorage scope; BASE_DATA_ROOT always names the base.
 */
export const BASE_DATA_ROOT = process.env.LH_DATA_DIR
	? path.resolve(process.env.LH_DATA_DIR)
	: path.join(ROOT, "data");

/** The base root used by existing callers/tests; per-user paths use PATHS. */
const DATA_ROOT = BASE_DATA_ROOT;

export const PATHS = {
	root: ROOT,
	/** Teacher system prompt — the agent's instructions (src/agent/). */
	teacherPrompt: path.join(ROOT, "src", "agent", "system-prompt.md"),
	/** The ACTIVE user's data root (admin/standalone = BASE_DATA_ROOT). */
	get data(): string {
		return scopeRoot(BASE_DATA_ROOT);
	},
	/** Chat sessions (AI SDK UIMessage transcripts, one JSON file per chat). */
	get chats(): string {
		return path.join(scopeRoot(BASE_DATA_ROOT), "chats");
	},
	get graph(): string {
		return path.join(scopeRoot(BASE_DATA_ROOT), "graph");
	},
	/** Debug artifacts (env-gated): data/debug/provider-events/<chatId>.jsonl
	 * raw provider stream recordings (src/agent/provider-events.ts). */
	get debug(): string {
		return path.join(scopeRoot(BASE_DATA_ROOT), "debug");
	},
	/** App-managed document copies. Referenced by quoted path chips and read
	 *  through the ordinary file tools. */
	get attachments(): string {
		return path.join(scopeRoot(BASE_DATA_ROOT), "attachments");
	},
} as const;

/** The attachment root for an explicit user data root (the sweeper walks
 *  every user, not only the active request scope). */
export function attachmentsRootFor(root: string): string {
	return path.join(root, "attachments");
}

/** True only for the app-managed attachment subtree. This is the narrow
 *  exception to the file-tool data-root/credential guard — realpath is
 *  checked separately by resolveAllowedPath, so a symlink cannot escape. */
export function isAttachmentPath(candidate: string): boolean {
	const under = (target: string, root: string): boolean => {
		const normalizedTarget = process.platform === "win32" ? target.toLowerCase() : target;
		const normalizedRoot = process.platform === "win32" ? root.toLowerCase() : root;
		return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`);
	};
	const resolved = path.resolve(candidate);
	const root = path.resolve(PATHS.attachments);
	if (under(resolved, root)) return true;
	// macOS /var is a symlink to /private/var. A realpath'd copy must still be
	// recognized as an attachment path (the portable-export collector and the
	// file tools both check the realpath).
	try {
		return under(realpathSync.native(resolved), realpathSync.native(root));
	} catch {
		return false;
	}
}

/** The server-wide account registry (hashes live here, never in chat data). */
export const USERS_FILE = path.join(BASE_DATA_ROOT, "users.json");
/** Per-user record roots for non-admin accounts. */
export const USERS_DIR = path.join(BASE_DATA_ROOT, "users");
/** Headless server configuration (port, host, cookie-signing secret). */
export const SERVER_CONFIG_FILE = path.join(BASE_DATA_ROOT, "server.json");
/** Per-scope appearance files (admin/standalone at the base root). */
export const APPEARANCE_FILE_NAME = "appearance.json";

// ─── Models ────────────────────────────────────────────────────────────────
// BYOK ALL THE WAY DOWN (owner, 2026-09-22): there are NO factory default
// models. Every engine resolves from the user's model slots (settings.json
// models section: strong/cheap/vision) over per-role/ChatSettings overrides,
// and a chain that ends empty REFUSES honestly (503 models_not_configured).
// .env stays for secrets (API keys) only. What remains here are ENGINE
// CONSTRUCTION FACTS: the thinking-level scale and the default order.

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Every agent role in the app. The conversation pair (prober/teacher)
 *  resolves chat.model → strong slot; background roles resolve their own
 *  override → tier slot (core/settings-resolution.ts ROLE_SLOT). */
export type ModelRole =
	| "prober"
	| "teacher"
	| "researcher"
	| "demoBuilder"
	| "visualMaker"
	| "pdfReader"
	| "extractor"
	| "auditor";

/**
 * The LIVE graph store (src/store/graph.ts) — owned by the app's extraction
 * pipeline. Line shapes: src/core/contracts.ts. CHAINS ARE THE STORED
 * TRUTH (owner, 2026-09-30): edges are a derived view, never stored.
 */
export const LEDGER_FILES = {
	get nodes(): string { return path.join(PATHS.graph, "nodes.jsonl"); },
	get chains(): string { return path.join(PATHS.graph, "chains.jsonl"); },
	get sessions(): string { return path.join(PATHS.graph, "sessions.jsonl"); },
	/** Per-message extraction coverage (contracts/graph.ts CoverageEntry;
	 *  the checkpoint's replacement for chat extractions — notes keep
	 *  sessions.jsonl, whole-file as they are). */
	get coverage(): string { return path.join(PATHS.graph, "coverage.jsonl"); },
} as const;

/** A graph-family file in the ACTIVE user's scope. */
export function scopedGraphFile(name: string): string {
	return path.join(PATHS.graph, name);
}

/**
 * Notes-import bookkeeping (NOT a ledger): one JSON map, src-id → NotesSource
 * record (contracts/graph.ts) — the file path + import time + the run's usage
 * log. Read-modify-write like a chat file, not append-only like the ledgers.
 */
export const SOURCES_FILE = path.join(PATHS.graph, "sources.json");
/** Presentation-only source names/folder placement; never extraction identity. */
export const SOURCE_ORGANIZATION_FILE = path.join(PATHS.graph, "source-organization.json");
/** The layout ledger (read-modify-write like sources.json): nodeId →
 *  {x,y} resting positions from the incremental settle (core/layout.ts).
 *  Carries an updatedAt stamp for future live-physics conflict handling. */
export const POSITIONS_FILE = path.join(PATHS.graph, "positions.json");

/**
 * Graph render settings (the settings-panel controls): one small JSON blob,
 * read-modify-write. Shared shape/sanitizer: src/core/render-settings.ts.
 */
export const RENDER_SETTINGS_FILE = path.join(PATHS.graph, "render-settings.json");

/** The graph-family FORMAT STAMP sidecar (schema-versioning wave,
 *  2026-10-10): one version for the whole family — the four JSONL ledgers,
 *  sources.json, render-settings.json. LAZY v1: absent = v1; the first
 *  graph-family write creates it. positions.json is REBUILDABLE and rides
 *  along unversioned by design (owner ruling). */
export const GRAPH_FORMAT_FILE = path.join(PATHS.graph, "format.json");

/**
 * THE USER SETTINGS RECORD (settings-storage wave, 2026-09-19): one
 * versioned, DELTA-shaped JSON blob at the data-dir seam holding every
 * non-secret product preference — general, agent (background
 * model/thinking overrides + tool toggles + prompt-override switches),
 * appearance, graph. Explicit user choices only: ABSENT keys resolve to the
 * factory defaults compiled into src/core/settings.ts (FACTORY_SETTINGS), so
 * a software update that adds a knob (new tool, new role, new appearance
 * field) needs no migration — old records simply lack the new keys. The
 * version field is a PRIVATE schema counter for breaking shape changes
 * only (field renamed/meaning changed), unrelated to the app release
 * version. Secrets (API keys, login tokens) NEVER live here — auth.json /
 * .env.local keep that role. (The `chat` default-settings section died
 * with per-session models, owner 2026-09-28 — sessions own their model
 * from birth, stamped from the strong slot.)
 */
export const SETTINGS_FILE = path.join(DATA_ROOT, "settings.json");

/**
 * User prompt-override files (settings-storage wave, 2026-09-19): the
 * per-segment system-prompt overrides mirroring the SOURCE layout
 * (src/agent/prompts/) — the shared base as prompts/system-prompt.md,
 * fragments as prompts/teacher/<file> / prompts/prober/<file>. File
 * PRESENCE alone is not the override: settings.json's agent.prompts map
 * (segmentPath → boolean) is the explicit switch, so a user can keep a
 * customized file on disk but run the source default to compare. The
 * segment list itself is ALWAYS derived from source at runtime (the
 * loader in src/store/prompt-overrides.ts) — code updates that add,
 * remove, or reorder fragments adapt automatically; an override keyed to
 * a vanished segment stops composing but stays on disk.
 */
export const PROMPTS_OVERRIDE_DIR = path.join(DATA_ROOT, "prompts");

/**
 * THE AUTH/KEY STORE (auth-keys wave, 2026-09-19): BYOK provider keys in a
 * flat {VAR: value} JSON map — the SAME file the Electron app has always
 * hand-edited (owner decision: option A, zero migration). Desktop main.cjs
 * passes LH_AUTH_FILE pointing at userData/auth.json (mode 0600); in dev
 * (no Electron) the default is the repo-root auth.json (gitignored, same
 * pattern as .env.local — a worktree may symlink it to the master copy).
 * The SERVER reads/writes this file directly at call time (no restart to
 * change a key); it reflects the values into process.env at boot with
 * FILL-GAP precedence — real environment variables (incl. .env.local in
 * dev) always win (src/server/keys.ts). Hand-edits still work: the file is
 * re-read from disk on every API access. Secrets NEVER go in settings.json
 * — this file keeps that role, alongside .env.local.
 */
export const AUTH_FILE = process.env.LH_AUTH_FILE
	? path.resolve(process.env.LH_AUTH_FILE)
	: path.join(ROOT, "auth.json");
