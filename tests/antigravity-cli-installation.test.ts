import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, type spawn } from "node:child_process";
import { test } from "node:test";
import { inspectAgyInstallation } from "../src/agent/antigravity-cli/installation.ts";
import { AgyLaunchError, createAgyLauncher } from "../src/agent/antigravity-cli/launch.ts";

const binary = "/fake/agy";
const options = { cwd: "/fake/work", env: { NODE_ENV: "test" as const, GOOGLE_API_KEY: "native-test-key" } };

test("missing installation does not execute a command", async () => {
	assert.deepEqual(await inspectAgyInstallation(() => null, async () => { throw new Error("must not run"); }), {
		state: "not-found", version: null, minimumVersion: "1.4.7",
	});
});

for (const [output, state, version] of [
	["1.4.6\n", "update-required", "1.4.6"],
	["1.4.7", "meets-minimum", "1.4.7"],
	["1.4.8", "meets-minimum", "1.4.8"],
	["1.5.0", "meets-minimum", "1.5.0"],
	["2.0.0", "meets-minimum", "2.0.0"],
	["unexpected output containing private details", "version-unchecked", null],
	["1.4.7-preview", "version-unchecked", null],
	["99999999999999999999999999.1.1", "version-unchecked", null],
] as const) test(`installation version output ${JSON.stringify(output)} gives ${state}`, async () => {
	const status = await inspectAgyInstallation(() => binary, async (path) => { assert.equal(path, binary); return output; });
	assert.deepEqual(status, { state, version, minimumVersion: "1.4.7" });
});

test("probe failures expose neither raw errors nor binary paths", async () => {
	const status = await inspectAgyInstallation(() => binary, async () => { throw new Error("timeout /private/path secret-token"); });
	assert.deepEqual(status, { state: "version-unchecked", version: null, minimumVersion: "1.4.7" });
});

for (const output of ["1.4.6", "garbage", null]) test(`launcher refuses ${output ?? "failed"} version check before model work`, async () => {
	const launch = createAgyLauncher({ findBinary: () => binary,
		readVersion: async () => { if (output === null) throw new Error("failed probe"); return output; },
		spawnProcess: (() => { assert.fail("must not start model work"); }) as typeof spawn,
	});
	await assert.rejects(launch(["--print"], options) as Promise<unknown>, AgyLaunchError);
});

test("launcher uses the verified executable directly and preserves model args and native env", async () => {
	const child = {} as ChildProcessWithoutNullStreams;
	let calls = 0;
	const launch = createAgyLauncher({ findBinary: () => binary, readVersion: async () => "1.4.8",
		spawnProcess: ((path: string, args: string[], opts: unknown) => {
			calls++;
			assert.equal(path, binary);
			assert.deepEqual(args, ["--model", "gemini-3.8-flash"]);
			assert.deepEqual(opts, { ...options, stdio: "pipe", windowsHide: true });
			return child;
		}) as typeof spawn,
	});
	assert.equal(await launch(["--model", "gemini-3.8-flash"], options), child);
	assert.equal(calls, 1);
});

test("aborting during a version check prevents model process creation", async () => {
	const controller = new AbortController();
	const launch = createAgyLauncher({ findBinary: () => binary,
		readVersion: async () => { controller.abort(); return "1.4.8"; },
		spawnProcess: (() => { assert.fail("must not start after abort"); }) as typeof spawn,
	});
	await assert.rejects(launch([], { ...options, signal: controller.signal }) as Promise<unknown>, /aborted/);
});

test("missing executable is not mistaken for an unchecked version", async () => {
	const launch = createAgyLauncher({ findBinary: () => null, readVersion: async () => assert.fail("must not probe") });
	assert.equal(await launch([], options), null);
});
