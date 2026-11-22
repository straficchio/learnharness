import assert from "node:assert/strict";
import { test } from "node:test";
import { repairMermaidFenceClosers } from "../src/core/markdown-repair.ts";

const chart = [
	"flowchart LR",
	'  A["Analog Spectrum X_a(f)\\nSupport: [-B, +B], Peak: A"] -->|"Multiply by s(t)"| B["Sampled Spectrum X_s(f)"]',
].join("\n");

test("splits a Mermaid closer that carries trailing prose", () => {
	const input = `before\n\`\`\`mermaid\n${chart}\n\`\`\`هاییCalls \`quiz\` to check understanding.\nafter\n`;
	const output = repairMermaidFenceClosers(input);
	assert.equal(output, `before\n\`\`\`mermaid\n${chart}\n\`\`\`\nهاییCalls \`quiz\` to check understanding.\nafter\n`);
});

test("leaves a valid Mermaid block byte-for-byte", () => {
	const input = `\`\`\`mermaid\n${chart}\n\`\`\`\n\nAfter.\n`;
	assert.equal(repairMermaidFenceClosers(input), input);
});

test("accepts trailing spaces on a valid closer", () => {
	const input = `\`\`\`mermaid\n${chart}\n\`\`\`   \nAfter.\n`;
	assert.equal(repairMermaidFenceClosers(input), input);
});

test("does not touch a non-Mermaid fence with a fence-like content line", () => {
	const input = "```md\n```not-a-close\nstill code\n```\n";
	assert.equal(repairMermaidFenceClosers(input), input);
});

test("repairs tilde Mermaid fences too", () => {
	const input = `~~~mermaid\n${chart}\n~~~garbage\nAfter.\n`;
	assert.equal(repairMermaidFenceClosers(input), `~~~mermaid\n${chart}\n~~~\ngarbage\nAfter.\n`);
});
