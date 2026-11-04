import { authUsersResponse } from "@/src/server";

/** Public login list: display names only, no hashes or session metadata. */
export async function GET() {
	return authUsersResponse();
}
