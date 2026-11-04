import { subscriptionBrowserResponse } from "@/src/server";
import { withUser } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const GETHandler = withUser(subscriptionBrowserResponse, { admin: true });
const POSTHandler = withUser(subscriptionBrowserResponse, { admin: true });
export { GETHandler as GET, POSTHandler as POST };
