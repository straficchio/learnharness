import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgyImage } from "./transcript.ts";

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;
const RULE_CHUNK_BYTES = 20_000;

export type AgyMcpConfig = {
	url: string;
	headers: Record<string, string>;
};

export type AgyTurnFiles = {
	home: string;
	cwd: string;
	appDataDir: string;
	imageDir: string;
	privateDir: string;
	logFile: string;
	imagePaths: string[];
	cleanup: () => Promise<void>;
};

function extensionFor(mimeType: string): string {
	switch (mimeType) {
		case "image/png": return "png";
		case "image/jpeg": return "jpg";
		case "image/webp": return "webp";
		case "image/gif": return "gif";
		default: return "bin";
	}
}

function quoteCommandPath(path: string): string {
	// Hooks run through sh -c on POSIX and cmd /c on Windows. Both accept
	// double quotes; Windows uses doubled quotes for embedded quotes.
	return process.platform === "win32"
		? `"${path.replace(/"/g, '""')}"`
		: `"${path.replace(/["\\$`]/g, "\\$&")}"`;
}

function splitPrompt(text: string, maxBytes = RULE_CHUNK_BYTES): string[] {
	const chunks: string[] = [];
	let current = "";
	const push = () => {
		if (current.trim()) chunks.push(current);
		current = "";
	};
	const append = (part: string) => {
		const candidate = current ? `${current}\n\n${part}` : part;
		if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
			current = candidate;
			return;
		}
		push();
		if (Buffer.byteLength(part, "utf8") <= maxBytes) {
			current = part;
			return;
		}
		// A single oversized paragraph: split on lines, then code points.
		for (const line of part.split("\n")) {
			const next = current ? `${current}\n${line}` : line;
			if (Buffer.byteLength(next, "utf8") <= maxBytes) {
				current = next;
				continue;
			}
			push();
			if (Buffer.byteLength(line, "utf8") <= maxBytes) {
				current = line;
				continue;
			}
			let slice = "";
			for (const char of line) {
				const candidateChar = slice + char;
				if (Buffer.byteLength(candidateChar, "utf8") > maxBytes) {
					if (slice) chunks.push(slice);
					slice = char;
				} else {
					slice = candidateChar;
				}
			}
			current = slice;
		}
	};

	for (const paragraph of text.split(/\n{2,}/)) append(paragraph);
	push();
	return chunks;
}

function gateScript(): string {
	return `import path from "node:path";
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
let name = "";
let args = {};
try {
	const value = JSON.parse(input);
	name = value.toolCall?.name ?? "";
	args = value.toolCall?.args ?? {};
} catch {}
const allowMcp = typeof name === "string" && name.startsWith("mcp_learnharness_");
let allowImage = false;
const imageDir = process.env.LH_AGY_IMAGE_DIR;
if (imageDir && (name === "read_file" || name === "view_file")) {
	const candidate = args.Path ?? args.AbsolutePath ?? args.path ?? args.file_path;
	if (typeof candidate === "string") {
		const relative = path.relative(path.resolve(imageDir), path.resolve(candidate));
		allowImage = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
	}
}
const allowed = allowMcp || allowImage;
process.stdout.write(JSON.stringify({
	decision: allowed ? "allow" : "deny",
	reason: allowed ? "LearnHarness tool bridge" : "LearnHarness allows only its harness MCP tools and its image files.",
}));
`;
}

function hookCommand(script: string): string {
	return `${quoteCommandPath(process.execPath)} ${quoteCommandPath(script)}`;
}

export async function createAgyTurnFiles(input: {
	systemPrompt: string;
	mcp: AgyMcpConfig;
	images: AgyImage[];
}): Promise<AgyTurnFiles> {
	const home = await mkdtemp(join(tmpdir(), "agy-home-"));
	let cwd: string | undefined;
	try {
		cwd = await mkdtemp(join(tmpdir(), "agy-cwd-"));
		const privateDir = join(home, "private");
		const imageDir = join(privateDir, "images");
		const appDataDir = join(home, "appdata");
		const configDir = join(home, ".gemini", "config");
		const rulesDir = join(configDir, "rules");

		await Promise.all([
			mkdir(privateDir, { recursive: true, mode: PRIVATE_DIR_MODE }),
			mkdir(imageDir, { recursive: true, mode: PRIVATE_DIR_MODE }),
			mkdir(appDataDir, { recursive: true, mode: PRIVATE_DIR_MODE }),
			mkdir(rulesDir, { recursive: true, mode: PRIVATE_DIR_MODE }),
		]);

		const imagePaths: string[] = [];
		for (const [index, image] of input.images.entries()) {
			const path = join(imageDir, `image-${index}.${extensionFor(image.mimeType)}`);
			await writeFile(path, Buffer.from(image.data, "base64"), { mode: PRIVATE_FILE_MODE });
			imagePaths.push(path);
		}

		const gate = join(privateDir, "gate.mjs");
		await writeFile(gate, gateScript(), { mode: PRIVATE_FILE_MODE });

		await Promise.all([
			writeFile(join(configDir, "mcp_config.json"), JSON.stringify({
				mcpServers: {
					learnharness: {
						type: "http",
						url: input.mcp.url,
						headers: input.mcp.headers,
					},
				},
			}), { mode: PRIVATE_FILE_MODE }),
			writeFile(join(configDir, "hooks.json"), JSON.stringify({
				"learnharness-gate": {
					PreToolUse: [{
						matcher: "*",
						hooks: [{ type: "command", command: hookCommand(gate), timeout: 5 }],
					}],
				},
			}), { mode: PRIVATE_FILE_MODE }),
		]);

		const chunks = splitPrompt(input.systemPrompt);
		await Promise.all(chunks.map((chunk, index) => writeFile(
			join(rulesDir, `${String(index).padStart(2, "0")}-learnharness.md`),
			`---\ntrigger: always_on\n---\n\n${chunk}\n`,
			{ mode: PRIVATE_FILE_MODE },
		)));

		const logFile = join(privateDir, "agy.log");
		return {
			home,
			cwd,
			appDataDir,
			imageDir,
			privateDir,
			logFile,
			imagePaths,
			cleanup: async () => {
				await Promise.all([
					rm(home, { recursive: true, force: true }),
					rm(cwd!, { recursive: true, force: true }),
				]);
			},
		};
	} catch (error) {
		await Promise.all([
			rm(home, { recursive: true, force: true }),
			...(cwd ? [rm(cwd, { recursive: true, force: true })] : []),
		]);
		throw error;
	}
}

/** The child environment is isolated from the user's CLI configuration but
 * keeps the native keyring and any explicit ADC/proxy launch environment. */
export function agyChildEnv(base: NodeJS.ProcessEnv, files: AgyTurnFiles): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...base,
		HOME: files.home,
		USERPROFILE: files.home,
		ANTIGRAVITY_APP_DATA_DIR: files.appDataDir,
		LH_AGY_IMAGE_DIR: files.imageDir,
		// The gate script is the only Node child and imports built-ins only.
		// Do not inherit tsx/Next loader flags from the server process.
		NODE_OPTIONS: "",
	};
	// Preserve Application Default Credentials when the CLI uses them; the
	// keyring path needs no HOME override at all.
	if (!env.CLOUDSDK_CONFIG && base.HOME) {
		const gcloud = join(base.HOME, ".config", "gcloud");
		env.CLOUDSDK_CONFIG = gcloud;
	}
	if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";
	return env;
}
