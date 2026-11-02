"use client";

import type { UserSettings } from "@/src/core";
import { Toggle } from "./controls";

export function DeveloperSection({
	developer,
	onSectionChange,
}: {
	developer: UserSettings["developer"];
	onSectionChange: (next: NonNullable<UserSettings["developer"]>) => void;
}) {
	return <div className="space-y-3" data-testid="developer-section">
		<div className="flex items-center gap-3">
			<span className="font-prose text-(length:--lh-prose-size) text-foreground">Model trace</span>
			<Toggle
				label="Model trace"
				checked={developer?.modelTrace === true}
				onChange={(next) => onSectionChange({ ...developer, modelTrace: next })}
			/>
		</div>
		<p className="text-xs leading-relaxed text-muted-foreground">
			Records the model-facing request, tool schemas, raw provider/CLI events, and the final response for each model call, locally under
			<code className="mx-1 font-mono">data/debug/model-traces/</code>.
			Off by default. Traces contain full prompts and responses; treat them as private diagnostic data and delete them when no longer needed.
		</p>
		<p className="text-xs leading-relaxed text-muted-foreground">
			Open a chat and use the <strong className="font-medium text-foreground">Trace</strong> button in its header to view the live trace for that session.
		</p>
	</div>;
}
