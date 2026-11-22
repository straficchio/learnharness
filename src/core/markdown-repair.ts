/**
 * Display-only Markdown repair for model-authored fences.
 *
 * A model occasionally closes a Mermaid fence with trailing text on the same
 * line (for example ```هاییCalls `quiz` ...). CommonMark reads that as code
 * content, so the chart parser receives the fence and the following prose and
 * fails. Mermaid labels never legitimately contain a line beginning with the
 * closing fence, so for Mermaid blocks we can split the corrupt line into a
 * real closing fence plus a prose line. Other fences are untouched: a code
 * sample may intentionally show a fence-like line.
 */
const FENCE = /^\s{0,3}(`{3,}|~{3,})([^\n]*)$/;

function fenceRun(line: string): { char: string; length: number; rest: string } | null {
	const match = FENCE.exec(line);
	if (!match) return null;
	return { char: match[1]![0]!, length: match[1]!.length, rest: match[2] ?? "" };
}

function closes(run: { char: string; length: number }, opener: { char: string; length: number }): boolean {
	return run.char === opener.char && run.length >= opener.length;
}

/** The observed corruption is an Arabic-script token glued to the closing
 *  fence and immediately followed by English prose (`هاییCalls…`). Drop only
 *  that leading RTL run when an ASCII word starts immediately after it;
 *  genuine non-Latin prose is otherwise preserved. */
const RTL_CLOSER_DEBRIS = /^[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\u061C\u200E\u200F]+(?=[A-Za-z])/;

function cleanTrailing(trailing: string): string {
	return trailing.trimStart().replace(RTL_CLOSER_DEBRIS, "");
}

/** Split only a Mermaid fence's malformed closer. All other content, including
 *  every non-Mermaid code block, is returned byte-for-byte. */
export function repairMermaidFenceClosers(markdown: string): string {
	if (!markdown.includes("```") && !markdown.includes("~~~")) return markdown;
	const out: string[] = [];
	let opener: { char: string; length: number } | null = null;
	for (const line of markdown.split("\n")) {
		const run = fenceRun(line);
		if (opener === null) {
			out.push(line);
			if (run && run.rest.trim().split(/\s+/)[0]?.toLowerCase() === "mermaid") {
				opener = { char: run.char, length: run.length };
			}
			continue;
		}
		if (run && closes(run, opener)) {
			const trailing = run.rest;
			if (trailing.trim() === "") {
				out.push(line);
				opener = null;
				continue;
			}
			// The corrupt closer: emit a bare fence and keep the text as prose.
			out.push(`${run.char.repeat(run.length)}`, cleanTrailing(trailing));
			opener = null;
			continue;
		}
		out.push(line);
	}
	return out.join("\n");
}
