import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ChartSpecError,
	parseChartSpec,
	sampleExpression,
} from "../lib/chart-spec.ts";

test("parses a compact chart with functions, data, bars, histograms, and heatmaps", () => {
	const spec = parseChartSpec(JSON.stringify({
		title: "Sampling",
		x: { label: "x", domain: [-2, 2], type: "linear" },
		y: { label: "y" },
		series: [
			{ type: "line", label: "parabola", expression: "x^2", domain: [-2, 2], samples: 100 },
			{ type: "scatter", label: "points", x: [0, 1], y: [0, 1] },
			{ type: "bar", label: "counts", x: ["a", "b"], y: [2, 3] },
			{ type: "histogram", label: "hist", data: [1, 2, 2, 3], bins: 4 },
			{ type: "heatmap", label: "grid", x: [0, 1], y: [0, 1], z: [[1, 2], [3, 4]] },
		],
		annotations: [{ x: 1, y: 1, text: "peak" }],
	}));
	assert.equal(spec.title, "Sampling");
	assert.equal(spec.series.length, 5);
	assert.equal(spec.grid, true);
	assert.equal(spec.legend, true);
	assert.equal(spec.annotations[0]!.text, "peak");
});

test("accepts JSON5 chart bodies with comments, bare keys, and trailing commas", () => {
	const spec = parseChartSpec(`{
		// a teaching chart written for humans
		title: 'JSON5',
		series: [
			{ type: 'line', expression: 'x^2', domain: [0, 2], },
		],
	}`);
	assert.equal(spec.title, "JSON5");
	assert.equal(spec.series.length, 1);
});

test("samples functions and splits at non-finite poles", () => {
	const segments = sampleExpression("1/x", [-1, 1], 401);
	assert.ok(segments.length >= 2, "a pole must break the line into separate segments");
	const parabola = sampleExpression("x^2", [-2, 2], 100);
	assert.equal(parabola.length, 1);
	const middle = parabola[0]![50]!;
	assert.ok(Math.abs(middle.x) < 0.01);
	assert.ok(Math.abs(middle.y) < 0.01);
});

test("rejects unsafe or ambiguous chart specs", () => {
	assert.throws(() => parseChartSpec("{"), ChartSpecError);
	assert.throws(() => parseChartSpec(JSON.stringify({ series: [] })), ChartSpecError);
	assert.throws(
		() => parseChartSpec(JSON.stringify({ series: [{ type: "line", expression: "y + 1", domain: [0, 1] }] })),
		/only x is allowed/,
	);
	assert.throws(
		() => parseChartSpec(JSON.stringify({ series: [{ type: "line", expression: "x = 1", domain: [0, 1] }] })),
		ChartSpecError,
	);
	assert.throws(
		() => parseChartSpec(JSON.stringify({ x: { type: "log", domain: [-1, 1] }, series: [{ type: "line", x: [1], y: [1] }] })),
		/positive for a log axis/,
	);
	assert.throws(
		() => parseChartSpec(JSON.stringify({ series: [{ type: "bar", x: ["a"], y: [1, 2] }] })),
		/lengths must match/,
	);
});
