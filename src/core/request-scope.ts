/**
 * THE REQUEST DATA SCOPE (multi-user wave, 2026-11-03).
 *
 * Multi-user server mode gives every browser request a user + data root. The
 * store adapters are process-wide singletons, so the scope must ride Node's
 * AsyncLocalStorage — never a mutable "current user" variable (two concurrent
 * requests would clobber each other). The storage itself is globalThis-backed
 * for the same reason the event bus and turn registries are: Next dev gives
 * each route entry its own module instance, and an ordinary module-level ALS
 * would be a different object in the route and the store it calls.
 *
 * Standalone mode (Electron, plain dev, the test suite) never installs a
 * scope; `scopeRoot(fallback)` returns the legacy data root unchanged.
 *
 * This module is server/store-only. It must never be re-exported from
 * src/core/index.ts: it imports node:async_hooks and would drag that into
 * the browser bundle.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestScope {
	/** Stable account id (`local` in standalone mode). */
	userId: string;
	/** Absolute data root for this user. Admin = the base data dir. */
	root: string;
}

interface ScopeGlobal {
	__lhRequestScope?: AsyncLocalStorage<RequestScope>;
}

function storage(): AsyncLocalStorage<RequestScope> {
	const g = globalThis as typeof globalThis & ScopeGlobal;
	return (g.__lhRequestScope ??= new AsyncLocalStorage<RequestScope>());
}

/** Run `fn` (and every async continuation it starts) inside one user scope. */
export function runInScope<T>(scope: RequestScope, fn: () => T): T {
	return storage().run(scope, fn);
}

export function currentScope(): RequestScope | undefined {
	return storage().getStore();
}

export function currentScopeId(): string | undefined {
	return currentScope()?.userId;
}

/** The scoped root, or the legacy/base root when no request scope is active. */
export function scopeRoot(fallback: string): string {
	return currentScope()?.root ?? fallback;
}

/** Chat-id → data scope registry. Background callbacks that fire outside a
 *  request (subscription-connection changes, queued wake pumps) need the
 *  owner's root; every chat read/create remembers it while a request scope is
 *  active. */
interface ChatScopeGlobal {
	__lhChatScopes?: Map<string, RequestScope>;
}

function chatScopes(): Map<string, RequestScope> {
	const g = globalThis as typeof globalThis & ChatScopeGlobal;
	return (g.__lhChatScopes ??= new Map());
}

export function rememberChatScope(chatId: string, scope: RequestScope | undefined = currentScope()): void {
	if (scope) chatScopes().set(chatId, scope);
}

export function forgetChatScope(chatId: string): void {
	chatScopes().delete(chatId);
}

export function chatScope(chatId: string): RequestScope | undefined {
	return chatScopes().get(chatId);
}

/** Run a background callback in the chat owner's scope when known. */
export function runInChatScope<T>(chatId: string, fn: () => T): T {
	const scope = chatScopes().get(chatId);
	return scope ? runInScope(scope, fn) : fn();
}

