/**
 * The non-admin runtime view (multi-user wave, 2026-11-03): the operational
 * slices the chat UI needs without exposing the full shared settings record.
 *
 * These values are read-only for regular users. They are not secrets (the
 * model picker already lists models; the graph meter needs the chunk budget;
 * dictation needs the language), and the settings dialog still shows only
 * Appearance.
 */
import { resolveSettings } from "../core/settings-resolution.ts";
import { readSettings as readSettingsRecord } from "../store/settings.ts";
import { readAppearance } from "../store/appearance.ts";
import { CURRENT_SETTINGS_VERSION, type AppearanceSettings, type ModelsSettings } from "../core/settings.ts";
import type { RequestUser } from "./session.ts";

export interface RuntimeSettingsView {
	version: number;
	models: ModelsSettings | undefined;
	graph: ReturnType<typeof resolveSettings>["graph"];
	dictation: ReturnType<typeof resolveSettings>["dictation"];
}

export function runtimeSettings(): RuntimeSettingsView {
	const record = readSettingsRecord();
	const resolved = resolveSettings(record);
	return {
		version: record?.version ?? CURRENT_SETTINGS_VERSION,
		models: record?.models,
		graph: resolved.graph,
		dictation: resolved.dictation,
	};
}

/** The settings-record view a user may receive. Admin gets the full shared
 *  record; everyone gets their own appearance. */
export function settingsViewFor(user: RequestUser): Record<string, unknown> {
	const record = readSettingsRecord();
	if (user.role !== "admin") {
		return {
			version: record?.version ?? CURRENT_SETTINGS_VERSION,
			appearance: readAppearance(),
		};
	}
	const legacy: AppearanceSettings | undefined = record?.appearance;
	const appearance = readAppearance({ legacySettings: legacy }) ?? legacy;
	return {
		...(record ?? { version: CURRENT_SETTINGS_VERSION }),
		appearance,
	};
}
