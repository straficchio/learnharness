"use client";

import { useEffect, useRef, useState } from "react";
import type { GLModel, GLViewer } from "3dmol";
import { DiagramFrame } from "@/components/diagrams/diagram-frame";
import { load3Dmol } from "@/components/diagrams/3dmol-loader";

const MAX_STRUCTURE_CHARS = 2 * 1024 * 1024;
const HYDROGEN_COLOR = "#64748b";
type StructureFormat = "pdb" | "cif" | "xyz" | "sdf" | "mol2";
type StructureStyle = "stick" | "sphere" | "cartoon";

function normalizeFormat(format: string): StructureFormat | null {
	switch (format.toLowerCase()) {
		case "pdb": return "pdb";
		case "cif": return "cif";
		case "xyz": return "xyz";
		case "sdf":
		case "mol": return "sdf";
		case "mol2": return "mol2";
		default: return null;
	}
}

function styleSpec(style: StructureStyle): Record<string, unknown> {
	if (style === "cartoon") return { cartoon: { color: "spectrum" } };
	if (style === "sphere") return { sphere: { scale: 0.35, colorscheme: "Jmol" } };
	return { stick: { radius: 0.15, colorscheme: "Jmol" }, sphere: { scale: 0.22, colorscheme: "Jmol" } };
}

/** Jmol paints hydrogen white — invisible on the viewer's white card. Style
 *  non-hydrogen atoms normally, then give H a readable slate color. */
function applyStyle(viewer: GLViewer, style: StructureStyle): void {
	if (style === "cartoon") {
		viewer.setStyle({}, styleSpec(style) as never);
		return;
	}
	viewer.setStyle({ elem: "H", invert: true }, styleSpec(style) as never);
	viewer.setStyle(
		{ elem: "H" },
		(style === "sphere"
			? { sphere: { scale: 0.35, color: HYDROGEN_COLOR } }
			: { stick: { radius: 0.15, color: HYDROGEN_COLOR }, sphere: { scale: 0.22, color: HYDROGEN_COLOR } }) as never,
	);
}

/** Probe before downloading the 567 KB viewer: a device without WebGL gets a
 *  direct message instead of a generic 3Dmol failure. The probe context is
 *  released immediately so it never counts against the browser's limit. */
function hasWebGL(): boolean {
	try {
		const canvas = document.createElement("canvas");
		const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
		if (!gl) return false;
		gl.getExtension("WEBGL_lose_context")?.loseContext();
		return true;
	} catch {
		return false;
	}
}

