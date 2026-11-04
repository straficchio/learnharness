/**
 * Per-user appearance (multi-user wave, 2026-11-03): appearance.json inside
 * the ACTIVE user's data scope (admin/standalone at the base root). This is
 * the one settings section a non-admin may change.
 *
 * Legacy compatibility: before this file existed, appearance lived in
 * settings.json. Admin/standalone reads fall back to that delta until the new
 * file is written; server users start from the factory/default.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { APPEARANCE_FILE_NAME, PATHS } from "../../config.ts";
import {
	CURRENT_SETTINGS_VERSION,
	isHexColor,
	sanitizeUserSettings,
	type AppearanceSettings,
} from "../core/settings.ts";

function appearanceFile(): string {
	return path.join(PATHS.data, APPEARANCE_FILE_NAME);
}

function sanitize(raw: unknown): AppearanceSettings | null {
	const record = sanitizeUserSettings({ version: CURRENT_SETTINGS_VERSION, appearance: raw });
	return record?.appearance ?? null;
}

export function readAppearance(options: { legacySettings?: AppearanceSettings } = {}): AppearanceSettings | null {
	let raw: string;
	try {
		raw = fs.readFileSync(appearanceFile(), "utf-8");
	} catch {
		return options.legacySettings ?? null;
	}
	try {
		return sanitize(JSON.parse(raw));
	} catch {
		return options.legacySettings ?? null;
	}
}

export function writeAppearance(raw: unknown): AppearanceSettings | null {
	const settings = sanitize(raw);
	if (!settings) return null;
	fs.mkdirSync(path.dirname(appearanceFile()), { recursive: true, mode: 0o700 });
	const tmp = `${appearanceFile()}.${crypto.randomUUID().slice(0, 8)}.tmp`;
	try {
		fs.writeFileSync(tmp, `${JSON.stringify(settings, null, "\t")}\n`, { encoding: "utf-8", mode: 0o600 });
		fs.renameSync(tmp, appearanceFile());
	} finally {
		fs.rmSync(tmp, { force: true });
	}
	return settings;
}

export { isHexColor };
