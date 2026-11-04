/**
 * Browser-safe authentication/account DTOs (multi-user wave, 2026-11-03).
 * Password hashes, session versions and filesystem roots stay server-side.
 */

export type UserRole = "admin" | "user";

/** The current user as the shell needs it (sidebar, settings nav). */
export interface SessionUser {
	id: string;
	name: string;
	role: UserRole;
	hasPassword: boolean;
}

/** One row on the public login list. */
export interface LoginUser {
	id: string;
	name: string;
	role: UserRole;
	hasPassword: boolean;
}

/** One row in the admin's Users settings section. */
export interface UserAccountView extends SessionUser {
	createdAt: string;
}

export interface AuthStatusResponse {
	user: SessionUser;
	serverMode: boolean;
	standalone: boolean;
}

export interface ServerConfigView {
	/** Configured values (data/server.json). */
	port: number;
	host: string;
	/** What this process actually bound (PORT/HOSTNAME), when known. */
	runningPort: number | null;
	runningHost: string | null;
	/** True when the configured values differ from the running process. */
	restartRequired: boolean;
}

export const DEFAULT_SERVER_PORT = 3000;
export const DEFAULT_SERVER_HOST = "0.0.0.0";
