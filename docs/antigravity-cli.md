# Antigravity CLI

LearnHarness can run its agents through an externally installed **Google
Antigravity CLI** (`agy`). This is a separate provider from the API-key
providers and subscription connections. The CLI owns authentication, routing,
model access, and billing; LearnHarness does **not** guarantee subscription-only
use.

## User setup

1. Install and authenticate the Antigravity CLI outside LearnHarness, using a
   terminal on **the machine running the LearnHarness server**, under its
   operating-system user. Follow the
   [CLI reference](https://antigravity.google/docs/cli/reference). A CLI
   installed only on a remote browser's computer is not sufficient. No
   always-running CLI process is needed.
2. Make `agy` discoverable to that server process. LearnHarness searches its
   `PATH` and common installation locations. On Windows it requires a directly
   runnable `agy.exe`; a `.cmd` wrapper does not qualify. Desktop launch
   environments can differ from terminal environments.
3. Open **Settings → Providers → External CLI → Antigravity CLI** and switch it
   on. This is an app-wide, persisted opt-in, **off by default**, even when the
   CLI is installed. Enabling reveals the installation/version result and
   **Check again**.
4. Select an Antigravity CLI model in the model controls. The list is discovered
   from `agy models`; **CLI default model** uses whatever the CLI is configured
   to use.

The required minimum is **1.4.7**, defined in the
[shared contract](../src/core/contracts/antigravity-cli.ts). A check reports
**Not found**, **meets minimum**, **update required**, or **Version could not be
checked**. It runs only `--version`, not an authentication check or model
request. Meeting the minimum proves neither authentication nor model access,
quota, billing method, or complete protocol compatibility. Each fresh model
process also checks the version and refuses an old or unverifiable installation.

Install, update, sign in, and change the CLI's account/configuration externally.
There is no LearnHarness Antigravity CLI sign-in, reauthentication, or
account-status control. Switching the opt-in off blocks future LearnHarness
requests using this provider and preserves saved model selections; it does not
interrupt an already admitted turn or sign out the CLI. Use the normal
cancellation control to stop running work.

## Models and thinking

`agy models` returns account-specific model slugs. LearnHarness groups variants
such as `gemini-3.8-flash-low`, `gemini-3.8-flash-medium`, and
`gemini-3.8-flash-high` into one model family. The thinking-level control maps
onto the CLI's `--effort` values the family advertises. A standalone model with
no effort variants uses only the CLI's configured effort. The discovery result
is cached for about five minutes; model-setting writes and the next catalog
refresh update it.

**CLI default model** deliberately omits both `--model` and `--effort`, so the
CLI's own configured default applies. A changed account or plan can remove a
previously discovered family; the saved selection is never silently remapped to
another model.

## Images

The CLI's streaming prompt format accepts text only. LearnHarness writes images
from the active transcript to temporary files and names their absolute paths in
the replay. The model may use the CLI's native `read_file`/`view_file` tool on
those paths only. The pre-tool gate allows no other native file access. Images
returned by harness tools travel through the MCP bridge normally.

## Maintainer implementation

### Engine and tool bridge

[The shared engine factory](../src/agent/models.ts) registers
[`createAntigravityCliProvider`](../src/agent/antigravity-cli/provider.ts) in
Pi's model collection. The provider's `antigravity-cli` stream adapter converts
the CLI's NDJSON stream into native Pi assistant events. Model slots and
background-role resolution use the same engine seam as other providers;
LearnHarness still owns the agent loop, tool execution, questions, persistence,
and jobs.

For each fresh process, [the adapter](../src/agent/antigravity-cli/stream.ts)
exposes the current LearnHarness tool schemas through a temporary
[Streamable HTTP MCP bridge](../src/agent/antigravity-cli/tool-bridge.ts). It
binds only `127.0.0.1` on an ephemeral port and requires a random per-bridge
bearer token. Every tool is marked `_meta["antigravity/alwaysLoad"] = true`, so
the CLI offers it directly as `mcp_learnharness_…` instead of requiring a
schema-file read or a generic `call_mcp_tool` step. The bridge configuration
also sets `timeoutSeconds: 1800`, so the CLI's shorter default per-call MCP
ceiling cannot cut off a learner question.

**Streamed tool intent alone never authorizes execution.** An authenticated MCP
request must carry a unique `_meta.progressToken` shaped
`<conversation_id>:<step_index>`. LearnHarness matches it to the streamed tool
step's index, bare tool name, and arguments (the CLI's UI-only `toolSummary`
field is ignored). Missing/reused identities, undeclared tools, mismatches, and
CLI output that advances past unresolved calls fail closed. This is a required
compatibility seam, not an official stability guarantee for that CLI metadata.

