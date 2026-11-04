"use client";

/**
 * Settings → Users (multi-user wave, 2026-11-03): the admin's account
 * management surface. New accounts are passwordless; the user sets a
 * password at first login. Reset clears the password and invalidates live
 * sessions. Delete removes the account and its entire per-user data folder.
 */
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSessionUser } from "@/components/session-user";
import type { UserAccountView } from "@/src/core";

export function UsersSection() {
	const { user: current } = useSessionUser();
	const [users, setUsers] = useState<UserAccountView[] | null>(null);
	const [name, setName] = useState("");
	const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const load = useCallback(async () => {
		try {
			const response = await fetch("/api/users", { cache: "no-store" });
			const body = await response.json().catch(() => ({})) as { users?: UserAccountView[]; error?: string };
			if (!response.ok) throw new Error(body.error ?? "Could not load users.");
			setUsers(body.users ?? []);
			setError(null);
		} catch (cause) {
			setUsers([]);
			setError(cause instanceof Error ? cause.message : "Could not load users.");
		}
	}, []);

	useEffect(() => { void load(); }, [load]);

	const mutate = useCallback(async (run: () => Promise<Response>, after?: () => void) => {
		setBusy(true);
		setError(null);
		try {
			const response = await run();
			const body = await response.json().catch(() => ({})) as { error?: string };
			if (!response.ok) throw new Error(body.error ?? "Request failed.");
			after?.();
			await load();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Request failed.");
		} finally {
			setBusy(false);
		}
	}, [load]);

	const create = () => {
		const trimmed = name.trim();
		if (!trimmed) return setError("Enter a user name.");
		void mutate(
			() => fetch("/api/users", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: trimmed }),
			}),
			() => setName(""),
		);
	};

	const rename = () => {
		if (!editing) return;
		const trimmed = editing.name.trim();
		if (!trimmed) return setError("Enter a user name.");
		void mutate(
			() => fetch(`/api/users/${encodeURIComponent(editing.id)}`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: trimmed }),
			}),
			() => setEditing(null),
		);
	};

	const reset = (user: UserAccountView) => {
		if (!window.confirm(`Clear ${user.name}'s password? They will set a new one at next login.`)) return;
		void mutate(() => fetch(`/api/users/${encodeURIComponent(user.id)}/reset-password`, { method: "POST" }));
	};

	const remove = (user: UserAccountView) => {
		if (!window.confirm(`Delete ${user.name} and ALL of their sessions, graph, and files? This cannot be undone.`)) return;
		void mutate(() => fetch(`/api/users/${encodeURIComponent(user.id)}`, { method: "DELETE" }));
	};

	return <div className="space-y-4" data-testid="users-section">
		<div className="flex items-end gap-2">
			<label className="min-w-0 flex-1 space-y-1 text-xs text-muted-foreground">
				<span>New user name</span>
				<Input
					value={name}
					onChange={(event) => setName(event.target.value)}
					placeholder="e.g. Alice"
					data-testid="users-new-name"
					onKeyDown={(event) => { if (event.key === "Enter") create(); }}
				/>
			</label>
			<Button type="button" size="sm" disabled={busy} onClick={create} data-testid="users-create">Add user</Button>
		</div>

		{users === null && <p className="text-xs text-muted-foreground">Loading users…</p>}
		{users?.length === 0 && <p className="text-xs text-muted-foreground">No users yet.</p>}
		{users?.map((user) => (
			<div key={user.id} className="rounded-lg border border-border/80 p-3" data-testid={`user-row-${user.name}`}>
				<div className="flex flex-wrap items-center gap-2">
					{editing?.id === user.id ? (
						<>
							<Input
								value={editing.name}
								onChange={(event) => setEditing({ id: user.id, name: event.target.value })}
								className="max-w-56"
								data-testid="user-rename-input"
								onKeyDown={(event) => { if (event.key === "Enter") rename(); }}
							/>
							<Button type="button" size="xs" disabled={busy} onClick={rename}>Save</Button>
							<Button type="button" size="xs" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
						</>
					) : (
						<>
							<span className="font-prose text-sm text-foreground">{user.name}</span>
							{user.id === current.id && <span className="text-[10px] uppercase tracking-wide text-muted-foreground">You</span>}
							<span className="text-[10px] uppercase tracking-wide text-muted-foreground">
								{user.role === "admin" ? "Admin" : user.hasPassword ? "Password set" : "No password"}
							</span>
						</>
					)}
				</div>
				{editing?.id !== user.id && (
					<div className="mt-2 flex flex-wrap gap-2">
						<Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => setEditing({ id: user.id, name: user.name })} data-testid={`user-rename-${user.name}`}>
							Rename
						</Button>
						{user.role !== "admin" && <>
							<Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => reset(user)} data-testid={`user-reset-${user.name}`}>
								Reset password
							</Button>
							<Button type="button" size="xs" variant="destructive" disabled={busy} onClick={() => remove(user)} data-testid={`user-delete-${user.name}`}>
								Delete
							</Button>
						</>}
					</div>
				)}
			</div>
		))}
		{error && <p role="alert" className="text-xs text-destructive" data-testid="users-error">{error}</p>}
		<p className="text-[11px] leading-relaxed text-muted-foreground">
			The admin account cannot be deleted. Deleting a user removes their sessions, graph, jobs, and debug files.
		</p>
	</div>;
}
