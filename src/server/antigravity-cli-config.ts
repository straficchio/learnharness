import { getAgyBinary } from "../agent/antigravity-cli/binary.ts";
import { settingsStore } from "../store/settings.ts";

/** Fresh admission state, not a process-wide cache. Existing runs retain
 * their engines; only new chat/job/extraction/compaction admissions consult it. */
export function antigravityCliEnabled(): boolean {
	return settingsStore.readSettings()?.antigravityCli?.enabled === true;
}

/** Installation/opt-in availability only, never authenticated readiness. */
export function antigravityCliAvailable(): boolean {
	return antigravityCliEnabled() && getAgyBinary() !== null;
}
