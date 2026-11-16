import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import type { AgyImage } from "./transcript.ts";

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;
const RULE_CHUNK_BYTES = 20_000;
/** The MCP server name in the isolated config and its agy permission grant. */
const AGY_MCP_SERVER_NAME = "learnharness";
const HARNESS_MCP_PERMISSION = `mcp(${AGY_MCP_SERVER_NAME}/*)`;

/** The one file agy uses for its native login. The CLI has no config-home
 *  override (upstream issue #155), so this is the only credential shared
 *  with the otherwise isolated turn home. */
const CREDENTIAL_RELATIVE_PATH = [".gemini", "antigravity-cli", "antigravity-oauth-token"] as const;

function credentialFile(home: string): string {
	return join(home, ...CREDENTIAL_RELATIVE_PATH);
}

type SeededCredential = { source: string; original: Buffer };

async function writePrivateFile(file: string, bytes: Buffer): Promise<void> {
	await writeFile(file, bytes, { mode: PRIVATE_FILE_MODE });
	// umask may relax the create mode; the final path must stay 0600.
	await chmod(file, PRIVATE_FILE_MODE);
}

async function writePrivateFileAtomic(file: string, bytes: Buffer): Promise<void> {
	const temporary = join(dirname(file), `.${basename(file)}.${randomBytes(8).toString("hex")}.tmp`);
	try {
		await writePrivateFile(temporary, bytes);
		await rename(temporary, file);
	} finally {
		await rm(temporary, { force: true });
	}
}

async function seedCredential(home: string, sourceHome: string | undefined): Promise<SeededCredential | undefined> {
	if (!sourceHome) return undefined;
	const source = credentialFile(sourceHome);
	const info = await stat(source).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (!info?.isFile()) return undefined;
	const original = await readFile(source);
	const target = credentialFile(home);
	await mkdir(dirname(target), { recursive: true, mode: PRIVATE_DIR_MODE });
	await writePrivateFile(target, original);
	return { source, original };
}

/** Persist a token the CLI refreshed in the isolated home. The write-back is
 *  skipped if the real login changed while the turn ran — a concurrent
 *  re-login or another turn's refresh must never be clobbered. */
async function syncCredential(home: string, seeded: SeededCredential | undefined): Promise<void> {
	if (!seeded) return;
	let refreshed: Buffer;
	try {
		refreshed = await readFile(credentialFile(home));
	} catch {
		return;
	}
	if (refreshed.equals(seeded.original)) return;
	let current: Buffer;
	try {
		current = await readFile(seeded.source);
	} catch {
		return;
	}
	if (!current.equals(seeded.original)) return;
	await writePrivateFileAtomic(seeded.source, refreshed);
}

const TOOL_BRIDGE_RULE = `## LearnHarness tool bridge

You are running inside LearnHarness. The host registers the harness tools under
the \`mcp_learnharness_\` prefix. The CLI's native tool list does not include
them; they are still registered. When the instructions below name a harness
tool (for example \`probe\`, \`probe_done\`, \`ask_user_question\`, \`quiz\`,
\`explain\`, \`list_sessions\`, \`list_propositions\`, \`read\`, \`write\`, or
\`question\`), call \`mcp_learnharness_<name>\` (for example
\`mcp_learnharness_probe\`). Never call a bare harness name,
\`call_mcp_tool\`, \`read_file\`, \`run_command\`, or any other native CLI tool;
the host blocks those. The one exception is reading an image path that
LearnHarness included in the conversation: use \`read_file\` or \`view_file\`
only for those image paths. If a call is blocked, retry the same action with its
\`mcp_learnharness_\` name.`;

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
	reason: allowed
		? "LearnHarness tool bridge"
		: "LearnHarness blocked a native CLI tool. Harness tools are registered as mcp_learnharness_<name> (for example mcp_learnharness_probe); retry with that name.",
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
	/** The server user's real home. Only `agy`'s OAuth token file is shared
	 *  from it; every other file stays in the isolated turn home. */
	credentialHome?: string;
}): Promise<AgyTurnFiles> {
	const home = await mkdtemp(join(tmpdir(), "agy-home-"));
	let cwd: string | undefined;
	let seededCredential: SeededCredential | undefined;
	try {
		cwd = await mkdtemp(join(tmpdir(), "agy-cwd-"));
		seededCredential = await seedCredential(home, input.credentialHome);
		const privateDir = join(home, "private");
		const imageDir = join(privateDir, "images");
		const appDataDir = join(home, "appdata");
		const configDir = join(home, ".gemini", "config");
		const rulesDir = join(configDir, "rules");
		const cliDir = join(home, ".gemini", "antigravity-cli");

		await Promise.all([
			mkdir(privateDir, { recursive: true, mode: PRIVATE_DIR_MODE }),
			mkdir(imageDir, { recursive: true, mode: PRIVATE_DIR_MODE }),
			mkdir(appDataDir, { recursive: true, mode: PRIVATE_DIR_MODE }),
			mkdir(rulesDir, { recursive: true, mode: PRIVATE_DIR_MODE }),
			mkdir(cliDir, { recursive: true, mode: PRIVATE_DIR_MODE }),
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
					[AGY_MCP_SERVER_NAME]: {
						type: "http",
						url: input.mcp.url,
						headers: input.mcp.headers,
						// The CLI bounds each MCP tool call with its own default.
						// LearnHarness holds question calls until the learner answers,
						// so give the bridge a longer ceiling than our 10-minute
						// live-process retention; a later answer starts a fresh replay.
						timeoutSeconds: 1_800,
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
			// agy's default MCP policy is Ask, which headless print mode treats
			// as a denial. Allow the harness namespace; the PreToolUse hook above
			// remains the independent gate for every native CLI tool.
			writePrivateFile(join(cliDir, "settings.json"), Buffer.from(`${JSON.stringify({
				permissions: { allow: [HARNESS_MCP_PERMISSION] },
			}, null, "\t")}\n`)),
		]);

		const chunks = splitPrompt(input.systemPrompt);
		await Promise.all([
			writeFile(join(rulesDir, "00-tool-bridge.md"), `---\ntrigger: always_on\n---\n\n${TOOL_BRIDGE_RULE}\n`, { mode: PRIVATE_FILE_MODE }),
			...chunks.map((chunk, index) => writeFile(
				join(rulesDir, `${String(index + 1).padStart(2, "0")}-learnharness.md`),
				`---\ntrigger: always_on\n---\n\n${chunk}\n`,
				{ mode: PRIVATE_FILE_MODE },
			)),
		]);

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
				await syncCredential(home, seededCredential).catch((error: unknown) => {
					console.warn("agy credential sync failed:", error);
				});
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

/** The child environment is isolated from the user's CLI configuration.
 *  `createAgyTurnFiles` seeds only the native OAuth token file into that home;
 *  the keyring and any explicit ADC/proxy launch environment stay available. */
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
	// Preserve Application Default Credentials when the CLI uses them.
	if (!env.CLOUDSDK_CONFIG && base.HOME) {
		const gcloud = join(base.HOME, ".config", "gcloud");
		env.CLOUDSDK_CONFIG = gcloud;
	}
	if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";
	return env;
}
