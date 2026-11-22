/**
 * Portable session bundles — the attachment-aware transfer format.
 *
 * A session JSON alone is not portable when it names app-managed attachment
 * copies: those paths point into the exporting user's data root. A bundle
 * carries the session JSON plus the copies the user actually uploaded, and
 * replaces every other rooted local path with an explicit placeholder before
 * the file leaves the machine.
 *
 * Pure and browser-safe: reading/writing the copies and building the ZIP is
 * the server's job; this module owns the wire contract, path collection,
 * placeholder wording, and manifest validation.
 */
import { filePathLabel, isFilePath, parseFilePaths } from "./file-paths.ts";
import { MAX_BULK_EXPORT_SESSIONS } from "./session-transfer.ts";
import { ATTACHMENT_ID_RE } from "../../lib/attachment-limits.ts";

export const SESSION_BUNDLE_FORMAT = "learnharness.session.bundle";
export const SESSION_BUNDLE_VERSION = 1;
export const SESSION_BUNDLE_MANIFEST = "manifest.json";
export const SESSION_BUNDLE_SESSIONS_DIR = "sessions";
export const SESSION_BUNDLE_ATTACHMENTS_DIR = "attachments";
/** A portable reference inside the exported session JSON. It contains no
 *  filesystem path; the bundle manifest maps it to an attachment entry. */
export const ATTACHMENT_REF_PREFIX = "attachment-ref:";

export const LOCAL_FILE_PLACEHOLDER_PREFIX = "[local file not included: ";
export const ATTACHMENT_UNAVAILABLE_PLACEHOLDER_PREFIX = "[attachment unavailable: ";
export const ATTACHMENT_PLACEHOLDER_PREFIX = "[attachment: ";

/** One app-managed copy carried by the bundle. `refs` holds the portable
 *  references written into the session JSON(s) — never an absolute path. */
export interface BundleAttachment {
	/** ZIP entry: attachments/<uuid>/<safe-name>. */
	entry: string;
	name: string;
	size: number;
	refs: string[];
}

export interface BundleSession {
	/** ZIP entry: sessions/<filename>.json. */
	file: string;
	id: string;
	title: string;
	attachments: BundleAttachment[];
}

export interface SessionBundleManifest {
	format: typeof SESSION_BUNDLE_FORMAT;
	version: typeof SESSION_BUNDLE_VERSION;
	exportedAt: string;
	sessions: BundleSession[];
}

export type BundleManifestParse =
	| { ok: true; manifest: SessionBundleManifest }
	| { ok: false; error: string };

export function localFilePlaceholder(path: string): string {
	return `${LOCAL_FILE_PLACEHOLDER_PREFIX}${filePathLabel(path)}]`;
}

export function unavailableAttachmentPlaceholder(path: string): string {
	return `${ATTACHMENT_UNAVAILABLE_PLACEHOLDER_PREFIX}${filePathLabel(path)}]`;
}

/** Human-facing exports (Markdown) do not carry attachment copies; name the
 *  file instead of exposing an absolute path. */
export function attachmentPlaceholder(path: string): string {
	return `${ATTACHMENT_PLACEHOLDER_PREFIX}${filePathLabel(path)}]`;
}

/** The id/name pair of an app-managed attachment path, whichever user's root
 *  it happens to name. Used to distinguish "our copy" from a local path. */
export function attachmentParts(value: string): { id: string; name: string } | null {
	const match = /(?:^|[\\/])attachments[\\/]([0-9a-f-]{36})[\\/]([^\\/]+)$/i.exec(value);
	if (!match || !ATTACHMENT_ID_RE.test(match[1]!)) return null;
	return { id: match[1]!.toLowerCase(), name: match[2]! };
}

export function bundleAttachmentEntry(id: string, name: string): string {
	return `${SESSION_BUNDLE_ATTACHMENTS_DIR}/${id}/${name}`;
}

