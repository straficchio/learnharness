import { claudeCodeInstallationResponse } from "@/src/server";
import { withUser } from "@/src/server";

/** Installation/version only; never reads auth status or makes a model request. */
async function GETHandler(request: Request) {
	return claudeCodeInstallationResponse(request);
}

export const GET = withUser(GETHandler, { admin: true });
