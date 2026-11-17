import { parseFilePaths } from "../src/core/file-paths.ts";

/** One attachment upload: file bytes plus multipart metadata headroom. */
export const ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;
export const ATTACHMENT_MAX_BODY_BYTES = ATTACHMENT_MAX_BYTES + 2 * 1024 * 1024;
/** Maximum documents added to one message/draft. */
export const ATTACHMENT_MAX_FILES = 10;
/** Unreferenced copies attached to an existing session are removed after this. */
export const ATTACHMENT_GRACE_MS = 60 * 60 * 1000;

const TEXT_EXTENSIONS = /\.(?:pdf|txt|md|markdown|csv|tsv|json|log|tex|rst|org)$/i;
const TEXT_MIME = /^(?:text\/|application\/(?:json|xml|x-yaml|yaml)$)/i;
const SENSITIVE_NAMES = /^(?:(?:\.env(?:\..+)?|auth\.json|chatgpt-credentials\.json|github-copilot-credentials\.json|xai-credentials\.json|id_rsa|id_ed25519|id_ecdsa|\.netrc|\.npmrc|\.git-credentials|\.bash_history|\.zsh_history|\.python_history|\.node_repl_history|.*\.pem|.*\.key)|credential.*\.json)$/i;

/** A document the attachment pipeline accepts: PDF or a plain-text format.
 *  The PDF reader and `read` tool do the interpretation; this gate only keeps
 *  binaries and credential-shaped names out of the app-managed attachment
 *  area. */
export function isAttachableDocument(file: { name: string; type?: string }): boolean {
	const name = attachmentLabel(file.name ?? "");
	if (SENSITIVE_NAMES.test(name)) return false;
	if (TEXT_EXTENSIONS.test(name)) return true;
	return TEXT_MIME.test((file.type ?? "").toLowerCase());
}

/** The accept attribute shared by the picker and the drag/drop classifier. */
export const ATTACHMENT_ACCEPT = [
	".pdf", ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".log", ".tex", ".rst", ".org",
	"application/pdf", "text/*", "application/json", "application/xml", "application/x-yaml", "application/yaml",
].join(",");

/** Display label from a path or filename; never returns an empty string. */
export function attachmentLabel(name: string): string {
	const base = name.split(/[\\/]/).at(-1) ?? name;
	return base.trim() || "document";
}

/** Filesystem-safe basename. Never used as an authorization decision. */
export function safeAttachmentName(name: string): string {
	const base = attachmentLabel(name)
		.replace(/[\x00-\x1f\x7f\\/:*?"<>|]/g, "_")
		.replace(/^\.+/, "")
		.replace(/[. ]+$/, "")
		.slice(0, 180);
	return base || "document";
}

/** UUID-shaped attachment directory id (the path contract the sweeper and
 *  the fs guard both recognize). */
export const ATTACHMENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The app-managed paths already chip-referenced by a draft/answer. Ordinary
 *  referenced local files do not consume the attachment budget. */
export function attachmentPathsIn(value: string): string[] {
	return parseFilePaths(value)
		.flatMap((part) => part.kind === "path" ? [part.path] : [])
		.filter((path) => path.split(/[\\/]/).some((segment) => ATTACHMENT_ID_RE.test(segment)));
}