export function bundleAttachmentRef(id: string, name: string): string {
	return `${ATTACHMENT_REF_PREFIX}${id}/${name}`;
}

/** Paths the learner actually referenced: user/custom message content and
 *  the model's tool-call arguments. Teacher prose and tool output may contain
 *  paths as CONTENT (a code sample, an error message); those are not file
 *  references and must survive a portable export unchanged. */
export function referencePathsIn(value: unknown): string[] {
	const found = new Set<string>();
	const record = isRecord(value) ? value : null;
	const messages = record && Array.isArray(record.messages) ? record.messages : [];
	for (const raw of messages) {
		if (!isRecord(raw)) continue;
		if (raw.role === "user" || raw.role === "custom") {
			for (const candidate of pathStringsIn(raw)) found.add(candidate);
			continue;
		}
		if (raw.role !== "assistant" || !Array.isArray(raw.content)) continue;
		for (const block of raw.content) {
			if (isRecord(block) && block.type === "toolCall") {
				for (const candidate of pathStringsIn(block.arguments)) found.add(candidate);
			}
		}
	}
	return [...found];
}

/** Every rooted path that appears as a whole string, a backtick chip, or a
 *  quoted prose path. Deliberately conservative: an unquoted path with
 *  spaces inside ordinary prose is not guessed at. */
export function pathStringsIn(value: unknown): string[] {
	const found = new Set<string>();
	const visit = (node: unknown): void => {
		if (typeof node === "string") {
			const whole = node.trim();
			if (isFilePath(whole)) found.add(whole);
			for (const part of parseFilePaths(node)) {
				if (part.kind === "path") found.add(part.path);
			}
			for (const match of node.matchAll(/"([^"\n]+)"|'([^'\n]+)'/g)) {
				const candidate = match[1] ?? match[2];
				if (candidate !== undefined && isFilePath(candidate)) found.add(candidate);
			}
			return;
		}
		if (Array.isArray(node)) {
			for (const item of node) visit(item);
			return;
		}
		if (node !== null && typeof node === "object") {
			for (const item of Object.values(node)) visit(item);
		}
	};
	visit(value);
	return [...found];
}

/** Replace exact path spells on every string in a JSON-shaped value. Longest
 *  first so a directory path cannot partially rewrite a longer file path.
 *  Backtick-wrapped chips become plain placeholder text. */
export function replaceExactPaths(value: unknown, replacements: ReadonlyMap<string, string>): unknown {
	const pairs = [...replacements.entries()].filter(([from, to]) => from !== to).sort((a, b) => b[0].length - a[0].length);
	if (pairs.length === 0) return value;
	const replaceText = (text: string): string => {
		let out = text;
		for (const [from, to] of pairs) {
			out = out.split(`\`${from}\``).join(to);
			out = out.split(from).join(to);
		}
		return out;
	};
	const visit = (node: unknown): unknown => {
		if (typeof node === "string") return replaceText(node);
		if (Array.isArray(node)) return node.map(visit);
		if (node !== null && typeof node === "object") {
			return Object.fromEntries(Object.entries(node).map(([key, item]) => [key, visit(item)]));
		}
		return node;
	};
	return visit(value);
}

/** True when a record still contains a placeholder this module minted. */
export function hasPortablePlaceholder(value: unknown): boolean {
	if (typeof value === "string") {
		return value.includes(LOCAL_FILE_PLACEHOLDER_PREFIX)
			|| value.includes(ATTACHMENT_UNAVAILABLE_PLACEHOLDER_PREFIX)
			|| value.includes(ATTACHMENT_PLACEHOLDER_PREFIX);
	}
	if (Array.isArray(value)) return value.some(hasPortablePlaceholder);
	if (value !== null && typeof value === "object") return Object.values(value).some(hasPortablePlaceholder);
	return false;
}

