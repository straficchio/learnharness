/**
 * Auth + account HTTP composition (multi-user wave, 2026-11-03). Framework-
 * free so route files stay one-line wrappers and tests can drive the handlers
 * directly. Authentication is cookie-based; see session.ts for the token.
 */
import {
	clearSessionCookie,
	isAdmin,
	isServerMode,
	sessionCookieFor,
	type RequestUser,
} from "./session.ts";
import {
	clearUserPassword,
	createUserRecord,
	findUserRecord,
	listUserRecords,
	publicLoginUsers,
	renameUserRecord,
	setUserPassword,
	toAccountView,
	toSessionUser,
	userDataRoot,
	verifyPassword,
} from "./users.ts";
import { deleteUserCompletely } from "./user-deletion.ts";

function json(body: unknown, init?: ResponseInit): Response {
	return Response.json(body, {
		...init,
		headers: { "Cache-Control": "no-store", ...(init?.headers ?? {}) },
	});
}

function sessionBody(user: RequestUser) {
	return {
		user: { id: user.id, name: user.name, role: user.role, hasPassword: user.hasPassword },
		serverMode: isServerMode(),
		standalone: !isServerMode(),
	};
}

async function body(req: Request): Promise<Record<string, unknown>> {
	try {
		const parsed = await req.json();
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
	} catch {
		return {};
	}
}

export function authUsersResponse(): Response {
	if (!isServerMode()) return json({ users: [], serverMode: false, standalone: true });
	return json({ users: publicLoginUsers(), serverMode: true, standalone: false });
}

export async function authLoginResponse(req: Request): Promise<Response> {
	if (!isServerMode()) return json({ error: "Standalone mode has no login." }, { status: 404 });
	const input = await body(req);
	const userId = typeof input.userId === "string" ? input.userId : "";
	const record = findUserRecord(userId);
	if (!record) return json({ error: "Unknown user." }, { status: 401 });
	const remember = input.remember === true;

	if (record.password) {
		if (!(await verifyPassword(record, input.password))) {
			return json({ error: "Incorrect password." }, { status: 401 });
		}
	} else if (typeof input.newPassword === "string" && input.newPassword.length > 0) {
		try {
			const updated = await setUserPassword(record.id, input.newPassword);
			const user: RequestUser = {
				...toSessionUser(updated),
				root: userDataRoot(updated),
				sessionVersion: updated.sessionVersion,
			};
			return json(sessionBody(user), { headers: { "Set-Cookie": sessionCookieFor(user, remember) } });
		} catch (error) {
			return json({ error: error instanceof Error ? error.message : "Could not set the password." }, { status: 400 });
		}
	}

	const user: RequestUser = {
		...toSessionUser(record),
		root: userDataRoot(record),
		sessionVersion: record.sessionVersion,
	};
	return json(sessionBody(user), { headers: { "Set-Cookie": sessionCookieFor(user, remember) } });
}

export function authLogoutResponse(): Response {
	return json({ ok: true }, { headers: { "Set-Cookie": clearSessionCookie() } });
}

export function authMeResponse(user: RequestUser): Response {
	return json(sessionBody(user));
}

export async function authPasswordResponse(req: Request, user: RequestUser): Promise<Response> {
	const input = await body(req);
	const record = findUserRecord(user.id);
	if (!record) return json({ error: "User not found." }, { status: 401 });
	if (record.password && !(await verifyPassword(record, input.currentPassword))) {
		return json({ error: "Current password is incorrect." }, { status: 401 });
	}
	const newPassword = typeof input.newPassword === "string" ? input.newPassword : "";
	try {
		const updated = await setUserPassword(record.id, newPassword);
		const next: RequestUser = {
			...toSessionUser(updated),
			root: user.root,
			sessionVersion: updated.sessionVersion,
		};
		return json(sessionBody(next), { headers: { "Set-Cookie": sessionCookieFor(next, false) } });
	} catch (error) {
		return json({ error: error instanceof Error ? error.message : "Could not change the password." }, { status: 400 });
	}
}

// ─── Admin user management ─────────────────────────────────────────────────

export function usersAdminResponse(user: RequestUser): Response {
	if (!isAdmin(user)) return json({ error: "Admin access required." }, { status: 403 });
	return json({ users: listUserRecords().map(toAccountView), serverMode: isServerMode() });
}

export async function createUserResponse(req: Request, user: RequestUser): Promise<Response> {
	if (!isAdmin(user)) return json({ error: "Admin access required." }, { status: 403 });
	const input = await body(req);
	try {
		const created = createUserRecord(input.name);
		return json({ user: toAccountView(created) });
	} catch (error) {
		return json({ error: error instanceof Error ? error.message : "Could not create the user." }, { status: 400 });
	}
}

export async function updateUserResponse(req: Request, id: string, user: RequestUser): Promise<Response> {
	if (!isAdmin(user)) return json({ error: "Admin access required." }, { status: 403 });
	const input = await body(req);
	try {
		const updated = renameUserRecord(id, input.name);
		return json({ user: toAccountView(updated) });
	} catch (error) {
		return json({ error: error instanceof Error ? error.message : "Could not rename the user." }, { status: 400 });
	}
}

export async function deleteUserResponse(id: string, user: RequestUser): Promise<Response> {
	if (!isAdmin(user)) return json({ error: "Admin access required." }, { status: 403 });
	try {
		const removed = await deleteUserCompletely(id);
		return json({ deleted: toAccountView(removed) });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Could not delete the user.";
		const status = /cannot be deleted|not found/i.test(message) ? 400 : 409;
		return json({ error: message }, { status });
	}
}

export function resetPasswordResponse(id: string, user: RequestUser): Response {
	if (!isAdmin(user)) return json({ error: "Admin access required." }, { status: 403 });
	try {
		const updated = clearUserPassword(id);
		return json({ user: toAccountView(updated) });
	} catch (error) {
		return json({ error: error instanceof Error ? error.message : "Could not reset the password." }, { status: 400 });
	}
}
