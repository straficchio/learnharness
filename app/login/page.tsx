import { redirect } from "next/navigation";
import { LoginForm } from "@/components/login";
import { pageSessionUser } from "@/src/server";
import { isServerMode } from "@/src/server";

export const dynamic = "force-dynamic";

/** Server mode's only public page. A valid cookie skips the screen entirely;
 *  standalone never has a login. */
export default async function LoginPage() {
	if (!isServerMode()) redirect("/");
	const user = await pageSessionUser();
	if (user) redirect("/");
	return <LoginForm />;
}
