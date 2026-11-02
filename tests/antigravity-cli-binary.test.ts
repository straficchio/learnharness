import assert from "node:assert/strict";
import test from "node:test";

import { resolveAgyBinary } from "../src/agent/antigravity-cli/binary.ts";

const HOME = "/home/u";

function resolveWith(executables: string[], env: Record<string, string> = {}, platform: NodeJS.Platform = "linux", homeDir = HOME) {
	const found = new Set(executables);
	return resolveAgyBinary({ env, platform, homeDir, isExecutable: (p) => found.has(p) });
}

test("prefers a PATH hit", () => {
	const binary = resolveWith(["/usr/bin/agy", `${HOME}/.local/bin/agy`], { PATH: "/opt/x:/usr/bin" });
	assert.equal(binary, "/usr/bin/agy");
});

test("falls back to ~/.local/bin and standard native locations", () => {
	const all = [`${HOME}/.local/bin/agy`, `${HOME}/.npm-global/bin/agy`, "/opt/homebrew/bin/agy", "/usr/local/bin/agy", "/usr/bin/agy"];
	for (let i = 0; i < all.length; i++) assert.equal(resolveWith(all.slice(i), { PATH: "" }), all[i]);
});

test("npm global bin follows npm_config_prefix when set", () => {
	const binary = resolveWith(["/opt/npm/bin/agy", `${HOME}/.npm-global/bin/agy`], { npm_config_prefix: "/opt/npm" });
	assert.equal(binary, "/opt/npm/bin/agy");
});

test("windows finds native agy.exe and never treats a .cmd wrapper as runnable", () => {
	const winHome = "C:\\Users\\u";
	const env = { PATH: "C:\\tools;C:\\bin", LOCALAPPDATA: `${winHome}\\AppData\\Local`, APPDATA: `${winHome}\\AppData\\Roaming` };
	assert.equal(resolveWith(["C:\\bin\\agy.cmd"], env, "win32", winHome), null);
	assert.equal(resolveWith(["C:\\bin\\agy.exe"], env, "win32", winHome), "C:\\bin\\agy.exe");
	assert.equal(resolveWith([`${winHome}\\.local\\bin\\agy.exe`], env, "win32", winHome), `${winHome}\\.local\\bin\\agy.exe`);
	assert.equal(resolveWith([`${winHome}\\AppData\\Local\\Programs\\Antigravity\\agy.exe`], env, "win32", winHome), `${winHome}\\AppData\\Local\\Programs\\Antigravity\\agy.exe`);
	assert.equal(resolveWith([`${winHome}\\AppData\\Local\\agy\\agy.exe`], env, "win32", winHome), `${winHome}\\AppData\\Local\\agy\\agy.exe`);
});

test("relative Windows PATH entries are fixed to an absolute discovery identity", () => {
	assert.equal(resolveAgyBinary({ env: { PATH: ".\\bin" }, platform: "win32", homeDir: "C:\\Users\\u", cwd: "C:\\server",
		isExecutable: (candidate) => candidate === "C:\\server\\bin\\agy.exe",
	}), "C:\\server\\bin\\agy.exe");
});

test("returns null when every location misses", () => {
	assert.equal(resolveWith([], { PATH: "/usr/bin:/bin" }), null);
});