export function MoleculeBlock({
	source,
	language,
	incomplete = false,
}: {
	source: string;
	language: string;
	incomplete?: boolean;
}) {
	const hostRef = useRef<HTMLDivElement>(null);
	const viewerRef = useRef<GLViewer | null>(null);
	const initialViewRef = useRef<number[] | null>(null);
	const styleRef = useRef<StructureStyle>("stick");
	const unitCellRef = useRef(true);
	const spinRef = useRef(false);
	const [visible, setVisible] = useState(false);
	const [ready, setReady] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [style, setStyle] = useState<StructureStyle>("stick");
	const [unitCell, setUnitCell] = useState(true);
	const [hasCell, setHasCell] = useState(false);
	const [spin, setSpin] = useState(false);
	const format = normalizeFormat(language);

	useEffect(() => {
		styleRef.current = style;
	}, [style]);

	useEffect(() => {
		unitCellRef.current = unitCell;
	}, [unitCell]);

	useEffect(() => {
		spinRef.current = spin;
	}, [spin]);

	useEffect(() => {
		const host = hostRef.current;
		if (!host || typeof IntersectionObserver === "undefined") {
			setVisible(true);
			return;
		}
		const observer = new IntersectionObserver((entries) => {
			const entry = entries[0];
			if (entry) setVisible(entry.isIntersecting);
		}, { rootMargin: "300px" });
		observer.observe(host);
		return () => observer.disconnect();
	}, []);

	// The viewer owns a WebGL context and timers: its lifetime is exactly the
	// fence's on-screen lifetime. Style and unit-cell changes are applied below
	// without recreating it, so the camera survives a control toggle.
	useEffect(() => {
		if (incomplete || !visible || !format) return;
		const host = hostRef.current;
		if (!host) return;
		setReady(false);
		setError(null);
		setHasCell(false);
		initialViewRef.current = null;
		if (source.length > MAX_STRUCTURE_CHARS) {
			setError("Structure data is too large to display.");
			return;
		}
		if (!hasWebGL()) {
			setError("The 3D viewer needs WebGL, which this browser or device does not provide.");
			return;
		}
		let cancelled = false;
		void load3Dmol()
			.then((threeDmol) => {
				if (cancelled) return;
				const viewer = threeDmol.createViewer(host, { backgroundColor: "white" });
				viewerRef.current = viewer;
				// PDB parsers strip hydrogens unless asked to keep them; a water
				// molecule would otherwise render as a lone oxygen.
				const model = viewer.addModel(source, format, { keepH: true }) as GLModel;
				applyStyle(viewer, styleRef.current);
				const cell = format === "cif" ? model.getCrystData() : null;
				setHasCell(Boolean(cell));
				if (cell && unitCellRef.current) viewer.addUnitCell(model);
				viewer.resize();
				viewer.zoomTo();
				viewer.render();
				if (spinRef.current) viewer.spin("y", 1);
				setReady(true);
			})
			.catch((cause: unknown) => {
				if (cancelled) return;
				const viewer = viewerRef.current;
				viewerRef.current = null;
				setReady(false);
				try { viewer?.destroy(); } catch { /* already gone */ }
				setError(cause instanceof Error ? cause.message : String(cause));
			});
		return () => {
			cancelled = true;
			setReady(false);
			initialViewRef.current = null;
			const viewer = viewerRef.current;
			viewerRef.current = null;
			try { viewer?.destroy(); } catch { /* already gone */ }
		};
	}, [incomplete, visible, source, format]);

	useEffect(() => {
		const viewer = viewerRef.current;
		if (!viewer || !ready) return;
		try {
			applyStyle(viewer, style);
			viewer.render();
		} catch {
			/* A style that the parsed model cannot show leaves the last one. */
		}
	}, [style, ready]);

	useEffect(() => {
		const viewer = viewerRef.current;
		if (!viewer || !ready || format !== "cif" || !hasCell) return;
		try {
			viewer.removeUnitCell();
			if (unitCell) viewer.addUnitCell();
			viewer.zoomTo();
			viewer.render();
			initialViewRef.current = viewer.getView() as number[];
		} catch {
			/* The structure may lack crystallographic symmetry data. */
		}
	}, [unitCell, hasCell, format, ready]);

	useEffect(() => {
		const viewer = viewerRef.current;
		if (!viewer || !ready) return;
		try {
			viewer.spin(spin ? "y" : false, 1);
		} catch {
			/* no viewer yet */
		}
	}, [spin, ready]);

	// Full-screen and sidebar/window resizes change the host box; 3Dmol's
	// canvas does not track CSS size on its own.
	useEffect(() => {
		const host = hostRef.current;
		if (!host || !ready) return;
		const resize = () => {
			try {
				viewerRef.current?.resize();
				viewerRef.current?.render();
				if (!initialViewRef.current) {
					const view = viewerRef.current?.getView();
					if (view) initialViewRef.current = view as number[];
				}
			} catch {
				/* viewer is being torn down */
			}
		};
		resize();
		const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
		observer?.observe(host);
		document.addEventListener("fullscreenchange", resize);
		return () => {
			observer?.disconnect();
			document.removeEventListener("fullscreenchange", resize);
		};
	}, [ready]);

	const download = () => {
		try {
			const uri = viewerRef.current?.pngURI();
			if (!uri) return;
			const link = document.createElement("a");
			link.href = uri;
			link.download = "structure.png";
			link.click();
		} catch {
			/* A failed snapshot should not blank the viewer. */
		}
	};
	const reset = () => {
		try {
			const viewer = viewerRef.current;
			if (!viewer) return;
			const view = initialViewRef.current;
			if (view) viewer.setView(view);
			else viewer.zoomTo();
			viewer.render();
		} catch {
			/* no viewer */
		}
	};
	const label = format ? `3D structure · ${format.toUpperCase()}` : "3D structure";
	return (
		<DiagramFrame
			source={source}
			label={label}
			testId="md-molecule"
			busy={!!format && !error && (incomplete || !visible || !ready)}
			error={format ? error : "Unsupported 3D structure format. Use pdb, cif, xyz, sdf/mol, or mol2."}
			className="bg-white text-slate-900"
		>
			<div ref={hostRef} className="h-[340px] w-full overflow-hidden rounded-md" data-testid="md-molecule-viewer" />
			<div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-slate-700">
				{(["stick", "sphere", ...(format === "pdb" ? ["cartoon" as const] : [])] as StructureStyle[]).map((choice) => (
					<button
						key={choice}
						type="button"
						aria-pressed={style === choice}
						onClick={() => setStyle(choice)}
						className={`rounded border px-2 py-1 ${style === choice ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 bg-white"}`}
					>
						{choice}
					</button>
				))}
				<button type="button" onClick={() => setSpin((value) => !value)} className="rounded border border-slate-300 bg-white px-2 py-1">
					{spin ? "Stop spin" : "Spin"}
				</button>
				<button type="button" onClick={reset} className="rounded border border-slate-300 bg-white px-2 py-1">Reset</button>
				{format === "cif" && hasCell && (
					<button type="button" onClick={() => setUnitCell((value) => !value)} className="rounded border border-slate-300 bg-white px-2 py-1">
						{unitCell ? "Hide cell" : "Show cell"}
					</button>
				)}
				<button type="button" onClick={download} className="rounded border border-slate-300 bg-white px-2 py-1">PNG</button>
			</div>
		</DiagramFrame>
	);
}
