/**
 * Auto-update policy: the settings record is the only switch; Electron main
 * fails closed. Default is OFF (FACTORY_SETTINGS.general.autoUpdate = false).
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const mainSource = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
const { MAX_SETTINGS_BYTES, autoUpdateEnabledFromRecord, readAutoUpdateSetting } =
	require("../electron/auto-update-policy.cjs") as {
		MAX_SETTINGS_BYTES: number;
		autoUpdateEnabledFromRecord(record: unknown): boolean;
		readAutoUpdateSetting(file: string): boolean;
	};

const dirs: string[] = [];
function scratch(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-auto-update-"));
	dirs.push(dir);
	return dir;
}
function writeSettings(value: unknown): string {
	const file = path.join(scratch(), "settings.json");
	fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
	return file;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("autoUpdateEnabledFromRecord", () => {
	it("only an explicit boolean true enables automatic updates", () => {
		assert.equal(autoUpdateEnabledFromRecord({ general: { autoUpdate: true } }), true);
		assert.equal(autoUpdateEnabledFromRecord({ general: { autoUpdate: false } }), false);
		assert.equal(autoUpdateEnabledFromRecord({ general: {} }), false);
		assert.equal(autoUpdateEnabledFromRecord({}), false);
		assert.equal(autoUpdateEnabledFromRecord(null), false);
		assert.equal(autoUpdateEnabledFromRecord([]), false);
		assert.equal(autoUpdateEnabledFromRecord({ general: { autoUpdate: "true" } }), false);
	});
});

describe("readAutoUpdateSetting", () => {
	it("fails closed for missing, corrupt, and non-boolean records", () => {
		assert.equal(readAutoUpdateSetting(path.join(scratch(), "missing.json")), false);
		assert.equal(readAutoUpdateSetting(writeSettings("{not json")), false);
		assert.equal(readAutoUpdateSetting(writeSettings({ general: { autoUpdate: 1 } })), false);
	});
	it("reads the stored boolean", () => {
		assert.equal(readAutoUpdateSetting(writeSettings({ general: { autoUpdate: true } })), true);
		assert.equal(readAutoUpdateSetting(writeSettings({ general: { autoUpdate: false } })), false);
		assert.equal(readAutoUpdateSetting(writeSettings({ version: 1 })), false);
	});
	it("rejects oversized records", () => {
		const file = path.join(scratch(), "settings.json");
		fs.writeFileSync(file, " ".repeat(MAX_SETTINGS_BYTES + 1));
		assert.equal(readAutoUpdateSetting(file), false);
	});
});

describe("Electron main wiring", () => {
	it("reads the policy through the fail-closed seam and gates automatic checks", () => {
		assert.match(mainSource, /readAutoUpdateSetting\(SETTINGS_FILE\(\), fs\)/);
		assert.match(mainSource, /if \(!manual && !automaticUpdatesEnabled\(\)\)/);
	});
	it("applies the renderer's live toggle without waiting for the 24h tick", () => {
		assert.match(mainSource, /ipcMain\.on\("lh:update-auto", \(event, enabled\)/);
		assert.match(mainSource, /function setAutoUpdate\(enabled\) \{\s*if \(typeof enabled !== "boolean"\) return;\s*if \(enabled\) checkForUpdates\(\);/);
	});
});
