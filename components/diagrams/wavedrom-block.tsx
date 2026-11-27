"use client";

import { useEffect, useState } from "react";
import { SvgImage } from "@/components/artifacts/svg-image";
import { DiagramFrame } from "@/components/diagrams/diagram-frame";

const MAX_WAVEDROM_SOURCE = 128_000;

export function WaveDromBlock({ source, incomplete = false }: { source: string; incomplete?: boolean }) {
	const [svg, setSvg] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setSvg(null);
		setError(null);
		if (incomplete) return;
		if (source.length > MAX_WAVEDROM_SOURCE) {
			setError("WaveDrom source is too large.");
			return;
		}
		void Promise.all([import("json5"), import("wavedrom")])
			.then(([json5, module]) => {
				if (cancelled) return;
				let value: unknown;
				try {
					value = json5.default.parse(source);
				} catch (cause) {
					setError(`WaveDrom JSON is invalid: ${cause instanceof Error ? cause.message : String(cause)}`);
					return;
				}
				if (!value || typeof value !== "object" || Array.isArray(value)) {
					setError("WaveDrom source must be a JSON object.");
					return;
				}
				const output = document.createElement("div");
				module.renderWaveElement(0, value as Record<string, unknown>, output, module.waveSkin);
				const rendered = output.querySelector("svg");
				if (!rendered) throw new Error("WaveDrom produced no SVG.");
				setSvg(new XMLSerializer().serializeToString(rendered));
			})
			.catch((cause: unknown) => {
				if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
			});
		return () => {
			cancelled = true;
		};
	}, [source, incomplete]);

	return (
		<DiagramFrame
			source={source}
			label="timing diagram"
			testId="md-wavedrom"
			busy={!error && !svg}
			error={error}
			className="bg-white text-slate-900"
			downloadName="timing.svg"
			downloadText={svg ?? undefined}
		>
			{svg && <SvgImage svg={svg} alt="Timing diagram" className="mx-auto block h-auto max-w-full" />}
		</DiagramFrame>
	);
}
