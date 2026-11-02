export { ANTIGRAVITY_CLI_PROVIDER } from "../../core/contracts/antigravity-cli.ts";

export const ANTIGRAVITY_CLI_API = "antigravity-cli";

/** The provider-level fallback that deliberately omits --model and --effort. */
export const AGY_DEFAULT_MODEL_ID = "default";

export enum AntigravityCliError {
	CliNotFound = "agy CLI not found",
	NotSignedIn = "not signed in",
}
