"use client";

/**
 * The signed-in user for client surfaces (multi-user wave, 2026-11-03):
 * settings navigation, the sidebar account menu, and login/logout flows.
 * Server pages still authenticate independently; this context only drives UI.
 */
import { createContext, useContext } from "react";
import type { SessionUser } from "@/src/core";

export interface SessionContextValue {
	user: SessionUser;
	serverMode: boolean;
	standalone: boolean;
}

const STANDALONE: SessionContextValue = {
	user: { id: "local", name: "Local", role: "admin", hasPassword: false },
	serverMode: false,
	standalone: true,
};

const SessionContext = createContext<SessionContextValue>(STANDALONE);

export function SessionProvider({
	user,
	serverMode,
	standalone,
	children,
}: SessionContextValue & { children: React.ReactNode }) {
	return <SessionContext.Provider value={{ user, serverMode, standalone }}>{children}</SessionContext.Provider>;
}

export function useSessionUser(): SessionContextValue {
	return useContext(SessionContext);
}
