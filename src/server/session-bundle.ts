/**
 * Portable session bundles — server half.
 *
 * Export prepares a ChatRecord by separating three kinds of paths:
 *   • app-managed attachment copies that exist in the active user's root
 *     (bundled into the ZIP),
 *   • app-managed paths that are missing or belong to another user
 *     (replaced with an "unavailable" placeholder),
 *   • every other rooted local path (replaced with a "not included"
 *     placeholder — the export never reaches out to copy user files).
 *
 * Import restores bundled copies under the importing user's root, rewrites
 * the session's exact path strings, then runs the normal import gate. Old
 * JSON and attachment-free ZIP exports keep their existing format.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { strToU8, zipSync } from "fflate";
import type { ChatRecord } from "../core/contracts/chat.ts";
import {
	SESSION_BUNDLE_FORMAT,
	SESSION_BUNDLE_MANIFEST,
	SESSION_BUNDLE_SESSIONS_DIR,
	SESSION_BUNDLE_VERSION,
	attachmentParts,
	attachmentPlaceholder,
	bundleAttachmentEntry,
	bundleAttachmentRef,
	hasPortablePlaceholder,
	localFilePlaceholder,
	pathStringsIn,
	referencePathsIn,
	replaceExactPaths,
	unavailableAttachmentPlaceholder,
	type BundleAttachment,
	type BundleSession,
	type SessionBundleManifest,
} from "../core/session-bundle.ts";
import { MAX_SESSION_IMPORT_BYTES, buildSessionExport, parseSessionExport, sessionExportFilename } from "../core/session-transfer.ts";
import { ATTACHMENT_MAX_BYTES, isAttachableDocument } from "../../lib/attachment-limits.ts";
import { PATHS, isAttachmentPath } from "../../config.ts";
import { removeStoredAttachment, storeAttachment } from "./attachments.ts";
import { importSessionRecord } from "./session-transfer.ts";

export interface PreparedSessionExport {
	record: ChatRecord;
	attachments: BundleAttachment[];
	/** ZIP entry → the real source file on this machine. */
	sources: Map<string, string>;
	notices: string[];
}

interface BundleWriteResult {
	bytes: Uint8Array;
	manifest: SessionBundleManifest;
}

export class SessionBundleError extends Error {
	readonly status: number;
	constructor(message: string, status = 400) {
		super(message);
		this.name = "SessionBundleError";
		this.status = status;
	}
}

function notice(count: number, singular: string, plural: string): string | null {
	if (count === 0) return null;
	return `${count} ${count === 1 ? singular : plural}.`;
}

async function classifyAttachment(candidate: string): Promise<{ id: string; entry: string; name: string; size: number; source: string } | null> {
	if (!isAttachmentPath(candidate)) return null;
	let real: string;
	try {
		real = await fs.realpath(candidate);
		if (!isAttachmentPath(real)) return null;
		const stat = await fs.stat(real);
		if (!stat.isFile() || stat.size === 0 || stat.size > ATTACHMENT_MAX_BYTES) return null;
		const parts = attachmentParts(real);
		if (!parts || !isAttachableDocument({ name: parts.name })) return null;
		return {
			id: parts.id,
			entry: bundleAttachmentEntry(parts.id, parts.name),
			name: parts.name,
			size: stat.size,
			source: real,
		};
	} catch {
		return null;
	}
}

/** Split a record into its portable session, bundle attachments, and
 *  placeholder substitutions. Reads stats/realpaths only — not file bytes. */
export async function prepareSessionForExport(record: ChatRecord): Promise<PreparedSessionExport> {
	const paths = pathStringsIn(record);
	const learnerReferences = new Set(referencePathsIn(record));
	const replacements = new Map<string, string>();
	const byEntry = new Map<string, BundleAttachment>();
	const sources = new Map<string, string>();
	let unavailable = 0;
	let local = 0;

	for (const candidate of paths) {
		const found = await classifyAttachment(candidate);
		if (found) {
			// No absolute path leaves the machine. The session JSON carries a
			// portable ref; the manifest maps it to the archived copy.
			const ref = bundleAttachmentRef(found.id, found.name);
			replacements.set(candidate, ref);
			const existing = byEntry.get(found.entry);
			if (existing) {
				if (!existing.refs.includes(ref)) existing.refs.push(ref);
			} else {
				byEntry.set(found.entry, {
					entry: found.entry,
					name: found.name,
					size: found.size,
					refs: [ref],
				});
			}
			sources.set(found.entry, found.source);
			continue;
		}
		if (attachmentParts(candidate)) {
			replacements.set(candidate, unavailableAttachmentPlaceholder(candidate));
			unavailable += 1;
		} else if (learnerReferences.has(candidate)) {
			replacements.set(candidate, localFilePlaceholder(candidate));
			local += 1;
		}
		// A path in teacher prose/tool output is CONTENT, not a reference.
	}

	const notices = [
		notice(local, "local file reference was replaced with a placeholder", "local file references were replaced with placeholders"),
		notice(unavailable, "attachment copy was unavailable and was replaced", "attachment copies were unavailable and were replaced"),
	].filter((value): value is string => value !== null);

	return {
		record: replaceExactPaths(record, replacements) as ChatRecord,
		attachments: [...byEntry.values()],
		sources,
		notices,
	};
}

