"use client";

import { useEffect, useState } from "react";
import { SvgImage } from "@/components/artifacts/svg-image";
import { DiagramFrame } from "@/components/diagrams/diagram-frame";
import type { ChartPoint, ChartSeries, ChartSpec } from "@/lib/chart-spec";

const PALETTE = ["#2563eb", "#dc2626", "#059669", "#d97706", "#7c3aed", "#0891b2", "#db2777", "#4d7c0f"];

function colorOf(series: ChartSeries, index: number): string {
	return series.color ?? PALETTE[index % PALETTE.length]!;
}

function labelOf(series: ChartSeries, index: number): string {
	return series.label ?? `${series.type} ${index + 1}`;
}

function finitePoints(x: number[], y: number[]): ChartPoint[][] {
	const segments: ChartPoint[][] = [];
	let current: ChartPoint[] = [];
	for (let i = 0; i < x.length; i++) {
		const px = x[i]!;
		const py = y[i]!;
		if (Number.isFinite(px) && Number.isFinite(py)) {
			current.push({ x: px, y: py });
		} else if (current.length > 0) {
			segments.push(current);
			current = [];
		}
	}
	if (current.length > 0) segments.push(current);
	return segments;
}

function histogramBins(data: number[], requested: number): Array<{ x0: number; x1: number; count: number }> {
	const values = data.filter((value) => Number.isFinite(value));
	if (values.length === 0) return [];
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;
	for (const value of values) {
		if (value < min) min = value;
		if (value > max) max = value;
	}
	const span = max - min;
	const bins = Math.max(2, Math.min(requested, 100));
	const step = span > 0 ? span / bins : 1;
	const out = Array.from({ length: bins }, (_, index) => ({
		x0: span > 0 ? min + step * index : min,
		x1: span > 0 ? min + step * (index + 1) : min + 1,
		count: 0,
	}));
	for (const value of values) {
		const index = span > 0 ? Math.min(bins - 1, Math.max(0, Math.floor((value - min) / step))) : 0;
		out[index]!.count += 1;
	}
	return out;
}

/** Plot returns a bare <svg> for a plain chart, or a <figure> when it has
 *  legends: the figure appends each legend SVG first and the plot last. A
 *  figure is not a valid data:image/svg+xml payload, and its first SVG is the
 *  legend — the plot is the final direct SVG child. */
function chartSvgs(chart: SVGSVGElement | HTMLElement): { main: SVGSVGElement; legends: SVGSVGElement[] } {
	if (chart instanceof SVGSVGElement) return { main: chart, legends: [] };
	const svgs = Array.from(chart.children).filter((child): child is SVGSVGElement => child instanceof SVGSVGElement);
	const main = svgs.pop();
	if (!main) throw new Error("chart produced no SVG.");
	return { main, legends: svgs };
}

/** Plot's continuous-color legend is an SVG exactly as wide as its ramp, so
 *  tick labels overhang the viewport and are clipped when the legend is
 *  displayed as an <img>. Pad the viewBox instead of changing the content. */
function paddedLegend(svg: SVGSVGElement): string {
	const clone = svg.cloneNode(true) as SVGSVGElement;
	const viewBox = (clone.getAttribute("viewBox") ?? "").split(/[ ,]+/).map(Number);
	const widthAttr = Number.parseFloat(clone.getAttribute("width") ?? "");
	const heightAttr = Number.parseFloat(clone.getAttribute("height") ?? "");
	const x = viewBox.length === 4 && Number.isFinite(viewBox[0]) ? viewBox[0]! : 0;
	const y = viewBox.length === 4 && Number.isFinite(viewBox[1]) ? viewBox[1]! : 0;
	const width = viewBox.length === 4 && Number.isFinite(viewBox[2]) && viewBox[2]! > 0
		? viewBox[2]!
		: Number.isFinite(widthAttr) && widthAttr > 0 ? widthAttr : 240;
	const height = viewBox.length === 4 && Number.isFinite(viewBox[3]) && viewBox[3]! > 0
		? viewBox[3]!
		: Number.isFinite(heightAttr) && heightAttr > 0 ? heightAttr : 50;
	const padX = 14;
	const padY = 6;
	clone.setAttribute("viewBox", `${x - padX} ${y - padY} ${width + padX * 2} ${height + padY * 2}`);
	clone.setAttribute("width", String(width + padX * 2));
	clone.setAttribute("height", String(height + padY * 2));
	return new XMLSerializer().serializeToString(clone);
}

