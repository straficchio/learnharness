#!/usr/bin/env node
/**
 * Headless LearnHarness launcher (multi-user wave, 2026-11-03).
 *
 *   npm run server        built .next/standalone server
 *   npm run dev:server    next dev with HMR on the same data root/config
 *
 * data/server.json is read BEFORE Next starts: { version, host, port, secret }.
 * The app reads the same file for the cookie-signing secret and Settings →
 * Server. PORT/HOSTNAME env vars, when set, override the file for one launch.
 *
 * The default LH_AUTH_FILE is <data>/auth.json; if it does not exist and the
 * repo-root auth.json does, it is copied once (0600) so an existing BYOK setup
 * keeps working. Set LH_AUTH_FILE to override.
 */
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEV = process.argv.includes("--dev");
const DATA_DIR = process.env.LH_DATA_DIR ? path.resolve(process.env.LH_DATA_DIR) : path.join(ROOT, "data");
const CONFIG_FILE = path.join(DATA_DIR, "server.json");
const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "0.0.0.0";

function validPort(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 65535;
}

function validHost(value) {
	return typeof value === "string" && value.trim().length > 0 && value.length <= 255 && !/[\s/\\]/.test(value);
}

function writeConfig(config) {
	fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
	const tmp = `${CONFIG_FILE}.${randomBytes(8).toString("hex")}.tmp`;
	try {
		fs.writeFileSync(tmp, `${JSON.stringify(config, null, "\t")}\n`, { encoding: "utf-8", mode: 0o600 });
		fs.renameSync(tmp, CONFIG_FILE);
	} finally {
		fs.rmSync(tmp, { force: true });
	}
}

function ensureConfig() {
	let parsed = null;
	try {
		parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
	} catch {
		parsed = null;
	}
	if (
		!parsed || typeof parsed !== "object" || Array.isArray(parsed)
		|| !validPort(parsed.port) || !validHost(parsed.host)
		|| typeof parsed.secret !== "string" || parsed.secret.length < 32
	) {
		const created = {
			version: 1,
			host: validHost(parsed?.host) ? parsed.host : DEFAULT_HOST,
			port: validPort(parsed?.port) ? parsed.port : DEFAULT_PORT,
			secret: randomBytes(32).toString("hex"),
		};
		writeConfig(created);
		return created;
	}
	return { version: 1, host: parsed.host, port: parsed.port, secret: parsed.secret };
}

function urls(host, port) {
	if (host !== "0.0.0.0" && host !== "::") return [`http://${host}:${port}`];
	const addresses = [];
	for (const entries of Object.values(os.networkInterfaces())) {
		for (const entry of entries ?? []) {
			if (entry.family === "IPv4" && !entry.internal) addresses.push(`http://${entry.address}:${port}`);
		}
	}
	return [`http://127.0.0.1:${port}`, ...addresses];
}

function authFile(dataDir) {
	const configured = process.env.LH_AUTH_FILE;
	if (configured) return path.resolve(configured);
	const target = path.join(dataDir, "auth.json");
	if (!fs.existsSync(target)) {
		const legacy = path.join(ROOT, "auth.json");
		if (fs.existsSync(legacy)) {
			fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
			fs.copyFileSync(legacy, target);
			fs.chmodSync(target, 0o600);
			console.log(`[server] copied the existing auth.json to ${target}`);
		}
	}
	return target;
}

const config = ensureConfig();
const port = process.env.LH_PORT ? Number(process.env.LH_PORT) : process.env.PORT ? Number(process.env.PORT) : config.port;
const host = process.env.LH_HOST?.trim() || config.host;
if (!validPort(port)) {
	console.error(`[server] invalid port: ${process.env.PORT ?? config.port}`);
	process.exit(1);
}
if (!validHost(host)) {
	console.error(`[server] invalid host: ${host}`);
	process.exit(1);
}

const env = {
	...process.env,
	NODE_ENV: DEV ? "development" : "production",
	NEXT_TELEMETRY_DISABLED: "1",
	LH_SERVER_MODE: "1",
	LH_DATA_DIR: DATA_DIR,
	LH_AUTH_FILE: authFile(DATA_DIR),
	PORT: String(port),
	HOSTNAME: host,
	LH_BOUND_PORT: String(port),
	LH_BOUND_HOST: host,
};
// Server mode is a browser deployment; never inherit the Electron child's
// private capability (a stale secret would require the desktop header).
delete env.LH_DESKTOP_SERVER;
delete env.LH_DESKTOP_API_SECRET;

console.log(`[server] LearnHarness ${DEV ? "development" : "production"} server`);
console.log(`[server] data: ${DATA_DIR}`);
console.log(`[server] auth: ${env.LH_AUTH_FILE}`);
for (const url of urls(host, port)) console.log(`[server] ${url}`);

if (DEV) {
	const nextBin = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");
	const child = spawn(process.execPath, [nextBin, "dev", "-H", host, "-p", String(port)], {
		cwd: ROOT,
		env,
		stdio: "inherit",
	});
	const forward = (signal) => () => child.kill(signal);
	process.once("SIGINT", forward("SIGINT"));
	process.once("SIGTERM", forward("SIGTERM"));
	child.once("exit", (code, signal) => {
		if (signal) process.kill(process.pid, signal);
		else process.exit(code ?? 0);
	});
} else {
	const standalone = path.join(ROOT, ".next", "standalone");
	const entry = path.join(standalone, "server.js");
	if (!fs.existsSync(entry)) {
		console.error(`[server] missing ${entry} — run \"npm run build\" first.`);
		process.exit(1);
	}
	// next build can trace repo data/secrets into standalone when the dynamic
	// filesystem warning widens the trace. Server mode uses LH_DATA_DIR and
	// LH_AUTH_FILE external to the payload; remove any traced copies so a
	// local build cannot accidentally ship them.
	for (const leaked of ["data", "auth.json", "chatgpt-credentials.json", ".env", ".env.local"]) {
		const target = path.join(standalone, leaked);
		if (fs.existsSync(target)) {
			fs.rmSync(target, { recursive: true, force: true });
			console.warn(`[server] removed traced ${leaked} from standalone`);
		}
	}
	for (const name of fs.readdirSync(standalone)) {
		if (/^(chatgpt|github-copilot|xai)-credentials\.json/.test(name)) {
			fs.rmSync(path.join(standalone, name), { recursive: true, force: true });
			console.warn(`[server] removed traced ${name} from standalone`);
		}
	}
	// next build's standalone output omits browser assets; copy them so the
	// login/app pages can load their CSS and JS.
	const staticFrom = path.join(ROOT, ".next", "static");
	if (fs.existsSync(staticFrom)) {
		fs.cpSync(staticFrom, path.join(standalone, ".next", "static"), { recursive: true, force: true });
	}
	const publicFrom = path.join(ROOT, "public");
	if (fs.existsSync(publicFrom)) {
		fs.cpSync(publicFrom, path.join(standalone, "public"), { recursive: true, force: true });
	}
	try {
		// The standalone server.js reads PORT/HOSTNAME/LH_* from process.env;
		// this launcher process must apply the computed config before import.
		Object.assign(process.env, env);
		delete process.env.LH_DESKTOP_SERVER;
		delete process.env.LH_DESKTOP_API_SECRET;
		await import(pathToFileURL(entry).href);
	} catch (error) {
		console.error("[server] failed to start:", error);
		process.exit(1);
	}
}
