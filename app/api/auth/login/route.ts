import { authLoginResponse } from "@/src/server";

/** Public login. Passwordless accounts may also submit newPassword to claim
 *  the account in the same step; remember=true gets the persistent cookie. */
export async function POST(req: Request) {
	return authLoginResponse(req);
}
