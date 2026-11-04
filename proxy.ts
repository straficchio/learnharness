import { NextResponse, type NextRequest } from "next/server";
import { desktopAPIAuthorized } from "./src/server/desktop-access.ts";
import { isServerMode } from "./src/server/mode.ts";
import { SESSION_COOKIE } from "./src/server/session.ts";

/** Applies to the authenticated pages and every API method. API handlers
 *  re-authenticate through withUser; this proxy only short-circuits page
 *  requests when the login cookie is absent and keeps the Electron desktop
 *  capability check. */
export function proxy(request: NextRequest) {
	const { pathname } = request.nextUrl;
	const isApi = pathname === "/api" || pathname.startsWith("/api/");

	// The Electron capability is injected only on /api/* by the shell. Page
	// requests must never run this check (they carry no desktop header).
	if (isApi && !desktopAPIAuthorized(request.headers)) {
		return NextResponse.json(
			{ error: "Desktop API access requires the trusted LearnHarness window." },
			{ status: 403, headers: { "Cache-Control": "no-store" } },
		);
	}

	if (isServerMode()) {
		if (!isApi && pathname !== "/login" && !request.cookies.has(SESSION_COOKIE)) {
			const url = request.nextUrl.clone();
			url.pathname = "/login";
			url.search = "";
			return NextResponse.redirect(url);
		}
	}

	return NextResponse.next();
}

export const config = {
	matcher: ["/", "/chat/:path*", "/settings", "/login", "/api/:path*"],
};
