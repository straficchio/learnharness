/**
 * Best-effort secret redaction for learner-file text before it enters the
 * model context or a persisted chat record. This is a guard, not a
 * guarantee: the hard boundary is the credential-path deny in fs-shared.ts.
 * Keep the patterns conservative — a false positive only hides a token-like
 * string; a false negative is caught by the path guard for the app's own
 * stores.
 */

const RULES: ReadonlyArray<readonly [RegExp, string]> = [
	[/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]"],
	[/\b(?:sk-ant-|sk-or-v1-|sk-)[A-Za-z0-9_-]{16,}\b/g, "[REDACTED KEY]"],
	[/\btvly-[A-Za-z0-9]{10,}\b/g, "[REDACTED KEY]"],
	[/\bAIza[0-9A-Za-z_-]{30,}\b/g, "[REDACTED KEY]"],
	[/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED TOKEN]"],
	[/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED TOKEN]"],
	[/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED KEY]"],
	[/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/gi, "Bearer [REDACTED]"],
	[
		/((?:"|'|`)?[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*(?:"|'|`)?\s*[:=]\s*(?:"|'|`))([^"'\n`]{8,})((?:"|'|`))/gi,
		"$1[REDACTED]$3",
	],
];

export function redactSecrets(text: string): string {
	let out = text;
	for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
	return out;
}
