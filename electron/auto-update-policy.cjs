"use strict";

/**
 * Auto-update policy — the pure, testable seam between the server-owned
 * settings record and Electron main. The record lives at
 * `<userData>/data/settings.json` (LH_DATA_DIR in the packaged app); this
 * module only reads `general.autoUpdate`. Fail closed: missing, corrupt,
 * oversized, or non-boolean = OFF.
 *
 * The setting is default OFF (see FACTORY_SETTINGS in src/core/settings.ts);
 * Electron reads it at boot and the renderer pushes the live value over IPC
 * when the Settings toggle changes.
 */

const fs = require("node:fs");

/** 1 MiB is far larger than any legitimate settings record. */
const MAX_SETTINGS_BYTES = 1024 * 1024;

/** Pure record projection, exported for tests. */
function autoUpdateEnabledFromRecord(record) {
	return record !== null && typeof record === "object" && !Array.isArray(record)
		? record.general !== null &&
			typeof record.general === "object" &&
			!Array.isArray(record.general) &&
			record.general.autoUpdate === true
		: false;
}

/** Read the settings record and return whether automatic updates are on.
 *  Never throws; any unreadable/invalid state resolves OFF. The fs seam is
 *  injectable so Electron tests can run the real main.cjs against a fake
 *  filesystem. */
function readAutoUpdateSetting(settingsFile, fsImpl = fs) {
	try {
		const stat = fsImpl.statSync(settingsFile);
		if (!stat.isFile() || stat.size > MAX_SETTINGS_BYTES) return false;
		return autoUpdateEnabledFromRecord(JSON.parse(fsImpl.readFileSync(settingsFile, "utf8")));
	} catch {
		return false;
	}
}

module.exports = { MAX_SETTINGS_BYTES, autoUpdateEnabledFromRecord, readAutoUpdateSetting };
