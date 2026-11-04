/**
 * THE ACCOUNT STORE (multi-user wave, 2026-11-03): data/users.json.
 *
 * Server mode has exactly one admin (`usr_admin`) plus any number of regular
 * users. Passwords are scrypt hashes; the file is mode 0600. The admin's data
 * root is the base data dir; every regular user's root is
 * <base>/users/<id>/. Names are display names and are unique
 * case-insensitively; ids are opaque and never derived from names.
 *
 * Standalone mode never creates or reads this file: the shell gets a synthetic
 * local admin (src/server/session.ts).
 */
import { randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { BASE_DATA_ROOT, USERS_DIR, USERS_FILE } from "../../config.ts";
import type { SessionUser, UserAccountView, UserRole } from "../core/contracts/users.ts";
import { isServerMode } from "./mode.ts";

const USERS_VERSION = 1;
const ADMIN_ID = "usr_admin";
export const ADMIN_DISPLAY_NAME = "Admin";
export const MIN_PASSWORD_LENGTH = 8;
const MAX_NAME_LENGTH = 64;

type PasswordHash = { salt: string; hash: string };

interface UserRecord {
	id: string;
	name: string;
	role: UserRole;
	createdAt: string;
	password: PasswordHash | null;
	sessionVersion: number;
}

interface UsersFile {
	version: number;
	users: UserRecord[];
}

function readFile(): UsersFile | null {
	let raw: string;
	try {
		raw = fs.readFileSync(USERS_FILE, "utf-8");
	} catch {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("users.json is corrupt — restore it from a backup before starting server mode.");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("users.json has an invalid shape — restore it from a backup.");
	}
	const value = parsed as Record<string, unknown>;
	const users = Array.isArray(value.users) ? value.users : [];
	const out: UserRecord[] = [];
	for (const item of users) {
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		const user = item as Record<string, unknown>;
		if (typeof user.id !== "string" || !/^usr_[A-Za-z0-9_-]+$/.test(user.id)) continue;
		if (typeof user.name !== "string" || !user.name.trim()) continue;
		if (user.role !== "admin" && user.role !== "user") continue;
		const password = user.password;
		const validPassword = password === null || (
			typeof password === "object" && !Array.isArray(password)
			&& typeof (password as Record<string, unknown>).salt === "string"
			&& typeof (password as Record<string, unknown>).hash === "string"
		);
		if (!validPassword) continue;
		out.push({
			id: user.id,
			name: user.name,
			role: user.role,
			createdAt: typeof user.createdAt === "string" ? user.createdAt : new Date(0).toISOString(),
			password: password as PasswordHash | null,
			sessionVersion: typeof user.sessionVersion === "number" && Number.isSafeInteger(user.sessionVersion) && user.sessionVersion >= 0
				? user.sessionVersion
				: 1,
		});
	}
	return { version: typeof value.version === "number" ? value.version : USERS_VERSION, users: out };
}

function writeFile(file: UsersFile): void {
	fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true, mode: 0o700 });
	const tmp = `${USERS_FILE}.${randomBytes(8).toString("hex")}.tmp`;
	try {
		fs.writeFileSync(tmp, `${JSON.stringify(file, null, "\t")}\n`, { encoding: "utf-8", mode: 0o600 });
		fs.renameSync(tmp, USERS_FILE);
	} finally {
		fs.rmSync(tmp, { force: true });
	}
}

function adminRecord(name = ADMIN_DISPLAY_NAME): UserRecord {
	return {
		id: ADMIN_ID,
		name,
		role: "admin",
		createdAt: new Date().toISOString(),
		password: null,
		sessionVersion: 1,
	};
}

function uniqueName(users: UserRecord[], wanted: string, exceptId?: string): string {
	const base = wanted.trim().slice(0, MAX_NAME_LENGTH);
	if (!base) throw new Error("A user name is required.");
	let candidate = base;
	let n = 2;
	while (users.some((user) => user.id !== exceptId && user.name.toLocaleLowerCase() === candidate.toLocaleLowerCase())) {
		candidate = `${base} ${n++}`;
	}
	return candidate;
}

function validName(raw: unknown): string {
	if (typeof raw !== "string") throw new Error("A user name is required.");
	const name = raw.trim();
	if (!name) throw new Error("A user name is required.");
	if (name.length > MAX_NAME_LENGTH) throw new Error(`User names are limited to ${MAX_NAME_LENGTH} characters.`);
	if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error("User names cannot contain control characters.");
	return name;
}

/** Read the registry; in server mode create the admin on first boot and heal
 *  a registry that lost its admin. Standalone never touches the file. */
export function loadUsers(): UsersFile {
	if (!isServerMode()) return { version: USERS_VERSION, users: [] };
	const existing = readFile();
	if (!existing) {
		const created = { version: USERS_VERSION, users: [adminRecord()] };
		writeFile(created);
		return created;
	}
	if (!existing.users.some((user) => user.role === "admin")) {
		const name = uniqueName(existing.users, ADMIN_DISPLAY_NAME);
		existing.users.unshift(adminRecord(name));
		writeFile(existing);
	}
	return existing;
}

