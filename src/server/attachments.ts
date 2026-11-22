/**
 * App-managed document copies (attachment wave, 2026-11-17).
 *
 * A text box uploads a PDF/text file; the message receives the copied file's
 * path, and the existing read/pdf tools inspect it. The transcript carries
 * only the path — never the document bytes — so the model pays for a tool
 * call only when it needs the content.
 *
 * One attachment = `attachments/<uuid>/<safe-name>` plus a `meta.json`
 * sidecar. The sidecar records whether the upload began in a new-session
 * draft (30-day default retention) or an existing session (one-hour grace
 * once unreferenced). Session deletion removes referenced copies immediately
 * when no other chat still mentions them.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	ATTACHMENT_GRACE_MS,
	ATTACHMENT_ID_RE,
	ATTACHMENT_MAX_BYTES,
	isAttachableDocument,
	safeAttachmentName,
} from "../../lib/attachment-limits.ts";
import {
	ATTACHMENT_RETENTION_DAYS_DEFAULT,
	ATTACHMENT_RETENTION_DAYS_MAX,
	ATTACHMENT_RETENTION_DAYS_MIN,
} from "../core/settings.ts";
import { BASE_DATA_ROOT, PATHS, USERS_DIR, attachmentsRootFor } from "../../config.ts";
import { readSettings } from "../store/settings.ts";

export interface StoredAttachment {
	id: string;
	name: string;
	path: string;
	size: number;
}

interface AttachmentMeta {
	version: 1;
	id: string;
	name: string;
	size: number;
	draft: boolean;
	createdAt: string;
}

export class AttachmentError extends Error {
	readonly status: number;
	constructor(message: string, status = 400) {
		super(message);
		this.name = "AttachmentError";
		this.status = status;
	}
}

const META_FILE = "meta.json";
const DAY_MS = 24 * 60 * 60 * 1000;

function attachmentRoot(): string {
	return PATHS.attachments;
}

function attachmentDir(root: string, id: string): string | null {
	return ATTACHMENT_ID_RE.test(id) ? path.join(root, id) : null;
}

/** Persist one uploaded file. The caller has already bounded the request
 *  body; these checks are the authoritative per-file contract. */
