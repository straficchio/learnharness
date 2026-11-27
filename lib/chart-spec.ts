/**
 * Declarative chart specs for the `chart`/`plot` fenced renderer.
 *
 * This is deliberately not Vega-Lite or matplotlib: it is a compact,
 * model-friendly subset for teaching charts. Validation and function
 * sampling are browser-safe and free of DOM dependencies so they can be
 * tested directly.
 */
import JSON5 from "json5";
import { compileExpression, ExpressionError } from "./expression.ts";

export const CHART_MAX_SOURCE_CHARS = 200_000;
export const CHART_MAX_SERIES = 20;
export const CHART_MAX_POINTS = 50_000;
export const CHART_MAX_SAMPLES = 2_000;
export const FUNCTION_MAX_LENGTH = 200;

export type ChartAxisType = "linear" | "log";

export interface ChartAxis {
	label?: string;
	type?: ChartAxisType;
	domain?: [number, number];
}

export interface ChartSeriesBase {
	label?: string;
	color?: string;
}

export interface ChartExpressionSeries extends ChartSeriesBase {
	type: "line" | "area" | "scatter";
	expression: string;
	domain: [number, number];
	samples?: number;
}

export interface ChartArraySeries extends ChartSeriesBase {
	type: "line" | "area" | "scatter";
	x: number[];
	y: number[];
}

export interface ChartBarSeries extends ChartSeriesBase {
	type: "bar";
	x: Array<string | number>;
	y: number[];
}

export interface ChartHistogramSeries extends ChartSeriesBase {
	type: "histogram";
	data: number[];
	bins?: number;
}

export interface ChartHeatmapSeries extends ChartSeriesBase {
	type: "heatmap";
	x: number[];
	y: number[];
	z: number[][];
}

export type ChartSeries =
	| ChartExpressionSeries
	| ChartArraySeries
	| ChartBarSeries
	| ChartHistogramSeries
	| ChartHeatmapSeries;

export interface ChartAnnotation {
	x: number;
	y: number;
	text: string;
}

export interface ChartSpec {
	title?: string;
	x?: ChartAxis;
	y?: ChartAxis;
	series: ChartSeries[];
	annotations: ChartAnnotation[];
	grid: boolean;
	legend: boolean;
}

export interface ChartPoint {
	x: number;
	y: number;
}

export class ChartSpecError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ChartSpecError";
	}
}

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function numberArray(value: unknown, field: string): number[] {
	if (!Array.isArray(value) || value.some((item) => !finite(item))) {
		throw new ChartSpecError(`${field} must be an array of finite numbers.`);
	}
	return value as number[];
}

function axis(value: unknown, field: string): ChartAxis | undefined {
	if (value === undefined) return undefined;
	const raw = record(value);
	if (!raw) throw new ChartSpecError(`${field} must be an object.`);
	const out: ChartAxis = {};
	if (raw.label !== undefined) {
		if (typeof raw.label !== "string") throw new ChartSpecError(`${field}.label must be a string.`);
		out.label = raw.label;
	}
	if (raw.type !== undefined) {
		if (raw.type !== "linear" && raw.type !== "log") {
			throw new ChartSpecError(`${field}.type must be linear or log.`);
		}
		out.type = raw.type;
	}
	if (raw.domain !== undefined) {
		if (!Array.isArray(raw.domain) || raw.domain.length !== 2 || raw.domain.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
			throw new ChartSpecError(`${field}.domain must be [min, max].`);
		}
		out.domain = [raw.domain[0] as number, raw.domain[1] as number];
		if (out.type === "log" && (out.domain[0]! <= 0 || out.domain[1]! <= 0)) {
			throw new ChartSpecError(`${field}.domain must be positive for a log axis.`);
		}
	}
	return out;
}

