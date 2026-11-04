/**
 * Server-component session helpers (multi-user wave, 2026-11-03):
 * next/headers and next/navigation live here so the pure route wrapper and
 * the store layers never import the request-render machinery.
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { runInScope } from "../core/request-scope.ts";
import { SESSION_COOKIE, sessionUserFromCookie, standaloneUser, type RequestUser } from "./session.ts";
import { isServerMode } from "./mode.ts";

/** The signed-in user, or null when a login is required. */
export async function pageSessionUser(): Promise<RequestUser | null> {
	if (!isServerMode()) return standaloneUser();
	const cookieStore = await cookies();
	return sessionUserFromCookie(cookieStore.get(SESSION_COOKIE)?.value);
}

/** The app shell's gate: server mode without a valid session goes to /login. */
export async function requirePageUser(): Promise<RequestUser> {
	const user = await pageSessionUser();
	if (!user) redirect("/login");
	return user;
}

/** Run a page's server-side data reads inside its user data scope. */
export async function withPageUser<T>(fn: (user: RequestUser) => T | Promise<T>): Promise<T> {
	const user = await requirePageUser();
	return runInScope({ userId: user.id, root: user.root }, () => fn(user));
}
