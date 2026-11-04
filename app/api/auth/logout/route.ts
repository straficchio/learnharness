import { authLogoutResponse } from "@/src/server";

export async function POST() {
	return authLogoutResponse();
}
