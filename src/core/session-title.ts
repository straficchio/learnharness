/**
 * Session-title conventions — the pure half of the async title job.
 *
 * The first message used to BECOME the title, which meant a file-only
 * opening produced a long absolute path. The fallback now names the file,
 * and the selected model replaces it with a five-word topic title when it
 * returns. These helpers are deterministic and model-free.
 */
import { TITLE_MAX_CHARS, titleFromPrompt } from "./contracts/graph.ts";
import { filePathLabel, isFilePath, parseFilePaths } from "./file-paths.ts";

export const TITLE_MAX_WORDS = 5;

/** Every rooted path the learner explicitly referenced in the opening text:
 *  backtick chips plus the whole-string form used by simple composers. */
export function promptFilePaths(prompt: string): string[] {
	const found = new Set<string>();
	for (const part of parseFilePaths(prompt)) {
		if (part.kind === "path") found.add(part.path);
	}
	const whole = prompt.trim();
	if (isFilePath(whole)) found.add(whole);
	return [...found];
}

/** The title shown while the model works (and the final fallback if it
 *  fails). A file-only prompt uses the file's stem, never the path. */
export function fallbackTitleForPrompt(prompt: string): string {
	const trimmed = prompt.trim();
	if (!trimmed) return "Untitled session";
	const paths = promptFilePaths(trimmed);
	if (paths.length > 0) {
		const parts = parseFilePaths(trimmed);
		const prose = isFilePath(trimmed)
			? ""
			: parts
				.filter((part) => part.kind === "text")
				.map((part) => part.text)
				.join("")
				.replace(/[`\s]/g, "");
		if (prose === "") {
			const label = filePathLabel(paths[0]!);
			const stem = label.replace(/\.[^.]+$/, "").trim();
			return stem || "New session";
		}
		// A mixed prompt keeps its prose but never shows the absolute path in
		// the sidebar while the model title is still in flight.
		const labelled = parts.length > 0
			? parts.map((part) => part.kind === "path" ? filePathLabel(part.path) : part.text).join("")
			: trimmed;
		return titleFromPrompt(labelled.trim() || trimmed);
	}
	return titleFromPrompt(trimmed);
}

/** Keep only the model's title line, strip wrappers/labels, and enforce the
 *  five-word contract. Empty output never replaces an honest fallback. */
export function normalizeGeneratedTitle(raw: string, fallback: string): string {
	let text = raw.replace(/\r/g, "").trim();
	const fence = /^```[^\n]*\n([\s\S]*?)\n```$/i.exec(text);
	if (fence) text = fence[1]!.trim();
	const line = text.split("\n").map((part) => part.trim()).find((part) => part.length > 0) ?? "";
	let title = line
		.replace(/^title\s*:\s*/i, "")
		.replace(/^here(?:'s| is) (?:a|the) (?:short )?title(?: for (?:this|the) (?:session|lesson))?\s*:\s*/i, "")
		.trim()
		.replace(/^[*_`"'“”‘’]+/, "")
		.replace(/[*_`"'“”‘’]+$/, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!title) return fallback;
	title = title.split(" ").slice(0, TITLE_MAX_WORDS).join(" ").trim();
	if (title.length > TITLE_MAX_CHARS) title = title.slice(0, TITLE_MAX_CHARS).trim();
	return title || fallback;
}
