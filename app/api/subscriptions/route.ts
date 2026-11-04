import { subscriptionControlsResponse } from "@/src/server";
import { withUser } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const GETHandler = withUser(subscriptionControlsResponse, { admin: true });
const POSTHandler = withUser(subscriptionControlsResponse, { admin: true });
export { GETHandler as GET, POSTHandler as POST };