export function parseSessionBundleManifest(value: unknown): BundleManifestParse {
	if (!isRecord(value)) return { ok: false, error: "The bundle manifest is not a JSON object." };
	if (value.format !== SESSION_BUNDLE_FORMAT) return { ok: false, error: "This is not a LearnHarness session bundle." };
	if (value.version !== SESSION_BUNDLE_VERSION) {
		return { ok: false, error: "This bundle uses a newer format than this app understands." };
	}
	if (!Array.isArray(value.sessions) || value.sessions.length === 0) {
		return { ok: false, error: "The bundle manifest has no sessions." };
	}
	if (value.sessions.length > MAX_BULK_EXPORT_SESSIONS) {
		return { ok: false, error: `A bundle may contain at most ${MAX_BULK_EXPORT_SESSIONS} sessions.` };
	}
	const seenFiles = new Set<string>();
	const sessions: BundleSession[] = [];
	for (const [index, raw] of value.sessions.entries()) {
		if (!isRecord(raw)) return { ok: false, error: `Bundle session ${index + 1} is invalid.` };
		const file = raw.file;
		if (typeof file !== "string" || !/^sessions\/[^/\\]+\.json$/i.test(file) || file.includes("..")) {
			return { ok: false, error: `Bundle session ${index + 1} has an unsafe file path.` };
		}
		if (seenFiles.has(file)) return { ok: false, error: "The bundle names the same session file twice." };
		seenFiles.add(file);
		if (typeof raw.id !== "string" || raw.id.length === 0 || typeof raw.title !== "string") {
			return { ok: false, error: `Bundle session ${index + 1} is missing its id or title.` };
		}
		if (!Array.isArray(raw.attachments)) return { ok: false, error: `Bundle session ${index + 1} has no attachments list.` };
		const attachments: BundleAttachment[] = [];
		const seenEntries = new Set<string>();
		for (const rawAttachment of raw.attachments) {
			if (!isRecord(rawAttachment)) return { ok: false, error: `Bundle session ${index + 1} has an invalid attachment.` };
			const entry = rawAttachment.entry;
			const name = rawAttachment.name;
			const size = rawAttachment.size;
			const refs = rawAttachment.refs;
			const entryMatch = typeof entry === "string" ? /^attachments\/([0-9a-f-]{36})\/([^/\\]+)$/i.exec(entry) : null;
			if (!entryMatch) {
				return { ok: false, error: `Bundle session ${index + 1} has an unsafe attachment entry.` };
			}
			const entryPath = entry as string;
			const entryId = entryMatch[1]!.toLowerCase();
			const entryName = entryMatch[2]!;
			if (
				typeof name !== "string" || name.length === 0 || entryName !== name
				|| name === "." || name === ".." || name.includes("\\")
			) {
				return { ok: false, error: `Bundle session ${index + 1} has a mismatched attachment name.` };
			}
			if (typeof size !== "number" || !Number.isFinite(size) || size < 0) {
				return { ok: false, error: `Bundle session ${index + 1} has an invalid attachment size.` };
			}
			const attachmentName = name as string;
			const expectedRef = bundleAttachmentRef(entryId, attachmentName);
			if (!Array.isArray(refs) || refs.length === 0 || refs.some((ref) => ref !== expectedRef)) {
				return { ok: false, error: `Bundle session ${index + 1} has invalid attachment references.` };
			}
			if (seenEntries.has(entryPath)) return { ok: false, error: `Bundle session ${index + 1} repeats an attachment.` };
			seenEntries.add(entryPath);
			attachments.push({ entry: entryPath, name: attachmentName, size: size as number, refs: refs as string[] });
		}
		sessions.push({ file, id: raw.id, title: raw.title, attachments });
	}
	return {
		ok: true,
		manifest: {
			format: SESSION_BUNDLE_FORMAT,
			version: SESSION_BUNDLE_VERSION,
			exportedAt: typeof value.exportedAt === "string" ? value.exportedAt : new Date().toISOString(),
			sessions,
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
