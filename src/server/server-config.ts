/**
 * Headless server configuration (multi-user wave, 2026-11-03).
 *
 * data/server.json is GLOBAL and lives outside every user scope:
 *   { version: 1, host, port, secret }
 *
 * The port/host are read by scripts/serve.mjs BEFORE Next starts; the app
 * reads the same file for the cookie-signing secret and the Settings → Server
 * view. Changing the port therefore needs a restart. The secret is generated
 * once and never leaves the server (the API returns port/host only).
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	DEFAULT_SERVER_HOST,
	DEFAULT_SERVER_PORT,
	type ServerConfigView,
} from "../core/contracts/users.ts";
import { BASE_DATA_ROOT, SERVER_CONFIG_FILE } from "../../config.ts";

export interface ServerConfig {
	version: 1;
	host: string;
	port: number;
	secret: string;
}

function configFile(): string {
	return SERVER_CONFIG_FILE;
}

function validPort(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 65_535;
}

function validHost(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= 255 && !/[\s/\\]/.test(value);
}

function defaults(): ServerConfig {
	return {
		version: 1,
		host: DEFAULT_SERVER_HOST,
		port: DEFAULT_SERVER_PORT,
		secret: randomBytes(32).toString("hex"),
	};
}

function write(config: ServerConfig): void {
	fs.mkdirSync(path.dirname(configFile()), { recursive: true, mode: 0o700 });
	const tmp = `${configFile()}.${randomBytes(8).toString("hex")}.tmp`;
	try {
		fs.writeFileSync(tmp, `${JSON.stringify(config, null, "\t")}\n`, { encoding: "utf-8", mode: 0o600 });
		fs.renameSync(tmp, configFile());
	} finally {
		fs.rmSync(tmp, { force: true });
	}
}

function parse(raw: string): ServerConfig | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const value = parsed as Record<string, unknown>;
	if (!validPort(value.port) || !validHost(value.host) || typeof value.secret !== "string" || value.secret.length < 32) {
		return null;
	}
	return { version: 1, host: value.host, port: value.port, secret: value.secret };
}

/** Read, or create defaults on first use. A corrupt file is rewritten with a
 *  fresh secret (all sessions invalidate) rather than bricking login. */
export function ensureServerConfig(): ServerConfig {
	let raw: string;
	try {
		raw = fs.readFileSync(configFile(), "utf-8");
	} catch {
		const created = defaults();
		write(created);
		return created;
	}
	const parsed = parse(raw);
	if (parsed) return parsed;
	console.warn("[server-config] invalid server.json — recreating defaults (existing sessions will be invalidated)");
	const created = defaults();
	write(created);
	return created;
}

export function readServerConfig(): ServerConfig {
	return ensureServerConfig();
}

/** Save the admin-editable fields; the signing secret is preserved. */
export function writeServerConfig(next: { port: number; host: string }): ServerConfig {
	if (!validPort(next.port)) throw new Error("Port must be an integer between 1 and 65535.");
	if (!validHost(next.host)) throw new Error("Host must be a hostname or IP address without spaces or slashes.");
	const current = ensureServerConfig();
	const config: ServerConfig = { ...current, port: next.port, host: next.host };
	write(config);
	return config;
}

function running(): { port: number | null; host: string | null } {
	const port = Number(process.env.LH_BOUND_PORT ?? process.env.PORT);
	const host = (process.env.LH_BOUND_HOST ?? process.env.HOSTNAME)?.trim();
	return {
		port: Number.isSafeInteger(port) && port > 0 && port <= 65_535 ? port : null,
		host: host || null,
	};
}

/** The client-safe view: configured values, actual bind, restart state. */
export function serverConfigView(): ServerConfigView {
	const config = readServerConfig();
	const actual = running();
	return {
		port: config.port,
		host: config.host,
		runningPort: actual.port,
		runningHost: actual.host,
		restartRequired: (actual.port !== null && actual.port !== config.port) || (actual.host !== null && actual.host !== config.host),
	};
}

export { validHost as isValidServerHost, validPort as isValidServerPort };
export const SERVER_DATA_ROOT = BASE_DATA_ROOT;