/** Old JSON exports and raw chat records have no manifest. Keep a path that
 *  still points at an app-managed copy in THIS user's root; replace every
 *  other attachment path and every learner reference with a placeholder. */
export async function sanitizeImportedSession(record: ChatRecord): Promise<ChatRecord> {
	const learnerReferences = new Set(referencePathsIn(record));
	const replacements = new Map<string, string>();
	for (const candidate of pathStringsIn(record)) {
		if (attachmentParts(candidate)) {
			const found = await classifyAttachment(candidate);
			if (!found) replacements.set(candidate, unavailableAttachmentPlaceholder(candidate));
			continue;
		}
		if (learnerReferences.has(candidate)) replacements.set(candidate, localFilePlaceholder(candidate));
	}
	return replaceExactPaths(record, replacements) as ChatRecord;
}

/** Markdown is a human artifact with no attachment payload: every rooted
 *  path becomes a readable placeholder, including uploaded copies. */
export function sanitizeSessionForMarkdown(record: ChatRecord): ChatRecord {
	const learnerReferences = new Set(referencePathsIn(record));
	const replacements = new Map<string, string>();
	for (const candidate of pathStringsIn(record)) {
		if (attachmentParts(candidate)) replacements.set(candidate, attachmentPlaceholder(candidate));
		else if (learnerReferences.has(candidate)) replacements.set(candidate, localFilePlaceholder(candidate));
	}
	return replaceExactPaths(record, replacements) as ChatRecord;
}

/** Build the bundle ZIP for one or more already-prepared sessions. */
export async function buildSessionBundleZip(prepared: readonly PreparedSessionExport[]): Promise<BundleWriteResult> {
	if (prepared.length === 0) throw new SessionBundleError("Nothing to export.", 400);
	const exportedAt = new Date().toISOString();
	const entries: Record<string, Uint8Array> = {};
	const manifestSessions: BundleSession[] = [];
	const uniqueSources = new Map<string, string>();
	const usedFiles = new Set<string>();
	let uncompressed = 0;

	for (const item of prepared) {
		let file = `${SESSION_BUNDLE_SESSIONS_DIR}/${sessionExportFilename(item.record)}`;
		let suffix = 2;
		while (usedFiles.has(file)) {
			file = `${SESSION_BUNDLE_SESSIONS_DIR}/${sessionExportFilename(item.record).replace(/\.json$/i, `-${suffix++}.json`)}`;
		}
		usedFiles.add(file);
		const wrapper = buildSessionExport(item.record, exportedAt);
		const bytes = strToU8(JSON.stringify(wrapper, null, "\t"));
		entries[file] = bytes;
		uncompressed += bytes.byteLength;
		manifestSessions.push({
			file,
			id: item.record.id,
			title: item.record.title,
			attachments: item.attachments,
		});
		for (const [entry, source] of item.sources) uniqueSources.set(entry, source);
	}

	for (const [entry, source] of uniqueSources) {
		let bytes: Uint8Array;
		try {
			bytes = new Uint8Array(await fs.readFile(source));
		} catch {
			throw new SessionBundleError(`The attachment copy "${entry}" disappeared during export.`, 409);
		}
		uncompressed += bytes.byteLength;
		entries[entry] = bytes;
	}

	const manifest: SessionBundleManifest = {
		format: SESSION_BUNDLE_FORMAT,
		version: SESSION_BUNDLE_VERSION,
		exportedAt,
		sessions: manifestSessions,
	};
	const manifestBytes = strToU8(JSON.stringify(manifest, null, "\t"));
	entries[SESSION_BUNDLE_MANIFEST] = manifestBytes;
	uncompressed += manifestBytes.byteLength;

	if (uncompressed > 500 * 1024 * 1024) {
		throw new SessionBundleError("This bundle would exceed the 500 MB expanded transfer limit.", 413);
	}

	const bytes = zipSync(entries);
	if (bytes.byteLength > 250 * 1024 * 1024) {
		throw new SessionBundleError("This bundle would exceed the 250 MB transfer limit.", 413);
	}
	return { bytes, manifest };
}

/** True when a session carries app-managed copies that this export can
 *  actually bundle. Used by the routes to choose JSON vs ZIP. */
export function hasBundleAttachments(prepared: readonly PreparedSessionExport[]): boolean {
	return prepared.some((item) => item.attachments.length > 0);
}

