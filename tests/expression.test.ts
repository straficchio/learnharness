import assert from "node:assert/strict";
import { test } from "node:test";
import { compileExpression, ExpressionError } from "../lib/expression.ts";

test("compiles chart expressions with standard precedence and right-associative powers", () => {
	const at = (source: string, x: number) => compileExpression(source)(x);
	assert.equal(at("1 + 2 * 3", 0), 7);
	assert.equal(at("(1 + 2) * 3", 0), 9);
	assert.equal(at("2^3^2", 0), 512);
	assert.equal(at("-x^2", 2), -4);
	assert.equal(at("(-x)^2", 2), 4);
	assert.equal(at("2^-1", 0), 0.5);
	assert.equal(at("x^-2", 2), 0.25);
	assert.equal(at(".5 * x", 4), 2);
	assert.equal(at("1e-3 * x", 1000), 1);
});

test("exposes pi/e constants and a fixed function whitelist", () => {
	const at = (source: string) => compileExpression(source)(0.5);
	assert.ok(Math.abs(at("sin(pi/2)") - 1) < 1e-12);
	assert.ok(Math.abs(at("ln(e)") - 1) < 1e-12);
	assert.ok(Math.abs(at("log(e)") - 1) < 1e-12);
	assert.equal(at("sqrt(16) + abs(-2)"), 6);
	assert.equal(at("min(3, 1, 2) + max(3, 1, 2)"), 4);
	assert.equal(at("pow(2, 3) + atan2(1, 1) * 0"), 8);
	assert.equal(at("floor(2.9) + ceil(2.1) + round(2.5)"), 8);
});

test("rejects anything outside the closed grammar — no JavaScript, properties, or assignments", () => {
	const invalid = [
		"",
		"y + 1",
		"unknown(x)",
		"sin",
		"sin(x, 1)",
		"min()",
		"x = 2",
		"x; 2",
		"x[0]",
		"x.constructor",
		"x.__proto__",
		"constructor",
		"constructor('alert(1)')",
		"toString",
		"hasOwnProperty",
		"2x",
		"(x + 1",
		"x + 1)",
		"1e999",
		"#",
	];
	for (const source of invalid) {
		assert.throws(() => compileExpression(source), ExpressionError, source);
	}
});

test("compiles once and evaluates the same expression at multiple x values", () => {
	const f = compileExpression("x^2 - 2*x + 1");
	assert.deepEqual([0, 1, 2, 3].map(f), [1, 0, 1, 4]);
});