export function ChartBlock({ source, incomplete = false }: { source: string; incomplete?: boolean }) {
	const [svg, setSvg] = useState<string | null>(null);
	const [legends, setLegends] = useState<string[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [spec, setSpec] = useState<ChartSpec | null>(null);

	useEffect(() => {
		let cancelled = false;
		setSvg(null);
		setLegends([]);
		setSpec(null);
		setError(null);
		if (incomplete) return;
		void Promise.all([import("@/lib/chart-spec"), import("@observablehq/plot")])
			.then(([chartSpec, Plot]) => {
				if (cancelled) return;
				const parsed = chartSpec.parseChartSpec(source);
				const marks: unknown[] = [];
				let hasHeatmap = false;
				for (const [index, series] of parsed.series.entries()) {
					const color = colorOf(series, index);
					if (series.type === "heatmap") {
						hasHeatmap = true;
						const points = series.y.flatMap((y, row) => series.x.map((x, column) => ({ x, y, z: series.z[row]![column]! })));
						marks.push(Plot.cell(points, { x: "x", y: "y", fill: "z" }));
					} else if (series.type === "histogram") {
						const bins = histogramBins(series.data, series.bins ?? 20);
						marks.push(Plot.rectY(bins, { x1: "x0", x2: "x1", y: "count", fill: color }));
					} else if (series.type === "bar") {
						const points = series.x.map((x, i) => ({ x, y: series.y[i]! }));
						marks.push(Plot.barY(points, { x: "x", y: "y", fill: color }));
					} else {
						const segments = "expression" in series
							? chartSpec.sampleExpression(series.expression, series.domain, series.samples ?? 600)
							: finitePoints(series.x, series.y);
						for (const segment of segments) {
							if (segment.length === 0) continue;
							if (series.type === "scatter") marks.push(Plot.dot(segment, { x: "x", y: "y", fill: color }));
							else if (series.type === "area") marks.push(Plot.areaY(segment, { x: "x", y: "y", fill: color, fillOpacity: 0.25, stroke: color }));
							else marks.push(Plot.line(segment, { x: "x", y: "y", stroke: color, strokeWidth: 2 }));
						}
					}
				}
				for (const annotation of parsed.annotations) {
					marks.push(Plot.dot([annotation], { x: "x", y: "y", fill: "#111" }));
					marks.push(Plot.text([annotation], { x: "x", y: "y", text: "text", dx: 7, dy: -7, fill: "#111", fontSize: 11 }));
				}
				if (marks.length === 0) throw new Error("chart has no drawable series.");
				const chart = Plot.plot({
					width: 720,
					height: 420,
					marginTop: 28,
					marginRight: 28,
					marginBottom: 48,
					marginLeft: 64,
					x: {
						label: parsed.x?.label,
						type: parsed.x?.type,
						domain: parsed.x?.domain,
						grid: parsed.grid,
					},
					y: {
						label: parsed.y?.label,
						type: parsed.y?.type,
						domain: parsed.y?.domain,
						grid: parsed.grid,
					},
					color: hasHeatmap ? { legend: parsed.legend } : undefined,
					style: { background: "white", color: "#111" },
					marks: marks as never[],
				});
				if (cancelled) return;
				const { main, legends: legendElements } = chartSvgs(chart);
				if (parsed.title) {
					const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
					title.textContent = parsed.title;
					main.prepend(title);
				}
				setSpec(parsed);
				setSvg(new XMLSerializer().serializeToString(main));
				setLegends(legendElements.map(paddedLegend));
			})
			.catch((cause: unknown) => {
				if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
			});
		return () => {
			cancelled = true;
		};
	}, [source, incomplete]);

	const legend = spec && spec.legend && spec.series.length > 1
		? spec.series.flatMap((series, index) => series.type === "heatmap"
			? []
			: [{ key: index, label: labelOf(series, index), color: colorOf(series, index) }])
		: [];
	return (
		<DiagramFrame
			source={source}
			label="chart"
			testId="md-chart"
			busy={!error && !svg}
			error={error}
			className="bg-white text-slate-900"
			downloadName="chart.svg"
			downloadText={svg ?? undefined}
		>
			{svg && (
				<>
					{spec?.title && (
						<div className="mb-2 text-center text-sm font-semibold" data-testid="md-chart-title">{spec.title}</div>
					)}
					<SvgImage svg={svg} alt={spec?.title ?? "Chart"} className="mx-auto block h-auto max-w-full" width={720} />
					{legend.length > 0 && (
						<div className="mt-2 flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-slate-700">
							{legend.map((item) => (
								<span key={item.key} className="inline-flex items-center gap-1.5">
									<span className="size-2.5 rounded-full" style={{ backgroundColor: item.color }} aria-hidden="true" />
									{item.label}
								</span>
							))}
						</div>
					)}
					{legends.map((legendSvg, index) => (
						<span key={index} data-testid="md-chart-legend" className="block">
							<SvgImage svg={legendSvg} alt="Chart legend" className="mx-auto mt-2 block h-auto max-w-full" />
						</span>
					))}
				</>
			)}
		</DiagramFrame>
	);
}
