#!/usr/bin/env node
/**
 * Cross-platform launcher for the headless LearnHarness server.
 *
 * The three root wrappers (start-server.sh, start-server.command,
 * start-server.cmd) all call this file, so the install/build/start behavior
 * is identical on Linux, macOS and Windows:
 *
 *   1. install dependencies with `npm ci` when node_modules is missing
 *   2. build the production server when .next/standalone/server.js is missing
 *   3. start `scripts/serve.mjs` (or `--dev` for the HMR server)
 *
 * The bind address and port come from data/server.json; a fresh config is
 * created with host 0.0.0.0. `--host` / `--port` override them for one launch.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const MIN_NODE_MAJOR = 22;

const HELP = `Usage: node scripts/launch-server.mjs [options]

Starts the headless multi-user server. On the first run it installs
dependencies and builds the production bundle when they are missing.

Options:
  --dev            run the development server (HMR) instead of the production build
  --build          force a fresh production build before starting
  --host <addr>    bind address for this launch (default: data/server.json, else 0.0.0.0)
  --port <n>       port for this launch (default: data/server.json, else 3000)
  -h, --help       show this help
`;

function fail(message) {
	console.error(`[launch] ${message}`);
	process.exit(1);
}

function parseArgs(argv) {
	const options = { dev: false, build: false, host: undefined, port: undefined, help: false };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--dev") options.dev = true;
		else if (arg === "--build") options.build = true;
		else if (arg === "--help" || arg === "-h") options.help = true;
		else if (arg === "--host") options.host = requiredValue(arg, argv[++index]);
		else if (arg.startsWith("--host=")) options.host = requiredValue("--host", arg.slice("--host=".length));
		else if (arg === "--port") options.port = requiredValue(arg, argv[++index]);
		else if (arg.startsWith("--port=")) options.port = requiredValue("--port", arg.slice("--port=".length));
		else fail(`unknown option: ${arg}\n\n${HELP}`);
	}
	if (options.port !== undefined) {
		const port = Number(options.port);
		if (!Number.isSafeInteger(port) || port < 1 || port > 65535) fail(`invalid port: ${options.port}`);
		options.port = String(port);
	}
	return options;
}

function requiredValue(flag, value) {
	if (!value || value.startsWith("--")) fail(`${flag} needs a value`);
	return value;
}

function run(command, commandArgs) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, commandArgs, {
			cwd: ROOT,
			stdio: "inherit",
			env: process.env,
			// Windows resolves npm.cmd through the shell; POSIX runs it directly.
			shell: process.platform === "win32",
		});
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (signal) reject(new Error(`stopped by ${signal}`));
			else if (code === 0) resolve();
			else reject(new Error(`exited with code ${code}`));
		});
	});
}

function hasDependencies() {
	return fs.existsSync(path.join(ROOT, "node_modules", "next", "package.json"));
}

function hasProductionBuild() {
	return fs.existsSync(path.join(ROOT, ".next", "standalone", "server.js"));
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
	process.stdout.write(HELP);
	process.exit(0);
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (!Number.isSafeInteger(nodeMajor) || nodeMajor < MIN_NODE_MAJOR) {
	fail(`Node.js ${MIN_NODE_MAJOR} or newer is required (CI uses 26). Found ${process.version}.`);
}

const env = { ...process.env };
if (options.host) env.LH_HOST = options.host;
if (options.port) env.LH_PORT = options.port;

console.log(`[launch] LearnHarness ${options.dev ? "development" : "production"} server`);
console.log(`[launch] repo: ${ROOT}`);

try {
	if (!hasDependencies()) {
		console.log("[launch] dependencies are missing; running npm ci");
		await run(NPM, ["ci"]);
	}
	if (!options.dev && (options.build || !hasProductionBuild())) {
		console.log("[launch] building the production server (the first build can take several minutes)");
		await run(NPM, ["run", "build"]);
		if (!hasProductionBuild()) fail("the build finished but .next/standalone/server.js is missing");
	}
} catch (error) {
	fail(error instanceof Error ? error.message : String(error));
}

const serveArgs = [path.join(ROOT, "scripts", "serve.mjs")];
if (options.dev) serveArgs.push("--dev");

const exitCode = await new Promise((resolve) => {
	const child = spawn(process.execPath, serveArgs, { cwd: ROOT, stdio: "inherit", env });
	const forward = (signal) => () => {
		try {
			child.kill(signal);
		} catch {
			// The child already exited.
		}
	};
	process.once("SIGINT", forward("SIGINT"));
	process.once("SIGTERM", forward("SIGTERM"));
	child.once("exit", (code, signal) => {
		if (signal) process.kill(process.pid, signal);
		else resolve(code ?? 0);
	});
});

process.exit(exitCode);