export interface BundleImportSummary {
	imported: Array<{ id: string; title: string }>;
	replaced: Array<{ id: string; title: string }>;
	conflicts: Array<{ id: string; title: string }>;
	failures: Array<{ file: string; error: string; id?: string; title?: string; code?: string }>;
	notices: string[];
}

/** Restore one validated bundle. `entries` is the unzipped map. */
export async function importSessionBundle(
	manifest: SessionBundleManifest,
	entries: Record<string, Uint8Array>,
	options: { replace: boolean },
): Promise<BundleImportSummary> {
	const restored = new Map<string, { path: string; id: string }>();
	const entryErrors = new Map<string, string>();

	// Restore each unique copy once; shared across sessions in this bundle.
	const uniqueAttachments = new Map<string, BundleAttachment>();
	for (const session of manifest.sessions) {
		for (const attachment of session.attachments) {
			if (!uniqueAttachments.has(attachment.entry)) uniqueAttachments.set(attachment.entry, attachment);
		}
	}
	for (const [entry, attachment] of uniqueAttachments) {
		const bytes = entries[entry];
		if (!bytes) {
			entryErrors.set(entry, `The bundle is missing attachment "${attachment.name}".`);
			continue;
		}
		if (bytes.byteLength !== attachment.size) {
			entryErrors.set(entry, `Attachment "${attachment.name}" has the wrong size.`);
			continue;
		}
		try {
			const file = new File([bytes as unknown as BlobPart], attachment.name);
			const stored = await storeAttachment(file, { draft: false });
			restored.set(entry, { path: stored.path, id: stored.id });
		} catch (error) {
			entryErrors.set(entry, error instanceof Error ? error.message : String(error));
		}
	}

	const result: BundleImportSummary = { imported: [], replaced: [], conflicts: [], failures: [], notices: [] };
	const usedEntries = new Set<string>();
	for (const session of manifest.sessions) {
		const data = entries[session.file];
		if (!data) {
			result.failures.push({ file: session.file, error: "The bundle is missing this session file.", id: session.id, title: session.title });
			continue;
		}
		if (data.byteLength > MAX_SESSION_IMPORT_BYTES) {
			result.failures.push({ file: session.file, error: "The session file is too large.", id: session.id, title: session.title });
			continue;
		}
		let parsed: ReturnType<typeof parseSessionExport>;
		try {
			parsed = parseSessionExport(JSON.parse(new TextDecoder().decode(data)));
		} catch {
			result.failures.push({ file: session.file, error: "The session file is not valid JSON.", id: session.id, title: session.title });
			continue;
		}
		if (!parsed.ok) {
			result.failures.push({ file: session.file, error: parsed.error, id: session.id, title: session.title });
			continue;
		}
		if (parsed.session.id !== session.id) {
			result.failures.push({ file: session.file, error: "The session id does not match the bundle manifest.", id: session.id, title: session.title });
			continue;
		}
		const missing = session.attachments.find((attachment) => !restored.has(attachment.entry));
		if (missing) {
			result.failures.push({
				file: session.file,
				error: entryErrors.get(missing.entry) ?? `The bundle is missing attachment "${missing.name}".`,
				id: session.id,
				title: session.title,
			});
			continue;
		}
		const sessionText = JSON.stringify(parsed.session);
		const unbound = session.attachments.find((attachment) => attachment.refs.some((ref) => !sessionText.includes(ref)));
		if (unbound) {
			result.failures.push({
				file: session.file,
				error: "The bundle manifest references an attachment the session does not contain.",
				id: session.id,
				title: session.title,
			});
			continue;
		}

		const replacements = new Map<string, string>();
		for (const attachment of session.attachments) {
			const target = restored.get(attachment.entry)!;
			for (const ref of attachment.refs) replacements.set(ref, target.path);
		}
		const record = await sanitizeImportedSession(replaceExactPaths(parsed.session, replacements) as ChatRecord);
		const outcome = importSessionRecord(record, { replace: options.replace });
		if (outcome.ok) {
			if (outcome.replaced) result.replaced.push({ id: outcome.id, title: outcome.title });
			else result.imported.push({ id: outcome.id, title: outcome.title });
			for (const attachment of session.attachments) usedEntries.add(attachment.entry);
			if (hasPortablePlaceholder(record)) {
				result.notices.push(`${outcome.title}: some local file references were not included and remain marked in the transcript.`);
			}
			continue;
		}
		if (outcome.code === "session_exists") {
			result.conflicts.push({ id: outcome.id, title: outcome.title });
		} else {
			result.failures.push({
				file: session.file,
				error: outcome.error,
				id: outcome.id,
				title: outcome.title,
				code: outcome.code,
			});
		}
	}

	// A session that failed (or conflicted) must not leave an orphan copy.
	for (const [entry, target] of restored) {
		if (!usedEntries.has(entry)) await removeStoredAttachment(target.id);
	}
	return result;
}
