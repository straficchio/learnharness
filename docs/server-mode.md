# Server mode (multi-user)

LearnHarness has two deployment modes:

- **Standalone** — the Electron desktop app, `npm run dev`, and the test suite. No login; the one local user is the admin. Multi-user controls are hidden.
- **Server** — a headless Next server with a login list, per-user data, one admin, and a shared configuration. Enabled explicitly with `LH_SERVER_MODE=1`.

The service is meant for a **trusted LAN with trusted users**. It is not hardened for Internet exposure: there is no TLS, rate limiting, or account lockout. App-data paths are denied to the learner file tools, but the server's other files remain readable to agents.

Because the default is plain HTTP on a LAN address, client code must not rely on secure-context-only browser APIs. For example, `crypto.randomUUID` is `undefined` at `http://<LAN-IP>:3000`; use `crypto.getRandomValues` or a fallback for client-side identifiers. A secure-context API throwing in a send path can abort the request before `/api/chat`, leaving the UI at “Thinking…”.

## Quick start

```bash
npm ci
npm run build            # produces .next/standalone
npm run server           # headless production server
```

For development with HMR:

```bash
npm run dev:server
# if 3000 is busy (another dev shell):
LH_PORT=3101 npm run dev:server
```

Both launchers read `data/server.json` before Next starts:

```json
{
  "version": 1,
  "host": "0.0.0.0",
  "port": 3000,
  "secret": "<generated once>"
}
```

The default bind address is `0.0.0.0`, so other machines on the LAN can reach the printed URLs. Use `127.0.0.1` for a local-only server. `LH_HOST` / `LH_PORT` override the file for one launch; the Settings → Server page edits the file and reports whether a restart is required.

The data root is `data/` by default; set `LH_DATA_DIR` for a different location. For an isolated trial:

```bash
LH_DATA_DIR=/tmp/lh-server-data LH_PORT=3101 npm run dev:server
```
In server mode the provider-key file defaults to `<data>/auth.json`. If it does not exist and the repository-root `auth.json` does, the launcher copies it once with mode `0600`. Set `LH_AUTH_FILE` explicitly to override.

## Launch scripts

The repository root has one launcher per platform. All three call the same
`scripts/launch-server.mjs`, so the behavior is identical:

| Platform | File | Start |
| --- | --- | --- |
| Linux | `start-server.sh` | `./start-server.sh` |
| macOS | `start-server.command` | double-click in Finder, or `./start-server.command` |
| Windows | `start-server.cmd` | double-click, or `start-server.cmd` in a terminal |

The first launch installs dependencies (`npm ci`) and builds the production
server when `node_modules` or `.next/standalone/server.js` is missing. Later
launches start immediately. Options:

- `--dev` — run the development server with HMR instead of the production build
- `--build` — force a fresh production build
- `--host <addr>` / `--port <n>` — override the bind address or port for this launch
- `--help` — show the options

A fresh `data/server.json` binds to `0.0.0.0`, so other machines on the LAN can
connect. Use `--host 127.0.0.1` for a local-only launch. Node.js 22 or newer is
required (CI uses Node 26).

## First boot and login

On the first server start, `data/users.json` is created with **one passwordless account named “Admin”**. The login page lists account names; select the admin and either set a password or choose **Skip for now**. The same set-password/skip flow applies to every newly created user.

- Passwords are hashed with scrypt and must be at least 8 characters.
- “Keep me signed in on this browser” is unchecked by default. Checked, the cookie becomes persistent (currently ten years; browsers may cap it). Unchecked, it lasts for the browser session.
- Logging out deletes the cookie.
- Changing or resetting a password invalidates the account's older sessions.
- The account menu in the sidebar offers **Change password** and **Log out**.
- If a password is skipped, anyone on the trusted network can select that account. Set one when possible.

## Per-user data

```text
data/
  settings.json          shared non-secret configuration
  auth.json              shared provider keys (server-mode default)
  users.json             accounts, scrypt hashes, session versions (0600)
  server.json            port, host, cookie secret (0600)
  appearance.json        admin's appearance
  prompts/               shared prompt overrides
  chats/ graph/ jobs/ debug/     admin's records
  users/
    usr_.../
      appearance.json
      chats/
      graph/
      jobs/
      debug/
```

The admin uses the existing data root, so previous standalone sessions and graph data need no migration. Every other user gets `data/users/<id>/`. Chats, graph ledgers, jobs, source inventory, positions, render settings, traces and debug captures all resolve inside the active user's root.

API keys, model slots, provider connections, prompts, graph settings, compaction, dictation and the developer trace toggle are **shared configuration**. Only the admin can read or change them. A regular user's Settings dialog contains **Appearance only**; their appearance file is inside their own data root. The chat UI still receives a read-only runtime view of the model slots, graph chunk budget and dictation language from `/api/runtime`.

## Users management

Settings → Users is admin-only:

- **Add user** creates a passwordless account and its data folder.
- **Rename** changes the display name (unique, case-insensitive).
- **Reset password** clears the password and invalidates sessions; the user sets a new one at next login.
- **Delete** aborts any running turns/jobs/extractions, then removes the account and all of its data. It returns a conflict if work refuses to settle; retry after it stops.
- The single admin account cannot be deleted. There is no second-admin promotion.

The account registry is `data/users.json` (mode `0600`). Passwords are never returned by the API.

## Configuration access

- Admin: all shared settings, provider keys, model slots, prompts, users, server port/host, developer trace toggle.
- Regular user: appearance, their own chats/graph/jobs, session model choice, and the read-only runtime view.
- Login list: public names only (`GET /api/auth/users`), no hashes or session metadata.
- All API routes authenticate through the session cookie; the proxy also redirects page requests without a cookie to `/login`.

The port/host can be edited in Settings → Server. `npm run server` reads it at startup, so a change requires a restart. The Settings page shows both the configured and currently running values.

## Operations and recovery

- Back up the whole data root, not only user folders: `users.json`, `server.json`, `settings.json` and `auth.json` are global.
- Deleting `server.json` generates a new cookie secret and invalidates all sessions.
- If the admin password is lost, stop the server and remove the admin's `password` field in `data/users.json` (or restore a backup). The admin can then log in passwordless and set a new one. Keep the file mode unchanged.
- Run one server process per data root. Multiple processes would race the JSON/JSONL stores.
- `npm run smoke:server-mode` (after `npm run build`) starts a disposable headless instance and checks login, cookies, page redirects, shared settings visibility and per-user chat isolation.
- The headless server does not run the Electron browser-service helper. Demo verification falls back to system Chrome when available; PDF/SVG rendering is native.

## Not in scope

- Internet hardening, TLS termination, rate limits, account lockout.
- Desktop-to-remote-server connections (Electron remains standalone).
- Multiple admins, per-user API keys, or per-user shared-config overrides beyond appearance.
- A per-user OS-level filesystem sandbox. The app's `data/` root is denied to the learner file tools, but other server files are shared.