### Native tool gate

The isolated CLI configuration installs a `PreToolUse` hook. It allows only
`mcp_learnharness_*` calls and `read_file`/`view_file` on files inside the
turn's image directory. Every other native tool is hard-denied: shell commands,
writes, web/browser tools, subagents, schedules, and other MCP servers. The
stream adapter also fails the turn if a disallowed native tool reaches execution,
so the hook and the adapter are independent checks.

### Credentials and process boundaries

[Environment provenance](../src/core/auth-env.ts) removes credentials reflected
into `process.env` **only by LearnHarness's key store** before launching the CLI
or its version probe. The original launch environment and the user's OS keyring
remain available, so native CLI authentication/routing still applies.
LearnHarness neither copies its saved API keys into this provider nor enforces a
subscription-only account. Prompts, relevant history, images, and tool results
go through the CLI's configured service.

Each process runs with a temporary `HOME`/`USERPROFILE`, its own temporary app
data directory, an empty temporary working directory, and a log file inside the
same private tree. The user's real `~/.gemini` rules, plugins, MCP servers,
settings, onboarding state, conversation history, and logs are not used or
modified. `CLOUDSDK_CONFIG`/`GOOGLE_APPLICATION_CREDENTIALS` are preserved for
users who authenticate through Application Default Credentials. The whole tree,
including images and the token-bearing MCP configuration, is removed on close.

Processes are spawned directly without a shell. Launch arguments use streaming
JSON input/output, disable slash-command expansion, wait without the CLI's own
print deadline, and write the CLI log into the private tree. These are
integration boundaries, **not an OS sandbox, legal certification, or a blanket
claim about provider-policy compliance**. Provider terms and account limits
still apply. CLI stderr is retained in a bounded buffer and logged on process
close; server logs can therefore contain CLI diagnostic information.

### Ownership, reuse, and recovery

LearnHarness's persisted transcript is authoritative, not an Antigravity saved
session. [Conversation agents](../src/agent/teacher-agent.ts) pass the existing
chat ID as Pi's `sessionId`; [background subagent runs](../src/agent/subagents/pi-run.ts)
get a fresh identity per invocation, stable across that run's tool turns.

A child normally exits after its final response. It is retained only while a
LearnHarness tool is waiting for its result, including a learner question. A
held child can continue only for the same stream owner and nonempty session
identity, matching tool-result IDs/names, the expected history extension, and
unchanged model, effort, system prompt, tools, and child environment. Colliding
tool IDs in two chats or runs do not grant cross-session reuse. A direct caller
without a session ID can run, but never retains a reusable child.

Held children have a **ten-minute idle timeout**, intentionally bounded below
the CLI's per-call MCP ceiling (LearnHarness asks for 30 minutes in the bridge
config). A later answer starts fresh and replays the active LearnHarness
history, including the question and answer. If there is no eligible held
child—for example after timeout/restart, a changed configuration, or history
replacement—the next call starts fresh and replays the active LearnHarness
history. [Replay](../src/agent/antigravity-cli/transcript.ts) is
labelled user/assistant/tool-call/tool-result text in one streaming user
message, with image files referenced by path; it is **not** CLI `--conversation`
resume or exact native-role/thinking history restoration. The current system
prompt and tool schemas are supplied separately. A compatibility failure after
admission is reported on continuation, not silently hidden by replay. Recovery
is not a guarantee that arbitrary CLI failures will retry automatically.

### Waiting, cancellation, and cleanup

