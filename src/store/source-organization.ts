import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { scopedGraphFile } from "../../config.ts";
import { emptySourceOrganization, parseSourceOrganization } from "../core/source-organization.ts";
import type { SourceOrganizationStore } from "../core/ports.ts";
import { emit } from "../core/events.ts";
import { currentScopeId } from "../core/request-scope.ts";
import { assertGraphFormat, ensureGraphFormat } from "./graph-format.ts";

export const sourceOrganizationStore: SourceOrganizationStore = {
	read() {
		assertGraphFormat();
		let raw: string;
		try { raw = fs.readFileSync(scopedGraphFile("source-organization.json"), "utf8"); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptySourceOrganization();
			throw error;
		}
		return parseSourceOrganization(JSON.parse(raw));
	},
	write(state) {
		assertGraphFormat();
		const valid = parseSourceOrganization(state);
		fs.mkdirSync(path.dirname(scopedGraphFile("source-organization.json")), { recursive: true });
		ensureGraphFormat();
		const tmp = `${scopedGraphFile("source-organization.json")}.${randomUUID()}.tmp`;
		try {
			fs.writeFileSync(tmp, JSON.stringify(valid, null, "\t") + "\n", "utf8");
			fs.renameSync(tmp, scopedGraphFile("source-organization.json"));
		} finally { fs.rmSync(tmp, { force: true }); }
		emit("sources-changed", {}, currentScopeId());
	},
};
