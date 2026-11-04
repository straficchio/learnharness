/**
 * THE SESSION SEAM (multi-user wave, 2026-11-03).
 *
 * Server mode authenticates every API route through a signed, HttpOnly cookie.
 * The token carries only the account id + session version; the account is
 * re-read from users.json on every request so deletion and password resets
 * invalidate live sessions immediately. Standalone mode returns the synthetic
 * local admin and never looks at a cookie.
 *
 * The cookie token is HMAC-SHA256 over a base64url payload, signed with the
 * secret in data/server.json. No dependency on a JWT library, no server-side
 * session table, and logout is just cookie deletion.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { runInScope, type RequestScope } from "../core/request-scope.ts";
import type { SessionUser } from "../core/contracts/users.ts";
import { isServerMode } from "./mode.ts";
export { isServerMode } from "./mode.ts";
import { readServerConfig } from "./server-config.ts";
import { findUserRecord, toSessionUser, userDataRoot } from "./users.ts";
import { BASE_DATA_ROOT } from "../../config.ts";

export const SESSION_COOKIE = "lh_session";
/** Ten years. Browsers may cap persistent cookies (Chrome currently 400 days). */
const REMEMBER_MAX_AGE = 60 * 60 * 24 * 365 * 10;

export interface RequestUser extends SessionUser {
	root: string;
	/** The users.json session version the token must match. */
	sessionVersion: number;
}

export interface SessionToken {
	sub: string;
	ver: number;
}

function localAdmin(): RequestUser {
	return {
		id: "local",
		name: "Local",
		role: "admin",
		hasPassword: false,
		root: BASE_DATA_ROOT,
		sessionVersion: 0,
	};
}

export function isStandaloneMode(): boolean {
	return !isServerMode();
}

export function standaloneUser(): RequestUser {
	return localAdmin();
}

export function requestUser(user: SessionUser): RequestUser {
	const record = findUserRecord(user.id);
	return {
		...user,
		root: record ? userDataRoot(record) : BASE_DATA_ROOT,
		sessionVersion: record?.sessionVersion ?? 0,
	};
}

function sign(payload: SessionToken): string {
	const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
	const mac = createHmac("sha256", readServerConfig().secret).update(body).digest("base64url");
	return `${body}.${mac}`;
}

function verify(token: string | undefined): SessionToken | null {
	if (!token) return null;
	const dot = token.lastIndexOf(".");
	if (dot <= 0) return null;
	const body = token.slice(0, dot);
	const supplied = Buffer.from(token.slice(dot + 1), "base64url");
	const expected = createHmac("sha256", readServerConfig().secret).update(body).digest();
	if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
	try {
		const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
		if (typeof parsed.sub !== "string" || typeof parsed.ver !== "number" || !Number.isSafeInteger(parsed.ver)) return null;
		return { sub: parsed.sub, ver: parsed.ver };
	} catch {
		return null;
	}
}

function tokenFor(user: RequestUser): string {
	return sign({ sub: user.id, ver: user.sessionVersion });
}

function cookieAttributes(): string {
	// Trusted-LAN HTTP: no Secure. SameSite=Lax blocks cross-site state changes.
	return "Path=/; HttpOnly; SameSite=Lax";
}

export function sessionCookieFor(user: RequestUser, remember: boolean): string {
	const age = remember ? `; Max-Age=${REMEMBER_MAX_AGE}` : "";
	return `${SESSION_COOKIE}=${encodeURIComponent(tokenFor(user))}; ${cookieAttributes()}${age}`;
}

export function clearSessionCookie(): string {
	return `${SESSION_COOKIE}=; ${cookieAttributes()}; Max-Age=0`;
}

/** Parse the Cookie header without Next's request helpers (route tests call
 *  handlers with a plain Request). */
export function cookieValue(header: string | null, name = SESSION_COOKIE): string | undefined {
	if (!header) return undefined;
	for (const part of header.split(";")) {
		const index = part.indexOf("=");
		if (index < 0) continue;
		if (part.slice(0, index).trim() !== name) continue;
		try {
			return decodeURIComponent(part.slice(index + 1).trim());
		} catch {
			return part.slice(index + 1).trim();
		}
	}
	return undefined;
}

function resolveTokenUser(rawToken: string | undefined): RequestUser | null {
	const token = verify(rawToken);
	if (!token) return null;
	const record = findUserRecord(token.sub);
	if (!record || record.sessionVersion !== token.ver) return null;
	return {
		...toSessionUser(record),
		root: userDataRoot(record),
		sessionVersion: record.sessionVersion,
	};
}

/** Resolve the signed-in user from a raw Request. Standalone = local admin. */
export function requestSessionUser(req: Request): RequestUser | null {
	if (!isServerMode()) return localAdmin();
	return resolveTokenUser(cookieValue(req.headers.get("cookie")));
}

/** Re-resolve a cookie value (the page-session helper uses next/headers). */
export function sessionUserFromCookie(value: string | undefined): RequestUser | null {
	if (!isServerMode()) return localAdmin();
	return resolveTokenUser(value);
}

/** Role check used by the server-side account helpers. */
export function isAdmin(user: RequestUser | null): boolean {
	return user?.role === "admin";
}

export type RouteHandler<Ctx> = (req: Request, ctx: Ctx, user: RequestUser) => Response | Promise<Response>;

/** Wrap one route export: authenticate, authorize, and install the user data
 *  scope for the handler and every async continuation it starts. */
export function withUser<Ctx = unknown, R extends Response | Promise<Response> = Response | Promise<Response>>(
	handler: (req: Request, ctx: Ctx, user: RequestUser) => R,
	options: { admin?: boolean; serverOnly?: boolean } = {},
): (req?: Request, ctx?: Ctx) => R {
	return (req, ctx) => {
		const request = req ?? new Request("http://localhost/");
		if (options.serverOnly && !isServerMode()) {
			return Response.json({ error: "Not available in standalone mode." }, { status: 404 }) as R;
		}
		let user: RequestUser | null;
		try {
			user = requestSessionUser(request);
		} catch (error) {
			console.error("[auth] session lookup failed:", error);
			return Response.json({ error: "Authentication is temporarily unavailable." }, { status: 500 }) as R;
		}
		if (!user) return Response.json({ error: "Sign in required." }, { status: 401 }) as R;
		if (options.admin && user.role !== "admin") {
			return Response.json({ error: "Admin access required." }, { status: 403 }) as R;
		}
		const scope: RequestScope = { userId: user.id, root: user.root };
		return runInScope(scope, () => handler(request, ctx as Ctx, user));
	};
}