A question stops later tool work until the learner answers. An answer arriving
while the child is still eligible resolves its held MCP call. If the CLI
abandons a held call before the learner answers, LearnHarness retires that child
quietly; the pending question survives, and the answer starts a fresh replay
instead of surfacing a protocol/timeout error the learner cannot act on.
Request abort kills the child and ends the active stream as aborted.
Cancellation of an individual queued MCP call prevents its later admission; it
cannot undo work already admitted to Pi. Normal completion, abort, failure, and
idle expiry terminate the child, escalating to `SIGKILL` after one second if
necessary. On child close the adapter settles/closes bridge calls, releases the
listener, and removes its temporary directories. Startup failures also clean
allocated resources. This is normal-process cleanup, not a promise of cleanup
after an OS crash or forced server termination.

## Usage, context, and troubleshooting

Token counts come from completed `agent_response` steps (`input`, `output`,
cache read/write). The CLI's final result counters are cumulative across the
session and are not used as a per-turn price. LearnHarness does **not** ingest
the CLI's dollar totals. The adapter's internal zero rates are Pi-required
placeholders; CLI turns/jobs remain **unpriced**, and model menus say **CLI
billing**, not free or subscription usage.

The CLI does not expose a per-session context-window budget comparable to the
Claude Code control query. The meter therefore shows the completed-response
token count without a maximum rather than guessing one. Compaction clears
earlier measurements as usual.

| Symptom | What to check |
| --- | --- |
| Model absent or saved choice unavailable | Enable the opt-in, check discovery under the server's OS user/environment, and use **Check again**. Saved selections are not silently remapped. |
| Not found / unchecked / update required | Repair or update the external executable, then use **Check again**. The probe has a five-second timeout and accepts a bounded version response; it does not install or authenticate anything. |
| Meets minimum, but request fails | Verify native CLI authentication, routing, model access, and quota externally. Installation readiness does not test them. |
| MCP identity/admission error | The installed CLI did not satisfy the bridge contract. No stdout-only tool fallback is available; investigate compatibility rather than bypassing admission. |
| Native tool denied | Expected. Only harness MCP tools and the turn's own image files are allowed. |
| Answer resumes with a new process | Expected after idle expiry, restart, or reuse-validation failure; history is replayed, not resumed from a CLI conversation file. |
| No context maximum or dollar estimate | Expected: the CLI owns the window/routing/billing, and neither absence is evidence of zero usage. |

## Source and regression map

These offline tests use a synthetic `agy` process and MCP requests. They
establish adapter behavior, not live account eligibility, billing, model
quality, or provider approval.

| Area | Durable references |
| --- | --- |
| Discovery, version checks, default-off gating | [binary](../src/agent/antigravity-cli/binary.ts), [installation](../src/agent/antigravity-cli/installation.ts), [launcher](../src/agent/antigravity-cli/launch.ts), [opt-in tests](../tests/antigravity-cli-opt-in.test.ts) |
| Settings controls and status HTTP boundary | [UI](../components/settings/antigravity-cli-status.tsx), [HTTP handler](../src/server/antigravity-cli.ts), [UI tests](../tests/antigravity-cli-status-ui.test.tsx), [HTTP tests](../tests/antigravity-cli-status-http.test.ts) |
| MCP transport and progress-token admission | [bridge](../src/agent/antigravity-cli/tool-bridge.ts), [bridge tests](../tests/antigravity-cli-tool-bridge.test.ts), [stream tests](../tests/antigravity-cli-stream.test.ts) |
| Launch isolation, native gate, images, reuse, abort, cleanup | [stream](../src/agent/antigravity-cli/stream.ts), [session files](../src/agent/antigravity-cli/session-files.ts), [reuse comparison](../src/agent/antigravity-cli/reuse-context.ts), [live-process registry](../src/agent/antigravity-cli/live-processes.ts), [stream tests](../tests/antigravity-cli-stream.test.ts) |
| Replay and learner-question lifecycle | [transcript](../src/agent/antigravity-cli/transcript.ts), [transcript tests](../tests/antigravity-cli-transcript.test.ts), [harness tests](../tests/antigravity-cli-harness.test.ts) |
| Model discovery and pricing labels | [discovery](../src/agent/antigravity-cli/model-discovery.ts), [catalog](../src/server/model-catalog.ts), [discovery tests](../tests/antigravity-cli-model-discovery.test.ts), [pricing parity tests](../tests/pricing-native-parity.test.ts) |
