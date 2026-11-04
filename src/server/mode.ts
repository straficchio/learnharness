/**
 * Deployment mode (multi-user wave, 2026-11-03).
 *
 * SERVER MODE is explicit: the headless launcher sets LH_SERVER_MODE=1.
 * Everything else is STANDALONE — the Electron shell, plain `npm run dev`,
 * and the test suite keep the legacy single admin with no login. Never infer
 * the mode from the presence of a users file: standalone must not accidentally
 * turn into a login-gated app after a server-mode experiment.
 */
export function isServerMode(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.LH_SERVER_MODE === "1";
}
