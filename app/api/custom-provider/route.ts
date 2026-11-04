/** PR #62's single custom endpoint: discover/manual connect, offline pins,
 * and disconnect. Host boundaries and mutations live behind the server barrel. */
import { customProviderGet, customProviderMutation } from "@/src/server";
import { withUser } from "@/src/server";

export const dynamic = "force-dynamic";
const GETHandler = withUser(customProviderGet, { admin: true });
const POSTHandler = withUser(customProviderMutation, { admin: true });
const PATCHHandler = withUser(customProviderMutation, { admin: true });
const DELETEHandler = withUser(customProviderMutation, { admin: true });
export { GETHandler as GET, POSTHandler as POST, PATCHHandler as PATCH, DELETEHandler as DELETE };
