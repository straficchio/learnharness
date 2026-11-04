"use client";

/**
 * The server-mode login list (multi-user wave, 2026-11-03). Users select their
 * name; passwordless accounts get the first-login setup step with a skip
 * option. "Keep me signed in" is opt-in and defaults off.
 */
import { useCallback, useEffect, useState } from "react";
import { LhMark } from "@/components/lh-mark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { LoginUser } from "@/src/core";

type Phase = "list" | "password" | "setup";

export function LoginForm() {
	const [users, setUsers] = useState<LoginUser[] | null>(null);
	const [selected, setSelected] = useState<LoginUser | null>(null);
	const [phase, setPhase] = useState<Phase>("list");
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [remember, setRemember] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		let alive = true;
		fetch("/api/auth/users", { cache: "no-store" })
			.then((response) => response.ok ? response.json() as Promise<{ users?: LoginUser[] }> : Promise.reject(new Error("list failed")))
			.then((body) => { if (alive) setUsers(body.users ?? []); })
			.catch(() => { if (alive) { setUsers([]); setError("Could not load the user list. Is the server running?"); } });
		return () => { alive = false; };
	}, []);

	const choose = useCallback((user: LoginUser) => {
		setSelected(user);
		setPhase(user.hasPassword ? "password" : "setup");
		setPassword("");
		setConfirm("");
		setError(null);
	}, []);

	const back = useCallback(() => {
		setSelected(null);
		setPhase("list");
		setPassword("");
		setConfirm("");
		setError(null);
	}, []);

	const submit = useCallback(async (setPasswordNow: boolean) => {
		if (!selected) return;
		setError(null);
		if (!selected.hasPassword && setPasswordNow) {
			if (password.length < 8) return setError("Passwords must be at least 8 characters.");
			if (password !== confirm) return setError("The passwords do not match.");
		}
		if (selected.hasPassword && !password) return setError("Enter your password.");
		setBusy(true);
		try {
			const response = await fetch("/api/auth/login", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					userId: selected.id,
					remember,
					...(selected.hasPassword ? { password } : setPasswordNow ? { newPassword: password } : {}),
				}),
			});
			const body = await response.json().catch(() => ({})) as { error?: string };
			if (!response.ok) throw new Error(body.error ?? "Could not sign in.");
			window.location.assign("/");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not sign in.");
			setBusy(false);
		}
	}, [confirm, password, remember, selected]);

	return (
		<main className="flex min-h-dvh items-center justify-center bg-background px-4 py-10 text-foreground">
			<div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-xl">
				<div className="mb-6 flex items-center gap-3">
					<LhMark className="size-9" />
					<div>
						<h1 className="font-title text-2xl tracking-tight">Learning Harness</h1>
						<p className="text-xs text-muted-foreground">Choose your account to continue.</p>
					</div>
				</div>

				{phase === "list" && (
					<div className="space-y-2" data-testid="login-user-list">
						{users === null && <p className="text-sm text-muted-foreground">Loading users…</p>}
						{users?.length === 0 && <p className="text-sm text-muted-foreground">No users configured. Restart the server to create the admin account.</p>}
						{users?.map((user) => (
							<button
								key={user.id}
								type="button"
								data-testid={`login-user-${user.name}`}
								onClick={() => choose(user)}
								className="flex w-full cursor-pointer items-center justify-between rounded-lg border border-border/80 px-3 py-2.5 text-left transition-colors hover:border-border hover:bg-accent"
							>
								<span className="font-prose text-sm">{user.name}</span>
								<span className="text-[11px] uppercase tracking-wide text-muted-foreground">
									{user.role === "admin" ? "Admin" : user.hasPassword ? "" : "No password"}
								</span>
							</button>
						))}
					</div>
				)}

				{phase !== "list" && selected && (
					<form
						className="space-y-4"
						data-testid="login-password-form"
						onSubmit={(event) => {
							event.preventDefault();
							void submit(!selected.hasPassword);
						}}
					>
						<div className="flex items-center justify-between gap-3">
							<div>
								<div className="font-prose text-base">{selected.name}</div>
								<div className="text-xs text-muted-foreground">
									{selected.hasPassword ? "Enter your password." : "This account has no password yet."}
								</div>
							</div>
							<button type="button" onClick={back} className="cursor-pointer text-xs text-muted-foreground underline-offset-2 hover:underline">
								Change user
							</button>
						</div>

						<label className="block space-y-1 text-xs text-muted-foreground">
							<span>{selected.hasPassword ? "Password" : "New password (optional)"}</span>
							<Input
								type="password"
								autoFocus
								autoComplete={selected.hasPassword ? "current-password" : "new-password"}
								value={password}
								onChange={(event) => setPassword(event.target.value)}
								data-testid="login-password"
							/>
						</label>
						{!selected.hasPassword && (
							<label className="block space-y-1 text-xs text-muted-foreground">
								<span>Confirm password</span>
								<Input
									type="password"
									autoComplete="new-password"
									value={confirm}
									onChange={(event) => setConfirm(event.target.value)}
									data-testid="login-confirm"
								/>
							</label>
						)}
						<label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
							<input
								type="checkbox"
								checked={remember}
								onChange={(event) => setRemember(event.target.checked)}
								data-testid="login-remember"
								className="size-3.5 accent-foreground"
							/>
							Keep me signed in on this browser
						</label>

						<div className="flex flex-wrap items-center gap-2">
							<Button type="submit" size="sm" disabled={busy} data-testid="login-submit">
								{busy ? "Signing in…" : selected.hasPassword ? "Sign in" : password ? "Set password and continue" : "Continue"}
							</Button>
							{!selected.hasPassword && (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									disabled={busy}
									onClick={() => void submit(false)}
									data-testid="login-skip"
								>
									Skip for now
								</Button>
							)}
						</div>
						{!selected.hasPassword && (
							<p className="text-[11px] leading-relaxed text-muted-foreground">
								You can set a password later from the account menu. Without one, anyone on this trusted network can select this account.
							</p>
						)}
					</form>
				)}

				{error && <p role="alert" className="mt-4 text-xs text-destructive" data-testid="login-error">{error}</p>}
			</div>
		</main>
	);
}