export async function storeAttachment(
	file: File,
	options: { draft: boolean },
): Promise<StoredAttachment> {
	if (!(file instanceof File)) throw new AttachmentError("No file was uploaded.", 400);
	if (!isAttachableDocument(file)) throw new AttachmentError("Only PDF and text documents can be attached.", 415);
	if (file.size === 0) throw new AttachmentError("That file is empty.", 400);
	if (file.size > ATTACHMENT_MAX_BYTES) {
		throw new AttachmentError(`That file is too large. Maximum ${ATTACHMENT_MAX_BYTES / (1024 * 1024)} MB per file.`, 413);
	}
	const root = attachmentRoot();
	const id = randomUUID();
	const dir = path.join(root, id);
	const name = safeAttachmentName(file.name);
	const filePath = path.join(dir, name);
	try {
		await fs.mkdir(dir, { recursive: true, mode: 0o700 });
		await fs.writeFile(filePath, new Uint8Array(await file.arrayBuffer()), { mode: 0o600, flag: "wx" });
		const meta: AttachmentMeta = {
			version: 1,
			id,
			name,
			size: file.size,
			draft: options.draft,
			createdAt: new Date().toISOString(),
		};
		await fs.writeFile(path.join(dir, META_FILE), `${JSON.stringify(meta, null, "\t")}\n`, { mode: 0o600, flag: "wx" });
		return { id, name, path: filePath, size: file.size };
	} catch (error) {
		await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
}

/** Attachment ids mentioned by a saved message list or an arbitrary text
 *  fragment. Both POSIX and Windows separators are accepted because the
 *  message stores the native path. */
export function attachmentIdsInText(text: string): Set<string> {
	const ids = new Set<string>();
	// `+` because session cleanup scans JSON.stringify(messages): Windows
	// paths arrive there with doubled backslashes.
	const pattern = /[\\/]+attachments[\\/]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[\\/]+/gi;
	for (const match of text.matchAll(pattern)) {
		if (ATTACHMENT_ID_RE.test(match[1]!)) ids.add(match[1]!.toLowerCase());
	}
	return ids;
}

function chatRootFor(root: string): string {
	return path.join(root, "chats");
}

/** Every attachment id still named by a chat file in this user root. */
async function referencedIds(root: string): Promise<Set<string>> {
	const ids = new Set<string>();
	const dir = chatRootFor(root);
	let entries: string[];
	try {
		entries = await fs.readdir(dir);
	} catch {
		return ids;
	}
	await Promise.all(entries.filter((name) => name.endsWith(".json")).map(async (name) => {
		try {
			const text = await fs.readFile(path.join(dir, name), "utf-8");
			for (const id of attachmentIdsInText(text)) ids.add(id);
		} catch {
			// A transient unreadable chat must never cause an attachment delete.
			// Mark the sweep as unsafe for this root by returning a sentinel that
			// suppresses all deletes below.
			ids.add("*");
		}
	}));
	return ids;
}

async function readMeta(dir: string): Promise<AttachmentMeta | null> {
	try {
		const parsed: unknown = JSON.parse(await fs.readFile(path.join(dir, META_FILE), "utf-8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		const raw = parsed as Record<string, unknown>;
		return raw.version === 1 && typeof raw.createdAt === "string" &&
			typeof raw.draft === "boolean" && typeof raw.size === "number"
			? raw as unknown as AttachmentMeta
			: null;
	} catch {
		return null;
	}
}

async function deleteAttachment(root: string, id: string): Promise<boolean> {
	const dir = attachmentDir(root, id);
	if (!dir) return false;
	try {
		const stat = await fs.lstat(dir);
		if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
		await fs.rm(dir, { recursive: true, force: false });
		return true;
	} catch {
		return false;
	}
}

/** Remove one app-managed copy by id. The transfer importer uses this for
 *  rollback when a bundle session cannot be restored after its files landed. */
export async function removeStoredAttachment(id: string): Promise<boolean> {
	return deleteAttachment(attachmentRoot(), id);
}

export interface AttachmentSweepStats {
	deleted: number;
	kept: number;
	roots: number;
}

/** Delete unreferenced copies according to their sidecar policy. Exported
 *  for tests; production calls ensureAttachmentSweep(). */
export async function sweepAttachmentsNow(now = Date.now()): Promise<AttachmentSweepStats> {
	const settings = readSettings();
	const configured = settings?.general?.attachmentRetentionDays;
	const retentionDays = typeof configured === "number" && Number.isFinite(configured)
		? Math.min(ATTACHMENT_RETENTION_DAYS_MAX, Math.max(ATTACHMENT_RETENTION_DAYS_MIN, Math.floor(configured)))
		: ATTACHMENT_RETENTION_DAYS_DEFAULT;
	const retentionMs = retentionDays * DAY_MS;

	let roots: string[] = [BASE_DATA_ROOT];
	try {
		const users = await fs.readdir(USERS_DIR, { withFileTypes: true });
		roots = [...roots, ...users.filter((entry) => entry.isDirectory()).map((entry) => path.join(USERS_DIR, entry.name))];
	} catch {
		// no user roots — the base root covers standalone/admin data
	}

	const stats: AttachmentSweepStats = { deleted: 0, kept: 0, roots: 0 };
	for (const root of roots) {
		const attachments = attachmentsRootFor(root);
		const referenced = await referencedIds(root);
		// An unreadable chat poisoned the scan; keep everything this pass.
		if (referenced.has("*")) {
			stats.roots += 1;
			continue;
		}
		let entries: import("node:fs").Dirent[];
		try {
			entries = await fs.readdir(attachments, { withFileTypes: true });
		} catch {
			continue;
		}
		stats.roots += 1;
		for (const entry of entries) {
			if (!entry.isDirectory() || !ATTACHMENT_ID_RE.test(entry.name)) continue;
			const dir = path.join(attachments, entry.name);
			if (referenced.has(entry.name.toLowerCase())) {
				stats.kept += 1;
				continue;
			}
			const meta = await readMeta(dir);
			const created = meta ? Date.parse(meta.createdAt) : NaN;
			let age = now - (Number.isFinite(created) ? created : 0);
			if (!Number.isFinite(created)) {
				try { age = now - (await fs.stat(dir)).mtimeMs; } catch { age = 0; }
			}
			// Missing/invalid metadata is treated as a draft upload: the
			// conservative retention, never the one-hour session grace.
			const threshold = meta && meta.draft === false ? ATTACHMENT_GRACE_MS : retentionMs;
			if (age > threshold && await deleteAttachment(attachments, entry.name)) stats.deleted += 1;
			else stats.kept += 1;
		}
	}
	return stats;
}

/** Remove copies named by a session that was just deleted, but only when no
 *  remaining chat references them. Fire-and-forget from the deletion path. */
export async function cleanupChatAttachments(root: string, messages: unknown): Promise<number> {
	if (messages === undefined || messages === null) return 0;
	const ids = attachmentIdsInText(JSON.stringify(messages));
	if (ids.size === 0) return 0;
	const referenced = await referencedIds(root);
	if (referenced.has("*")) return 0;
	const attachments = attachmentsRootFor(root);
	let deleted = 0;
	for (const id of ids) {
		if (!referenced.has(id) && await deleteAttachment(attachments, id)) deleted += 1;
	}
	return deleted;
}

interface SweepGlobal {
	__lhAttachmentSweep?: boolean;
}

/** Start the lazy production sweeper once per process. First run is immediate
 *  (after the upload returns), then every 15 minutes. `.unref()` keeps a
 *  short-lived CLI/build process free to exit. */
export function ensureAttachmentSweep(): void {
	const global = globalThis as typeof globalThis & SweepGlobal;
	if (global.__lhAttachmentSweep) return;
	global.__lhAttachmentSweep = true;
	const run = () => {
		void sweepAttachmentsNow().catch((error) => {
			console.error("[attachments] retention sweep failed:", error);
		});
	};
	setTimeout(run, 0).unref?.();
	setInterval(run, 15 * 60 * 1000).unref?.();
}