export function findUserRecord(id: string): UserRecord | null {
	if (!/^usr_[A-Za-z0-9_-]+$/.test(id)) return null;
	return loadUsers().users.find((user) => user.id === id) ?? null;
}

export function findUserByName(name: string): UserRecord | null {
	const normalized = name.trim().toLocaleLowerCase();
	return loadUsers().users.find((user) => user.name.toLocaleLowerCase() === normalized) ?? null;
}

export function listUserRecords(): UserRecord[] {
	return [...loadUsers().users].sort((a, b) => {
		if (a.role !== b.role) return a.role === "admin" ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
}

export function toSessionUser(user: UserRecord): SessionUser {
	return {
		id: user.id,
		name: user.name,
		role: user.role,
		hasPassword: user.password !== null,
	};
}

export function toAccountView(user: UserRecord): UserAccountView {
	return { ...toSessionUser(user), createdAt: user.createdAt };
}

export function userDataRoot(user: Pick<UserRecord, "id" | "role">): string {
	if (user.role === "admin") return BASE_DATA_ROOT;
	return path.join(USERS_DIR, user.id);
}

export function ensureUserDataRoot(user: Pick<UserRecord, "id" | "role">): void {
	const root = userDataRoot(user);
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
}

export function createUserRecord(rawName: unknown): UserRecord {
	const name = validName(rawName);
	const file = loadUsers();
	if (file.users.some((user) => user.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
		throw new Error("A user with that name already exists.");
	}
	const record: UserRecord = {
		id: `usr_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
		name,
		role: "user",
		createdAt: new Date().toISOString(),
		password: null,
		sessionVersion: 1,
	};
	file.users.push(record);
	writeFile(file);
	ensureUserDataRoot(record);
	return record;
}

export function renameUserRecord(id: string, rawName: unknown): UserRecord {
	const name = validName(rawName);
	const file = loadUsers();
	const user = file.users.find((candidate) => candidate.id === id);
	if (!user) throw new Error("User not found.");
	if (file.users.some((candidate) => candidate.id !== id && candidate.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
		throw new Error("A user with that name already exists.");
	}
	user.name = name;
	writeFile(file);
	return user;
}

/** Remove the ACCOUNT only. The HTTP layer aborts work and deletes the data
 *  root; this store refuses to remove the one admin. */
export function removeUserRecord(id: string): UserRecord {
	const file = loadUsers();
	const user = file.users.find((candidate) => candidate.id === id);
	if (!user) throw new Error("User not found.");
	if (user.role === "admin") throw new Error("The admin account cannot be deleted.");
	file.users = file.users.filter((candidate) => candidate.id !== id);
	writeFile(file);
	return user;
}

export function clearUserPassword(id: string): UserRecord {
	const file = loadUsers();
	const user = file.users.find((candidate) => candidate.id === id);
	if (!user) throw new Error("User not found.");
	if (user.role === "admin") throw new Error("Change the admin password from the account menu.");
	user.password = null;
	user.sessionVersion += 1;
	writeFile(file);
	return user;
}

const scryptAsync = (password: string, salt: Buffer, keylen: number) =>
	new Promise<Buffer>((resolve, reject) => {
		scrypt(password, salt, keylen, { N: 16_384, r: 8, p: 1 }, (error, key) => {
			if (error) reject(error);
			else resolve(key);
		});
	});

export async function hashPassword(password: string): Promise<PasswordHash> {
	if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
		throw new Error(`Passwords must be at least ${MIN_PASSWORD_LENGTH} characters.`);
	}
	const salt = randomBytes(16);
	const hash = await scryptAsync(password, salt, 64);
	return { salt: salt.toString("hex"), hash: hash.toString("hex") };
}

export async function verifyPassword(user: UserRecord, password: unknown): Promise<boolean> {
	if (!user.password) return true;
	if (typeof password !== "string" || !password) return false;
	const expected = Buffer.from(user.password.hash, "hex");
	const actual = await scryptAsync(password, Buffer.from(user.password.salt, "hex"), expected.length);
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Set a known hash and invalidate older sessions. */
export function storePasswordHash(id: string, password: PasswordHash): UserRecord {
	const file = loadUsers();
	const user = file.users.find((candidate) => candidate.id === id);
	if (!user) throw new Error("User not found.");
	user.password = password;
	user.sessionVersion += 1;
	writeFile(file);
	return user;
}

export async function setUserPassword(id: string, password: string): Promise<UserRecord> {
	return storePasswordHash(id, await hashPassword(password));
}

/** Public login-list rows + admin metadata; no hashes or session versions. */
export function publicLoginUsers(): Array<SessionUser> {
	return listUserRecords().map(toSessionUser);
}

export function adminExists(): boolean {
	return loadUsers().users.some((user) => user.role === "admin");
}

export { ADMIN_ID };
