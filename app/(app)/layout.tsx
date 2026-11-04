import { AppShell, SidebarProvider } from "@/components/sidebar";
import { ActivityProvider } from "@/components/activity-dock";
import { ServerEventsProvider } from "@/components/server-events";
import { AppearanceProvider } from "@/components/settings/appearance";
import { SessionProvider } from "@/components/session-user";
import UpdateBanner from "@/components/update-banner";
import { requirePageUser } from "@/src/server";
import { isServerMode } from "@/src/server";

/** The authenticated app surface: every route in this group has a user. In
 *  server mode requirePageUser redirects to /login; standalone returns the
 *  synthetic local admin and never shows account controls. */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
	const user = await requirePageUser();
	const serverMode = isServerMode();
	return (
		<SessionProvider
			user={{ id: user.id, name: user.name, role: user.role, hasPassword: user.hasPassword }}
			serverMode={serverMode}
			standalone={!serverMode}
		>
			<ServerEventsProvider>
				<AppearanceProvider>
					<SidebarProvider>
						<ActivityProvider>
							<AppShell>{children}</AppShell>
						</ActivityProvider>
					</SidebarProvider>
				</AppearanceProvider>
			</ServerEventsProvider>
			<UpdateBanner />
		</SessionProvider>
	);
}
