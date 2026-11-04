"use client";

/**
 * Sidebar account controls (multi-user wave, 2026-11-03): server mode only.
 * Change password keeps the current session valid (the server reissues the
 * cookie with the new session version); logout deletes it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { LogOutIcon, UserRoundIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSessionUser } from "@/components/session-user";

export function AccountMenu() {
	const { user, serverMode, standalone } = useSessionUser();
	const [hasPassword, setHasPassword] = useState(user.hasPassword);
	const [open, setOpen] = useState(false);
	const [dialog, setDialog] = useState(false);
	const [current, setCurrent] = useState("");
	const [next, setNext] = useState("");
	const [confirm, setConfirm] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const rootRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (!open) return;
		const close = (event: MouseEvent) => {
			if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
		};
		document.addEventListener("mousedown", close);
		return () => document.removeEventListener("mousedown", close);
	}, [open]);

	const save = useCallback(async () => {
		setError(null);
		setNotice(null);
		if (next.length < 8) return setError("Passwords must be at least 8 characters.");
		if (next !== confirm) return setError("The passwords do not match.");
		setBusy(true);
		try {
			const response = await fetch("/api/auth/password", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ currentPassword: current, newPassword: next }),
			});
			const body = await response.json().catch(() => ({})) as { error?: string };
			if (!response.ok) throw new Error(body.error ?? "Could not change the password.");
			setCurrent("");
			setNext("");
			setConfirm("");
			setHasPassword(true);
			setNotice("Password saved.");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not change the password.");
		} finally {
			setBusy(false);
		}
	}, [confirm, current, next]);

	const logout = useCallback(async () => {
		try {
			await fetch("/api/auth/logout", { method: "POST" });
		} finally {
			window.location.assign("/login");
		}
	}, []);

	if (!serverMode || standalone) return null;

	return (
		<div ref={rootRef} className="relative px-3 pb-1 pt-1" data-testid="account-menu">
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				data-testid="account-menu-trigger"
				className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
			>
				<UserRoundIcon className="size-3.5 shrink-0" />
				<span className="min-w-0 flex-1 truncate">{user.name}</span>
				<span className="text-[10px] uppercase tracking-wide">{user.role === "admin" ? "Admin" : ""}</span>
			</button>
			{open && (
				<div className="absolute bottom-full left-3 z-20 mb-1 w-52 rounded-lg border border-border bg-card p-1.5 text-xs shadow-xl">
					<button
						type="button"
						onClick={() => { setOpen(false); setDialog(true); setNotice(null); setError(null); }}
						data-testid="account-change-password"
						className="flex w-full cursor-pointer items-center rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent"
					>
						{hasPassword ? "Change password" : "Set a password"}
					</button>
					<button
						type="button"
						onClick={() => void logout()}
						data-testid="account-logout"
						className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-destructive transition-colors hover:bg-accent"
					>
						<LogOutIcon className="size-3" />
						Log out
					</button>
				</div>
			)}
			{dialog && (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4" role="dialog" aria-modal="true" aria-label="Change password">
					<div className="w-full max-w-sm rounded-xl border border-border bg-card p-5 shadow-xl">
						<h2 className="font-title text-xl tracking-tight">{hasPassword ? "Change password" : "Set a password"}</h2>
						<div className="mt-4 space-y-3">
							{hasPassword && (
								<label className="block space-y-1 text-xs text-muted-foreground">
									<span>Current password</span>
									<Input type="password" autoComplete="current-password" value={current} onChange={(event) => setCurrent(event.target.value)} data-testid="account-current-password" />
								</label>
							)}
							<label className="block space-y-1 text-xs text-muted-foreground">
								<span>New password</span>
								<Input type="password" autoComplete="new-password" value={next} onChange={(event) => setNext(event.target.value)} data-testid="account-new-password" />
							</label>
							<label className="block space-y-1 text-xs text-muted-foreground">
								<span>Confirm password</span>
								<Input type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} data-testid="account-confirm-password" />
							</label>
						</div>
						{error && <p role="alert" className="mt-3 text-xs text-destructive">{error}</p>}
						{notice && <p className="mt-3 text-xs text-muted-foreground">{notice}</p>}
						<div className="mt-4 flex justify-end gap-2">
							<Button type="button" variant="ghost" size="sm" onClick={() => setDialog(false)}>Close</Button>
							<Button type="button" size="sm" disabled={busy} onClick={() => void save()} data-testid="account-save-password">Save</Button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