function expression(value: unknown): (x: number) => number {
	if (typeof value !== "string" || value.length === 0 || value.length > FUNCTION_MAX_LENGTH) {
		throw new ChartSpecError(`expression must be a string of at most ${FUNCTION_MAX_LENGTH} characters.`);
	}
	try {
		return compileExpression(value);
	} catch (error) {
		if (error instanceof ExpressionError) throw new ChartSpecError(`expression is invalid: ${error.message}`);
		throw new ChartSpecError(`expression is invalid: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function sampleCount(value: unknown): number {
	if (value === undefined) return 600;
	if (!finite(value) || value < 32) throw new ChartSpecError("samples must be a number of at least 32.");
	return Math.min(Math.floor(value), CHART_MAX_SAMPLES);
}

function series(value: unknown, index: number): ChartSeries {
	const raw = record(value);
	if (!raw) throw new ChartSpecError(`series[${index}] must be an object.`);
	const label = raw.label === undefined ? undefined : raw.label;
	const color = raw.color === undefined ? undefined : raw.color;
	if (label !== undefined && typeof label !== "string") throw new ChartSpecError(`series[${index}].label must be a string.`);
	if (color !== undefined && typeof color !== "string") throw new ChartSpecError(`series[${index}].color must be a string.`);
	const base = { ...(label !== undefined ? { label } : {}), ...(color !== undefined ? { color } : {}) };
	const type = raw.type;
	if (type === "histogram") {
		const data = numberArray(raw.data, `series[${index}].data`);
		const bins = raw.bins === undefined ? 20 : raw.bins;
		if (!finite(bins) || bins < 2 || bins > 100) throw new ChartSpecError(`series[${index}].bins must be between 2 and 100.`);
		return { ...base, type, data, bins: Math.floor(bins) };
	}
	if (type === "heatmap") {
		const x = numberArray(raw.x, `series[${index}].x`);
		const y = numberArray(raw.y, `series[${index}].y`);
		if (!Array.isArray(raw.z) || raw.z.length === 0) throw new ChartSpecError(`series[${index}].z must be a non-empty matrix.`);
		const z = raw.z.map((row, rowIndex) => numberArray(row, `series[${index}].z[${rowIndex}]`));
		if (z.some((row) => row.length !== x.length) || z.length !== y.length) {
			throw new ChartSpecError(`series[${index}] heatmap dimensions must be z[y][x].`);
		}
		return { ...base, type, x, y, z };
	}
	if (type === "bar") {
		if (!Array.isArray(raw.x) || raw.x.some((item) => typeof item !== "string" && !finite(item))) {
			throw new ChartSpecError(`series[${index}].x must be strings or finite numbers.`);
		}
		const y = numberArray(raw.y, `series[${index}].y`);
		if (raw.x.length !== y.length) throw new ChartSpecError(`series[${index}] x/y lengths must match.`);
		return { ...base, type, x: raw.x as Array<string | number>, y };
	}
	if (type !== "line" && type !== "area" && type !== "scatter") {
		throw new ChartSpecError(`series[${index}].type is unsupported.`);
	}
	if (raw.expression !== undefined) {
		const domain = raw.domain;
		if (!Array.isArray(domain) || domain.length !== 2 || domain.some((item) => !finite(item)) || domain[0]! >= domain[1]!) {
			throw new ChartSpecError(`series[${index}].domain must be [min, max] with min < max.`);
		}
		if (raw.x !== undefined || raw.y !== undefined) throw new ChartSpecError(`series[${index}] cannot mix expression and x/y arrays.`);
		expression(raw.expression);
		return {
			...base,
			type,
			expression: raw.expression as string,
			domain: [domain[0] as number, domain[1] as number],
			samples: sampleCount(raw.samples),
		};
	}
	const x = numberArray(raw.x, `series[${index}].x`);
	const y = numberArray(raw.y, `series[${index}].y`);
	if (x.length !== y.length) throw new ChartSpecError(`series[${index}] x/y lengths must match.`);
	return { ...base, type, x, y };
}

export function parseChartSpec(source: string): ChartSpec {
	if (source.length > CHART_MAX_SOURCE_CHARS) throw new ChartSpecError("chart source is too large.");
	let value: unknown;
	try {
		value = JSON5.parse(source);
	} catch (error) {
		throw new ChartSpecError(`chart JSON is invalid: ${error instanceof Error ? error.message : String(error)}`);
	}
	const raw = record(value);
	if (!raw) throw new ChartSpecError("chart must be a JSON object.");
	if (!Array.isArray(raw.series) || raw.series.length === 0) throw new ChartSpecError("chart.series must be a non-empty array.");
	if (raw.series.length > CHART_MAX_SERIES) throw new ChartSpecError(`chart.series may contain at most ${CHART_MAX_SERIES} entries.`);
	const seriesList = raw.series.map((item, index) => series(item, index));
	const points = seriesList.reduce((sum, item) => {
		if (item.type === "histogram") return sum + item.data.length;
		if (item.type === "heatmap") return sum + item.x.length * item.y.length;
		if (item.type === "bar" || item.type === "line" || item.type === "area" || item.type === "scatter") {
			return sum + ("expression" in item ? (item.samples ?? 600) : item.x.length);
		}
		return sum;
	}, 0);
	if (points > CHART_MAX_POINTS) throw new ChartSpecError(`chart contains more than ${CHART_MAX_POINTS} points.`);
	const annotations: ChartAnnotation[] = [];
	if (raw.annotations !== undefined) {
		if (!Array.isArray(raw.annotations)) throw new ChartSpecError("chart.annotations must be an array.");
		for (const [index, item] of raw.annotations.entries()) {
			const annotation = record(item);
			if (!annotation || !finite(annotation.x) || !finite(annotation.y) || typeof annotation.text !== "string") {
				throw new ChartSpecError(`annotations[${index}] must be {x, y, text}.`);
			}
			annotations.push({ x: annotation.x, y: annotation.y, text: annotation.text });
		}
	}
	const xAxis = axis(raw.x, "x");
	const yAxis = axis(raw.y, "y");
	return {
		...(typeof raw.title === "string" ? { title: raw.title } : {}),
		...(xAxis ? { x: xAxis } : {}),
		...(yAxis ? { y: yAxis } : {}),
		series: seriesList,
		annotations,
		grid: raw.grid !== false,
		legend: raw.legend !== false,
	};
}

/** Evaluate a restricted expression over a domain. Non-finite values split
 *  the line into separate segments instead of drawing through a pole. */
export function sampleExpression(expressionText: string, domain: [number, number], samples = 600): ChartPoint[][] {
	const compiled = expression(expressionText);
	const count = Math.max(32, Math.min(Math.floor(samples), CHART_MAX_SAMPLES));
	const segments: ChartPoint[][] = [];
	let current: ChartPoint[] = [];
	let previous: ChartPoint | null = null;
	for (let i = 0; i <= count; i++) {
		const x = domain[0] + (domain[1] - domain[0]) * (i / count);
		let y: number;
		try {
			y = compiled(x);
		} catch {
			y = Number.NaN;
		}
		if (!Number.isFinite(y)) {
			if (current.length > 0) segments.push(current);
			current = [];
			previous = null;
			continue;
		}
		// A pole between two samples can otherwise draw a straight line across
		// the asymptote. A large opposite-sign jump is the cheap, safe signal.
		if (previous && Math.sign(y) !== Math.sign(previous.y) && Math.abs(y) > 10 && Math.abs(previous.y) > 10) {
			if (current.length > 0) segments.push(current);
			current = [];
		}
		const point = { x, y };
		current.push(point);
		previous = point;
	}
	if (current.length > 0) segments.push(current);
	return segments;
}
