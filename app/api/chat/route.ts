import { handleChatRequest } from "@/src/server";
import { withUser } from "@/src/server";

async function POSTHandler(req: Request) {
	return handleChatRequest(req);
}

export const POST = withUser(POSTHandler);
