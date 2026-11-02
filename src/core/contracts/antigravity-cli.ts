export const ANTIGRAVITY_CLI_PROVIDER = "antigravity-cli";

/** Installation/version only. Never an authentication, quota, or billing verdict. */
export interface AntigravityCliStatus {
	state: "not-found" | "meets-minimum" | "update-required" | "version-unchecked";
	version: string | null;
	minimumVersion: string;
}

// stream-json input, always-loaded MCP tools, and the progressToken identity
// used by this adapter were verified with 1.4.7. Admission fails closed when
// the installed CLI does not satisfy the protocol.
export const ANTIGRAVITY_CLI_MINIMUM_VERSION = "1.4.7";
